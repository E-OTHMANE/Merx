// @vitest-environment node

/*
 * E4-06 — les retours vus de PostgREST.
 *
 * `returns.test.ts` éprouve les gardes en SQL, dans une transaction annulée. Il
 * ne peut pas éprouver l'API : PostgREST est un autre processus, qui ne verrait
 * rien d'une transaction ouverte là-bas, et c'est lui qui traduit un SQLSTATE
 * en code HTTP. Le statut est donc **mesuré** ici, jamais lu sur une table de
 * correspondance (SPEC § 4, RÈGLE des refus en 4xx) — en E9, PowerSync lit un
 * 5xx comme une panne passagère et rejoue sans fin, ce qui bloquerait la file
 * de l'appareil sur un refus définitif.
 *
 * Deux codes neufs passent ici pour la première fois :
 *
 *   — `PT400` du registre du bon (RÈGLE M3-9), dans ses **deux** branches : la
 *     quantité et l'avoir ;
 *   — `PT409` du bon qu'un retour vivant empêche d'annuler.
 *
 * Et chaque refus a son contrôle positif, sans quoi un refus venu de
 * l'isolation, d'un privilège manquant ou d'une requête mal formée passerait
 * tous les tests sans qu'aucun garde existe (CLAUDE.md ; E1-01, E4-05).
 *
 * Les lignes sont **validées**, pas posées dans une transaction. Le démontage
 * est donc explicite, dans l'ordre inverse des dépendances.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, INSUFFICIENT_PRIVILEGE, withoutTriggers } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'returns-api-e4-06-password'

/* Les statuts réellement rendus, mesurés ici et non supposés. */
const DENIED_HTTP = 403
const INVALID_HTTP = 400
const CONFLICT_HTTP = 409

const CHECK_VIOLATION = '23514'
/** Le registre du bon : « demande impossible à satisfaire ». */
const UNSATISFIABLE = 'PT400'

/* Les phrases des gardes — chacune n'est dite que par le sien. */
const OVER_QUANTITY = "rend plus que le bon n'a livré"
const OVER_CREDIT = "crédite plus que le bon n'a facturé"
const RETURN_BLOCKS_CANCEL = 'porte un retour non annulé'
const NOT_BY_HAND = "ne s'écrit pas à la main"

const emails = {
  owner: `patron.retourapi.${Date.now()}@merx.test`,
  worker: `employe.retourapi.${Date.now()}@merx.test`,
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
  variant: '',
  ownerAppUser: '',
  shortYear: '',
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

const DOC_CODES: Record<string, string> = {
  quote: 'DV',
  order: 'CM',
  delivery_note: 'BL',
  return: 'RT',
}

let numbered = 0

function nextNumber(docType: string): string {
  numbered += 1
  return `${DOC_CODES[docType]}-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`
}

type Line = readonly [quantity: string, unitPrice: string]

/**
 * Un brouillon et ses lignes, posés en `postgres` : un préparatif ne mesure
 * rien. `line_total` est engendrée, et les totaux disent la vérité sur les
 * lignes — `merx.require_consistent_totals()` les relit à la confirmation.
 */
async function draft(
  docType: string,
  lines: readonly Line[],
  source: string | null = null,
): Promise<string> {
  const subtotal = lines
    .reduce((sum, [quantity, price]) => sum + Number(quantity) * Number(price), 0)
    .toFixed(2)

  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, created_by,' +
      ' subtotal, total, source_document_id)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4, $5, $6, $6, $7) returning id',
    [
      fixture.tenant,
      docType,
      fixture.warehouse,
      fixture.device,
      fixture.ownerAppUser,
      subtotal,
      source,
    ],
  )
  for (const [quantity, price] of lines) {
    await client.query(
      'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity,' +
        ' unit_price, created_by) values ($1, $2, $3, $4, $5, $6)',
      [fixture.tenant, doc.id, fixture.variant, quantity, price, fixture.ownerAppUser],
    )
  }
  return doc.id
}

/** La confirmation telle que l'écran l'envoie : statut, numéro et date d'un geste. */
async function confirmByApi(
  document: string,
  docType: string,
  role: Role = 'worker',
): Promise<Awaited<ReturnType<typeof rest>>> {
  return await rest(`sale_document?id=eq.${document}`, {
    token: tokens[role],
    method: 'PATCH',
    body: {
      status: 'confirmed',
      doc_number: nextNumber(docType),
      issued_at: new Date().toISOString(),
    },
  })
}

async function confirmed(
  docType: string,
  lines: readonly Line[],
  source: string | null = null,
): Promise<string> {
  const id = await draft(docType, lines, source)
  const result = await confirmByApi(id, docType)
  expect(result.ok, result.body).toBe(true)
  return id
}

