// @vitest-environment node

/*
 * RÈGLE M8-1 — le changement de prix d'achat écrit dans le journal.
 * E1-04, addendum à E2-03. SPEC § 3, § 6 (`variant_cost`), § 9 M8.
 *
 * `variant_cost` s'écrit directement par PostgREST : le journal est tenu par un
 * trigger sur la table (`merx.apply_audit()`), et c'est lui qu'on éprouve ici,
 * sur le chemin réel — un patron, son vrai jeton, la requête que l'écran émet.
 *
 * Trois écritures, trois entrées, chacune avec son avant et son après ; une
 * écriture qui ne change pas le prix n'en laisse aucune, pas plus qu'une
 * écriture refusée. Et le revers, qui tient la décision : hors session — sans
 * commerce, ou sans auteur dans le jeton — l'écriture elle-même est refusée, et
 * aucune ligne ne naît. Sans ce revers, la décision ne tiendrait qu'au trigger,
 * et personne ne verrait le jour où quelqu'un l'assouplit.
 *
 * Chaque assertion d'entrée manquante nomme l'action : un trigger retiré fait
 * tomber ces tests en disant ce qui manque.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor, withoutTriggers } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

const ACTION = 'purchase_price_change'

/** Le corollaire de `audit_log.user_id NOT NULL` : aucun auteur à inscrire (E1-04). */
const NO_AUTHOR = '23502'

interface CostState {
  variant_id: string
  cost_price: string
}

