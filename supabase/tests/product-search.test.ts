// @vitest-environment node

/*
 * E2-04 — la recherche produit. SPEC § 2.1 (exception nommée), § 6
 * (Recherche), § 10 (point de rupture n° 4).
 *
 * Deux parties, sur un même jeu :
 *
 *   — le comportement : chaque champ cherché, chaque règle de pliage, la
 *     tolérance aux fautes, la référence partielle, le classement, et les
 *     gardes. Chaque assertion négative a son contrôle positif à côté ;
 *   — la performance : le plan d'exécution du vrai appel, puis le chronomètre.
 *
 * Le jeu est réaliste parce qu'un petit jeu ne prouve rien : sur trois
 * produits, un Seq Scan est aussi rapide qu'un index. 10 000 produits dans le
 * commerce testé, et 40 000 chez quatre voisins — la table réelle contient
 * tous les commerces, et c'est elle qu'un Seq Scan lirait. Le générateur est
 * déterministe : même forme à chaque exécution.
 *
 * **L'assertion qui compte est celle du plan.** À 10 000 lignes en local, un
 * chronomètre passe même sans index (mesuré : 417 à 472 ms pour un Seq Scan
 * sur les 50 000 lignes — sous le seuil de 300 ms pour un seul commerce plus
 * petit). Le plan est lu par `auto_explain`, sur l'appel réel de
 * `search_products()` : c'est le plan de la requête que la fonction exécute,
 * pas celui d'une copie. `auto_explain` ne se charge pas par `LOAD` sur ce
 * stack (refusé par supautils), mais il est préchargé, et ses réglages
 * s'appliquent par `SET`. S'il ne rend aucun plan, le test échoue en le
 * disant — il ne se replie sur rien.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { actAs, tokenFor } from './isolation'
import { BATTERY, indexUsage, planOf } from './search-plan'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

const PER_TENANT = 10_000
const NEIGHBOURS = 4
const BUDGET_MS = 300
const RUNS = 5

const INSUFFICIENT_PRIVILEGE = '42501'

/* Ce que la fonction rend, et rien d'autre : aucun coût (SPEC § 3). */
const COLUMNS = [
  'barcode',
  'code',
  'name_ar',
  'name_fr',
  'photo_url',
  'product_id',
  'sku',
  'variant_id',
]

interface Hit {
  variant_id: string
  product_id: string
  name_fr: string
  name_ar: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  photo_url: string | null
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }
  return client
}

let client: Client

const tenants = { own: '', neighbours: [] as string[] }

/*
 * Les aiguilles. Chaque terme cherché n'existe que dans le champ qu'il éprouve,
 * et nulle part dans le jeu engendré.
 *
 *   zephyrine — nom français accentué, nom arabe avec voyelles brèves,
 *               référence, SKU divergent de la référence, code-barres ; une
 *               seconde variante supprimée ;
 *   qasbah    — nom arabe avec alif hamza dessous et ta marbuta, référence 4512 ;
 *   xylandre  — produit supprimé ;
 *   underscore, lookalike — « ZB_12 » et « ZBX12 », pour le `_` littéral ;
 *   twin      — chez un voisin, le même nom et la même référence que zephyrine.
 */
const needles = {
  zephyrine: '',
  zephyrineDeleted: '',
  qasbah: '',
  apricot: '',
  xylandre: '',
  vasteline: '',
  underscore: '',
  lookalike: '',
  twin: '',
}

const authUsers = {} as Record<'owner' | 'worker' | 'stranger', string>
const tokens = {} as Record<'owner' | 'worker' | 'stranger', string>
const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
  stranger: `stranger-${crypto.randomUUID()}@merx.test`,
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

