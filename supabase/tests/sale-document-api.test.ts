// @vitest-environment node

/*
 * E4-01 — le modèle document vu de PostgREST.
 *
 * `sale-document.test.ts` éprouve les gardes en SQL, dans une transaction
 * annulée, et presque toujours en `postgres` : c'est là que se mesure ce que la
 * base refuse, sans qu'un privilège ou une policy ne vienne répondre à sa
 * place. Il ne peut pas éprouver l'API — PostgREST est un autre processus, qui
 * ne verrait rien d'une transaction ouverte ici, et c'est lui qui traduit un
 * SQLSTATE en code HTTP. Un garde juste en SQL peut sortir de l'API en `500`
 * muet — et c'est arrivé : voir les statuts mesurés plus bas.
 *
 * Trois chemins, ceux que l'écran de vente empruntera (E4-03) :
 *
 *   1. un `PATCH` sur un document confirmé — le contenu est figé (RÈGLE M3-3) ;
 *   2. l'annulation par l'API — admise au patron, refusée à l'employé, et les
 *      mouvements inverses écrits sous la policy de leur type ;
 *   3. un `POST` direct d'un mouvement `sale_cancellation` — jamais à la main.
 *
 * Chaque refus est lu sur ce qui sort réellement : le code rendu par PostgREST
 * et la phrase du garde. Et chacun a son contrôle positif : un refus qui
 * viendrait de l'isolation, d'un privilège manquant ou d'une requête mal formée
 * passerait tous les tests de refus sans qu'aucun garde existe.
 *
 * Les lignes sont **validées**, pas posées dans une transaction : voir plus
 * haut. Le démontage est donc explicite, dans l'ordre inverse des dépendances.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, INSUFFICIENT_PRIVILEGE, withoutTrigger, withoutTriggers } from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'document-api-e4-01-password'

/*
 * Les statuts HTTP réellement rendus, mesurés ici et non supposés.
 *
 * C'est ce fichier qui a montré le défaut : les gardes des tables figées
 * levaient `55006`, qu'aucune table de correspondance de PostgREST ne connaît,
 * et le refus sortait en **`500`**. Un 5xx dit « panne passagère » à PowerSync,
 * qui rejoue alors sans fin une écriture qui ne passera jamais (SPEC § 4,
 * RÈGLE des refus en 4xx). Les gardes lèvent désormais `PT409`, dont les trois
 * chiffres *sont* le statut.
 */
const FROZEN_HTTP = 409
const DENIED_HTTP = 403
/* E4-02 — l'unicité du numéro et le garde de sa forme. */
const CONFLICT_HTTP = 409
const INVALID_HTTP = 400
const UNIQUE_VIOLATION = '23505'
const INVALID_PARAMETER = '22023'

/* Les phrases des gardes — chacune n'est dite que par le sien. */
const CONTENT_FROZEN = 'ne se modifie plus'
const NOT_DELETABLE = 'ne se supprime pas'
const NO_CANCEL_RIGHT = 'Annuler un document exige la capacité cancel_document'
const NOT_BY_HAND = "ne s'écrit pas à la main"
/*
 * Dans le corps JSON de PostgREST, les guillemets de la phrase de Postgres sont
 * échappés : la chaîne attendue les porte échappés aussi. Et elle nomme la
 * table — un refus de policy sur une *autre* table répondrait le même `42501`
 * avec la même tournure (CLAUDE.md, E2-03).
 */
const RLS_REFUSAL =
  'row-level security policy \\"column_capability_insert\\" for table \\"stock_movement\\"'

const emails = {
  owner: `patron.docapi.${Date.now()}@merx.test`,
  worker: `employe.docapi.${Date.now()}@merx.test`,
  neighbour: `voisin.docapi.${Date.now()}@merx.test`,
  /** E4-07 — un compte authentifié sans fiche app_user : un jeton sans commerce ni rôle. */
  stranger: `inconnu.docapi.${Date.now()}@merx.test`,
}

type Role = 'owner' | 'worker' | 'neighbour' | 'stranger'
const ROLES = ['owner', 'worker', 'neighbour', 'stranger'] as const

let client: Client