/** Pose du stock, par l'API et sous le jeton du patron — l'ajustement est audité. */
async function stockUp(quantity: string): Promise<void> {
  const result = await rest('stock_movement', {
    token: tokens.owner,
    method: 'POST',
    body: {
      variant_id: fixture.variant,
      warehouse_id: fixture.warehouse,
      movement_type: 'adjustment',
      quantity,
      note: 'mise en stock',
    },
  })
  expect(result.ok, result.body).toBe(true)
}

async function movementsOf(
  document: string,
): Promise<Array<{ movement_type: string; quantity: string }>> {
  const { rows } = await client.query<{ movement_type: string; quantity: string }>(
    'select movement_type::text as movement_type, quantity::text as quantity' +
      ' from public.stock_movement where source_id = $1 order by movement_type',
    [document],
  )
  return rows
}

async function level(): Promise<string> {
  return (
    await one<{ quantity: string }>(
      'select quantity::text as quantity from public.stock_level where variant_id = $1',
      [fixture.variant],
    )
  ).quantity
}

async function statusOf(document: string): Promise<string> {
  return (
    await one<{ status: string }>(
      'select status::text as status from public.sale_document where id = $1',
      [document],
    )
  ).status
}

/** Un bon de livraison confirmé par l'API, de dix pièces à 9 DH. */
async function deliveredNote(): Promise<string> {
  return await confirmed('delivery_note', [['10', '9.00']])
}

/* -------------------------------------------------------------------------- */
/* Préparatifs                                                                 */
/* -------------------------------------------------------------------------- */

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
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1)' +
        ' returning id',
      ['Retours API E4-06'],
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
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A')" +
        ' returning id',
      [fixture.tenant],
    )
  ).id
  const product = await one<{ id: string }>(
    "insert into public.product (tenant_id, name_fr) values ($1, 'Crème') returning id",
    [fixture.tenant],
  )
  fixture.variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [fixture.tenant, product.id],
    )
  ).id

  fixture.shortYear = (
    await one<{ short: string }>(
      "select to_char(merx.document_number_year(now()) % 100, 'FM00') as short",
    )
  ).short

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

  for (const role of ROLES) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }

  // Assez de stock pour tous les cas : chacun sort dix pièces d'un bon.
  await stockUp('1000')
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    const tenant = fixture.tenant
    if (tenant !== '') {
      /*
       * Les gardes sont levés pour ranger, et `session_replication_role =
       * replica` suspend aussi les clés étrangères : les lignes partent donc
       * avant les documents, la cascade ne le ferait pas (CLAUDE.md).
       */
      await withoutTriggers(client, async () => {
        await client.query('delete from public.audit_log where tenant_id = $1', [tenant])
        await client.query('delete from public.stock_movement where tenant_id = $1', [tenant])
        await client.query('delete from public.stock_level where tenant_id = $1', [tenant])
        await client.query('delete from public.sale_line where tenant_id = $1', [tenant])
        // Les enfants avant les parents : la filiation ne cascade pas.
        await client.query(
          'delete from public.sale_document where tenant_id = $1 and source_document_id is not null',
          [tenant],
        )
        await client.query('delete from public.sale_document where tenant_id = $1', [tenant])
        await client.query('delete from public.document_sequence where tenant_id = $1', [tenant])
      })
      await client.query('delete from public.product where tenant_id = $1', [tenant])
      await client.query('delete from public.app_user where tenant_id = $1', [tenant])
      await client.query('delete from public.device where tenant_id = $1', [tenant])
      await client.query('delete from public.warehouse where tenant_id = $1', [tenant])
      await client.query('delete from public.tenant where id = $1', [tenant])
    }
  }
  for (const role of ROLES) {
    if (authUsers[role] !== '') await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/* ========================================================================== */
/* 1. Le retour par l'API — le contrôle positif                                */
/* ========================================================================== */

describe('un retour enregistré par l’API', () => {
  /*
   * Le chemin de l'écran, de bout en bout : le brouillon porte son origine, les
   * lignes partent en un appel, la confirmation pose le numéro — et le stock
   * revient. Ni `tenant_id`, ni `warehouse_id`, ni `created_by` ne sont
   * envoyés : ils ont pour défaut le commerce, le dépôt et la fiche du jeton.
   */
  it('remet le stock, sous le jeton de l’employé', async () => {
    const note = await deliveredNote()
    const before = Number(await level())

    const created = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      // `rest()` demande déjà `return=representation` : la ligne créée revient.
      body: {
        doc_type: 'return',
        device_id: fixture.device,
        source_document_id: note,
        subtotal: '27.00',
        total: '27.00',
        notes: 'emballage abîmé',
      },
    })
    expect(created.ok, created.body).toBe(true)
    const back = (JSON.parse(created.body) as Array<{ id: string }>)[0]!.id

    const lines = await rest('sale_line', {
      token: tokens.worker,
      method: 'POST',
      body: [
        {
          sale_document_id: back,
          variant_id: fixture.variant,
          quantity: '3',
          unit_price: '9.00',
          price_source: 'manual',
        },
      ],
    })
    expect(lines.ok, lines.body).toBe(true)

    const confirmation = await confirmByApi(back, 'return')
    expect(confirmation.ok, confirmation.body).toBe(true)

    expect(await movementsOf(back)).toEqual([{ movement_type: 'return', quantity: '3.000' }])
    expect(Number(await level())).toBe(before + 3)
    // Le motif est resté sur le document : il s'imprimera (E5-01).
    const saved = await one<{ notes: string | null }>(
      'select notes from public.sale_document where id = $1',
      [back],
    )
    expect(saved.notes).toBe('emballage abîmé')
  })

  it('refuse un retour sans bon d’origine, en 400 mesuré', async () => {
    const result = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      body: { doc_type: 'return', device_id: fixture.device },
    })

    expect(result.ok, 'FUITE — un retour issu de rien, par l’API').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(CHECK_VIOLATION)
    expect(result.body).toContain('sale_document_return_has_source')
  })
})

