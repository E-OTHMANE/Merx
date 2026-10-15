// @vitest-environment node

/*
 * E4-04 — les refus du prix, vus de PostgREST.
 *
 * `sale-price.test.ts` éprouve les gardes en SQL, dans une transaction annulée.
 * Il ne peut pas éprouver l'API : PostgREST est un autre processus, qui ne
 * verrait rien d'une transaction ouverte là-bas, et c'est **lui** qui traduit un
 * SQLSTATE en code HTTP. Un garde juste en SQL peut sortir de l'API en `500`
 * muet — c'est arrivé quatre fois en E4-01, et le prix en est écrit à SPEC § 4
 * (RÈGLE des refus en 4xx) : PowerSync lit un 5xx comme une panne passagère et
 * rejoue sans fin une écriture qui ne passera jamais, bloquant la file de
 * l'appareil (E9).
 *
 * Trois refus, trois statuts **mesurés** :
 *
 *   — le plancher, `42501` → **403** ;
 *   — la forme d'un forçage, `23514` → **400** ;
 *   — la cohérence des totaux à la confirmation, `23514` → **400**.
 *
 * Chacun avec sa phrase, et chacun avec son contrôle positif : un refus qui
 * viendrait de l'isolation, d'un privilège manquant ou d'une requête mal formée
 * passerait tous les tests de refus sans qu'aucun garde existe.
 *
 * Les lignes sont **validées**, pas posées dans une transaction. Le démontage
 * est donc explicite, dans l'ordre inverse des dépendances.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { withoutTriggers } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'sale-price-api-e4-04-password'

/* Les statuts réellement rendus, mesurés et non lus sur la table de PostgREST. */
const DENIED_HTTP = 403
const INVALID_HTTP = 400
const CREATED_HTTP = 201

const INSUFFICIENT_PRIVILEGE = '42501'
const CHECK_VIOLATION = '23514'

/* Les phrases des gardes — chacune n'est dite que par le sien. */
const BELOW_FLOOR = 'Prix sous le plancher de cette variante'
const OVERRIDE_SHAPE = 'sale_line_override_shape'
const TOTALS_LIE = 'ne dit pas la vérité sur ses lignes'

const emails = {
  owner: `patron.prixapi.${Date.now()}@merx.test`,
  worker: `employe.prixapi.${Date.now()}@merx.test`,
}

type Role = 'owner' | 'worker'
const ROLES = ['owner', 'worker'] as const

let client: Client

const authUsers: Record<Role, string> = { owner: '', worker: '' }
const tokens: Record<Role, string> = { owner: '', worker: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  /** Plancher à 11,50. */
  variant: '',
  ownerAppUser: '',
  shortYear: '',
}

let numbered = 0

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

/** Un brouillon, posé en `postgres` : un préparatif ne mesure rien. */
async function draft(totals = '0'): Promise<string> {
  return (
    await one<{ id: string }>(
      'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,' +
        " created_by, subtotal, total) values ($1, 'delivery_note', $2, $3, $4, $5, $5)" +
        ' returning id',
      [fixture.tenant, fixture.warehouse, fixture.device, fixture.ownerAppUser, totals],
    )
  ).id
}

/** La charge d'une ligne, telle que l'écran l'envoie — sans `line_total`. */
function linePayload(
  document: string,
  unitPrice: string,
  source: 'auto' | 'manual' = 'manual',
  overridden: string | null = '12.00',
): Record<string, unknown> {
  return {
    sale_document_id: document,
    variant_id: fixture.variant,
    quantity: '1.000',
    unit_price: unitPrice,
    price_source: source,
    overridden_price: overridden,
  }
}

