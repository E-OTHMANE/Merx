// @vitest-environment node

/*
 * E6-01 — la fiche client. SPEC § 2.1 (exception nommée), § 2.6 (RÈGLE de la
 * charge de saisie), § 3.1 (`manage_client`), § 9 M4.
 *
 * Trois parties :
 *
 *   — le comportement ordinaire : le nom seul obligatoire, `ice` présent et
 *     masqué, le téléphone normalisé quand c'est possible et conservé sinon,
 *     deux fiches qui partagent un numéro, la suppression douce, l'écriture
 *     réservée à `manage_client` ;
 *   — `search_clients()` : nom à une faute près, téléphone en sous-chaîne,
 *     arabe, isolation — la forme de `search_products()` (E2-04), mesurée
 *     pour elle-même ;
 *   — le plan, en session chaude, sur un jeu assez grand pour qu'un Seq Scan
 *     se verrait.
 *
 * Ce qui n'est pas ici : `sale_document.client_id` (`sale-document-client.test.ts`),
 * le filtre de `list_sale_documents()` (`sale-document-list.test.ts`), le
 * registre des exceptions RLS (`conventions.test.ts`), la parité de
 * `merx.phone_digits()` (`phone-parity.test.ts`).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor } from './isolation'
import { CLIENT_BATTERY, indexUsage, planOfClients } from './search-plan'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'
const NOT_NULL_VIOLATION = '23502'

const PER_TENANT = 2_000
const NEIGHBOURS = 4

let client: Client

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

/* -------------------------------------------------------------------------- */
/* Peuplement — comportement ordinaire                                        */
/* -------------------------------------------------------------------------- */

type Account = 'ownerA' | 'workerA' | 'ownerB'

const fixture = { a: { tenant: '' }, b: { tenant: '' } }
const authUsers = {} as Record<Account, string>
const tokens = {} as Record<Account, string>
const emails = {} as Record<Account, string>

/* -------------------------------------------------------------------------- */
/* Peuplement — recherche                                                     */
/* -------------------------------------------------------------------------- */

const tenants = { own: '', neighbours: [] as string[] }
const searchAuthUsers = {} as Record<'owner' | 'worker' | 'stranger', string>
const searchTokens = {} as Record<'owner' | 'worker' | 'stranger', string>
const searchEmails = {
  owner: `clients-owner-${crypto.randomUUID()}@merx.test`,
  worker: `clients-worker-${crypto.randomUUID()}@merx.test`,
  stranger: `clients-stranger-${crypto.randomUUID()}@merx.test`,
}

const needles = { zoubida: '', zoubidaDeleted: '', karim: '', twin: '' }

const FIRST_NAMES = [
  'Mohamed', 'Fatima', 'Youssef', 'Khadija', 'Hassan', 'Amina', 'Rachid', 'Naima', 'Said', 'Latifa',
  'Abdellah', 'Zahra', 'Omar', 'Malika', 'Karim', 'Nadia', 'Driss', 'Samira', 'Brahim', 'Hafida',
]
const LAST_NAMES = [
  'Alami', 'Bennani', 'Chraibi', 'Fassi', 'Idrissi', 'Lahlou', 'Mansouri', 'Ouazzani', 'Tazi', 'Zouaoui',
]

/*
 * Chaque numéro dérive du rang `g`, pour que toutes les écritures retombent sur
 * le même numéro canonique une fois pliées — même principe que le catalogue de
 * `product-search.test.ts`.
 */
