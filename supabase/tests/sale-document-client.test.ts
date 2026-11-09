// @vitest-environment node

/*
 * E6-01 — `sale_document.client_id`. SPEC § 4 (clés étrangères composites),
 * § 8 (RÈGLE M3-3 — le contenu est figé, le statut avance).
 *
 * Trois choses, et chacune son garde :
 *
 *   — la clé composite : un `client_id` du voisin est refusé, `23503`, la
 *     contrainte nommée — les deux écritures dans **une seule** transaction
 *     (CLAUDE.md, Même transaction) ;
 *   — un bon sans client reste un bon valable, confirmé compris ;
 *   — un document confirmé ne change pas de client : le garde générique de
 *     la table figée (E4-01) l'englobe d'office, sans qu'une ligne de son
 *     registre bouge — ce test le mesure, il ne le suppose pas.
 *
 * Ce qui n'est pas ici : la recherche client (`clients.test.ts`), le filtre
 * de `list_sale_documents()` (`sale-document-list.test.ts`), les gardes
 * génériques de la table figée, déjà mesurés par `sale-document.test.ts`
 * (E4-01) sur d'autres colonnes.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, attempt } from './isolation'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const FOREIGN_KEY_VIOLATION = '23503'

let client: Client

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  client: '',
  other: { tenant: '', client: '' },
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
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

  fixture.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Client E6-01')" +
        ' returning id',
    )
  ).id
  fixture.warehouse = (
    await one<{ id: string }>(
      'select id from public.warehouse where tenant_id = $1 and is_default',
      [fixture.tenant],
    )
  ).id
  fixture.device = (
    await one<{ id: string }>(
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A') returning id",
      [fixture.tenant],
    )
  ).id
  fixture.client = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name) values ($1, 'Droguerie Centrale') returning id",
      [fixture.tenant],
    )
  ).id

  // Le voisin, **dans la même transaction** : les deux écritures se
  // rencontrent, sans quoi une contrainte sans tenant_id passerait aussi.
  fixture.other.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Voisin E6-01')" +
        ' returning id',
    )
  ).id
  fixture.other.client = (
    await one<{ id: string }>(
      "insert into public.client (tenant_id, name) values ($1, 'Client du voisin') returning id",
      [fixture.other.tenant],
    )
  ).id
}, 60_000)

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
})

async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    await client.query('rollback to savepoint case_under_test')
    await client.query('reset role')
  }
}

async function draft(clientId: string | null): Promise<string> {
  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, client_id)' +
      " values ($1, 'delivery_note', $2, $3, $4) returning id",
    [fixture.tenant, fixture.warehouse, fixture.device, clientId],
  )
  return doc.id
}

/* ========================================================================== */
/* La clé composite                                                           */
/* ========================================================================== */

describe('sale_document.client_id — clé composite', () => {
  it('accepte un client du même commerce', async () => {
    await inCase(async () => {
      const id = await draft(fixture.client)
      const row = await one<{ client_id: string | null }>(
        'select client_id from public.sale_document where id = $1',
        [id],
      )
      expect(row.client_id).toBe(fixture.client)
    })
  })

  it('refuse le client du voisin — 23503, sale_document_client_id_fkey', async () => {
    await inCase(async () => {
      const refused = await attempt(
        client,
        'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, client_id)' +
          ` values ('${fixture.tenant}', 'delivery_note', '${fixture.warehouse}', '${fixture.device}',` +
          ` '${fixture.other.client}')`,
      )

      expect(refused.ok, 'FUITE — le client du voisin a été accepté').toBe(false)
      if (refused.ok) return
      expect(refused.code).toBe(FOREIGN_KEY_VIOLATION)
      expect(refused.message).toContain('sale_document_client_id_fkey')
    })
  })

  it('un identifiant qui n’existe nulle part est refusé de la même façon', async () => {
    await inCase(async () => {
      const refused = await attempt(
        client,
        'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, client_id)' +
          ` values ('${fixture.tenant}', 'delivery_note', '${fixture.warehouse}', '${fixture.device}',` +
          ` '${crypto.randomUUID()}')`,
      )
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.code).toBe(FOREIGN_KEY_VIOLATION)
    })
  })
})

/* ========================================================================== */
/* Un bon sans client reste valable (SPEC § 2.6)                              */
/* ========================================================================== */

describe('un bon sans client', () => {
  it('se crée, se confirme, et reste consultable', async () => {
    await inCase(async () => {
      const id = await draft(null)
      await client.query(
        `update public.sale_document set status = 'confirmed',
           doc_number = 'BL-A-26-00001', issued_at = now() where id = '${id}'`,
      )

      const row = await one<{ status: string; client_id: string | null; doc_number: string }>(
        'select status, client_id, doc_number from public.sale_document where id = $1',
        [id],
      )
      expect(row.status).toBe('confirmed')
      expect(row.client_id).toBeNull()
      expect(row.doc_number).toBe('BL-A-26-00001')
    })
  })
})

/* ========================================================================== */
/* Figé dès confirmation (RÈGLE M3-3) — le garde générique, pas un garde neuf  */
/* ========================================================================== */

describe('un document confirmé ne change pas de client', () => {
  it('refuse de poser un client sur un bon confirmé qui n’en avait pas — PT409', async () => {
    await inCase(async () => {
      const id = await draft(null)
      await client.query(
        `update public.sale_document set status = 'confirmed',
           doc_number = 'BL-A-26-00002', issued_at = now() where id = '${id}'`,
      )

      const moved = await attempt(
        client,
        `update public.sale_document set client_id = '${fixture.client}' where id = '${id}'`,
      )

      expect(moved.ok, 'FUITE — le client a changé sur un document figé').toBe(false)
      if (!moved.ok) expect(moved.code, moved.message).toBe(FROZEN_WRITE)
    })
  })

  it('refuse de changer le client d’un bon confirmé qui en avait un', async () => {
    await inCase(async () => {
      const id = await draft(fixture.client)
      await client.query(
        `update public.sale_document set status = 'confirmed',
           doc_number = 'BL-A-26-00003', issued_at = now() where id = '${id}'`,
      )

      const moved = await attempt(client, `update public.sale_document set client_id = null where id = '${id}'`)

      expect(moved.ok, 'FUITE — le client a été retiré sur un document figé').toBe(false)
      if (!moved.ok) expect(moved.code, moved.message).toBe(FROZEN_WRITE)
    })
  })

  it('le statut avance quand même : confirmed → delivered, le client ne bouge pas', async () => {
    await inCase(async () => {
      const id = await draft(fixture.client)
      await client.query(
        `update public.sale_document set status = 'confirmed',
           doc_number = 'BL-A-26-00004', issued_at = now() where id = '${id}'`,
      )

      const delivered = await attempt(
        client,
        `update public.sale_document set status = 'delivered' where id = '${id}'`,
      )
      expect(delivered.ok, delivered.ok ? '' : `${delivered.code} ${delivered.message}`).toBe(true)

      const row = await one<{ client_id: string | null }>(
        'select client_id from public.sale_document where id = $1',
        [id],
      )
      expect(row.client_id).toBe(fixture.client)
    })
  })
})