const authUsers: Record<Role, string> = { owner: '', worker: '', neighbour: '', stranger: '' }
const tokens: Record<Role, string> = { owner: '', worker: '', neighbour: '', stranger: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  variant: '',
  ownerAppUser: '',
  /** Les deux chiffres d'année que porte un numéro — E4-02. */
  shortYear: '',
  /** Le commerce voisin, pour le contrôle d'isolation. */
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
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
      [name],
    )
  ).id
  // Le dépôt naît avec le commerce (trigger `open_default_warehouse`, E3-02).
  const warehouse = (
    await one<{ id: string }>('select id from public.warehouse where tenant_id = $1 and is_default', [
      tenant,
    ])
  ).id
  const device = (
    await one<{ id: string }>(
      "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A') returning id",
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

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Un brouillon d'une ligne, posé en `postgres`. L'écran le créera lui-même
 * (E4-03) ; ici c'est un préparatif, et un préparatif ne mesure rien.
 */
async function draft(): Promise<string> {
  const doc = await one<{ id: string }>(
    // Les totaux disent la vérité sur la ligne : 3 × 10,00. Depuis E4-04,
    // `merx.require_consistent_totals()` refuse l'inverse à la confirmation.
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id, created_by,' +
      " subtotal, total) values ($1, 'delivery_note', $2, $3, $4, 30.00, 30.00) returning id",
    [fixture.tenant, fixture.warehouse, fixture.device, fixture.ownerAppUser],
  )
  await client.query(
    // `line_total` est engendrée depuis E4-04 (RÈGLE M3-7) : elle ne s'écrit pas.
    'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity,' +
      ' unit_price, created_by)' +
      " values ($1, $2, $3, '3', '10.00', $4)",
    [fixture.tenant, doc.id, fixture.variant, fixture.ownerAppUser],
  )
  return doc.id
}

/**
 * Un document confirmé, et le mouvement `sale` qu'il a écrit. Le type `sale`
 * est fermé jusqu'à E4-05 (RÈGLE M2-5) : le garde du fermé par défaut est
 * suspendu nommément le temps de l'insertion — hors transaction, un
 * `session_replication_role` emporterait aussi les clés étrangères (CLAUDE.md).
 */
let numbered = 0

/*
 * E4-02 — la confirmation porte son numéro et sa date, que la base exige
 * valides et uniques. Le compteur est local à ce fichier : ce qu'il mesure est
 * le statut HTTP des gardes du document, pas la numérotation.
 */
async function confirmedWithSale(quantity = '-3'): Promise<string> {
  const id = await draft()
  numbered += 1
  /*
   * Deux gardes d'E4-05 sont suspendus le temps du montage, et pour la même
   * raison : ce fichier mesure le **statut HTTP** des gardes du document, et
   * son mouvement de vente est une donnée de départ posée à la quantité voulue,
   * pas une vente.
   *
   *   — `write_sale_movements` pendant la confirmation : sinon le document
   *     porterait deux fois ses mouvements, les siens et ceux posés ici ;
   *   — `require_sale_origin` pendant l'insertion directe, qu'il refuse.
   *
   * Les deux sont mesurés dans `sale-lifecycle.test.ts`, le second aussi à
   * travers PostgREST dans `sale-lifecycle-api.test.ts`.
   */
  await withoutTrigger(client, 'public.sale_document', 'write_sale_movements', async () => {
    await client.query(
      "update public.sale_document set status = 'confirmed', doc_number = $2," +
        ' issued_at = now() where id = $1',
      [id, `BL-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`],
    )
  })

  await client.query('alter table public.stock_movement disable trigger require_open_movement_type')
  try {
    await withoutTrigger(client, 'public.stock_movement', 'require_sale_origin', async () => {
      await client.query(
        'insert into public.stock_movement (tenant_id, variant_id, warehouse_id, movement_type,' +
          ' quantity, source_type, source_id, created_by)' +
          " values ($1, $2, $3, 'sale', $4, 'sale_document', $5, $6)",
        [fixture.tenant, fixture.variant, fixture.warehouse, quantity, id, fixture.ownerAppUser],
      )
    })
  } finally {
    await client.query('alter table public.stock_movement enable trigger require_open_movement_type')
  }
  return id
}

async function statusOf(document: string): Promise<string> {
  return (
    await one<{ status: string }>('select status from public.sale_document where id = $1', [document])
  ).status
}

async function movementsOf(
  document: string,
): Promise<Array<{ movement_type: string; quantity: string; note: string | null }>> {
  const { rows } = await client.query<{
    movement_type: string
    quantity: string
    note: string | null
  }>(
    'select movement_type::text as movement_type, quantity::text as quantity, note' +
      ' from public.stock_movement where source_id = $1 order by movement_type',
    [document],
  )
  return rows
}

async function cancellationCount(): Promise<string> {
  return (
    await one<{ count: string }>(
      'select count(*)::text as count from public.stock_movement where tenant_id = $1' +
        " and movement_type = 'sale_cancellation'",
      [fixture.tenant],
    )
  ).count
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

  const main = await tenantWithVariant('Documents API E4-01')
  fixture.tenant = main.tenant
  fixture.warehouse = main.warehouse
  fixture.device = main.device
  fixture.variant = main.variant
  fixture.other = await tenantWithVariant('Voisin API E4-01')

  // L'année telle que le garde du numéro la recalcule depuis `issued_at` (E4-02).
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
  // Le voisin est **patron** chez lui : il a `cancel_document`, et c'est donc
  // bien l'isolation que son cas mesure, pas un droit manquant.
  await client.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      " values ($1, $2, 'Patron du voisin', 'owner')",
    [fixture.other.tenant, authUsers.neighbour],
  )

  for (const role of ROLES) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    for (const tenant of [fixture.tenant, fixture.other.tenant]) {
      if (tenant === '') continue
      /*
       * Les lignes avant les documents : les gardes sont levés pour ranger, et
       * `session_replication_role = replica` suspend aussi les clés étrangères
       * — donc la cascade de `sale_line` ne partirait pas (CLAUDE.md).
       */
      await withoutTriggers(client, async () => {
        await client.query('delete from public.audit_log where tenant_id = $1', [tenant])
        await client.query('delete from public.stock_movement where tenant_id = $1', [tenant])
        await client.query('delete from public.stock_level where tenant_id = $1', [tenant])
        await client.query('delete from public.sale_line where tenant_id = $1', [tenant])
        await client.query('delete from public.sale_document where tenant_id = $1', [tenant])
        // Le compteur d'E4-02 : dérivé, il ne se supprime pas par la porte
        // ordinaire, et sa clé vers `app_user` retiendrait le rangement.
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
/* 1. Le contenu d'un document confirmé, par l'API                             */
/* ========================================================================== */

describe('un PATCH sur un document confirmé', () => {
  it('est refusé, et la phrase du garde sort de l’API', async () => {
    const id = await confirmedWithSale()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { notes: 'remise accordée après coup' },
    })

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(FROZEN_HTTP)
    expect(result.code, result.body).toBe(FROZEN_WRITE)
    expect(result.body).toContain(CONTENT_FROZEN)
    // Et rien n'a bougé : un refus qui laisse la ligne changée n'est pas un refus.
    const row = await one<{ notes: string | null }>(
      'select notes from public.sale_document where id = $1',
      [id],
    )
    expect(row.notes).toBeNull()
  })

  it('tandis qu’un brouillon se modifie bien, lui, par le même chemin', async () => {
    const id = await draft()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { notes: 'à livrer lundi' },
    })

    /*
     * Sans ce contrôle, le cas précédent serait satisfait par un `PATCH` que
     * PostgREST refuse pour une raison étrangère au garde — un privilège
     * manquant, une policy, un corps mal formé.
     */
    expect(result.ok, result.body).toBe(true)
    expect((result.rows[0] as unknown as { notes: string }).notes).toBe('à livrer lundi')
  })

  it('et un DELETE sur un document confirmé est refusé aussi', async () => {
    const id = await confirmedWithSale()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.owner,
      method: 'DELETE',
    })

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(FROZEN_HTTP)
    expect(result.code, result.body).toBe(FROZEN_WRITE)
    expect(result.body).toContain(NOT_DELETABLE)
    expect(await statusOf(id)).toBe('confirmed')
  })
})

