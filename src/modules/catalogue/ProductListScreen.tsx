/*
 * La liste des produits, et leur recherche. M1 — E2-02, E2-04.
 *
 * Une seule source : `public.search_products()`. La requête vide rend les 50
 * premiers produits par ordre alphabétique ; une requête rend les 50 meilleurs
 * résultats, sur le nom français, le nom arabe, la référence, le SKU et le
 * code-barres — sans accents, à une faute près, sur référence partielle
 * (SPEC § 6, Recherche). L'écran n'en réimplémente rien : il envoie ce que le
 * vendeur tape, et affiche ce qui revient.
 *
 * Deux présentations, au choix du vendeur, gardé sur l'appareil : la liste, et
 * la grille photo — celle qu'on parcourt quand on ne sait pas écrire le nom
 * (BACKLOG E2-04, E4-03 : « sélection sur grille photo »).
 *
 * Lisible par tout le commerce (`view_catalogue`, les deux rôles, SPEC § 3.1).
 * La fiche et l'ajout sont réservés à `manage_product` : pour l'employé, les
 * lignes ne mènent nulle part et le bouton d'ajout n'existe pas. Le masquer est
 * un confort ; ce qui protège, ce sont les policies d'écriture de `product`.
 *
 * BRAND-UI § 8 : quatre états. Ligne de 64 px, photo au début de la ligne
 * (à droite en RTL, par les propriétés logiques), nom au-dessus, référence en
 * dessous. Champ de 56 px, libellé au-dessus. BRAND-UI § 7 : l'action
 * principale en bas, au pouce. BRAND-UI § 11 : aucun bouton sans texte.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { useCan } from '@/lib/auth'
import { signedPhotoUrls } from '@/modules/catalogue/photo'
import {
  Quantity,
  STOCK_FILTER_LIMIT,
  listByStockFilter,
  stockLevelsFor,
  type StockFilter,
  type StockLevel,
} from '@/modules/stock'
import { restoreProduct } from '@/modules/catalogue/products'
import {
  SEARCH_DELAY_MS,
  SEARCH_LIMIT,
  latestOnly,
  searchProducts,
  type SearchHit,
} from '@/modules/catalogue/search'

type View = 'list' | 'grid'

/* Le choix de présentation appartient à l'appareil, pas au compte. */
export const VIEW_STORAGE_KEY = 'merx.products.view'

function storedView(): View {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function storeView(view: View): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    // Un stockage refusé ne coûte que le souvenir du choix.
  }
}

/*
 * Ce que la liste montre : les résultats de la recherche, ou l'une des deux
 * questions de stock. **Une source par état** (E3-02).
 *
 * Les deux ne se combinent pas, et c'est une décision : croiser un texte avec
 * un filtre demanderait de replier les accents côté appareil pour recouper les
 * deux listes, donc une seconde copie de `merx.search_fold()` — et les deux
 * divergeraient sans que rien le dise. Un filtre actif remplace donc la
 * recherche, l'écran le dit, et « Tous les produits » y ramène.
 *
 * Le filtre porte sur **tout** le catalogue, pas sur les 50 résultats
 * affichés : « qu'est-ce qui est en négatif » n'a de sens que sur l'ensemble.
 */
type Source = 'search' | StockFilter

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'loaded'
      query: string
      hits: SearchHit[]
      photos: Map<string, string>
      levels: Map<string, StockLevel>
    }

/** Ce que la fiche transmet en revenant à la liste. */
export interface ProductListNavigation {
  saved?: string
  deleted?: { id: string; name: string }
}

interface Notice {
  text: string
  /** Le produit qu'« Annuler la suppression » rétablit. */
  undo?: { id: string; name: string }
}

function noticeOf(navigation: ProductListNavigation | null): Notice | null {
  if (navigation?.deleted !== undefined) {
    return { text: `« ${navigation.deleted.name} » supprimé.`, undo: navigation.deleted }
  }
  if (navigation?.saved !== undefined) return { text: `« ${navigation.saved} » enregistré.` }
  return null
}

/* La référence qu'on lit sous le nom : celle du produit, ou à défaut le SKU. */
function referenceOf(hit: SearchHit): string | null {
  return hit.code ?? hit.sku
}