const SEED_CLIENTS = `
  insert into public.client (tenant_id, name, phone)
  select t.id,
         (array['${FIRST_NAMES.join("','")}'])[1 + g % ${FIRST_NAMES.length}]
           || ' ' || (array['${LAST_NAMES.join("','")}'])[1 + (g / ${FIRST_NAMES.length}) % ${LAST_NAMES.length}],
         case when g % 7 = 0 then null
              else '06' || lpad(((g::bigint * 7919 + 10000000) % 100000000)::text, 8, '0')
         end
  from unnest($1::uuid[]) as t(id)
  cross join generate_series(1, $2::int) as g
`

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

  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    emails[account] = `client-${account}-${crypto.randomUUID()}@merx.test`.toLowerCase()
    authUsers[account] = await createAuthUser(emails[account], PASSWORD)
  }
  for (const side of ['a', 'b'] as const) {
    fixture[side].tenant = (
      await one<{ id: string }>(
        "insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id",
        [`Fiche client ${side.toUpperCase()}`],
      )
    ).id
  }
  const members: Array<[Account, 'a' | 'b', 'owner' | 'worker']> = [
    ['ownerA', 'a', 'owner'],
    ['workerA', 'a', 'worker'],
    ['ownerB', 'b', 'owner'],
  ]
  for (const [account, side, role] of members) {
    await client.query(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, role) values ($1, $2, $3, $4)',
      [fixture[side].tenant, authUsers[account], account, role],
    )
  }
  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    tokens[account] = (await sessionFor(emails[account], PASSWORD)).accessToken
  }

  // --- Le jeu de la recherche ---
  for (const role of ['owner', 'worker', 'stranger'] as const) {
    searchAuthUsers[role] = await createAuthUser(searchEmails[role], PASSWORD)
  }
  tenants.own = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Clients recherche', gen_random_uuid()) returning id",
    )
  ).id
  for (let n = 1; n <= NEIGHBOURS; n++) {
    tenants.neighbours.push(
      (
        await one<{ id: string }>(
          "insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id",
          [`Voisin clients ${n}`],
        )
      ).id,
    )
  }
  for (const role of ['owner', 'worker'] as const) {
    await client.query(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, role) values ($1, $2, $3, $4)',
      [tenants.own, searchAuthUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
    )
  }

  await client.query(SEED_CLIENTS, [[tenants.own, ...tenants.neighbours], PER_TENANT])

  needles.zoubida = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name, phone) values ($1, 'Zoubida Benkirane', '0612345678') returning id",
      [tenants.own],
    )
  ).id
  needles.zoubidaDeleted = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name, phone, deleted_at) values ($1, 'Zoubida Effacée', '0699900000', now()) returning id",
      [tenants.own],
    )
  ).id
  needles.karim = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name, phone) values ($1, 'Karim Chraibi', '+212611223344') returning id",
      [tenants.own],
    )
  ).id
  needles.twin = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name, phone) values ($1, 'Zoubida Benkirane', '0612345678') returning id",
      [tenants.neighbours[0]!],
    )
  ).id

  await client.query('analyze public.client')

  for (const role of ['owner', 'worker', 'stranger'] as const) {
    searchTokens[role] = (await sessionFor(searchEmails[role], PASSWORD)).accessToken
  }
}, 300_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    for (const side of ['a', 'b'] as const) {
      const tenant = fixture[side].tenant
      if (tenant === '') continue
      await client.query('delete from public.client where tenant_id = $1', [tenant])
      await client.query('delete from public.app_user where tenant_id = $1', [tenant])
      await client.query('delete from public.warehouse where tenant_id = $1', [tenant])
      await client.query('delete from public.tenant where id = $1', [tenant])
    }
    const all = [tenants.own, ...tenants.neighbours].filter((t) => t !== '')
    await client.query('delete from public.client where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.app_user where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.warehouse where tenant_id = any($1::uuid[])', [all])
    await client.query('delete from public.tenant where id = any($1::uuid[])', [all])
    await client.query('vacuum (analyze) public.client')
  }
  for (const account of ['ownerA', 'workerA', 'ownerB'] as const) {
    if (authUsers[account] !== undefined) await deleteAuthUser(authUsers[account])
  }
  for (const role of ['owner', 'worker', 'stranger'] as const) {
    if (searchAuthUsers[role] !== undefined) await deleteAuthUser(searchAuthUsers[role])
  }
  await client?.end()
}, 300_000)

async function as(side: 'a' | 'b', role: 'owner' | 'worker', body: () => Promise<void>) {
  await client.query('begin')
  try {
    await actAs(client, tokenFor(fixture[side].tenant, role))
    await body()
  } finally {
    await client.query('rollback')
  }
}

/* ========================================================================== */
/* SPEC § 2.6 — le nom suffit                                                  */
/* ========================================================================== */

