// @vitest-environment node

/*
 * E4-05 — le cycle des documents vu de PostgREST.
 *
 * `sale-lifecycle.test.ts` éprouve les gardes en SQL, dans une transaction
 * annulée. Il ne peut pas éprouver l'API : PostgREST est un autre processus,
 * qui ne verrait rien d'une transaction ouverte là-bas, et c'est lui qui
 * traduit un SQLSTATE en code HTTP. Le statut est donc **mesuré** ici, jamais
 * lu sur une table de correspondance (SPEC § 4, RÈGLE des refus en 4xx) — en
 * E9, PowerSync lit un 5xx comme une panne passagère et rejoue sans fin.
 *
 * Trois chemins, et chacun son contrôle positif — sans quoi un refus venu de
 * l'isolation, d'un privilège manquant ou d'une requête mal formée passerait
 * tous les tests de refus sans qu'aucun garde existe :
 *
 *   1. la confirmation d'un bon par l'API **écrit** les mouvements de vente, et
 *      c'est l'employé qui confirme : la policy du type s'applique à lui,
 *      puisque `merx.write_sale_movements()` est en `security invoker` ;
 *   2. un `POST` direct d'un mouvement `sale` est refusé — à l'employé comme au
 *      patron. Le type est ouvert sur `create_sale`, donc la policy ne refuse
 *      personne : ce qui refuse est `merx.require_sale_origin()`, et sa phrase
 *      le dit ;
 *   3. la transformation par l'API — admise, puis refusée dans chacune de ses
 *      quatre fautes, et à la frontière du commerce.
 *
 * Les lignes sont **validées**, pas posées dans une transaction. Le démontage
 * est donc explicite, dans l'ordre inverse des dépendances.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, withoutTriggers } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'lifecycle-api-e4-05-password'

/* Les statuts réellement rendus, mesurés ici et non supposés. */
const DENIED_HTTP = 403
const INVALID_HTTP = 400
const CONFLICT_HTTP = 409

const INVALID_PARAMETER = '22023'
const FOREIGN_KEY_VIOLATION = '23503'

/* Les phrases des gardes — chacune n'est dite que par le sien. */
const NOT_BY_HAND = "ne s'écrit pas à la main"
const SOURCE_DRAFT = 'encore un brouillon'
const SOURCE_CANCELLED = 'est annulé'
const CHAIN_REFUSED = 'ne donne pas un document de type'

const emails = {
  owner: `patron.cycleapi.${Date.now()}@merx.test`,
  worker: `employe.cycleapi.${Date.now()}@merx.test`,
  neighbour: `voisin.cycleapi.${Date.now()}@merx.test`,
}

type Role = 'owner' | 'worker' | 'neighbour'
const ROLES = ['owner', 'worker', 'neighbour'] as const

let client: Client

const authUsers: Record<Role, string> = { owner: '', worker: '', neighbour: '' }
const tokens: Record<Role, string> = { owner: '', worker: '', neighbour: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  variant: '',
  ownerAppUser: '',
  shortYear: '',
  other: { tenant: '', warehouse: '', device: '', variant: '' },
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

async function tenantWithVariant(
  name: string,
): Promise<{ tenant: string; warehouse: string; device: string; variant: string }> {
  const tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1)' +
        ' returning id',
      [name],
    )
  ).id
  // Le dépôt naît avec le commerce (trigger `open_default_warehouse`, E3-02).
  const warehouse = (
    await one<{ id: string }>(
      'select id from public.warehouse where tenant_id = $1 and is_default',
      [tenant],
    )
  ).id
  const device = (
    await one<{ id: string }>(
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A')" +
        ' returning id',
      [tenant],
    )
  ).id
  const product = await one<{ id: string }>(
    "insert into public.product (tenant_id, name_fr) values ($1, 'Crème') returning id",
    [tenant],
  )
  // La variante par défaut porte l'identifiant de son produit depuis E2-01.
  const variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [tenant, product.id],
    )
  ).id
  return { tenant, warehouse, device, variant }
}