function Skeleton({ view }: { view: View }) {
  if (view === 'grid') {
    return (
      <div aria-busy="true" aria-label="Chargement des produits" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="flex flex-col gap-2 rounded-card border border-paper-200 bg-white p-2">
            <div className="aspect-square w-full rounded-field bg-paper-100" />
            <div className="h-4 rounded-field bg-paper-100" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div aria-busy="true" aria-label="Chargement des produits" className="flex flex-col">
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="flex h-row items-center gap-4 border-b border-paper-200">
          <div className="size-12 shrink-0 rounded-field bg-paper-100" />
          <div className="h-4 flex-1 rounded-field bg-paper-100" />
        </div>
      ))}
    </div>
  )
}

/*
 * E11-02 : « photo produit systématique — ne jamais dépendre du seul texte ».
 * Sans photo, l'initiale tient la place : la colonne reste alignée, et la
 * ligne ne réclame rien.
 */
function Thumbnail({ url, name, size }: { url: string | undefined; name: string; size: 'row' | 'card' }) {
  const box = size === 'row' ? 'size-12 shrink-0' : 'aspect-square w-full'
  if (url !== undefined) {
    return <img src={url} alt="" className={`${box} rounded-field border border-paper-200 object-cover`} />
  }
  return (
    <div
      aria-hidden="true"
      className={`${box} flex items-center justify-center rounded-field bg-paper-100 text-paper-700 ${
        size === 'row' ? 'text-subtitle' : 'text-title'
      }`}
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  )
}

interface ItemProps {
  hit: SearchHit
  photoUrl: string | undefined
  editable: boolean
  /** Absent tant que la seconde lecture n'est pas revenue : la ligne n'invente rien. */
  level: StockLevel | undefined
}

/*
 * Où mène une ligne. Le patron va à la fiche, comme depuis E2-02 — c'est son
 * geste quotidien, et le stock y est à un lien de là. Le vendeur, qui ne peut
 * pas ouvrir la fiche (`manage_product`), va au stock : jusqu'ici la ligne ne
 * menait nulle part pour lui.
 */
function destinationOf(hit: SearchHit, editable: boolean): string {
  return editable ? `/products/${hit.productId}` : `/products/${hit.productId}/stock`
}

function ProductRow({ hit, photoUrl, editable, level }: ItemProps) {
  const reference = referenceOf(hit)

  return (
    <li className="border-b border-paper-200">
      <Link
        to={destinationOf(hit, editable)}
        className="flex min-h-row items-center gap-4 py-2"
      >
        <Thumbnail url={photoUrl} name={hit.name} size="row" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-subtitle text-paper-900">{hit.name}</p>
          {/* Une référence est une donnée : 16 px, chiffres tabulaires (BRAND-UI § 6). */}
          {reference !== null && (
            <p className="tabular truncate text-body text-paper-700">{reference}</p>
          )}
        </div>
        {/* BRAND-UI § 8 : le stock se lit au bord opposé, en chiffres tabulaires.
            Le négatif y est un repère, jamais un blocage (RÈGLE M2-3). */}
        {level !== undefined && (
          <span className="shrink-0">
            <Quantity level={level} />
          </span>
        )}
      </Link>
    </li>
  )
}

function ProductCard({ hit, photoUrl, editable, level }: ItemProps) {
  const reference = referenceOf(hit)

  return (
    <li className="rounded-card border border-paper-200 bg-white">
      <Link
        to={destinationOf(hit, editable)}
        className="flex h-full flex-col gap-2 p-2"
      >
        <Thumbnail url={photoUrl} name={hit.name} size="card" />
        <p className="line-clamp-2 text-body text-paper-900">{hit.name}</p>
        {reference !== null && (
          <p className="tabular truncate text-body text-paper-700">{reference}</p>
        )}
        {level !== undefined && <Quantity level={level} />}
      </Link>
    </li>
  )
}

/*
 * Les trois états de la liste. « Tous les produits » est la recherche ; les
 * deux autres sont les filtres du critère, et ils portent sur tout le
 * catalogue.
 *
 * Pas de troisième filtre : le critère en nomme deux. « Stock à zéro » rend
 * aussi bien le zéro compté que le stock jamais saisi — la question du vendeur
 * est « ai-je quelque chose à vendre », et la réponse est non dans les deux
 * cas. C'est la ligne qui dit de quelle sorte de non il s'agit, pas le filtre.
 */
const SOURCES: ReadonlyArray<readonly [Source, string]> = [
  ['search', 'Tous les produits'],
  ['zero', 'Stock à zéro'],
  ['negative', 'Stock négatif'],
]