/* -------------------------------------------------------------------------- */
/* Le jeu engendré                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Un catalogue de cosmétique tel qu'un grossiste de Derb Omar le tient :
 * 40 types de produits en français accentué et leur nom arabe — environ un sur
 * cinq avec voyelles brèves, formes d'alif mêlées —, 16 qualificatifs, 30
 * marques, 10 contenances. Références : environ une sur cinq absente (SPEC
 * § 2.6), un tiers en `MAR-1234`, le reste en nombre à cinq chiffres. Sept
 * produits sur dix environ portent un EAN-13 marocain (611). Un sur dix-sept a
 * une seconde variante, un sur dix-neuf est supprimé.
 *
 * Tout dérive de `g`, le rang du produit : l'identifiant aussi, pour que les
 * écritures qui suivent l'insertion retrouvent leurs lignes sans les chercher.
 *
 * **Chaque règle a un modulo premier avec 40**, le nombre de types. Avec
 * `g % 20 = 7` pour les suppressions, tous les produits du type n° 8
 * — Shampooing, شامبو — étaient supprimés, et « شمبو » ne trouvait rien : le
 * jeu mentait, pas la recherche (constaté en E2-04). Un modulo qui partage un
 * facteur avec 40 attache une propriété à des types entiers.
 */
const SEED_TABLE = `
  create temporary table search_seed as
  select t.id as tenant_id, t.n::int as n, g,
         md5(t.id::text || ':' || g)::uuid as product_id
  from unnest($1::uuid[]) with ordinality as t(id, n)
  cross join generate_series(1, $2::int) as g
`

const BRANDS = `array['Nivea','Dove','Garnier','L''Oréal','Palmolive','Mixa','Vichy','Nadia','Taous','Argania','Colgate','Signal','Head & Shoulders','Pantene','Elseve','Rexona','Axe','Gillette','Johnson''s','Petrole Hahn','Yves Rocher','Maybelline','Bourjois','Essence','Sensodyne','Veet','Diadermine','Neutrogena','Cien','Balea']`

const SEED_PRODUCTS = `
  insert into public.product (id, tenant_id, name_fr, name_ar, code, brand)
  select s.product_id, s.tenant_id,
         (array['Crème hydratante','Crème de jour','Crème de nuit','Lait corporel','Gel douche','Savon','Savon noir','Shampooing','Après-shampooing','Masque capillaire','Huile d''argan','Huile de ricin','Déodorant','Parfum','Eau de toilette','Eau de Cologne','Rouge à lèvres','Vernis à ongles','Fond de teint','Mascara','Crayon khôl','Dentifrice','Brosse à dents','Coton démaquillant','Lingettes','Gel coiffant','Laque','Teinture','Henné','Ghassoul','Eau de rose','Crème solaire','Baume à lèvres','Gommage','Sérum','Lotion tonique','Talc','Rasoir','Mousse à raser','Crème dépilatoire'])[1 + s.g % 40]
           || ' ' || (array['peaux sèches','peaux grasses','sensible','bébé','homme','femme','aloe vera','karité','citron','rose','amande douce','nourrissant','ultra doux','extra fort','sans parfum','menthe'])[1 + (s.g / 40) % 16]
           || ' ' || (${BRANDS})[1 + (s.g / 640) % 30]
           || ' ' || (array['50 ml','100 ml','150 ml','200 ml','250 ml','400 ml','500 ml','1 L','75 g','125 g'])[1 + (s.g / 7) % 10],
         case when s.g % 23 < 5
              then regexp_replace(ar.name, '([^ ])', '\\1' || chr(1614), 'g')
              else ar.name end,
         case
           when s.g % 11 in (0, 1) then null
           when s.g % 11 between 2 and 5
             then upper(left(regexp_replace((${BRANDS})[1 + (s.g / 640) % 30], '[^A-Za-z]', '', 'g'), 3)) || '-' || s.g
           else ((s.g * 7919) % 90000 + 10000)::text
         end,
         (${BRANDS})[1 + (s.g / 640) % 30]
  from search_seed s
  cross join lateral (
    select (array['كريم مرطب','كريم نهاري','كريم ليلي','حليب الجسم','جل الاستحمام','صابون','صابون بلدي','شامبو','بلسم','ماسك للشعر','زيت أركان','زيت الخروع','مزيل العرق','عطر','ماء تواليت','ماء كولونيا','أحمر الشفاه','طلاء الأظافر','كريم الأساس','ماسكارا','كحل','معجون الأسنان','فرشاة الأسنان','قطن','مناديل مبللة','جل الشعر','مثبت الشعر','صبغة','حناء','غاسول','ماء الورد','واقي الشمس','مرطب الشفاه','مقشر','سيروم','غسول','بودرة','شفرة حلاقة','رغوة الحلاقة','كريم إزالة الشعر'])[1 + s.g % 40] as name
  ) ar
`

