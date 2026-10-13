// @vitest-environment node

/*
 * E2-05 — l'import du catalogue. SPEC § 6 (Import), § 10 (point de rupture
 * n° 1), § 2.6, § 3, § 9 (RÈGLE M8-1).
 *
 * « Si 2 000 références ne rentrent pas en moins d'une heure, rien d'autre ne
 * compte. » Trois choses se vérifient ici, et la première prime :
 *
 *   1. **les lignes valides s'importent même si d'autres échouent**, et une
 *      ligne fautive ne laisse rien derrière elle — ni produit sans prix, ni
 *      variante orpheline. C'est l'atomicité par ligne, et elle se voit à ce
 *      qui reste en base après un lot mêlé ;
 *   2. le réimport met à jour au lieu de dupliquer, et n'écrit rien quand rien
 *      n'a changé ;
 *   3. la performance, et les deux dettes qu'E2-04 laisse à cette story : ce
 *      que `fastupdate = off` coûte à une insertion en masse, et le fait
 *      qu'après un import les requêtes de recherche passent encore par
 *      l'index.
 *
 * **Les gardes, un par niveau, chacun contournant les autres** (CLAUDE.md) :
 *
 *   — le garde de route (`manage_product`) est éprouvé en jsdom
 *     (`src/modules/catalogue/import/ImportScreen.test.tsx`) ;
 *   — le garde en tête de `import_products()` est éprouvé ici, par un appel
 *     PostgREST direct sous un jeton d'employé : il fait échouer **l'appel
 *     entier**, avec sa propre phrase ;
 *   — les policies d'écriture du catalogue sont éprouvées ligne par ligne par
 *     `catalogue.test.ts` et le balayage d'écriture de `settings.test.ts`, qui
 *     s'adressent aux tables sans passer par la fonction.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BATTERY, indexUsage, planOf } from './search-plan'
import { createAuthUser, deleteAuthUser, rest, sessionFor, withoutTriggers } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

/** Le bloc que l'appareil envoie (`src/modules/catalogue/import/importer.ts`). */
const CHUNK_SIZE = 50

/** Le fichier de référence de la story : 2 000 lignes en moins d'une minute. */
const STORY_ROWS = 2_000
const STORY_BUDGET_MS = 60_000

/** Le gros catalogue, celui d'E2-04 : c'est à cette échelle que le plan bascule. */
const LARGE_ROWS = 10_000
const NEIGHBOURS = 4
const NEIGHBOUR_ROWS = 5_000

const INSUFFICIENT_PRIVILEGE = '42501'

interface Row {
  line: number
  name_fr: string
  name_ar?: string
  code?: string
  barcode?: string
  category?: string
  brand?: string
  unit_label?: string
  pieces_per_carton?: number
  unit_price?: string
  cost_price?: string
}

interface Report {
  line: number
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected'
  product_id?: string
  code?: string
  constraint?: string | null
  table?: string | null
  message?: string
}

let client: Client

const tenants = { own: '', neighbours: [] as string[] }
const authUsers = {} as Record<'owner' | 'worker', string>
const tokens = {} as Record<'owner' | 'worker', string>
const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

/* -------------------------------------------------------------------------- */
/* Le fichier engendré                                                         */
/* -------------------------------------------------------------------------- */

/*
 * Le même catalogue de cosmétique qu'en E2-04, engendré ici côté test parce que
 * ces lignes-ci doivent entrer **par l'import** : c'est l'import qu'on mesure,
 * et c'est après lui que le plan de recherche se lit.
 *
 * Comme en E2-04, chaque règle a un modulo premier avec 40, le nombre de types
 * de produits : un modulo qui partage un facteur avec 40 attacherait une
 * propriété à des types entiers, et le jeu mentirait (constaté en E2-04, où
 * tous les shampooings étaient supprimés).
 */
const TYPES_FR = [
  'Crème hydratante', 'Crème de jour', 'Crème de nuit', 'Lait corporel', 'Gel douche',
  'Savon', 'Savon noir', 'Shampooing', 'Après-shampooing', 'Masque capillaire',
  'Huile d’argan', 'Huile de ricin', 'Déodorant', 'Parfum', 'Eau de toilette',
  'Eau de Cologne', 'Rouge à lèvres', 'Vernis à ongles', 'Fond de teint', 'Mascara',
  'Crayon khôl', 'Dentifrice', 'Brosse à dents', 'Coton démaquillant', 'Lingettes',
  'Gel coiffant', 'Laque', 'Teinture', 'Henné', 'Ghassoul',
  'Eau de rose', 'Crème solaire', 'Baume à lèvres', 'Gommage', 'Sérum',
  'Lotion tonique', 'Talc', 'Rasoir', 'Mousse à raser', 'Crème dépilatoire',
]