interface Entry {
  action: string
  entity_type: string
  entity_id: string
  user_id: string
  before: CostState | null
  after: CostState | null
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

/* Un commerce, un patron et un employé réels : le journal exige un auteur. */
const fixture = { tenant: '', owner: '' }
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

beforeAll(async () => {
  client = await connect()

  for (const role of ['owner', 'worker'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  fixture.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Journal des coûts', gen_random_uuid()) returning id",
    )
  ).id

  for (const role of ['owner', 'worker'] as const) {
    const { id } = await one<{ id: string }>(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
       values ($1, $2, $3, $4) returning id`,
      [fixture.tenant, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
    )
    if (role === 'owner') fixture.owner = id
  }

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined && fixture.tenant !== '') {
    await client.query('reset role')
    /*
     * Les entrées du journal sont en ajout seul et tiennent le commerce et le
     * patron par clé étrangère ; une ligne de coût ne se supprime pas hors
     * session. Le harnais range les deux triggers suspendus — le seul endroit
     * où ce contournement a sa place.
     */
    await withoutTriggers(client, async () => {
      await client.query('delete from public.audit_log where tenant_id = $1', [fixture.tenant])
      await client.query('delete from public.variant_cost where tenant_id = $1', [fixture.tenant])
    })
    await client.query('delete from public.product where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.app_user where tenant_id = $1', [fixture.tenant])
    // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
    await client.query('delete from public.warehouse where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.tenant where id = $1', [fixture.tenant])
  }
  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/** Un produit neuf ; sa variante par défaut porte son identifiant (E2-01). */
async function newVariant(): Promise<string> {
  return (
    await one<{ id: string }>(
      "insert into public.product (tenant_id, name_fr) values ($1, 'Parfum témoin') returning id",
      [fixture.tenant],
    )
  ).id
}

/**
 * Les entrées qui visent une ligne de coût, dans l'ordre. Le prix est relu en
 * texte : `12.50` reste `12.50`, et l'assertion compare la valeur exacte.
 */
async function entriesFor(costRow: string): Promise<Entry[]> {
  const state = (column: string): string =>
    `case when "${column}" is null then null
          else jsonb_build_object('variant_id', "${column}" ->> 'variant_id',
                                  'cost_price', "${column}" ->> 'cost_price') end`
  const { rows } = await client.query<Entry>(
    `select action::text as action, entity_type, entity_id, user_id,
            ${state('before')} as before, ${state('after')} as after
     from public.audit_log
     where tenant_id = $1 and entity_id = $2
     order by created_at, id`,
    [fixture.tenant, costRow],
  )
  return rows
}

const entry = (costRow: string, before: CostState | null, after: CostState | null): Entry => ({
  action: ACTION,
  entity_type: 'variant_cost',
  entity_id: costRow,
  user_id: fixture.owner,
  before,
  after,
})

/** Par le chemin de l'application : PostgREST, le jeton du patron. */
async function asOwner(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const result = await rest(path, { token: tokens.owner, method, body })
  if (!result.ok) throw new Error(`${method} ${path} : ${result.status} ${result.body}`)
  return result
}

async function createCost(variant: string, cost: string): Promise<string> {
  const created = await asOwner('variant_cost', 'POST', { variant_id: variant, cost_price: cost })
  const id = created.rows[0]?.id
  if (id === undefined) throw new Error('ligne de coût créée sans identifiant rendu')
  return id
}

async function costRowsOf(variant: string): Promise<number> {
  const { n } = await one<{ n: number }>(
    'select count(*)::int as n from public.variant_cost where variant_id = $1',
    [variant],
  )
  return n
}

const insertCost = (variant: string, cost: string): string =>
  `insert into public.variant_cost (tenant_id, variant_id, cost_price)
   values ('${fixture.tenant}', '${variant}', '${cost}')`

/* ========================================================================== */

describe('RÈGLE M8-1 — chaque écriture du prix d’achat laisse son entrée', () => {
  it('la création de la ligne', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '10.00')

    expect(await entriesFor(row), `${ACTION} manquante — création de la ligne`).toEqual([
      entry(row, null, { variant_id: variant, cost_price: '10.00' }),
    ])
  })

  it('la modification du prix', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '10.00')

    const changed = await asOwner(`variant_cost?id=eq.${row}`, 'PATCH', { cost_price: '12.50' })
    expect(changed.rows).toHaveLength(1)

    const entries = await entriesFor(row)
    expect(entries[1], `${ACTION} manquante — modification du prix`).toEqual(
      entry(row, { variant_id: variant, cost_price: '10.00' }, { variant_id: variant, cost_price: '12.50' }),
    )
    expect(entries).toHaveLength(2)
  })

  it('la suppression de la ligne', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '12.50')

    const removed = await asOwner(`variant_cost?id=eq.${row}`, 'DELETE')
    expect(removed.rows).toHaveLength(1)

    const entries = await entriesFor(row)
    expect(entries[1], `${ACTION} manquante — suppression de la ligne`).toEqual(
      entry(row, { variant_id: variant, cost_price: '12.50' }, null),
    )
    expect(entries).toHaveLength(2)
  })

  it('l’entrée ne retient que les colonnes déclarées — ni commerce, ni horodatage', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '7.00')

    const { rows } = await client.query<{ keys: string[] }>(
      `select array(select jsonb_object_keys("after") order by 1) as keys
       from public.audit_log where tenant_id = $1 and entity_id = $2`,
      [fixture.tenant, row],
    )
    expect(rows).toEqual([{ keys: ['cost_price', 'variant_id'] }])
  })

  it('une écriture qui ne change pas le prix n’en laisse aucune', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '10.00')

    const touched = await asOwner(`variant_cost?id=eq.${row}`, 'PATCH', { cost_price: '10.00' })
    expect(touched.rows, 'contrôle : la ligne a bien été touchée').toHaveLength(1)
    expect(await entriesFor(row)).toHaveLength(1)
  })

  it('l’écriture refusée à l’employé n’en laisse aucune', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '10.00')

    const refused = await rest(`variant_cost?id=eq.${row}`, {
      token: tokens.worker,
      method: 'PATCH',
      body: { cost_price: '1.00' },
    })
    expect(refused.rows).toHaveLength(0)
    expect(await entriesFor(row)).toHaveLength(1)
  })
})

/*
 * La décision arbitrée à la clôture d'E2-04 : hors session, pas d'écriture.
 * Deux gardes de `merx.log_audit()`, deux codes et deux phrases — un test ne
 * peut pas passer pour l'autre. `postgres` ne subit aucune policy : le refus
 * ne peut venir que du journal.
 */
describe('hors session, l’écriture est refusée — le journal exige un commerce et un auteur', () => {
  it('sans jeton : 42501, sous la phrase du journal, et aucune ligne', async () => {
    const variant = await newVariant()

    await client.query('begin')
    try {
      await client.query('reset role')
      await client.query("select set_config('request.jwt.claims', '', true)")

      const written = await attempt(client, insertCost(variant, '9.00'))
      expect(written.ok, 'FUITE — un prix d’achat posé sans commerce ni auteur').toBe(false)
      if (!written.ok) {
        expect(written.code).toBe(INSUFFICIENT_PRIVILEGE)
        expect(written.message).toContain('rien à journaliser')
      }
      expect(await costRowsOf(variant)).toBe(0)
    } finally {
      await client.query('rollback')
    }

    // Contrôle positif : la même ligne, posée par le patron, passe.
    await createCost(variant, '9.00')
    expect(await costRowsOf(variant)).toBe(1)
  })

  it('un commerce sans auteur : 23502, et aucune ligne', async () => {
    const variant = await newVariant()

    await client.query('begin')
    try {
      // Les claims d'un patron, sans fiche derrière : la policy laisse passer,
      // le journal n'a personne à inscrire.
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      const written = await attempt(client, insertCost(variant, '9.00'))
      expect(written.ok, 'FUITE — un prix d’achat posé sans auteur').toBe(false)
      if (!written.ok) {
        expect(written.code).toBe(NO_AUTHOR)
        expect(written.message).toContain('exige un auteur')
      }

      await client.query('reset role')
      expect(await costRowsOf(variant)).toBe(0)
    } finally {
      await client.query('rollback')
    }
  })

  it('modifier ou supprimer sans jeton : 42501, ligne intacte', async () => {
    const variant = await newVariant()
    const row = await createCost(variant, '10.00')

    await client.query('begin')
    try {
      await client.query('reset role')
      await client.query("select set_config('request.jwt.claims', '', true)")

      const changed = await attempt(
        client,
        `update public.variant_cost set cost_price = '1.00' where id = '${row}'::uuid`,
      )
      expect(changed.ok, 'FUITE — un prix d’achat changé sans commerce ni auteur').toBe(false)
      if (!changed.ok) expect(changed.code).toBe(INSUFFICIENT_PRIVILEGE)

      const removed = await attempt(client, `delete from public.variant_cost where id = '${row}'::uuid`)
      expect(removed.ok, 'FUITE — un prix d’achat supprimé sans commerce ni auteur').toBe(false)
      if (!removed.ok) expect(removed.code).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await client.query('rollback')
    }

    const { cost } = await one<{ cost: string }>(
      'select cost_price::text as cost from public.variant_cost where id = $1',
      [row],
    )
    expect(cost).toBe('10.00')
  })
})