/* ========================================================================== */
/* 2. L'annulation par l'API                                                   */
/* ========================================================================== */

describe('l’annulation par l’API', () => {
  it('passe pour le patron, et écrit le mouvement inverse', async () => {
    const id = await confirmedWithSale('-3')

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'erreur de saisie' },
    })

    expect(result.ok, result.body).toBe(true)
    expect((result.rows[0] as unknown as { status: string }).status).toBe('cancelled')

    // L'inverse de ce qui a bougé, pas un recalcul depuis les lignes.
    const movements = await movementsOf(id)
    expect(movements.map((m) => m.movement_type)).toEqual(['sale', 'sale_cancellation'])
    const reversal = movements.find((m) => m.movement_type === 'sale_cancellation')!
    expect(reversal.quantity).toBe('3.000')
    expect(reversal.note).toContain('erreur de saisie')

    // Et la trace, qui est le seul souvenir du motif une fois l'écran fermé.
    const { rows: entries } = await client.query<{ action: string }>(
      'select action::text as action from public.audit_log where tenant_id = $1 and entity_id = $2',
      [fixture.tenant, id],
    )
    expect(entries.map((e) => e.action)).toEqual(['document_cancellation'])
  })

  it('est refusée à l’employé, avec la phrase du droit d’annuler', async () => {
    const id = await confirmedWithSale()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.worker,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'je range' },
    })

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(DENIED_HTTP)
    expect(result.code, result.body).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain(NO_CANCEL_RIGHT)
    // Ni le statut, ni un mouvement derrière lui.
    expect(await statusOf(id)).toBe('confirmed')
    expect((await movementsOf(id)).map((m) => m.movement_type)).toEqual(['sale'])
  })

  it('ne traverse pas la frontière du commerce', async () => {
    const id = await confirmedWithSale()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.neighbour,
      method: 'PATCH',
      body: { status: 'cancelled', cancellation_reason: 'chez le voisin' },
    })

    /*
     * Le voisin est patron : il a `cancel_document`. C'est l'isolation qui
     * l'arrête, et PostgREST ne refuse pas — il ne voit simplement aucune ligne
     * à modifier. D'où l'assertion sur l'effet, et non sur un code.
     */
    expect(result.ok, result.body).toBe(true)
    expect(result.rows, 'FUITE — le document du voisin est modifiable').toHaveLength(0)
    expect(await statusOf(id)).toBe('confirmed')
  })
})