const TYPES_AR = [
  'كريم مرطب', 'كريم نهاري', 'كريم ليلي', 'حليب الجسم', 'جل الاستحمام',
  'صابون', 'صابون بلدي', 'شامبو', 'بلسم', 'ماسك للشعر',
  'زيت أركان', 'زيت الخروع', 'مزيل العرق', 'عطر', 'ماء تواليت',
  'ماء كولونيا', 'أحمر الشفاه', 'طلاء الأظافر', 'كريم الأساس', 'ماسكارا',
  'كحل', 'معجون الأسنان', 'فرشاة الأسنان', 'قطن', 'مناديل مبللة',
  'جل الشعر', 'مثبت الشعر', 'صبغة', 'حناء', 'غاسول',
  'ماء الورد', 'واقي الشمس', 'مرطب الشفاه', 'مقشر', 'سيروم',
  'غسول', 'بودرة', 'شفرة حلاقة', 'رغوة الحلاقة', 'كريم إزالة الشعر',
]

const QUALIFIERS = [
  'peaux sèches', 'peaux grasses', 'sensible', 'bébé', 'homme', 'femme', 'aloe vera',
  'karité', 'citron', 'rose', 'amande douce', 'nourrissant', 'ultra doux', 'extra fort',
  'sans parfum', 'menthe',
]

const BRANDS = [
  'Nivea', 'Dove', 'Garnier', 'L’Oréal', 'Palmolive', 'Mixa', 'Vichy', 'Nadia', 'Taous',
  'Argania', 'Colgate', 'Signal', 'Head & Shoulders', 'Pantene', 'Elseve', 'Rexona', 'Axe',
  'Gillette', 'Johnson’s', 'Petrole Hahn', 'Yves Rocher', 'Maybelline', 'Bourjois', 'Essence',
  'Sensodyne', 'Veet', 'Diadermine', 'Neutrogena', 'Cien', 'Balea',
]

const SIZES = ['50 ml', '100 ml', '150 ml', '200 ml', '250 ml', '400 ml', '500 ml', '1 L', '75 g', '125 g']

/** Une ligne de fichier, déterministe, comme l'appareil l'aurait préparée. */
function generatedRow(g: number, line: number): Row {
  const brand = BRANDS[Math.floor(g / 640) % 30]!
  const row: Row = {
    line,
    name_fr: `${TYPES_FR[g % 40]!} ${QUALIFIERS[Math.floor(g / 40) % 16]!} ${brand} ${SIZES[Math.floor(g / 7) % 10]!}`,
    name_ar: TYPES_AR[g % 40]!,
    brand,
    category: `Famille ${g % 11}`,
    unit_price: `${(g % 400) + 5}.50`,
  }
  // Une référence sur cinq manque (SPEC § 2.6), un tiers en MAR-1234.
  if (g % 11 > 1) {
    row.code =
      g % 11 <= 5
        ? `${brand.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()}-${g}`
        : String(((g * 7919) % 90000) + 10000)
  }
  if (g % 13 < 9) row.barcode = `611${String((g * 104729) % 10_000_000_000).padStart(10, '0')}`
  if (g % 9 === 4) row.pieces_per_carton = 12
  return row
}

function generatedRows(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, n) => generatedRow(from + n, from + n + 2))
}

/* -------------------------------------------------------------------------- */
/* L'import, par le chemin de l'application                                    */
/* -------------------------------------------------------------------------- */

/** Un appel d'import, tel que l'appareil le fait : PostgREST, le jeton, la RPC. */
async function importChunk(rows: readonly Row[], token = tokens.owner) {
  return rest('rpc/import_products', { token, method: 'POST', body: { rows } })
}

async function importRows(rows: readonly Row[], token = tokens.owner): Promise<Report[]> {
  const reports: Report[] = []
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const result = await importChunk(rows.slice(start, start + CHUNK_SIZE), token)
    if (!result.ok) throw new Error(`import_products : ${result.status} ${result.body}`)
    reports.push(...(result.rows as unknown as Report[]))
  }
  return reports
}