/* ========================================================================== */
/* 2. Le registre du bon — RÈGLE M3-9, les deux branches en 400 mesuré         */
/* ========================================================================== */

describe('le registre du bon, vu de l’API', () => {
  it('refuse une quantité au-delà du bon, en 400 mesuré', async () => {
    const note = await deliveredNote()
    const back = await draft('return', [['12', '9.00']], note)
    const before = await level()

    const result = await confirmByApi(back, 'return')

    expect(result.ok, 'FUITE — douze pièces rendues sur un bon de dix').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(UNSATISFIABLE)
    expect(result.body).toContain(OVER_QUANTITY)
    // Aucun effet : le retour est resté brouillon, et le stock n'a pas bougé.
    expect(await statusOf(back)).toBe('draft')
    expect(await level()).toBe(before)
  })

  it('refuse un avoir au-delà du bon, en 400 mesuré', async () => {
    const note = await deliveredNote()
    const back = await draft('return', [['10', '12.00']], note)

    const result = await confirmByApi(back, 'return')

    expect(result.ok, 'FUITE — un avoir de 120 DH sur un bon de 90 DH').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(UNSATISFIABLE)
    expect(result.body).toContain(OVER_CREDIT)
    expect(await statusOf(back)).toBe('draft')
  })
})

/* ========================================================================== */
/* 3. Le POST direct d'un mouvement de retour                                  */
/* ========================================================================== */

describe('un POST direct d’un mouvement return', () => {
  for (const role of ROLES) {
    it(`est refusé au ${role === 'owner' ? 'patron' : 'employé'}, en 403 mesuré`, async () => {
      const before = await level()

      const result = await rest('stock_movement', {
        token: tokens[role],
        method: 'POST',
        body: {
          variant_id: fixture.variant,
          warehouse_id: fixture.warehouse,
          movement_type: 'return',
          quantity: '5',
        },
      })

      expect(result.ok, 'FUITE — du stock rendu par l’API, sans bon de retour').toBe(false)
      expect(result.status, result.body).toBe(DENIED_HTTP)
      expect(result.code, result.body).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.body).toContain(NOT_BY_HAND)
      expect(result.body).toContain('bon de retour')
      // Aucun effet : le stock n'a pas bougé d'une pièce.
      expect(await level()).toBe(before)
    })
  }
})

/* ========================================================================== */
/* 4. L'annulation d'un bon qui porte un retour — 409 mesuré                   */
/* ========================================================================== */

describe('l’annulation d’un bon par l’API', () => {
  it('est refusée tant qu’un retour vit, en 409 mesuré', async () => {
    const note = await deliveredNote()
    await confirmed('return', [['3', '9.00']], note)
    const before = await level()

    const result = await rest(`sale_document?id=eq.${note}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'client introuvable' },
    })

    expect(result.ok, 'FUITE — un bon annulé sous un retour vivant').toBe(false)
    expect(result.status, result.body).toBe(CONFLICT_HTTP)
    expect(result.code, result.body).toBe(FROZEN_WRITE)
    expect(result.body).toContain(RETURN_BLOCKS_CANCEL)
    // Aucun effet : ni le statut, ni le stock.
    expect(await statusOf(note)).toBe('confirmed')
    expect(await level()).toBe(before)
  })

  /* Le contrôle positif : sans retour, l'annulation passe et inverse. */
  it('passe pour un bon sans retour, et rend le stock', async () => {
    const note = await deliveredNote()
    const before = Number(await level())

    const result = await rest(`sale_document?id=eq.${note}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'client absent' },
    })

    expect(result.ok, result.body).toBe(true)
    expect(Number(await level())).toBe(before + 10)
  })
})