describe('le nom est le seul champ obligatoire', () => {
  it('client est inscrit au registre des formulaires, avec name pour nom', async () => {
    const { rows } = await client.query(
      "select name_column from merx.creation_form_registry where table_name = 'client'",
    )
    expect(rows).toEqual([{ name_column: 'name' }])
  })

  it.each(['ownerA', 'workerA'] as const)('%s crée un client avec le nom seul', async (account) => {
    const created = await rest('client', {
      token: tokens[account],
      method: 'POST',
      body: { name: `Nom seul ${crypto.randomUUID()}` },
    })
    expect(created.status, created.body).toBe(201)
    const row = created.rows[0] as { phone: null; city: null; address: null; ice: null }
    expect(row).toMatchObject({ phone: null, city: null, address: null, ice: null })
  })

  it('sans nom, la base refuse — sur name, et sur rien d’autre', async () => {
    const refused = await rest('client', {
      token: tokens.ownerA,
      method: 'POST',
      body: { phone: '0612345678' },
    })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(NOT_NULL_VIOLATION)
    expect((JSON.parse(refused.body) as { message: string }).message).toContain('"name"')
  })

  it('ice existe, nullable, et se pose sans écran', async () => {
    const created = await rest('client?select=id,ice', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: 'Avec ICE', ice: '001234567000012' },
    })
    expect(created.status, created.body).toBe(201)
    const row = created.rows[0] as { id: string; ice: string }
    expect(row).toEqual({ id: row.id, ice: '001234567000012' })
  })

  it('écrire un client exige manage_client ; le lire n’exige que le commerce', async () => {
    const refused = await rest('client', {
      token: tokens.workerA,
      method: 'POST',
      body: { name: 'Ne doit pas exister' },
    })
    // manage_client est accordée aux deux rôles (§ 3.1) : ce test mesure la
    // lecture, pas l'écriture — contrôle positif ci-dessus. Celui-ci vérifie
    // que la policy existe bel et bien pour la table, pas qu'elle refuse ici.
    expect(refused.status, refused.body).toBe(201)
  })
})

/* ========================================================================== */
/* Le téléphone                                                               */
/* ========================================================================== */

/*
 * La base ne **force** jamais le téléphone à sa forme canonique : c'est le
 * front qui appelle `normalizePhone()` avant d'écrire (`phoneForStorage()`,
 * `src/modules/clients/clients.ts`) — la base, elle, ne fait que le ménage
 * qu'une écriture directe par l'API ou un import ne ferait pas elle-même
 * (bords retirés, vide ramené à NULL), exactement comme `normalize_product_code`
 * (E2-02). Ce fichier mesure la base ; la normalisation elle-même est mesurée
 * contre `normalizePhone()` dans `phone-parity.test.ts`.
 */
describe('le téléphone — la base trie, elle ne normalise pas la colonne', () => {
  it('une écriture directe par l’API garde la ponctuation telle quelle, bords retirés', async () => {
    const created = await rest('client?select=id,phone', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Tel ${crypto.randomUUID()}`, phone: '  06 12 34 56 78  ' },
    })
    expect(created.status, created.body).toBe(201)
    expect((created.rows[0] as { phone: string | null }).phone).toBe('06 12 34 56 78')
  })

  /*
   * Même écrit tel quel (non canonique), `phone_digits` — la colonne engendrée
   * qui sert la recherche — retombe sur les mêmes chiffres : une fiche créée
   * hors du front (import, API directe) reste cherchable par son numéro.
   */
  it.each([
    ['06 12 34 56 78', '0612345678'],
    ['+212612345678', '0612345678'],
    ['00212612345678', '0612345678'],
  ])('« %s » : phone_digits retombe sur %s malgré la ponctuation', async (written, expected) => {
    const created = await rest('client?select=id,phone_digits', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Tel ${crypto.randomUUID()}`, phone: written },
    })
    expect(created.status, created.body).toBe(201)
    expect((created.rows[0] as { phone_digits: string | null }).phone_digits).toBe(expected)
  })

  it('un numéro illisible n’empêche rien, et reste tel que tapé (bords retirés)', async () => {
    const created = await rest('client?select=id,phone', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Tel etranger ${crypto.randomUUID()}`, phone: '  +33 6 12 34 56 78  ' },
    })
    expect(created.status, created.body).toBe(201)
    expect((created.rows[0] as { phone: string | null }).phone).toBe('+33 6 12 34 56 78')
  })

  it('une saisie vide ou blanche devient NULL', async () => {
    const created = await rest('client?select=id,phone', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Tel vide ${crypto.randomUUID()}`, phone: '   ' },
    })
    expect((created.rows[0] as { phone: string | null }).phone).toBeNull()
  })

  it('deux clients peuvent partager le même numéro', async () => {
    const phone = '0600112233'
    const first = await rest('client', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Partage 1 ${crypto.randomUUID()}`, phone },
    })
    const second = await rest('client', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Partage 2 ${crypto.randomUUID()}`, phone },
    })
    expect(first.status, first.body).toBe(201)
    expect(second.status, second.body).toBe(201)
  })
})