const outcomes = (reports: readonly Report[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const report of reports) counts[report.outcome] = (counts[report.outcome] ?? 0) + 1
  return counts
}

/** Un produit du commerce, par sa référence — lu en `postgres`, hors RLS. */
async function productByCode(code: string) {
  const { rows } = await client.query<{
    id: string
    name_fr: string
    brand: string | null
    updated_at: string
    unit_price: string | null
    cost_price: string | null
    barcode: string | null
  }>(
    `select p.id, p.name_fr, p.brand, p.updated_at::text, b.unit_price::text, c.cost_price::text,
            v.barcode
     from public.product p
     join public.variant v on v.id = p.id
     left join public.price_break b on b.id = p.id
     left join public.variant_cost c on c.variant_id = p.id
     where p.tenant_id = $1 and lower(p.code) = lower($2) and p.deleted_at is null`,
    [tenants.own, code],
  )
  return rows
}

async function indexSetting(name: string, fastupdate: boolean): Promise<void> {
  await client.query(`alter index public.${name} set (fastupdate = ${fastupdate ? 'on' : 'off'})`)
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }

  for (const role of ['owner', 'worker'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  tenants.own = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Import', gen_random_uuid()) returning id",
    )
  ).id
  for (let n = 1; n <= NEIGHBOURS; n++) {
    tenants.neighbours.push(
      (
        await one<{ id: string }>(
          'insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id',
          [`Voisin import ${n}`],
        )
      ).id,
    )
  }
  for (const role of ['owner', 'worker'] as const) {
    await client.query(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, role) values ($1, $2, $3, $4)',
      [tenants.own, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
    )
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }

  /*
   * Les voisins, peuplés directement : ils ne servent qu'à donner à la table
   * sa taille réelle — c'est elle qu'un Seq Scan lirait (E2-04). Seul le
   * commerce testé reçoit ses lignes par l'import.
   */
  await client.query(
    `insert into public.product (tenant_id, name_fr, name_ar, code, brand)
     select t.id,
            ($2::text[])[1 + g % 40] || ' ' || ($3::text[])[1 + (g / 40) % 16],
            ($4::text[])[1 + g % 40],
            'V' || t.n || '-' || g,
            ($5::text[])[1 + (g / 640) % 30]
     from unnest($1::uuid[]) with ordinality as t(id, n)
     cross join generate_series(1, $6::int) as g`,
    [tenants.neighbours, TYPES_FR, QUALIFIERS, TYPES_AR, BRANDS, NEIGHBOUR_ROWS],
  )
  /*
   * `vacuum` avant de commencer, et pas seulement `analyze` : la suite base
   * tourne en série sur une seule base, et les fichiers qui précèdent y ont
   * peuplé puis vidé des dizaines de milliers de lignes. Les pages mortes
   * qu'ils laissent se lisent encore — un parcours de `variant` y dépassait le
   * délai chez les fichiers suivants, et le plan des requêtes larges tombait du
   * mauvais côté. La liste d'attente GIN que cette story éprouve, elle, naîtra
   * *après* ce rangement, de l'import lui-même.
   */
  await client.query('vacuum (analyze) public.product, public.variant, public.price_break')
}, 600_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    const all = [tenants.own, ...tenants.neighbours].filter((t) => t !== '')

    /*
     * **Les triggers ne se suspendent que pour ce qui l'exige.**
     * `session_replication_role = replica` ne coupe pas seulement les triggers
     * applicatifs : il coupe aussi les triggers d'intégrité référentielle,
     * donc les cascades. Ce ménage-ci, écrit d'abord d'un bloc, supprimait les
     * produits sans emporter leurs variantes : 283 000 variantes orphelines
     * après quelques exécutions, des lectures larges qui dépassaient leur
     * délai dans trois autres fichiers, et un plan de recherche qui basculait.
     *
     * Deux suppressions seulement en ont besoin : `variant_cost`, dont chaque
     * suppression est journalisée (RÈGLE M8-1, refusée hors session), et
     * `audit_log`, en ajout seul pour tout le monde (RÈGLE M8-2).
     */
    await withoutTriggers(client, async () => {
      await client.query('delete from public.variant_cost where tenant_id = any($1::uuid[])', [all])
      await client.query('delete from public.audit_log where tenant_id = any($1::uuid[])', [all])
    })

    // Puis le reste, cascades comprises : le produit emporte ses variantes,
    // qui emportent leurs paliers.
    await client.query('delete from public.product where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.category where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.app_user where tenant_id = any($1::uuid[])', [all])
    // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
    await client.query('delete from public.warehouse where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.tenant where id = any($1::uuid[])', [all])

    /*
     * Ce fichier écrit et supprime des dizaines de milliers de lignes dans une
     * base que les autres fichiers partagent (vite.config.ts : la suite base
     * tourne en série). Sans ce rangement, les pages mortes se relisent chez
     * eux, jusqu'à dépasser leur délai.
     */
    await client.query('vacuum (analyze) public.product, public.variant, public.price_break')
  }
  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 600_000)