const DOC_CODES: Record<string, string> = { quote: 'DV', order: 'CM', delivery_note: 'BL' }

let numbered = 0

function nextNumber(docType: string): string {
  numbered += 1
  return `${DOC_CODES[docType]}-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`
}

/**
 * Un brouillon d'une ligne, posé en `postgres` : un préparatif ne mesure rien.
 * Les totaux disent la vérité sur la ligne — `merx.require_consistent_totals()`
 * les relit à la confirmation (E4-04) — et `line_total` est engendrée.
 */
async function draft(docType: string, source: string | null = null): Promise<string> {
  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, created_by,' +
      ' subtotal, total, source_document_id)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4, $5, 30.00, 30.00, $6) returning id',
    [fixture.tenant, docType, fixture.warehouse, fixture.device, fixture.ownerAppUser, source],
  )
  await client.query(
    'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity,' +
      " unit_price, created_by) values ($1, $2, $3, '3', '10.00', $4)",
    [fixture.tenant, doc.id, fixture.variant, fixture.ownerAppUser],
  )
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

/** Un document confirmé, par l'API — et on exige que ça ait abouti. */
async function confirmed(docType: string, source: string | null = null): Promise<string> {
  const id = await draft(docType, source)
  const result = await confirmByApi(id, docType)
  expect(result.ok, result.body).toBe(true)
  return id
}