function SourceSwitch({ source, onChange }: { source: Source; onChange: (next: Source) => void }) {
  return (
    <div role="group" aria-label="Filtrer le stock" className="flex flex-wrap gap-2">
      {SOURCES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={source === value}
          onClick={() => onChange(value)}
          className={
            source === value
              ? 'h-touch rounded-button bg-ink-600 px-4 text-body text-white'
              : 'h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'
          }
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const options: ReadonlyArray<readonly [View, string]> = [
    ['list', 'Liste'],
    ['grid', 'Grille photo'],
  ]
  return (
    <div role="group" aria-label="Présentation des produits" className="flex gap-2">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={
            view === value
              ? 'h-touch flex-1 rounded-button bg-ink-600 px-4 text-body text-white'
              : 'h-touch flex-1 rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700'
          }
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function ProductListScreen() {
  const location = useLocation()
  const canManage = useCan('manage_product')

  const [query, setQuery] = useState('')
  const [source, setSource] = useState<Source>('search')
  const [view, setView] = useState<View>(storedView)
  const [state, setState] = useState<State>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(() =>
    noticeOf(location.state as ProductListNavigation | null),
  )
  const [failure, setFailure] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  const search = useMemo(() => latestOnly(searchProducts), [])

  /*
   * Une recherche par saisie, après SEARCH_DELAY_MS sans frappe. Pendant la
   * frappe, les résultats précédents restent affichés : un écran qui clignote
   * à chaque touche se lit plus mal qu'une liste qui change une fois.
   *
   * Sous un filtre de stock, il n'y a rien à attendre — aucune frappe n'est en
   * cours — et la liste vient de `listByStockFilter()`, qui porte déjà sa
   * quantité : une seule lecture au lieu de deux.
   *
   * Les photos sont demandées après coup, dans les deux cas : elles sont
   * signées une par une et ne doivent pas retenir l'affichage des quantités.
   */
  useEffect(() => {
    const delay = source !== 'search' || query.trim() === '' ? 0 : SEARCH_DELAY_MS

    const timer = window.setTimeout(() => {
      const load = async (): Promise<{
        query: string
        hits: SearchHit[]
        levels: Map<string, StockLevel>
      } | null> => {
        if (source !== 'search') {
          const entries = await listByStockFilter(source)
          return {
            query: '',
            // Les mêmes champs que la recherche, pour que la ligne et la carte
            // ne connaissent qu'une seule forme. Le code-barres n'est pas lu
            // par cet écran : rien ne l'affiche.
            hits: entries.map((entry) => ({
              variantId: entry.variantId,
              productId: entry.productId,
              name: entry.name,
              nameAr: entry.nameAr,
              code: entry.code,
              sku: entry.sku,
              barcode: null,
              photoPath: entry.photoPath,
            })),
            levels: new Map(entries.map((entry) => [entry.variantId, entry])),
          }
        }

        const outcome = await search(query)
        if (!outcome.current) return null
        const hits = outcome.value
        return {
          query: query.trim(),
          hits,
          levels: await stockLevelsFor(hits.map((hit) => hit.variantId)),
        }
      }

      load()
        .then(async (loaded) => {
          if (loaded === null) return
          const { hits } = loaded
          setState({ status: 'loaded', ...loaded, photos: new Map() })

          const paths = [
            ...new Set(hits.map((h) => h.photoPath).filter((p): p is string => p !== null)),
          ]
          const photos = await signedPhotoUrls(paths)
          setState((current) =>
            current.status === 'loaded' && current.hits === hits ? { ...current, photos } : current,
          )
        })
        .catch((error: unknown) =>
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Chargement impossible.',
          }),
        )
    }, delay)

    return () => window.clearTimeout(timer)
  }, [query, source, attempt, search])

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const chooseView = (next: View): void => {
    setView(next)
    storeView(next)
  }

  const undo = async (product: { id: string; name: string }): Promise<void> => {
    if (restoring) return
    setFailure(null)
    setRestoring(true)
    try {
      await restoreProduct(product.id)
      setNotice({ text: `« ${product.name} » rétabli.` })
      retry()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'Rétablissement impossible.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    // Premier niveau : la hauteur de l'écran est celle de la barre d'onglets
    // (`TabLayout`), pas la sienne — sinon l'écran vide défilerait d'une barre.
    <main className="px-4 py-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <h1 className="text-title text-paper-900">Produits</h1>

        {notice !== null && (
          <div className="flex flex-col items-start gap-2">
            <p role="status" className="text-body text-paper-700">
              {notice.text}
            </p>
            {notice.undo !== undefined && (
              <button
                type="button"
                disabled={restoring}
                onClick={() => void undo(notice.undo!)}
                className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
              >
                Annuler la suppression
              </button>
            )}
          </div>
        )}

        {failure !== null && (
          <p role="alert" className="text-body text-red-600">
            {failure}
          </p>
        )}

        {/* Sous un filtre, la liste ne vient pas de la recherche : le champ
            n'aurait rien à filtrer, et le laisser là laisserait croire le
            contraire. « Tous les produits » le ramène. */}
        {source === 'search' && (
        <div className="flex flex-col gap-2">
          <label htmlFor="product-search" className="text-label text-paper-700">
            Rechercher un produit
          </label>
          {/* `dir="auto"` : le champ suit l'écriture tapée, arabe ou latine. */}
          <input
            id="product-search"
            type="search"
            dir="auto"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-field rounded-field border border-paper-300 bg-white px-4 text-body text-paper-900 focus-visible:border-ink-600"
          />
        </div>
        )}

        <SourceSwitch source={source} onChange={setSource} />

        <ViewSwitch view={view} onChange={chooseView} />

        {state.status === 'loading' && <Skeleton view={view} />}

        {state.status === 'error' && (
          <div className="flex flex-col items-start gap-4 rounded-card border border-red-500 bg-red-100 p-4">
            <p role="alert" className="text-body text-red-700">
              {state.message}
            </p>
            <button
              type="button"
              onClick={retry}
              className="h-touch rounded-button border border-paper-300 bg-white px-4 text-body text-ink-700"
            >
              Réessayer
            </button>
          </div>
        )}

        {state.status === 'loaded' && state.hits.length === 0 && (
          <div className="rounded-card border border-paper-200 bg-white p-6">
            <p className="text-body text-paper-700">
              {/* Un filtre vide est une bonne nouvelle, et se lit comme telle :
                  « aucun produit » laisserait croire à un catalogue vide. */}
              {source === 'zero'
                ? 'Aucun produit à zéro.'
                : source === 'negative'
                  ? 'Aucun stock négatif.'
                  : state.query !== ''
                    ? `Aucun produit ne correspond à « ${state.query} ».`
                    : canManage
                      ? 'Aucun produit. Ajoutez le premier.'
                      : 'Aucun produit pour l’instant.'}
            </p>
          </div>
        )}

        {state.status === 'loaded' && state.hits.length > 0 && (
          <>
            {view === 'list' ? (
              <ul className="flex flex-col">
                {state.hits.map((hit) => (
                  <ProductRow
                    key={hit.variantId}
                    hit={hit}
                    photoUrl={hit.photoPath === null ? undefined : state.photos.get(hit.photoPath)}
                    editable={canManage}
                    level={state.levels.get(hit.variantId)}
                  />
                ))}
              </ul>
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {state.hits.map((hit) => (
                  <ProductCard
                    key={hit.variantId}
                    hit={hit}
                    photoUrl={hit.photoPath === null ? undefined : state.photos.get(hit.photoPath)}
                    editable={canManage}
                    level={state.levels.get(hit.variantId)}
                  />
                ))}
              </ul>
            )}
            {state.hits.length === SEARCH_LIMIT && (
              <p className="text-body text-paper-700">
                {/* Sous un filtre, la liste n'est pas alphabétique : le plus
                    négatif d'abord. Le dire évite de lire la coupe comme un
                    inventaire complet. */}
                {source === 'negative'
                  ? `Les ${STOCK_FILTER_LIMIT} stocks les plus négatifs.`
                  : source === 'zero'
                    ? `${STOCK_FILTER_LIMIT} produits à zéro au plus. Il y en a peut-être d’autres.`
                    : state.query === ''
                      ? `Les ${SEARCH_LIMIT} premiers produits, par ordre alphabétique. Tapez pour chercher.`
                      : `Les ${SEARCH_LIMIT} meilleurs résultats. Précisez la recherche pour affiner.`}
              </p>
            )}
          </>
        )}

        {canManage && (
          <div className="flex flex-col gap-2">
            <Link
              to="/products/new"
              className="flex h-button items-center justify-center rounded-button bg-ink-600 text-body text-white hover:bg-ink-700 active:bg-ink-800"
            >
              Ajouter un produit
            </Link>
            {/* E2-05, point de rupture n° 1 : un commerçant arrive avec un
                fichier, pas avec 2 000 saisies. Secondaire, parce que l'ajout
                d'un produit reste le geste quotidien (BRAND-UI § 8). */}
            <Link
              to="/products/import"
              className="flex h-button items-center justify-center rounded-button border border-paper-300 bg-white text-body text-ink-700"
            >
              Importer un fichier
            </Link>
          </div>
        )}
      </div>
    </main>
  )
}