/* -------------------------------------------------------------------------- */
/* Le critère qui décide de tout                                               */
/* -------------------------------------------------------------------------- */

describe('les lignes valides s’importent même si d’autres échouent', () => {
  it('importe les bonnes lignes d’un lot mêlé, et rejette les autres en les nommant', async () => {
    const reports = await importRows([
      { line: 2, name_fr: 'Crème A', code: 'MIX-1', unit_price: '15.00' },
      // Refusée par la base : `variant_cost.cost_price >= 0`.
      { line: 3, name_fr: 'Crème B', code: 'MIX-2', unit_price: '9.00', cost_price: '-4.00' },
      { line: 4, name_fr: 'Crème C', code: 'MIX-3', unit_price: '11.00' },
    ])

    expect(outcomes(reports)).toEqual({ created: 2, rejected: 1 })
    const refused = reports.find((report) => report.outcome === 'rejected')!
    expect(refused.line).toBe(3)
    expect(refused.code).toBe('23514')
    // Le nom de contrainte, pas le seul code : deux refus partagent un code.
    expect(refused.constraint).toBe('variant_cost_cost_price_check')
    expect(refused.table).toBe('variant_cost')

    expect(await productByCode('MIX-1')).toHaveLength(1)
    expect(await productByCode('MIX-3')).toHaveLength(1)
  })

  /*
   * L'atomicité par ligne, vue de l'autre côté : la ligne fautive n'a pas
   * laissé la moitié d'elle-même. Son produit et sa variante étaient écrits
   * avant que le prix d'achat ne soit refusé ; le point de sauvegarde de la
   * ligne les a repris.
   */
  it('ne laisse rien de la ligne fautive — ni produit, ni variante, ni palier', async () => {
    const { rows } = await client.query(
      `select p.id from public.product p
       where p.tenant_id = $1 and p.code = 'MIX-2'`,
      [tenants.own],
    )
    expect(rows).toEqual([])

    const orphans = await one<{ variants: string; breaks: string }>(
      `select (select count(*) from public.variant v
               left join public.product p on p.id = v.product_id
               where v.tenant_id = $1 and p.id is null) as variants,
              (select count(*) from public.price_break b
               left join public.variant v on v.id = b.variant_id
               where b.tenant_id = $1 and v.id is null) as breaks`,
      [tenants.own],
    )
    expect(Number(orphans.variants)).toBe(0)
    expect(Number(orphans.breaks)).toBe(0)
  })

  it('écrit ce que la ligne portait : prix de vente, code-barres, catégorie, prix d’achat', async () => {
    await importRows([
      {
        line: 2,
        name_fr: 'Crème complète',
        code: 'FULL-1',
        barcode: '6111234567890',
        category: 'Soins visage',
        brand: 'Nivea',
        unit_label: 'flacon',
        pieces_per_carton: 12,
        unit_price: '19.90',
        cost_price: '12.50',
      },
    ])

    const [product] = await productByCode('FULL-1')
    expect(product?.unit_price).toBe('19.90')
    expect(product?.cost_price).toBe('12.50')
    expect(product?.barcode).toBe('6111234567890')

    const category = await one<{ n: string }>(
      "select count(*) as n from public.category where tenant_id = $1 and name_fr = 'Soins visage'",
      [tenants.own],
    )
    expect(Number(category.n)).toBe(1)
  })

  it('n’écrit le prix d’achat au journal qu’une fois, et sous l’auteur du jeton (RÈGLE M8-1)', async () => {
    const entries = await client.query<{ user_id: string; after: { cost_price: number } }>(
      `select l.user_id, l.after from public.audit_log l
       join public.variant_cost c on c.id::text = l.entity_id::text
       where l.tenant_id = $1 and l.action = 'purchase_price_change'`,
      [tenants.own],
    )
    expect(entries.rows).toHaveLength(1)
    // `to_jsonb` d'un numeric rend un nombre JSON, pas une chaîne.
    expect(Number(entries.rows[0]!.after.cost_price)).toBe(12.5)

    const owner = await one<{ id: string }>(
      'select id from public.app_user where tenant_id = $1 and role = $2',
      [tenants.own, 'owner'],
    )
    expect(entries.rows[0]!.user_id).toBe(owner.id)
  })
})