/* ========================================================================== */
/* 3. Un mouvement d'annulation posté à la main                                */
/* ========================================================================== */

describe('un POST direct de sale_cancellation', () => {
  const post = (token: string) =>
    rest('stock_movement', {
      token,
      method: 'POST',
      body: {
        variant_id: fixture.variant,
        warehouse_id: fixture.warehouse,
        movement_type: 'sale_cancellation',
        quantity: '1000',
      },
    })

  it('est refusé au patron par le garde d’origine, et rien n’est écrit', async () => {
    const before = await cancellationCount()

    const result = await post(tokens.owner)

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(DENIED_HTTP)
    expect(result.code, result.body).toBe(INSUFFICIENT_PRIVILEGE)
    expect(result.body).toContain(NOT_BY_HAND)
    expect(await cancellationCount()).toBe(before)
  })

  it('est refusé à l’employé par la policy, qui se nomme', async () => {
    const before = await cancellationCount()

    const result = await post(tokens.worker)

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(DENIED_HTTP)
    expect(result.code, result.body).toBe(INSUFFICIENT_PRIVILEGE)
    /*
     * Deux refus, deux phrases : l'employé n'arrive jamais jusqu'au garde
     * d'origine, la policy du type le précède. Sans cette distinction, retirer
     * l'un laisserait le test de l'autre vert (CLAUDE.md, E1-02).
     */
    expect(result.body).toContain(RLS_REFUSAL)
    expect(result.body).not.toContain(NOT_BY_HAND)
    expect(await cancellationCount()).toBe(before)
  })
})

/* ========================================================================== */
/* 4. La numérotation vue de PostgREST — E4-02                                 */
/* ========================================================================== */

/*
 * Les deux refus de la numérotation, mesurés **à travers l'API**, parce que
 * c'est par là que l'appareil écrit et que c'est le statut rendu qui décide de
 * ce que PowerSync fera du refus (SPEC § 4, RÈGLE des refus en 4xx). Les codes
 * eux-mêmes sont mesurés à chaque passage par `refusal-status.test.ts` ; ce qui
 * est éprouvé ici est que les gardes sont bien **atteints** par ce chemin — et
 * que l'un n'est pas rendu en 5xx par un détour.
 *
 * `confirmDocument()` de `src/modules/sales` reconnaît le premier au nom de son
 * index et enjambe ; le second ne doit jamais arriver, puisque l'appareil
 * compose le numéro depuis sa propre lettre.
 */