const SEED_BARCODES = `
  update public.variant v
  set barcode = '611' || lpad(((s.g::bigint * 104729 + s.n * 7) % 10000000000)::text, 10, '0')
  from search_seed s
  where v.id = s.product_id and s.g % 13 < 9
`

const SEED_SECOND_VARIANTS = `
  insert into public.variant (tenant_id, product_id, sku)
  select s.tenant_id, s.product_id, coalesce(p.code, 'V' || left(md5(p.id::text), 10)) || '-B'
  from search_seed s
  join public.product p on p.id = s.product_id
  where s.g % 17 = 3
`

const SEED_DELETIONS = `
  update public.product p
  set deleted_at = now()
  from search_seed s
  where p.id = s.product_id and s.g % 19 = 7
`

async function insertProduct(
  tenant: string,
  fields: { name_fr: string; name_ar?: string; code?: string },
): Promise<string> {
  return (
    await one<{ id: string }>(
      `insert into public.product (tenant_id, name_fr, name_ar, code) values ($1, $2, $3, $4)
       returning id`,
      [tenant, fields.name_fr, fields.name_ar ?? null, fields.code ?? null],
    )
  ).id
}

beforeAll(async () => {
  client = await connect()

  for (const role of ['owner', 'worker', 'stranger'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  tenants.own = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Recherche', gen_random_uuid()) returning id",
    )
  ).id
  for (let n = 1; n <= NEIGHBOURS; n++) {
    tenants.neighbours.push(
      (
        await one<{ id: string }>(
          "insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id",
          [`Voisin ${n}`],
        )
      ).id,
    )
  }
  for (const role of ['owner', 'worker'] as const) {
    await client.query(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role) values ($1, $2, $3, $4)`,
      [tenants.own, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
    )
  }
  // `stranger` n'a aucune fiche : son jeton ne porte aucun commerce.

  await client.query(SEED_TABLE, [[tenants.own, ...tenants.neighbours], PER_TENANT])
  await client.query(SEED_PRODUCTS)
  await client.query(SEED_BARCODES)
  await client.query(SEED_SECOND_VARIANTS)
  await client.query(SEED_DELETIONS)
  await client.query('drop table search_seed')

  needles.zephyrine = await insertProduct(tenants.own, {
    name_fr: 'Crème Zéphyrine au karité',
    name_ar: 'مَرْهَمُ الزَّعْفَرَانِ',
    code: 'QX-7731',
  })
  // Un SKU qui a divergé de la référence : chaque champ se cherche seul.
  await client.query(
    "update public.variant set sku = 'KT-5520', barcode = '6119988776655' where id = $1",
    [needles.zephyrine],
  )
  needles.zephyrineDeleted = (
    await one<{ id: string }>(
      `insert into public.variant (tenant_id, product_id, sku, deleted_at)
       values ($1, $2, 'KT-9900', now()) returning id`,
      [tenants.own, needles.zephyrine],
    )
  ).id

  needles.qasbah = await insertProduct(tenants.own, {
    name_fr: 'Élixir Qasbah',
    name_ar: 'إكسير القصبة',
    code: '4512',
  })
  /*
   * La rivale de 4512 : sa référence commence par 4512 et son nom passe avant
   * « Élixir Qasbah » par ordre alphabétique. Sans le rang de la référence
   * exacte, c'est elle qui sortirait en premier pour « 4512 » (sabotage E2-04 :
   * sans elle, retirer ce rang ne changeait rien).
   */
  needles.apricot = await insertProduct(tenants.own, { name_fr: 'Abricot Orvane', code: '45129' })

  needles.xylandre = await insertProduct(tenants.own, { name_fr: 'Lotion Xylandre', code: 'XY-3301' })
  await client.query('update public.product set deleted_at = now() where id = $1', [needles.xylandre])
  needles.vasteline = await insertProduct(tenants.own, { name_fr: 'Onguent Vasteline', code: 'VS-2210' })
  needles.underscore = await insertProduct(tenants.own, { name_fr: 'Pastille Orvane', code: 'ZB_12' })
  needles.lookalike = await insertProduct(tenants.own, { name_fr: 'Pastille Orvane bis', code: 'ZBX12' })

  needles.twin = await insertProduct(tenants.neighbours[0]!, {
    name_fr: 'Crème Zéphyrine au karité',
    name_ar: 'مَرْهَمُ الزَّعْفَرَانِ',
    code: 'QX-7731',
  })

  await client.query('analyze public.product')
  await client.query('analyze public.variant')

  for (const role of ['owner', 'worker', 'stranger'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 300_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    const all = [tenants.own, ...tenants.neighbours].filter((t) => t !== '')
    // La cascade emporte variantes et paliers.
    await client.query('delete from public.product where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.app_user where tenant_id = any($1::uuid[])', [all])
    // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
    await client.query('delete from public.warehouse where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.tenant where id = any($1::uuid[])', [all])
    /*
     * 50 000 produits supprimés laissent autant de pages mortes, et la suite
     * base tourne en série : les fichiers suivants les reliraient à chaque
     * lecture large, jusqu'à dépasser leur délai (constaté en E2-05).
     */
    await client.query('vacuum (analyze) public.product, public.variant, public.price_break')
  }
  for (const role of ['owner', 'worker', 'stranger'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 300_000)

/* -------------------------------------------------------------------------- */
/* Outils                                                                      */
/* -------------------------------------------------------------------------- */

/** Une recherche, par le chemin de l'application : PostgREST, le jeton, la RPC. */
async function search(q: string, token: string = tokens.worker): Promise<Hit[]> {
  const result = await rest('rpc/search_products', { token, method: 'POST', body: { q } })
  if (!result.ok) throw new Error(`search_products(« ${q} ») : ${result.status} ${result.body}`)
  return result.rows as unknown as Hit[]
}

const productIds = (hits: readonly Hit[]): string[] => hits.map((h) => h.product_id)
const variantIds = (hits: readonly Hit[]): string[] => hits.map((h) => h.variant_id)

/** La forme comparable, côté test : minuscules, sans accents latins. */
const folded = (text: string | null): string =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/* -------------------------------------------------------------------------- */
/* Comportement                                                                */
/* -------------------------------------------------------------------------- */

describe('recherche simultanée sur les cinq champs', () => {
  it.each([
    ['le nom français', 'zephyrine'],
    ['le nom arabe', 'زعفران'],
    ['la référence', 'qx-77'],
    ['le SKU', 'kt-552'],
    ['le code-barres', '99887766'],
  ])('trouve un produit par %s seul', async (_field, term) => {
    const hits = await search(term)
    expect(hits[0]?.variant_id).toBe(needles.zephyrine)
  })

  it('ne trouve rien pour un terme qui n’est nulle part — contrôle des cinq précédents', async () => {
    expect(await search('zzqx')).toEqual([])
  })

  it('exige chaque mot de la requête', async () => {
    expect(productIds(await search('zephyrine karite'))).toContain(needles.zephyrine)
    expect(productIds(await search('zephyrine qasbah'))).toEqual([])
  })
})

describe('tolérante aux accents — BACKLOG E2-04 : « creme » trouve « crème »', () => {
  it('« creme » ne rend que des noms qui contiennent « crème »', async () => {
    const hits = await search('creme')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.filter((h) => !folded(h.name_fr).includes('creme'))).toEqual([])
  })

  it.each(['creme zephyrine', 'crème zéphyrine', 'CRÈME ZÉPHYRINE', 'elixir qasbah'])(
    '« %s » trouve son produit en premier',
    async (term) => {
      const expected = term.includes('qasbah') ? needles.qasbah : needles.zephyrine
      expect((await search(term))[0]?.product_id).toBe(expected)
    },
  )
})

describe('tolérante aux fautes — seuil 0,4 (SPEC § 6)', () => {
  it('« crme » (0,40 face à « creme ») trouve encore', async () => {
    expect((await search('crme zephyrine'))[0]?.product_id).toBe(needles.zephyrine)
  })

  it('« shampoing » trouve « Shampooing », et rien d’autre', async () => {
    const hits = await search('shampoing')
    expect(hits.length).toBeGreaterThan(0)
    // « Après-shampooing » en fait partie : c'est une bonne réponse.
    expect(hits.filter((h) => !folded(h.name_fr).includes('shampooing'))).toEqual([])
  })

  it('« شمبو » (0,40 face à « شامبو ») trouve « شامبو »', async () => {
    const hits = await search('شمبو')
    const found = hits.some((h) => (h.name_ar ?? '').includes('شامبو'))

    let diagnosis = ''
    if (!found) {
      // Le même appel, directement en base sous le même jeton, et la
      // similarité mesurée sur une ligne « شامبو » de ce jeu-ci.
      await client.query('begin')
      try {
        await actAs(client, tokenFor(tenants.own, 'worker'))
        const direct = await one<{ n: number }>(
          "select count(*)::int as n from public.search_products('شمبو')",
        )
        const sample = await one<{ ws: number; op: boolean; haystack: string }>(
          `select extensions.word_similarity(merx.search_fold('شمبو'), p.search_name || ' ' || p.search_code)::float8 as ws,
                  (merx.search_fold('شمبو') operator(extensions.<%) (p.search_name || ' ' || p.search_code)) as op,
                  p.search_name || ' ' || p.search_code as haystack
           from public.product p
           where p.tenant_id = $1 and p.deleted_at is null and p.name_ar like '%شامبو%' limit 1`,
          [tenants.own],
        )
        diagnosis = ` — en base directe : ${direct.n} lignes ; ws=${sample.ws}, <%=${sample.op}, « ${sample.haystack} »`
      } finally {
        await client.query('rollback')
      }
    }
    const seen = JSON.stringify(hits.slice(0, 5).map((h) => [h.name_fr, h.name_ar]))
    expect(found, `PostgREST : ${hits.length} résultats ${seen}${diagnosis}`).toBe(true)
  })

  /*
   * « 4521 » vaut 0,40 face à « 4512 » : à une faute près, il le trouverait.
   * Vérifier seulement l'absence de 4512 dans les 50 premiers ne suffisait
   * pas — il y était noyé parmi d'autres (sabotage E2-04). Ce qui est exigé :
   * chaque résultat contient « 4521 » tel quel.
   */
  it('un mot fait seulement de chiffres ne tolère pas de faute : chaque résultat contient « 4521 »', async () => {
    const hits = await search('4521')
    expect(hits.length).toBeGreaterThan(0)
    const without = hits.filter(
      (h) => !`${h.code ?? ''} ${h.sku ?? ''} ${h.barcode ?? ''} ${h.name_fr}`.includes('4521'),
    )
    expect(without.map((h) => [h.code, h.sku, h.barcode])).toEqual([])
    // Contrôle positif : la même référence, en partiel.
    expect(productIds(await search('4512'))).toContain(needles.qasbah)
  })

  it.each([
    ['4521', false],
    ['611-22.3', false],
    ['45', false],
    ['niv-4521', true],
    ['crme', true],
    ['شمبو', true],
  ] as const)('merx.search_allows_typo(« %s ») vaut %s', async (word, expected) => {
    const { allows } = await one<{ allows: boolean }>('select merx.search_allows_typo($1) as allows', [word])
    expect(allows).toBe(expected)
  })
})

/*
 * La forme comparable, règle par règle, directement. Par la recherche, la
 * tolérance aux fautes masquait deux règles : sans le pliage des alifs ni
 * celui de ة, « اكسير » et « القصبه » étaient encore trouvés, à une faute près
 * (sabotage E2-04). Ici, rien ne rattrape une règle retirée.
 */
describe('merx.search_fold — chaque règle', () => {
  it.each([
    ['accents', '  Crème   HYDRATANTE ', 'creme hydratante'],
    ['voyelles brèves et tatweel', 'كِرِيـمٌ', 'كريم'],
    ['alif hamza dessus', 'أركان', 'اركان'],
    ['alif hamza dessous', 'إكسير', 'اكسير'],
    ['alif madda', 'آمن', 'امن'],
    ['alif wasla', 'ٱلورد', 'الورد'],
    ['alif maqsura', 'مصطفى', 'مصطفي'],
    ['ta marbuta', 'القصبة', 'القصبه'],
    // Des mots sans ة : chaque cas n'éprouve que sa propre règle.
    ['waw hamza', 'مؤمن', 'مومن'],
    ['ya hamza', 'رئيس', 'رييس'],
    ['chiffres arabes', '٤٥١٢', '4512'],
    ['chiffres arabes orientaux', '۴۵۱۲', '4512'],
  ])('%s', async (_rule, input, expected) => {
    const { folded: result } = await one<{ folded: string }>('select merx.search_fold($1) as folded', [input])
    expect(result).toBe(expected)
  })
})

describe('arabe — la forme comparable', () => {
  it('ignore les voyelles brèves, stockées comme saisies', async () => {
    expect(productIds(await search('زعفران'))).toContain(needles.zephyrine)
    expect(productIds(await search('زَعْفَرَان'))).toContain(needles.zephyrine)
  })

  it('ramène les formes d’alif à ا : « اكسير » trouve « إكسير »', async () => {
    expect((await search('اكسير'))[0]?.product_id).toBe(needles.qasbah)
  })

  it('ramène ة à ه : « القصبه » trouve « القصبة »', async () => {
    expect((await search('القصبه'))[0]?.product_id).toBe(needles.qasbah)
  })

  it('ramène les chiffres arabes aux chiffres latins : « ٤٥١٢ » trouve 4512', async () => {
    expect((await search('٤٥١٢'))[0]?.product_id).toBe(needles.qasbah)
  })
})

describe('référence partielle — BACKLOG E2-04 : « 451 » trouve « 4512 »', () => {
  it('trouve 4512, et classe les références avant les codes-barres', async () => {
    const hits = await search('451')
    expect(productIds(hits)).toContain(needles.qasbah)

    const byReference = (h: Hit) => folded(h.code).includes('451') || folded(h.sku).includes('451')
    const byBarcodeOnly = (h: Hit) => !byReference(h) && (h.barcode ?? '').includes('451')

    // Contrôle positif : le code-barres est bien cherché en partiel lui aussi.
    expect(hits.some(byBarcodeOnly)).toBe(true)
    const lastReference = hits.map(byReference).lastIndexOf(true)
    const firstBarcode = hits.findIndex(byBarcodeOnly)
    expect(lastReference).toBeLessThan(firstBarcode)
  })

  it('la référence exacte passe en premier, devant une référence qui commence pareil', async () => {
    const hits = productIds(await search('4512'))
    expect(hits[0]).toBe(needles.qasbah)
    // Contrôle : la rivale est bien là, juste derrière.
    expect(hits).toContain(needles.apricot)
  })

  it('« 45 », deux caractères, trouve encore', async () => {
    const hits = await search('45')
    expect(hits.length).toBeGreaterThan(0)
    expect(folded(hits[0]!.code) + folded(hits[0]!.sku)).toContain('45')
  })

  it('un « _ » saisi est un caractère, pas un joker', async () => {
    const hits = productIds(await search('zb_1'))
    expect(hits).toContain(needles.underscore)
    expect(hits).not.toContain(needles.lookalike)
    // Contrôle positif : l'autre référence se trouve par ce qu'elle contient.
    expect(productIds(await search('zbx1'))).toContain(needles.lookalike)
  })
})

describe('requête vide', () => {
  it('rend les 50 premières variantes du commerce, par ordre alphabétique', async () => {
    const { rows } = await client.query<{ id: string }>(
      `select v.id
       from public.product p
       join public.variant v on v.product_id = p.id
       where p.tenant_id = $1 and p.deleted_at is null and v.deleted_at is null
       order by p.name_fr, v.id
       limit 50`,
      [tenants.own],
    )
    expect(variantIds(await search(''))).toEqual(rows.map((r) => r.id))
  })
})

describe('suppression douce', () => {
  it('un produit supprimé n’est pas trouvé ; rétabli, il l’est', async () => {
    expect(productIds(await search('xylandre'))).toEqual([])

    await client.query('update public.product set deleted_at = null where id = $1', [needles.xylandre])
    try {
      expect(productIds(await search('xylandre'))).toEqual([needles.xylandre])
    } finally {
      await client.query('update public.product set deleted_at = now() where id = $1', [needles.xylandre])
    }
  })

  /*
   * Deux gardes sur ce chemin : `p.deleted_at` et `v.deleted_at`. La
   * suppression d'un produit se propage à ses variantes (E2-01) : le second
   * garde écarte alors le produit à la place du premier, et retirer le premier
   * ne changeait rien (sabotage E2-04). Ce test contourne la propagation — les
   * triggers sont suspendus, en `postgres`, le temps de l'écriture — pour que le
   * produit supprimé garde une variante vivante : seul `p.deleted_at` l'écarte.
   */
  it('un produit supprimé dont la variante serait restée vivante n’est pas trouvé', async () => {
    // Contrôle positif : vivant, il est trouvé.
    expect(productIds(await search('vasteline'))).toEqual([needles.vasteline])

    const setDeleted = async (value: 'now()' | 'null') => {
      await client.query('set session_replication_role = replica')
      try {
        await client.query(`update public.product set deleted_at = ${value} where id = $1`, [needles.vasteline])
      } finally {
        await client.query('set session_replication_role = origin')
      }
    }

    await setDeleted('now()')
    try {
      const variant = await one<{ deleted_at: string | null }>(
        'select deleted_at from public.variant where id = $1',
        [needles.vasteline],
      )
      expect(variant.deleted_at, 'précondition : la variante est restée vivante').toBeNull()
      expect(productIds(await search('vasteline'))).toEqual([])
    } finally {
      await setDeleted('null')
    }
  })

  it('une variante supprimée n’est pas trouvée ; rétablie, elle l’est', async () => {
    expect(variantIds(await search('kt-99'))).not.toContain(needles.zephyrineDeleted)

    await client.query('update public.variant set deleted_at = null where id = $1', [needles.zephyrineDeleted])
    try {
      expect(variantIds(await search('kt-99'))).toContain(needles.zephyrineDeleted)
    } finally {
      await client.query('update public.variant set deleted_at = now() where id = $1', [
        needles.zephyrineDeleted,
      ])
    }
  })
})

/*
 * Les gardes de ce chemin. La fonction est `security definer` : aucune policy
 * ne s'y applique. Deux gardes, deux réponses distinctes :
 *
 *   — le privilège d'exécution, retiré à `anon` : 401, `42501`, la fonction
 *     nommée ;
 *   — le filtre du commerce, en tête du corps : 200, et seulement les lignes
 *     du commerce du jeton. Un jeton sans commerce rend une liste vide.
 */
describe('isolation — le filtre du commerce, seul garde de ce chemin', () => {
  it('ne rend jamais le produit du voisin, même nom, même référence', async () => {
    for (const term of ['zephyrine', 'qx-7731', 'زعفران']) {
      const hits = productIds(await search(term))
      expect(hits, term).not.toContain(needles.twin)
      // Contrôle positif : la même requête trouve le produit du commerce.
      expect(hits, term).toContain(needles.zephyrine)
    }
  })

  it('un jeton sans commerce ne trouve rien — 200 et liste vide', async () => {
    const result = await rest('rpc/search_products', {
      token: tokens.stranger,
      method: 'POST',
      body: { q: 'zephyrine' },
    })
    expect(result.status).toBe(200)
    expect(result.rows).toEqual([])
  })

  it('un appel anonyme est refusé — 401, 42501, la fonction nommée', async () => {
    const result = await rest('rpc/search_products', { method: 'POST', body: { q: 'zephyrine' } })
    expect(result.status).toBe(401)
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain('permission denied for function search_products')

    // Contrôle positif : la même requête, avec un jeton d'employé.
    expect(productIds(await search('zephyrine'))).toContain(needles.zephyrine)
  })
})

describe('aucun coût dans la réponse — SPEC § 3', () => {
  it.each(['owner', 'worker'] as const)('%s : exactement les colonnes attendues', async (role) => {
    const result = await rest('rpc/search_products', {
      token: tokens[role],
      method: 'POST',
      body: { q: 'zephyrine' },
    })
    expect(result.rows.length).toBeGreaterThan(0)
    expect(Object.keys(result.rows[0]!).sort()).toEqual(COLUMNS)
    expect(result.body).not.toMatch(/cost|margin/i)
  })
})

/* -------------------------------------------------------------------------- */
/* Performance                                                                 */
/* -------------------------------------------------------------------------- */

describe('performance — 10 000 références, parmi 40 000 d’autres commerces', () => {
  it('le jeu est bien en place', async () => {
    const { rows } = await client.query<{ tenant_id: string; live: string }>(
      `select tenant_id, count(*) filter (where deleted_at is null) as live
       from public.product where tenant_id = any($1::uuid[]) group by tenant_id`,
      [[tenants.own, ...tenants.neighbours]],
    )
    expect(rows).toHaveLength(NEIGHBOURS + 1)
    const own = rows.find((r) => r.tenant_id === tenants.own)
    // 10 000 engendrés, un sur vingt supprimé, plus les aiguilles vivantes.
    expect(Number(own?.live)).toBeGreaterThan(9_000)
  })

  it.each(BATTERY)('« %s » : l’index sert, aucun Seq Scan', async (q) => {
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
      // Un ou deux caractères, ou rien : un trigramme n'en extrait rien. Le
      // commerce passe alors par un index qui porte `tenant_id`.
      expect(usage.tenantIndexes, 'index du commerce').toBeGreaterThan(0)
    }
  })

  it(`chaque requête répond en moins de ${BUDGET_MS} ms, par PostgREST, sous un jeton d'employé`, async () => {
    const report: Array<{ q: string; max: number }> = []

    for (const q of BATTERY) {
      await search(q) // chauffe
      let max = 0
      for (let run = 0; run < RUNS; run++) {
        const start = performance.now()
        await search(q)
        max = Math.max(max, performance.now() - start)
      }
      report.push({ q, max: Math.round(max) })
    }

    const table = report.map((r) => `${r.q === '' ? '(vide)' : r.q} : ${r.max} ms`).join('\n')
    console.info(`search_products — maximum sur ${RUNS} appels :\n${table}`)
    expect(report.filter((r) => r.max >= BUDGET_MS), table).toEqual([])
  }, 120_000)
})