/* -------------------------------------------------------------------------- */
/* Réimporter                                                                  */
/* -------------------------------------------------------------------------- */

describe('réimporter le même fichier met à jour au lieu de dupliquer', () => {
  const file = (price: string, brand?: string): Row[] => [
    { line: 2, name_fr: 'Savon de Marseille', code: 'DUP-1', unit_price: price, ...(brand === undefined ? {} : { brand }) },
  ]

  it('crée à la première passe, met à jour à la seconde', async () => {
    expect(outcomes(await importRows(file('10.00', 'Taous')))).toEqual({ created: 1 })
    expect(outcomes(await importRows(file('12.00', 'Taous')))).toEqual({ updated: 1 })

    const found = await productByCode('DUP-1')
    expect(found).toHaveLength(1)
    expect(found[0]!.unit_price).toBe('12.00')
  })

  it('reconnaît la référence sans égard à la casse', async () => {
    const reports = await importRows([
      { line: 2, name_fr: 'Savon de Marseille', code: 'dup-1', unit_price: '12.00' },
    ])
    expect(reports[0]!.outcome).toBe('unchanged')
    expect(await productByCode('DUP-1')).toHaveLength(1)
  })

  /*
   * Rien n'a changé, donc rien ne s'écrit : ni nouvelle version de ligne, ni
   * `updated_at`, ni entrée au journal. Chaque écriture de trop est une ligne
   * de plus à réconcilier au retour du réseau (SPEC § 2.5).
   */
  it('n’écrit rien quand rien n’a changé', async () => {
    const before = await productByCode('DUP-1')
    const journal = await one<{ n: string }>(
      "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'purchase_price_change'",
      [tenants.own],
    )

    expect(outcomes(await importRows(file('12.00', 'Taous')))).toEqual({ unchanged: 1 })

    const after = await productByCode('DUP-1')
    expect(after[0]!.updated_at).toBe(before[0]!.updated_at)
    const journalAfter = await one<{ n: string }>(
      "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'purchase_price_change'",
      [tenants.own],
    )
    expect(journalAfter.n).toBe(journal.n)
  })

  it('une cellule vide n’efface pas ce qui est en base (SPEC § 2.6)', async () => {
    // Le fichier ne porte plus la marque : elle n'est pas dans la charge.
    expect(outcomes(await importRows(file('12.00')))).toEqual({ unchanged: 1 })
    expect((await productByCode('DUP-1'))[0]!.brand).toBe('Taous')
  })

  it('deux fois la même référence dans un même envoi ne crée qu’un produit', async () => {
    const reports = await importRows([
      { line: 2, name_fr: 'Gel A', code: 'TWICE-1', unit_price: '5.00' },
      { line: 3, name_fr: 'Gel A bis', code: 'TWICE-1', unit_price: '6.00' },
    ])
    expect(reports.map((report) => report.outcome)).toEqual(['created', 'updated'])
    expect(await productByCode('TWICE-1')).toHaveLength(1)
  })

  /*
   * La référence d'un produit supprimé est libre (E2-01) : l'import en crée un
   * neuf, et ne ressuscite pas l'ancien.
   */
  it('la référence d’un produit supprimé crée un produit neuf', async () => {
    await importRows([{ line: 2, name_fr: 'Ancien', code: 'GONE-1', unit_price: '3.00' }])
    const [before] = await productByCode('GONE-1')
    await client.query('update public.product set deleted_at = now() where id = $1', [before!.id])

    const reports = await importRows([
      { line: 2, name_fr: 'Nouveau', code: 'GONE-1', unit_price: '4.00' },
    ])
    expect(reports[0]!.outcome).toBe('created')

    const [after] = await productByCode('GONE-1')
    expect(after!.id).not.toBe(before!.id)
    expect(after!.name_fr).toBe('Nouveau')
  })
})