describe('la numérotation, par l’API', () => {
  const confirmBody = (docNumber: string) => ({
    status: 'confirmed',
    doc_number: docNumber,
    issued_at: new Date().toISOString(),
  })

  it('refuse un numéro déjà porté, en 409, au nom de l’index', async () => {
    const taken = `BL-A-${fixture.shortYear}-09001`
    const first = await draft()
    await client.query(
      "update public.sale_document set status = 'confirmed', doc_number = $2," +
        ' issued_at = now() where id = $1',
      [first, taken],
    )

    const second = await draft()
    const result = await rest(`sale_document?id=eq.${second}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: confirmBody(taken),
    })

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(CONFLICT_HTTP)
    expect(result.code, result.body).toBe(UNIQUE_VIOLATION)
    expect(result.body).toContain('sale_document_number_per_tenant')
    // Et le brouillon est resté brouillon : un refus qui numérote n'est pas un refus.
    expect(await statusOf(second)).toBe('draft')
  })

  it('refuse la lettre d’un autre appareil, en 400, avec la phrase du garde', async () => {
    const id = await draft()

    const result = await rest(`sale_document?id=eq.${id}`, {
      token: tokens.owner,
      method: 'PATCH',
      body: confirmBody(`BL-Z-${fixture.shortYear}-00001`),
    })

    expect(result.ok, result.body).toBe(false)
    expect(result.status, result.body).toBe(INVALID_HTTP)
    expect(result.code, result.body).toBe(INVALID_PARAMETER)
    expect(result.body).toContain("n'est pas celui de cet appareil")
    expect(await statusOf(id)).toBe('draft')
  })
})

/* ========================================================================== */
/* 5. La liste des documents vue de PostgREST — E4-07                          */
/* ========================================================================== */

/*
 * `list_sale_documents()` est `security definer` : aucune policy ne s'y
 * applique, et ses deux gardes sont tout ce qui sépare la liste d'un commerce de
 * celle du voisin. `sale-document-list.test.ts` les éprouve en SQL ; ici, ce que
 * seule l'API montre — le **statut** rendu (SPEC § 4, RÈGLE des refus en 4xx),
 * et le contenu tel que l'application le reçoit, auteur compris, sous le jeton
 * d'un employé.
 *
 * Le refus du premier garde est mesuré avec un compte qui s'est authentifié mais
 * n'a **aucune fiche** : son jeton ne porte ni commerce ni rôle, donc
 * `merx.can('create_sale')` répond non. C'est le seul compte réel qui le déclenche
 * sans déclencher le privilège d'exécution, que `revoke ... from anon` tient à part.
 */
describe('la liste des documents, par l’API', () => {
  const LIST_HTTP_DENIED = 403
  /* La phrase du premier garde — aucun autre garde de la fonction ne répond 42501. */
  const NO_LIST_RIGHT = 'consulter les documents de vente'

  const list = (token: string, body: Record<string, unknown> = {}) =>
    rest('rpc/list_sale_documents', { token, method: 'POST', body })

  interface Row {
    id: string
    doc_number: string | null
    author_name: string | null
    device_label: string | null
  }

  const rowsOf = (result: { body: string }): Row[] => JSON.parse(result.body) as Row[]

  it('rend à un employé les documents du commerce, auteur et appareil compris', async () => {
    const id = await confirmedWithSale()

    const result = await list(tokens.worker)

    expect(result.ok, result.body).toBe(true)
    const found = rowsOf(result).find((row) => row.id === id)
    expect(found, 'le document du commerce n’est pas listé').toBeDefined()
    // Le nom que `app_user` refuse à l'employé, rendu par la fonction.
    expect(found?.author_name).toBe('Patron')
    expect(found?.device_label).toBe('Comptoir')
  })

  it('et le même employé ne lit pas app_user par PostgREST', async () => {
    const result = await rest('app_user?select=full_name', { token: tokens.worker })

    expect(rowsOf(result), 'FUITE — un employé lit le registre des employés').toHaveLength(0)
  })

  it('ne rend rien des documents du commerce au patron du voisin', async () => {
    const id = await confirmedWithSale()

    const result = await list(tokens.neighbour)

    expect(result.ok, result.body).toBe(true)
    expect(
      rowsOf(result).map((row) => row.id),
      'FUITE — un document d’un autre commerce est listé',
    ).not.toContain(id)
    // Et le détail, par l'identifiant réel : zéro ligne, pas une erreur.
    const detail = await list(tokens.neighbour, { p_document_id: id })
    expect(detail.status, detail.body).toBe(200)
    expect(rowsOf(detail)).toHaveLength(0)
  })

  it('refuse un compte sans commerce en 403, avec la phrase du premier garde', async () => {
    await confirmedWithSale()

    const result = await list(tokens.stranger)

    expect(result.ok, 'FUITE — la liste sort sans create_sale').toBe(false)
    expect(result.status, result.body).toBe(LIST_HTTP_DENIED)
    expect(result.code, result.body).toBe('42501')
    expect(result.body).toContain(NO_LIST_RIGHT)
  })
})