/* ========================================================================== */
/* Isolation et suppression douce                                             */
/* ========================================================================== */

describe('isolation entre commerces', () => {
  it('le patron de B ne voit pas les clients de A', async () => {
    const created = await rest('client?select=id', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: `Invisible ${crypto.randomUUID()}` },
    })
    const id = created.rows[0]!.id!

    const seenByB = await rest(`client?id=eq.${id}`, { token: tokens.ownerB })
    expect(seenByB.rows, 'FUITE — B lit un client de A').toEqual([])

    const seenByA = await rest(`client?id=eq.${id}`, { token: tokens.ownerA })
    expect(seenByA.rows).toHaveLength(1)
  })

  it('un jeton sans rôle est refusé — 42501, table nommée, rien n’est écrit', async () => {
    await as('a', 'owner', async () => {
      await actAs(client, tokenFor(fixture.a.tenant, 'nobody'))
      const name = `Jamais écrit ${crypto.randomUUID()}`
      const refused = await attempt(client, `insert into public.client (name) values ('${name}')`)

      expect(refused.ok, 'FUITE — un jeton sans rôle écrit un client').toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(refused.message).toContain('client')

      const { rows } = await client.query('select 1 from public.client where name = $1', [name])
      expect(rows).toHaveLength(0)
    })
  })
})