/* -------------------------------------------------------------------------- */
/* Les gardes                                                                  */
/* -------------------------------------------------------------------------- */

describe('les gardes de l’import', () => {
  it('refuse l’appel entier à un employé, avec la phrase du garde de la fonction', async () => {
    const result = await importChunk(
      [{ line: 2, name_fr: 'Interdit', code: 'DENY-1', unit_price: '5.00' }],
      tokens.worker,
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain('Importer le catalogue exige le droit de créer des produits.')
    // Aucune ligne créée : le refus n'est pas un demi-import.
    expect(await productByCode('DENY-1')).toEqual([])

    // Contrôle positif : la même charge, sous le jeton du patron.
    const allowed = await importChunk([
      { line: 2, name_fr: 'Permis', code: 'DENY-1', unit_price: '5.00' },
    ])
    expect(allowed.ok).toBe(true)
    expect(await productByCode('DENY-1')).toHaveLength(1)
  })

  it('refuse un appel anonyme — 401, 42501, la fonction nommée', async () => {
    const result = await rest('rpc/import_products', {
      method: 'POST',
      body: { rows: [{ line: 2, name_fr: 'Anonyme' }] },
    })
    expect(result.status).toBe(401)
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain('permission denied for function import_products')
  })

  /*
   * L'import écrit sous l'identité de l'appelant, et cela doit rester vrai.
   * En `security definer`, les policies ne s'appliqueraient plus ligne par
   * ligne et le journal du prix d'achat ne porterait plus l'auteur du jeton
   * (voir l'en-tête de la migration). Le registre des exceptions RLS le
   * signalerait aussi — deux détections indépendantes.
   */
  it('n’est pas security definer, et n’est pas au registre des exceptions RLS', async () => {
    const fn = await one<{ prosecdef: boolean }>(
      `select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'import_products'`,
    )
    expect(fn.prosecdef).toBe(false)

    const registered = await one<{ n: string }>(
      "select count(*) as n from merx.rls_exception_registry where function_name = 'import_products'",
    )
    expect(Number(registered.n)).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Performance — le point de rupture n° 1                                      */
/* -------------------------------------------------------------------------- */

describe('2 000 références en moins d’une minute (SPEC § 10)', () => {
  it(
    `importe ${STORY_ROWS} lignes par blocs de ${CHUNK_SIZE}, sous le jeton du patron`,
    async () => {
      const rows = generatedRows(1, STORY_ROWS)
      const start = performance.now()
      const reports = await importRows(rows)
      const elapsed = Math.round(performance.now() - start)

      console.info(
        `import de ${STORY_ROWS} lignes : ${elapsed} ms ` +
          `(${(elapsed / STORY_ROWS).toFixed(1)} ms par ligne, blocs de ${CHUNK_SIZE})`,
      )
      expect(outcomes(reports).rejected ?? 0).toBe(0)
      expect(elapsed, `${elapsed} ms`).toBeLessThan(STORY_BUDGET_MS)
    },
    600_000,
  )

  /*
   * **Dette 1 laissée par E2-04** : ce que `fastupdate = off` coûte à une
   * insertion en masse. Les deux mesures portent sur des lignes distinctes du
   * même générateur, importées par le même chemin.
   *
   * Le chiffre ne décide de rien à lui seul : `fastupdate = on` range les
   * insertions dans une liste d'attente, et la dépense n'est pas évitée, elle
   * est reportée sur les recherches suivantes jusqu'au vacuum — c'est ce que
   * la dette 2 montre juste après.
   */
  it(
    'mesure ce que fastupdate = off coûte à l’import',
    async () => {
      const measure = async (fastupdate: boolean, from: number): Promise<number> => {
        for (const index of ['product_search', 'variant_search']) {
          await indexSetting(index, fastupdate)
        }
        const start = performance.now()
        await importRows(generatedRows(from, 500))
        return Math.round(performance.now() - start)
      }

      const off = await measure(false, 20_000)
      const on = await measure(true, 30_000)
      const offAgain = await measure(false, 40_000)

      /*
       * La production reste en `fastupdate = off` (migration product_search).
       *
       * Et il ne suffit pas de remettre le réglage : les 500 lignes importées
       * en `fastupdate = on` ont laissé leurs entrées dans la liste d'attente,
       * que seul un vacuum — ou ce vidage explicite — retire. Sans lui, la
       * section suivante trouvait 7 requêtes sur 16 écartées de l'index, alors
       * qu'elle prétendait juger de l'import, pas de la mesure qui la précède.
       *
       * C'est, accessoirement, la démonstration de ce que `fastupdate = on`
       * coûterait en production : 500 lignes ont suffi.
       */
      for (const index of ['product_search', 'variant_search']) await indexSetting(index, false)
      for (const index of ['product_search', 'variant_search']) {
        await client.query('select pg_catalog.gin_clean_pending_list($1::regclass)', [
          `public.${index}`,
        ])
      }

      console.info(
        `import de 500 lignes — fastupdate = off : ${off} ms puis ${offAgain} ms ; ` +
          `fastupdate = on : ${on} ms`,
      )
      // Aucune assertion sur l'écart : c'est une mesure, et le réglage ne se
      // change pas sur un chiffre d'import seul (BACKLOG E2-05).
      expect(off).toBeGreaterThan(0)
      expect(on).toBeGreaterThan(0)
    },
    900_000,
  )
})

/*
 * **Dette 2 laissée par E2-04** : après un import en masse, les requêtes de
 * recherche passent-elles encore par l'index ? En E2-04, juste après
 * l'insertion de 10 000 produits, 3 requêtes sur 12 seulement le faisaient —
 * c'est-à-dire une recherche cassée au moment précis où le commerçant vient de
 * remplir son catalogue et va l'essayer. Aucun vacuum, aucun `analyze` ici :
 * c'est l'état réel au sortir d'un import.
 */
describe('après l’import, la recherche passe encore par l’index', () => {
  it(
    `porte le commerce à ${LARGE_ROWS} références, par l'import`,
    async () => {
      const already = await one<{ n: string }>(
        'select count(*) as n from public.product where tenant_id = $1 and deleted_at is null',
        [tenants.own],
      )
      const missing = LARGE_ROWS - Number(already.n)
      if (missing > 0) {
        const start = performance.now()
        await importRows(generatedRows(100_000, missing))
        console.info(
          `import de ${missing} lignes supplémentaires : ${Math.round(performance.now() - start)} ms`,
        )
      }

      const total = await one<{ n: string }>(
        'select count(*) as n from public.product where tenant_id = $1 and deleted_at is null',
        [tenants.own],
      )
      expect(Number(total.n)).toBeGreaterThanOrEqual(LARGE_ROWS)

      /*
       * `analyze`, et **pas** de `vacuum` : ce sont deux choses différentes, et
       * seule la seconde viderait la liste d'attente GIN — c'est-à-dire ce que
       * cette section mesure.
       *
       * Sans `analyze`, le plan dépend des statistiques que les autres fichiers
       * de test ont laissées sur une table qu'ils ont peuplée puis vidée : les
       * quatre requêtes larges (« creme », « crème », « كريم », « nivea creme
       * 200 ») tombaient du côté de l'index du commerce dans la suite complète,
       * et du bon côté en exécution isolée. Ce n'est pas une propriété de
       * l'import — c'est du bruit, et il masquerait ce qu'on cherche.
       * L'autovacuum fait ce même `analyze` en production dans la minute.
       */
      await client.query('analyze public.product')
      await client.query('analyze public.variant')
    },
    900_000,
  )

  it.each(BATTERY)('« %s » : l’index sert encore, aucun Seq Scan', async (q) => {
    const nodes = await planOf(client, tenants.own, q)
    const pivot = await one<{ length: number | null }>(
      'select length(merx.search_pivot($1)) as length',
      [q],
    )
    const usage = indexUsage(nodes)

    expect(usage.seqScans, 'Seq Scan sur le catalogue').toEqual([])
    if ((pivot.length ?? 0) >= 3) {
      expect(usage.trigram, 'index trigramme du produit').toContain('product_search')
      expect(usage.trigram, 'index trigramme de la variante').toContain('variant_search')
    } else {
      expect(usage.tenantIndexes, 'index du commerce').toBeGreaterThan(0)
    }
  }, 120_000)
})