/**
 * Pose du stock, par l'API et sous le jeton du patron : l'`adjustment` est
 * audité, et `merx.log_audit()` prend son auteur du jeton (E1-04, E3-03).
 */
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

  const main = await tenantWithVariant('Cycle API E4-05')
  fixture.tenant = main.tenant
  fixture.warehouse = main.warehouse
  fixture.device = main.device
  fixture.variant = main.variant
  fixture.other = await tenantWithVariant('Voisin cycle API E4-05')

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
  // Le voisin est **patron** chez lui : son cas mesure l'isolation, pas un
  // droit manquant.
  await client.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      " values ($1, $2, 'Patron du voisin', 'owner')",
    [fixture.other.tenant, authUsers.neighbour],
  )

  for (const role of ROLES) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }

  // Assez de stock pour tous les cas du fichier : chacun en sort trois pièces.
  await stockUp('1000')
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    for (const tenant of [fixture.tenant, fixture.other.tenant]) {
      if (tenant === '') continue
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
      // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
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
/* 1. La confirmation par l'API écrit les mouvements — RÈGLE M3-5              */
/* ========================================================================== */

describe('la confirmation d’un bon par l’API', () => {
  it('écrit le mouvement de vente de l’employé qui confirme', async () => {
    const before = await level()
    const id = await confirmed('delivery_note')

    expect(await movementsOf(id)).toEqual([{ movement_type: 'sale', quantity: '-3.000' }])
    expect(Number(await level())).toBe(Number(before) - 3)
  })

  it('n’écrit rien pour un devis confirmé par la même requête', async () => {
    const before = await level()
    const id = await confirmed('quote')

    expect(await movementsOf(id)).toEqual([])
    expect(await level()).toBe(before)
  })
})

/* ========================================================================== */
/* 2. Le POST direct d'un mouvement de vente                                   */
/* ========================================================================== */

describe('un POST direct d’un mouvement sale', () => {
  for (const role of ['owner', 'worker'] as const) {
    it(`est refusé au ${role === 'owner' ? 'patron' : 'employé'}, en 403 mesuré`, async () => {
      const before = await level()

      const result = await rest('stock_movement', {
        token: tokens[role],
        method: 'POST',
        body: {
          variant_id: fixture.variant,
          warehouse_id: fixture.warehouse,
          movement_type: 'sale',
          quantity: '-1',
        },
      })

      expect(result.ok, 'FUITE — un mouvement de vente posé par l’API').toBe(false)
      expect(result.status, result.body).toBe(DENIED_HTTP)
      expect(result.code, result.body).toBe(INSUFFICIENT_PRIVILEGE)
      expect(result.body).toContain(NOT_BY_HAND)
      // Aucun effet : le stock n'a pas bougé d'une pièce.
      expect(await level()).toBe(before)
    })
  }
})

/* ========================================================================== */
/* 3. La transformation par l'API — RÈGLE M3-4                                 */
/* ========================================================================== */

describe('la transformation par l’API', () => {
  /*
   * Le contrôle positif, et c'est aussi le chemin de l'écran : ni `tenant_id`,
   * ni `warehouse_id`, ni `created_by` ne sont envoyés — ils ont pour défaut le
   * commerce, le dépôt et la fiche du jeton (E4-03).
   */
  it('crée un document lié, et l’original n’est pas touché', async () => {
    const quote = await confirmed('quote')

    const result = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      body: { doc_type: 'order', device_id: fixture.device, source_document_id: quote },
    })

    expect(result.ok, result.body).toBe(true)
    const { rows } = await client.query<{ id: string; source_document_id: string }>(
      'select id, source_document_id from public.sale_document where source_document_id = $1',
      [quote],
    )
    expect(rows).toHaveLength(1)

    // L'original garde son statut et son type : rien ne l'a muté.
    const original = await one<{ status: string; doc_type: string }>(
      'select status::text, doc_type::text from public.sale_document where id = $1',
      [quote],
    )
    expect(original).toEqual({ status: 'confirmed', doc_type: 'quote' })
  })

  it('refuse une chaîne impossible, en 400 mesuré', async () => {
    const note = await confirmed('delivery_note')

    const result = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      body: { doc_type: 'order', device_id: fixture.device, source_document_id: note },
    })

    expect(result.ok, 'FUITE — un bon transformé en commande').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(INVALID_PARAMETER)
    expect(result.body).toContain(CHAIN_REFUSED)
  })

  it('refuse un original encore brouillon, en 400 mesuré', async () => {
    const quote = await draft('quote')

    const result = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      body: { doc_type: 'order', device_id: fixture.device, source_document_id: quote },
    })

    expect(result.ok, 'FUITE — un brouillon transformé').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(INVALID_PARAMETER)
    expect(result.body).toContain(SOURCE_DRAFT)
  })

  it('refuse un original annulé, en 400 mesuré', async () => {
    const quote = await confirmed('quote')
    const cancelled = await rest(`sale_document?id=eq.${quote}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'client parti' },
    })
    expect(cancelled.ok, cancelled.body).toBe(true)

    const result = await rest('sale_document', {
      token: tokens.worker,
      method: 'POST',
      body: { doc_type: 'order', device_id: fixture.device, source_document_id: quote },
    })

    expect(result.ok, 'FUITE — un document annulé transformé').toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(INVALID_PARAMETER)
    expect(result.body).toContain(SOURCE_CANCELLED)
  })

  /*
   * La frontière du commerce. Le voisin est patron chez lui, et le document
   * qu'il crée est bien le sien : ce n'est donc pas l'isolation en écriture qui
   * refuse, mais la clé composite de la filiation — `23503`, rendu 409.
   */
  it('refuse un original du commerce voisin, en 409 mesuré', async () => {
    const mine = await confirmed('quote')

    const result = await rest('sale_document', {
      token: tokens.neighbour,
      method: 'POST',
      body: {
        doc_type: 'order',
        device_id: fixture.other.device,
        source_document_id: mine,
      },
    })

    expect(result.ok, 'FUITE — le voisin s’est rattaché à notre devis').toBe(false)
    expect(result.status, result.body).toBe(CONFLICT_HTTP)
    expect(result.code, result.body).toBe(FOREIGN_KEY_VIOLATION)
    expect(result.body).toContain('sale_document_source_document_id_fkey')
  })
})
