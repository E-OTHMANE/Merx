// @vitest-environment node

/*
 * E4-03 — le dépôt d'un bon, posé par la base.
 * SPEC § 2.1 (isolation), § 2.4 (dépôt unique, « jamais exposée »), § 8.
 *
 * `sale_document.warehouse_id` prend pour défaut `merx.default_warehouse_id()`,
 * afin que l'écran de vente n'ait pas à lire une table que le spec ne lui
 * expose pas, ni à payer un aller-retour de plus au comptoir.
 *
 * **Deux niveaux tiennent la même ligne, et chacun a son test ailleurs**
 * (CLAUDE.md, un test par niveau, chacun contournant l'autre) :
 *
 *   — les policies de § 2.1 sur `warehouse`. La fonction est `security
 *     invoker` : la lecture passe par elles. Elles sont mesurées par le
 *     balayage de `isolation.test.ts`, qui couvre `warehouse` comme les autres
 *     tables du registre ;
 *   — le filtre `tenant_id = merx.current_tenant_id()`, en tête du corps. Lui
 *     seul peut refuser quand la RLS ne s'applique pas, et c'est ce que ce
 *     fichier mesure : **en `postgres`**, qui porte BYPASSRLS, avec le jeton du
 *     commerce B et le dépôt du commerce A posé d'abord. Sous
 *     `authenticated`, les deux étages répondraient ensemble et retirer le
 *     filtre ne changerait rien d'observable.
 *
 * Les deux commerces sont posés dans **une seule** transaction : deux écritures
 * dans deux transactions annulées séparément ne se rencontrent jamais, et un
 * filtre absent passerait comme un filtre présent (la leçon d'E2-06).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EMPTY_CLAIMS, actAs, tokenFor } from './isolation'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const NOT_NULL_VIOLATION = '23502'

let client: Client

/** A est créé d'abord : sans filtre, c'est sa ligne que le `select` rendrait. */
const fixture = {
  a: { tenant: '', warehouse: '' },
  b: { tenant: '', warehouse: '', device: '' },
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

async function seedTenant(name: string): Promise<{ tenant: string; warehouse: string }> {
  const tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
      [name],
    )
  ).id
  // Le dépôt naît avec le commerce — trigger `merx.open_default_warehouse()`, E3-02.
  const warehouse = (
    await one<{ id: string }>(
      'select id from public.warehouse where tenant_id = $1 and is_default',
      [tenant],
    )
  ).id
  return { tenant, warehouse }
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
  await client.query('begin')

  fixture.a = await seedTenant('Voisin E4-03')
  fixture.b = { ...(await seedTenant('Vente E4-03')), device: '' }
  fixture.b.device = (
    await one<{ id: string }>(
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A') returning id",
      [fixture.b.tenant],
    )
  ).id
})

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
})

/** Un cas, dans son point de sauvegarde, rôle remis avant de le relâcher. */
async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('reset role')
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    await client.query('rollback to savepoint case_under_test')
    await client.query('reset role')
  }
}

describe('le dépôt par défaut d’un bon de vente', () => {
  it('est celui du commerce de la session', async () => {
    await inCase(async () => {
      await actAs(client, tokenFor(fixture.b.tenant, 'worker'))
      const doc = await one<{ warehouse_id: string }>(
        "insert into public.sale_document (doc_type, device_id)" +
          " values ('delivery_note', $1) returning warehouse_id",
        [fixture.b.device],
      )
      expect(doc.warehouse_id).toBe(fixture.b.warehouse)
    })
  })

  /*
   * Le filtre, seul, hors de la RLS. En `postgres` (BYPASSRLS) les deux dépôts
   * sont visibles — le contrôle le mesure d'abord, sans quoi le cas passerait
   * pour n'avoir rien eu à écarter — et seul `tenant_id =
   * merx.current_tenant_id()` peut encore écarter celui du voisin.
   */
  it('ne rend jamais le dépôt du voisin, même sans la RLS', async () => {
    await inCase(async () => {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify(tokenFor(fixture.b.tenant, 'worker')),
      ])

      const visible = await one<{ count: string }>(
        'select count(*)::text as count from public.warehouse where id = any($1::uuid[])',
        [[fixture.a.warehouse, fixture.b.warehouse]],
      )
      expect(visible.count).toBe('2')

      const resolved = await one<{ id: string | null }>(
        'select merx.default_warehouse_id() as id',
      )
      expect(resolved.id).toBe(fixture.b.warehouse)
      expect(resolved.id).not.toBe(fixture.a.warehouse)
    })
  })

  /*
   * Un jeton sans commerce ne reçoit pas un dépôt au hasard : la fonction rend
   * NULL, et le NOT NULL de la colonne refuse l'insertion. C'est le bon refus —
   * il n'y a pas de dépôt à deviner (et sous `authenticated` la policy aurait
   * de toute façon refusé la ligne).
   */
  it.each(EMPTY_CLAIMS)('rend NULL pour un jeton sans commerce ($label)', async ({ claims }) => {
    await inCase(async () => {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        claims === null ? '' : JSON.stringify(claims),
      ])

      const resolved = await one<{ id: string | null }>(
        'select merx.default_warehouse_id() as id',
      )
      expect(resolved.id).toBeNull()

      const refused = await client
        .query(
          'insert into public.sale_document (tenant_id, doc_type, device_id)' +
            " values ($1, 'delivery_note', $2)",
          [fixture.b.tenant, fixture.b.device],
        )
        .then(() => null)
        .catch((error: { code?: string }) => error.code ?? null)
      expect(refused).toBe(NOT_NULL_VIOLATION)
    })
  })
})