function confirmation(): Record<string, unknown> {
  numbered += 1
  return {
    status: 'confirmed',
    doc_number: `BL-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`,
    issued_at: new Date().toISOString(),
  }
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

  for (const role of ROLES) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  fixture.tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name)' +
        " values (gen_random_uuid(), 'Prix API E4-04') returning id",
    )
  ).id
  fixture.warehouse = (
    await one<{ id: string }>('select id from public.warehouse where tenant_id = $1 and is_default', [
      fixture.tenant,
    ])
  ).id
  fixture.device = (
    await one<{ id: string }>(
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A') returning id",
      [fixture.tenant],
    )
  ).id

  fixture.ownerAppUser = (
    await one<{ id: string }>(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
        " values ($1, $2, 'Patron', 'owner') returning id",
      [fixture.tenant, authUsers.owner],
    )
  ).id
  await client.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      " values ($1, $2, 'Employé', 'worker')",
    [fixture.tenant, authUsers.worker],
  )

  const product = await one<{ id: string }>(
    "insert into public.product (tenant_id, name_fr) values ($1, 'Savon noir') returning id",
    [fixture.tenant],
  )
  fixture.variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [fixture.tenant, product.id],
    )
  ).id
  await client.query('update public.variant set floor_price = 11.50 where id = $1', [
    fixture.variant,
  ])

  fixture.shortYear = (
    await one<{ short: string }>(
      "select to_char(merx.document_number_year(now()) % 100, 'FM00') as short",
    )
  ).short

  for (const role of ROLES) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    /*
     * Les lignes avant les documents : les gardes sont levés pour ranger, et
     * `session_replication_role = replica` suspend aussi les clés étrangères —
     * donc la cascade de `sale_line` ne partirait pas (CLAUDE.md).
     */
    await withoutTriggers(client, async () => {
      await client.query('delete from public.audit_log where tenant_id = $1', [fixture.tenant])
      await client.query('delete from public.sale_line where tenant_id = $1', [fixture.tenant])
      await client.query('delete from public.sale_document where tenant_id = $1', [fixture.tenant])
      await client.query('delete from public.document_sequence where tenant_id = $1', [
        fixture.tenant,
      ])
    })
    await client.query('delete from public.product where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.app_user where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.device where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.warehouse where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.tenant where id = $1', [fixture.tenant])
  }
  for (const role of ROLES) {
    if (authUsers[role] !== '') await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/* ========================================================================== */
/* Le plancher — 403                                                           */
/* ========================================================================== */

describe('une ligne sous le plancher, par l’API', () => {
  it('est refusée à l’employé en 403, et la phrase du garde sort de l’API', async () => {
    const document = await draft()

    const refused = await rest('sale_line', {
      token: tokens.worker,
      method: 'POST',
      body: linePayload(document, '10.00'),
    })

    expect(refused.status).toBe(DENIED_HTTP)
    expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(refused.body).toContain(BELOW_FLOOR)

    const written = await one<{ count: string }>(
      'select count(*)::text as count from public.sale_line where sale_document_id = $1',
      [document],
    )
    expect(written.count).toBe('0')
  })

  it('passe pour le patron — override_price_below_floor', async () => {
    const document = await draft()

    const created = await rest('sale_line', {
      token: tokens.owner,
      method: 'POST',
      body: linePayload(document, '10.00'),
    })

    expect(created.status).toBe(CREATED_HTTP)
  })

  /*
   * Le contrôle positif de l'employé : sans lui, le refus ci-dessus passerait
   * pour n'importe quelle raison — une policy, un privilège, une charge
   * incomplète.
   */
  it('passe pour l’employé au-dessus du plancher', async () => {
    const document = await draft()

    const created = await rest('sale_line', {
      token: tokens.worker,
      method: 'POST',
      body: linePayload(document, '12.00', 'manual', '13.00'),
    })

    expect(created.status).toBe(CREATED_HTTP)
  })
})

/* ========================================================================== */
/* La forme d'un forçage — 400                                                 */
/* ========================================================================== */

describe('un forçage mal formé, par l’API', () => {
  it('est refusé en 400, et la contrainte est nommée', async () => {
    const document = await draft()

    const refused = await rest('sale_line', {
      token: tokens.owner,
      method: 'POST',
      body: linePayload(document, '12.00', 'auto', '13.00'),
    })

    expect(refused.status).toBe(INVALID_HTTP)
    expect(refused.code).toBe(CHECK_VIOLATION)
    expect(refused.body).toContain(OVERRIDE_SHAPE)
  })
})

/* ========================================================================== */
/* La cohérence des totaux — 400                                               */
/* ========================================================================== */

describe('la confirmation d’un document, par l’API', () => {
  it('est refusée en 400 quand le sous-total ne dit pas la vérité', async () => {
    const document = await draft('500')
    await rest('sale_line', {
      token: tokens.owner,
      method: 'POST',
      body: linePayload(document, '12.00', 'auto', null),
    })

    const refused = await rest(`sale_document?id=eq.${document}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: confirmation(),
    })

    expect(refused.status).toBe(INVALID_HTTP)
    expect(refused.code).toBe(CHECK_VIOLATION)
    expect(JSON.parse(refused.body)).toMatchObject({
      message: expect.stringContaining(TOTALS_LIE),
    })

    const still = await one<{ status: string }>(
      'select status from public.sale_document where id = $1',
      [document],
    )
    expect(still.status).toBe('draft')
  })

  it('passe quand le sous-total est celui des lignes', async () => {
    const document = await draft('12')
    await rest('sale_line', {
      token: tokens.owner,
      method: 'POST',
      body: linePayload(document, '12.00', 'auto', null),
    })

    const confirmed = await rest(`sale_document?id=eq.${document}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: confirmation(),
    })

    expect(confirmed.ok).toBe(true)
    expect(confirmed.rows).toHaveLength(1)
  })

  /*
   * `line_total` est engendrée : la base la calcule, et l'écran ne l'envoie
   * pas. Une valeur fournie est refusée — c'est ce que la note d'E9-01 retient,
   * parce qu'une synchronisation qui la renverrait bloquerait la file sur une
   * écriture qui ne passera jamais.
   */
  it('refuse une ligne qui prétend dire son propre total', async () => {
    const document = await draft()

    const refused = await rest('sale_line', {
      token: tokens.owner,
      method: 'POST',
      body: { ...linePayload(document, '12.00', 'auto', null), line_total: '99.00' },
    })

    expect(refused.ok).toBe(false)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)
  })
})
