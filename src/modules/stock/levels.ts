/*
 * Les niveaux de stock, en lecture. M2 — E3-02.
 *
 * Aucun `tenant_id` n'est écrit ici : la policy `tenant_isolation` borne la
 * lecture, et « voir le catalogue et le stock » est accordé aux deux rôles
 * (SPEC § 3.1). Un `where` sur le commerce serait un filtre applicatif, ce que
 * SPEC § 2.1 refuse.
 *
 * Rien n'écrit dans `stock_level` — rien ne peut : la table est un agrégat
 * maintenu par trigger, et toute écriture directe est refusée en `55000`
 * (RÈGLE M2-1). Ce fichier n'a donc que des lectures, et ce n'est pas une
 * omission.
 *
 * **Deux chemins, parce que ce sont deux questions.**
 *
 *   — `stockLevelsFor()` complète une liste de résultats de recherche. La
 *     recherche reste `public.search_products()` (E2-04, exception § 2.1
 *     nommée) : rien ici ne la réimplémente et rien ne s'y greffe. Les
 *     quantités arrivent par une seconde lecture, sur les 50 variantes au plus
 *     que la recherche a rendues.
 *
 *     `in('variant_id', …)` devient `variant_id = any(array[…])`, et `uuid_eq`
 *     est `leakproof` : sous RLS c'est une condition d'index valide, servie par
 *     la colonne de tête de `stock_level_variant_warehouse`. C'est tout
 *     l'intérêt de ne pas joindre en SQL — mesuré, 50 recherches par index au
 *     lieu d'un parcours de la table.
 *
 *   — `listByStockFilter()` répond à « qu'est-ce qui est à zéro, qu'est-ce qui
 *     est en négatif », sur **tout** le catalogue. Le filtre porte sur
 *     `quantity`, et sous RLS ni `numeric_eq` ni `numeric_lt` ne sont
 *     `leakproof` : aucune condition d'index n'est possible sur cette colonne.
 *     Ce sont les deux index **partiels** de la migration qui servent, dont le
 *     prédicat est démontré à la planification et n'évalue rien. Mesuré :
 *     0,71 ms contre 65,3 ms pour l'anti-jointure qu'ils remplacent, et l'écart
 *     grandit avec le catalogue des autres commerces.
 *
 * Les deux questions ne se combinent pas, et c'est une décision : un filtre
 * actif change la **source** de la liste. Rapprocher les deux demanderait de
 * replier les accents côté appareil pour croiser un texte avec un filtre, donc
 * de réécrire `merx.search_fold()` une seconde fois — et les deux copies
 * divergeraient sans que rien le dise.
 */

import { supabase } from '@/lib/supabase'

/** Ce que les deux filtres de la story nomment. */
export type StockFilter = 'zero' | 'negative'

/** La quantité d'une variante, et ce qu'on sait de sa provenance. */
export interface StockLevel {
  variantId: string
  /** Décimale en chaîne, signée — jamais un flottant (CLAUDE.md). */
  quantity: string
  /**
   * `null` quand aucun mouvement n'a jamais touché la variante. Alors la
   * quantité vaut 0 et ne veut pas dire « compté à zéro » : SPEC § 2.5 refuse
   * de présenter l'un comme l'autre, et l'écran écrit « Stock non saisi ».
   */
  lastMovementAt: string | null
}

/** Une ligne du stock, avec de quoi la nommer à l'écran. */
export interface StockEntry extends StockLevel {
  productId: string
  name: string
  nameAr: string | null
  code: string | null
  sku: string | null
  /** Chemin dans le compartiment `product-photo`, pas une URL. */
  photoPath: string | null
}

/*
 * `quantity::text` et `last_movement_at` : la quantité voyage en texte, sinon
 * PostgREST rendrait le `numeric` en nombre JSON, donc en flottant une fois
 * parsé (`src/lib/decimal.ts`).
 */
const LEVEL_COLUMNS = 'variant_id, quantity::text, last_movement_at'

interface LevelRow {
  variant_id: string
  quantity: string
  last_movement_at: string | null
}

function levelOf(row: LevelRow): StockLevel {
  return {
    variantId: row.variant_id,
    quantity: row.quantity,
    lastMovementAt: row.last_movement_at,
  }
}

/**
 * Les niveaux des variantes données, indexés par `variantId`.
 *
 * Une variante absente de la réponse n'a pas de ligne de stock. Depuis E3-02
 * cela ne se produit plus — la ligne naît avec la variante —, et l'écran
 * n'affiche donc rien plutôt que d'inventer un zéro : un cas qui ne doit pas
 * arriver ne se maquille pas en cas normal.
 */
export async function stockLevelsFor(
  variantIds: readonly string[],
): Promise<Map<string, StockLevel>> {
  if (variantIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from('stock_level')
    .select(LEVEL_COLUMNS)
    .in('variant_id', [...variantIds])

  if (error !== null) throw new Error(error.message)

  return new Map(
    ((data ?? []) as LevelRow[]).map((row) => {
      const level = levelOf(row)
      return [level.variantId, level]
    }),
  )
}

/* Ce que la liste filtrée rend au plus — la même borne que la recherche. */
export const STOCK_FILTER_LIMIT = 50

interface EntryRow extends LevelRow {
  variant: {
    sku: string | null
    product: {
      id: string
      name_fr: string
      name_ar: string | null
      code: string | null
      photo_url: string | null
    } | null
  } | null
}

/**
 * Les variantes du commerce dont le stock est à zéro, ou négatif.
 *
 * **Un seul ordre, celui du serveur.** En négatif, le plus négatif d'abord :
 * c'est celui qu'on régularise en premier, et c'est aussi l'ordre de
 * `stock_level_negative`. À zéro, toutes les quantités sont égales et l'ordre
 * retombe sur `variant_id` — arbitraire, mais stable.
 *
 * Il serait plus agréable de trier par nom. Deux raisons de ne pas le faire :
 * l'ordre par nom traverserait deux jointures incorporées, que PostgREST ne
 * sert pas de façon fiable ; et un tri **côté appareil** sur les 50 lignes
 * reçues donnerait une liste « A, B, Z » d'où M serait absent sans que rien ne
 * le dise — le commerçant en conclurait que M va bien. Un ordre qui n'est pas
 * alphabétique rend la coupe visible ; l'écran l'annonce en plus.
 *
 * Les variantes et produits supprimés sont écartés, et les jointures sont
 * `!inner` : une ligne de stock dont le produit n'existe plus n'a rien à
 * montrer.
 */
export async function listByStockFilter(filter: StockFilter): Promise<StockEntry[]> {
  const base = supabase
    .from('stock_level')
    .select(
      `${LEVEL_COLUMNS},` +
        ' variant!inner(sku, deleted_at,' +
        ' product!inner(id, name_fr, name_ar, code, photo_url, deleted_at))',
    )
    .is('variant.deleted_at', null)
    .is('variant.product.deleted_at', null)

  const filtered = filter === 'zero' ? base.eq('quantity', 0) : base.lt('quantity', 0)

  const { data, error } = await filtered
    .order('quantity', { ascending: true })
    .order('variant_id', { ascending: true })
    .limit(STOCK_FILTER_LIMIT)

  if (error !== null) throw new Error(error.message)

  return ((data ?? []) as EntryRow[]).flatMap((row) => {
    const product = row.variant?.product
    if (product === null || product === undefined) return []
    return [
      {
        ...levelOf(row),
        productId: product.id,
        name: product.name_fr,
        nameAr: product.name_ar,
        code: product.code,
        sku: row.variant?.sku ?? null,
        photoPath: product.photo_url,
      },
    ]
  })
}