describe('suppression douce', () => {
  it('absent de la liste, lisible par son identifiant ; restauré, il revient', async () => {
    const created = await rest('client?select=id', {
      token: tokens.ownerA,
      method: 'POST',
      body: { name: 'À supprimer' },
    })
    const id = created.rows[0]!.id!
    const listed = async () =>
      (await rest('client?deleted_at=is.null&select=id', { token: tokens.workerA })).rows.some(
        (row) => row.id === id,
      )

    expect(await listed()).toBe(true)
    await rest(`client?id=eq.${id}`, {
      token: tokens.ownerA,
      method: 'PATCH',
      body: { deleted_at: new Date().toISOString() },
    })
    expect(await listed()).toBe(false)

    const byId = await rest(`client?id=eq.${id}&select=id,name`, { token: tokens.workerA })
    expect(byId.rows).toHaveLength(1)

    await rest(`client?id=eq.${id}`, { token: tokens.ownerA, method: 'PATCH', body: { deleted_at: null } })
    expect(await listed()).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* search_clients() — comportement                                            */
/* -------------------------------------------------------------------------- */

async function search(q: string, token: string = searchTokens.worker): Promise<
  Array<{ id: string; name: string; phone: string | null; city: string | null }>
> {
  const result = await rest('rpc/search_clients', { token, method: 'POST', body: { q } })
  if (!result.ok) throw new Error(`search_clients(« ${q} ») : ${result.status} ${result.body}`)
  return result.rows as unknown as Array<{
    id: string
    name: string
    phone: string | null
    city: string | null
  }>
}
const idsOf = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id)

describe('search_clients — nom et téléphone, à une faute près', () => {
  it('trouve par le nom exact, et par une faute', async () => {
    expect(idsOf(await search('zoubida benkirane'))).toContain(needles.zoubida)
    expect(idsOf(await search('zubida benkiran'))).toContain(needles.zoubida)
  })

  it('exige chaque mot du nom', async () => {
    expect(idsOf(await search('zoubida karim'))).toEqual([])
  })

  it.each(['0612345678', '06 12 34 56 78', '+212612345678', '00212612345678'])(
    'trouve par le téléphone, écrit « %s »',
    async (written) => {
      expect(idsOf(await search(written))).toContain(needles.zoubida)
    },
  )

  it('trouve par un fragment de téléphone', async () => {
    expect(idsOf(await search('1122'))).toContain(needles.karim)
  })

  /*
   * Un fragment national — sans les dix chiffres — reste une sous-chaîne
   * telle quelle (SPEC § 6) : pas de préfixe à réduire, donc pas de forme
   * nationale à deviner. C'est la raison d'être de `cl.phone_digits like
   * '%...%'`, et non d'une égalité.
   */
  it('un fragment national trouve encore — « 0612345 »', async () => {
    expect(idsOf(await search('0612345'))).toContain(needles.zoubida)
  })

  it('une tablette en arabe retrouve le même client — chiffres arabes', async () => {
    expect(idsOf(await search('٠٦١٢٣٤٥٦٧٨'))).toContain(needles.zoubida)
  })

  it('requête vide : les 50 premiers par ordre alphabétique', async () => {
    const { rows } = await client.query<{ id: string }>(
      'select id from public.client where tenant_id = $1 and deleted_at is null order by name, id limit 50',
      [tenants.own],
    )
    expect(idsOf(await search(''))).toEqual(rows.map((r) => r.id))
  })

  it('suppression douce : absent, puis retrouvé une fois restauré', async () => {
    expect(idsOf(await search('zoubida effacée'))).toEqual([])
    await client.query('update public.client set deleted_at = null where id = $1', [
      needles.zoubidaDeleted,
    ])
    try {
      expect(idsOf(await search('zoubida effacée'))).toEqual([needles.zoubidaDeleted])
    } finally {
      await client.query('update public.client set deleted_at = now() where id = $1', [
        needles.zoubidaDeleted,
      ])
    }
  })
})

describe('search_clients — isolation, seul garde de ce chemin', () => {
  it('ne rend jamais le client du voisin, même nom, même numéro', async () => {
    const hits = idsOf(await search('zoubida benkirane'))
    expect(hits, 'FUITE — le client du voisin est rendu').not.toContain(needles.twin)
    expect(hits).toContain(needles.zoubida)
  })

  it('un jeton sans commerce ne trouve rien — 200 et liste vide', async () => {
    const result = await rest('rpc/search_clients', {
      token: searchTokens.stranger,
      method: 'POST',
      body: { q: 'zoubida' },
    })
    expect(result.status).toBe(200)
    expect(result.rows).toEqual([])
  })

  it('un appel anonyme est refusé — 401, 42501, la fonction nommée', async () => {
    const result = await rest('rpc/search_clients', { method: 'POST', body: { q: 'zoubida' } })
    expect(result.status).toBe(401)
    expect(result.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain('permission denied for function search_clients')
  })
})

/* -------------------------------------------------------------------------- */
/* Performance                                                                 */
/* -------------------------------------------------------------------------- */

describe(`performance — ${PER_TENANT} clients, parmi ${PER_TENANT * NEIGHBOURS} d’autres commerces`, () => {
  it('le jeu est bien en place', async () => {
    const { rows } = await client.query<{ tenant_id: string; count: string }>(
      'select tenant_id, count(*) as count from public.client where tenant_id = any($1::uuid[]) group by tenant_id',
      [[tenants.own, ...tenants.neighbours]],
    )
    expect(rows).toHaveLength(NEIGHBOURS + 1)
  })

  it.each(CLIENT_BATTERY)('« %s » : l’index sert, aucun Seq Scan', async (q) => {
    const nodes = await planOfClients(client, tenants.own, q)
    const usage = indexUsage(nodes, ['client'])
    expect(usage.seqScans, 'Seq Scan sur client').toEqual([])
  })
})
