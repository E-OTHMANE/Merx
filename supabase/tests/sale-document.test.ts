// @vitest-environment node

/*
 * E4-01 — le modèle document.
 * SPEC § 2.3 (variant_id), § 3.1 (matrice), § 4 (conventions, clés composites),
 * § 7 M2 (RÈGLES M2-2, M2-5), § 8 (RÈGLES M3-1, M3-3), § 9 (RÈGLE M8-1).
 *
 * La story la plus critique de l'épique : ce qui est confirmé ne bouge plus. Un
 * garde par façon de manquer, et chacun sa phrase — aucun ne refuse comme un
 * autre, sans quoi le test de l'un passerait sur le refus du voisin (CLAUDE.md ;
 * E1-01, E1-02, E2-01, E3-01) :
 *
 *   — **naissance.** Un document naît brouillon, jamais confirmé : sans cela
 *     ses lignes ne pourraient jamais s'écrire.
 *   — **mise à jour**, trois refus distincts : une transition non déclarée, un
 *     contenu changé sous un statut figé, une colonne étrangère à la
 *     transition. Le statut avance, le contenu ne bouge pas.
 *   — **suppression** : seul le brouillon se supprime, avec ses lignes.
 *   — **TRUNCATE** : jamais, par le privilège et par un trigger.
 *   — **lignes** : plus aucune écriture sous un document qui n'est plus brouillon.
 *   — **annulation** : le droit (`cancel_document`) est vérifié sur la
 *     transition ; le mouvement inverse est écrit sous la policy de son type.
 *     Deux niveaux, deux refus distincts, un test par niveau qui contourne
 *     l'autre.
 *   — **trace** : une entrée `document_cancellation`, et aucune autre entrée.
 *
 * Les gardes de la table figée sont éprouvés en `postgres` : ils ne dépendent
 * ni d'un privilège ni d'une policy, et un refus qui viendrait d'un de ces deux
 * étages se lirait au code (`42501`, et non `PT409`). Un seul cas passe par
 * `authenticated`, pour montrer que l'API les rencontre.
 *
 * Tout est posé dans une transaction annulée en fin de fichier. Les deux
 * comptes d'authentification vivent hors transaction (la clé étrangère
 * d'`app_user.auth_user_id` les exige) et sont supprimés au démontage.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'document-e4-01-password'

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const NOT_NULL_VIOLATION = '23502'
const INVALID_TEXT_REPRESENTATION = '22P02'

/* Les phrases des gardes — chacune n'est dite que par le sien. */
const BORN_OPEN = 'naît au statut'
const CONTENT_FROZEN = 'ne se modifie plus'
const TRANSITION_REFUSED = 'Transition de statut refusée'
const TRANSITION_COLUMNS = 'a changé aussi'
const NOT_DELETABLE = 'ne se supprime pas'
const NOT_TRUNCATABLE = 'ne se vide pas d\'un coup'
const LINES_FROZEN = 'Les lignes de sale_line ne se modifient plus'
const NO_CANCEL_RIGHT = 'Annuler un document exige la capacité cancel_document'
const NOT_BY_HAND = 'ne s\'écrit pas à la main'
const RLS_REFUSAL = 'row-level security policy "column_capability_insert"'
const CLOSED_BY_DEFAULT = 'Aucune capacité n\'ouvre les mouvements de type'
const NO_TENANT = 'Aucun commerce rattaché à ce compte'

const emails = {
  owner: `patron.doc.${Date.now()}@merx.test`,
  worker: `employe.doc.${Date.now()}@merx.test`,
}

let client: Client

const authUsers: Record<'owner' | 'worker', string> = { owner: '', worker: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  variant: '',
  variant2: '',
  /** Les deux chiffres d'année que porte un numéro — E4-02. */
  shortYear: '',
  appUsers: { owner: '', worker: '' } as Record<'owner' | 'worker', string>,
  /** Un second commerce, pour les clés composites. */
  other: { tenant: '', warehouse: '', device: '', variant: '' },
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
  const variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [tenant, product.id],
    )
  ).id
  return { tenant, warehouse, device, variant }
}

beforeAll(async () => {
  for (const role of ['owner', 'worker'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  client = await connect()
  await client.query('begin')

  const main = await tenantWithVariant('Documents E4-01')
  fixture.tenant = main.tenant
  fixture.warehouse = main.warehouse
  fixture.device = main.device
  fixture.variant = main.variant

  const second = await one<{ id: string }>(
    "insert into public.product (tenant_id, name_fr) values ($1, 'Savon') returning id",
    [fixture.tenant],
  )
  fixture.variant2 = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [fixture.tenant, second.id],
    )
  ).id

  for (const role of ['owner', 'worker'] as const) {
    fixture.appUsers[role] = (
      await one<{ id: string }>(
        'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
          ' values ($1, $2, $3, $4) returning id',
        [fixture.tenant, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
      )
    ).id
  }

  fixture.other = await tenantWithVariant('Voisin E4-01')

  // L'année telle que le garde du numéro la recalcule depuis `issued_at`.
  fixture.shortYear = (
    await one<{ short: string }>(
      "select to_char(merx.document_number_year(now()) % 100, 'FM00') as short",
    )
  ).short
})

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()

  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== '') await deleteAuthUser(authUsers[role])
  }
}, 30_000)

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

/** L'état d'une requête PostgREST : les claims du jeton signé, puis `authenticated`. */
async function asApplication(role: 'owner' | 'worker'): Promise<void> {
  await client.query('reset role')
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    JSON.stringify({
      sub: authUsers[role],
      role: 'authenticated',
      app_metadata: { tenant_id: fixture.tenant, role },
    }),
  ])
  await client.query('set local role authenticated')
}

/** Un cas, dans son point de sauvegarde, rôle remis avant de le relâcher. */
async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('reset role')
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    // Le retour au point de sauvegarde d'abord : dans une transaction avortée,
    // « reset role » lui-même est refusé, et le cas suivant hériterait de l'échec.
    await client.query('rollback to savepoint case_under_test')
    await client.query('reset role')
  }
}

type Status = 'draft' | 'confirmed' | 'delivered' | 'cancelled'

/*
 * E4-02 — une confirmation porte désormais son numéro et sa date : la base les
 * exige (`sale_document_number_when_numbered`), conformes à leur ligne
 * (`merx.require_document_number_shape`) et uniques dans le commerce
 * (`sale_document_number_per_tenant`). Le compteur est local à ce fichier : ce
 * qu'il mesure est le gel du contenu, pas la numérotation — elle a son fichier.
 */
const DOC_CODES: Readonly<Record<string, string>> = {
  quote: 'DV',
  order: 'CM',
  delivery_note: 'BL',
}

let numbered = 0

/** `BL-A-26-00001`, pour l'appareil « A » du commerce et l'année du comptoir. */
function nextNumber(docType = 'delivery_note'): string {
  numbered += 1
  return `${DOC_CODES[docType]}-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`
}

/** Un brouillon de deux lignes, posé en `postgres`. Rend l'identifiant du document. */
async function draft(docType = 'delivery_note'): Promise<string> {
  await client.query('reset role')
  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4) returning id',
    [fixture.tenant, docType, fixture.warehouse, fixture.device],
  )
  for (const [variant, quantity, price, total] of [
    [fixture.variant, '2.500', '10.00', '25.00'],
    [fixture.variant2, '1', '4.50', '4.50'],
  ] as const) {
    await client.query(
      'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price, line_total)' +
        ' values ($1, $2, $3, $4, $5, $6)',
      [fixture.tenant, doc.id, variant, quantity, price, total],
    )
  }
  return doc.id
}

/**
 * Un document dans le statut demandé. La confirmation et la livraison sont
 * posées en `postgres` ; l'annulation passe par le patron, jeton à l'appui — la
 * transition vers `cancelled` exige la capacité et le journal exige un auteur.
 */
async function documentIn(status: Status, docType = 'delivery_note'): Promise<string> {
  const id = await draft(docType)
  if (status === 'draft') return id

  await client.query(
    "update public.sale_document set status = 'confirmed', doc_number = $2, issued_at = now()" +
      ' where id = $1',
    [id, nextNumber(docType)],
  )
  if (status === 'delivered') {
    await client.query("update public.sale_document set status = 'delivered' where id = $1", [id])
  }
  if (status === 'cancelled') {
    await asApplication('owner')
    await client.query(
      "update public.sale_document set status = 'cancelled', cancellation_reason = 'erreur de saisie'" +
        ' where id = $1',
      [id],
    )
    await client.query('reset role')
  }
  return id
}

/**
 * Pose un mouvement `sale` pour un document. Le type est fermé jusqu'à E4-05 :
 * le garde du fermé par défaut est suspendu le temps de l'insertion — son
 * `alter table` est transactionnel, le point de sauvegarde du cas le défait.
 */
async function postSale(
  document: string,
  variant: string,
  quantity: string,
  movementType = 'sale',
  note: string | null = null,
): Promise<void> {
  await client.query('reset role')
  await client.query('alter table public.stock_movement disable trigger require_open_movement_type')
  await client.query(
    'insert into public.stock_movement (tenant_id, variant_id, warehouse_id, movement_type, quantity,' +
      ' source_type, source_id, note)' +
      " values ($1, $2, $3, $4::public.stock_movement_type, $5, 'sale_document', $6, $7)",
    [fixture.tenant, variant, fixture.warehouse, movementType, quantity, document, note],
  )
  await client.query('alter table public.stock_movement enable trigger require_open_movement_type')
}

async function level(variant: string): Promise<string | null> {
  await client.query('reset role')
  const { rows } = await client.query<{ quantity: string }>(
    'select quantity::text from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [variant, fixture.warehouse],
  )
  return rows[0]?.quantity ?? null
}

async function movementsOf(
  document: string,
): Promise<Array<{ movement_type: string; variant_id: string; quantity: string; note: string | null }>> {
  await client.query('reset role')
  const { rows } = await client.query<{
    movement_type: string
    variant_id: string
    quantity: string
    note: string | null
  }>(
    'select movement_type::text, variant_id, quantity::text, note from public.stock_movement' +
      ' where source_id = $1 order by created_at, quantity',
    [document],
  )
  return rows
}

async function row(document: string): Promise<{
  status: string
  notes: string | null
  total: string
  doc_number: string | null
  cancellation_reason: string | null
}> {
  await client.query('reset role')
  return one(
    'select status::text, notes, total::text, doc_number, cancellation_reason' +
      ' from public.sale_document where id = $1',
    [document],
  )
}

async function lineCount(document: string): Promise<number> {
  await client.query('reset role')
  return Number(
    (
      await one<{ n: string }>(
        'select count(*)::text as n from public.sale_line where sale_document_id = $1',
        [document],
      )
    ).n,
  )
}

async function auditEntries(): Promise<
  Array<{
    action: string
    entity_type: string
    entity_id: string
    user_id: string
    before: Record<string, string | null> | null
    after: Record<string, string | null> | null
  }>
> {
  await client.query('reset role')
  // Les montants sont relus en texte, `->>` : le pilote rend un nombre JSON
  // comme un flottant JavaScript, et une assertion qui passe par un flottant ne
  // peut pas dire que la valeur est exacte (SPEC § 4). Même procédé qu'en E3-03.
  const state = (column: 'before' | 'after'): string =>
    `case when "${column}" is null then null else jsonb_build_object(
       'doc_type', "${column}" ->> 'doc_type',
       'doc_number', "${column}" ->> 'doc_number',
       'status', "${column}" ->> 'status',
       'total', "${column}" ->> 'total',
       'cancellation_reason', "${column}" ->> 'cancellation_reason') end`
  const { rows } = await client.query(
    `select action::text as action, entity_type, entity_id, user_id,
            ${state('before')} as before, ${state('after')} as after
     from public.audit_log where tenant_id = $1 order by created_at`,
    [fixture.tenant],
  )
  return rows
}

/* ========================================================================== */
/* Le modèle                                                                   */
/* ========================================================================== */

describe('le modèle', () => {
  it('connaît trois types de document, et aucune facture fiscale', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ label: string }>(
      `select e.enumlabel::text as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid and t.typname = 'sale_doc_type'
       order by e.enumsortorder`,
    )
    expect(rows.map((r) => r.label)).toEqual(['quote', 'order', 'delivery_note'])
  })

  it('connaît quatre statuts, le brouillon en premier', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ label: string }>(
      `select e.enumlabel::text as label from pg_enum e
       join pg_type t on t.oid = e.enumtypid and t.typname = 'sale_doc_status'
       order by e.enumsortorder`,
    )
    // « draft » en premier n'est pas décoratif : isolation.ts prend la première
    // étiquette pour peupler une colonne enum.
    expect(rows.map((r) => r.label)).toEqual(['draft', 'confirmed', 'delivered', 'cancelled'])
  })

  it('refuse un type de document hors liste, la facture comprise', async () => {
    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id)
       values ('${fixture.tenant}', 'invoice', '${fixture.warehouse}')`,
    )
    expect(written.ok).toBe(false)
    if (!written.ok) expect(written.code, written.message).toBe(INVALID_TEXT_REPRESENTATION)
  })

  /*
   * SPEC § 2.3 : le stock, les prix et les lignes de vente pointent sur
   * `variant_id`, jamais sur `product_id`. `conventions.ts` le balaie aussi ;
   * ce cas le dit sur la table de la story.
   */
  it('pointe les lignes sur la variante, jamais sur le produit', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'sale_line'`,
    )
    const names = rows.map((r) => r.column_name)
    expect(names).toContain('variant_id')
    expect(names).not.toContain('product_id')
  })

  it('n\'a pas encore de client_id : la colonne naît avec la table client, en E6-01', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'sale_document'`,
    )
    expect(rows.map((r) => r.column_name)).not.toContain('client_id')
  })

  it('déclare quatre transitions, et aucune ne part de cancelled', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ from_status: string; to_status: string; cols: string }>(
      `select from_status, to_status, array_to_string(mutable_columns, ',') as cols
       from merx.frozen_transition where table_name = 'sale_document'
       order by from_status, to_status`,
    )
    expect(rows).toEqual([
      { from_status: 'confirmed', to_status: 'cancelled', cols: 'cancellation_reason' },
      { from_status: 'confirmed', to_status: 'delivered', cols: '' },
      { from_status: 'delivered', to_status: 'cancelled', cols: 'cancellation_reason' },
      { from_status: 'draft', to_status: 'confirmed', cols: '' },
    ])
  })
})

/* ========================================================================== */
/* Un brouillon est libre                                                      */
/* ========================================================================== */

describe('un brouillon', () => {
  it('s\'écrit, se modifie et se supprime comme n\'importe quelle ligne, avec ses lignes', async () => {
    await inCase(async () => {
      await asApplication('worker')

      // Ni `tenant_id` ni `created_by` : le défaut les prend au jeton (§ 4, E3-03).
      const created = await one<{ id: string; created_by: string }>(
        `insert into public.sale_document (doc_type, warehouse_id, device_id)
         values ('delivery_note', '${fixture.warehouse}', '${fixture.device}')
         returning id, created_by`,
      )
      expect(created.created_by, 'le document n\'est pas signé').toBe(fixture.appUsers.worker)

      await client.query(
        `insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price, line_total)
         values ('${created.id}', '${fixture.variant}', 1.250, 12.50, 15.63)`,
      )

      const edited = await attempt(
        client,
        `update public.sale_document set notes = 'livraison jeudi', total = 15.63
         where id = '${created.id}'`,
      )
      expect(edited.ok, edited.ok ? '' : `${edited.code} ${edited.message}`).toBe(true)

      const relined = await attempt(
        client,
        `update public.sale_line set quantity = 2 where sale_document_id = '${created.id}'`,
      )
      expect(relined.ok, relined.ok ? '' : `${relined.code} ${relined.message}`).toBe(true)

      const removed = await attempt(
        client,
        `delete from public.sale_document where id = '${created.id}'`,
      )
      expect(removed.ok, removed.ok ? '' : `${removed.code} ${removed.message}`).toBe(true)

      expect(await lineCount(created.id), 'les lignes du brouillon sont restées').toBe(0)
    })
  })

  it('garde les quantités et les montants exacts, sans flottant', async () => {
    await inCase(async () => {
      const id = await draft()
      await client.query('reset role')
      const stored = await one<{ quantity: string; unit_price: string; price_source: string }>(
        `select quantity::text, unit_price::text, price_source::text
         from public.sale_line where sale_document_id = $1 and variant_id = $2`,
        [id, fixture.variant],
      )
      expect(stored.quantity).toBe('2.500')
      expect(stored.unit_price).toBe('10.00')
      // `auto` par défaut : le prix vient de la grille tant qu'on ne l'a pas forcé.
      expect(stored.price_source).toBe('auto')
    })
  })

  it('accepte un prix forcé à la main, et refuse une autre origine', async () => {
    await inCase(async () => {
      const id = await draft()
      const forced = await attempt(
        client,
        `update public.sale_line set price_source = 'manual' where sale_document_id = '${id}'`,
      )
      expect(forced.ok).toBe(true)

      const unknown = await attempt(
        client,
        `update public.sale_line set price_source = 'guess' where sale_document_id = '${id}'`,
      )
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) expect(unknown.code).toBe(INVALID_TEXT_REPRESENTATION)
    })
  })

  it('refuse une quantité nulle ou négative, et un montant négatif, par leur contrainte', async () => {
    await inCase(async () => {
      const id = await draft()
      const refusals: Array<[string, string]> = [
        [`update public.sale_line set quantity = 0 where sale_document_id = '${id}'`, 'sale_line_quantity_positive'],
        [`update public.sale_line set quantity = -1 where sale_document_id = '${id}'`, 'sale_line_quantity_positive'],
        [`update public.sale_line set unit_price = -1 where sale_document_id = '${id}'`, 'sale_line_amounts_not_negative'],
        [`update public.sale_line set line_discount = -1 where sale_document_id = '${id}'`, 'sale_line_amounts_not_negative'],
        [`update public.sale_document set total = -1 where id = '${id}'`, 'sale_document_amounts_not_negative'],
        [`update public.sale_document set discount_total = -1 where id = '${id}'`, 'sale_document_amounts_not_negative'],
      ]
      for (const [sql, constraint] of refusals) {
        const refused = await attempt(client, sql)
        expect(refused.ok, sql).toBe(false)
        if (!refused.ok) {
          expect(refused.code, refused.message).toBe(CHECK_VIOLATION)
          expect(refused.message, 'une autre contrainte a refusé').toContain(constraint)
        }
      }
    })
  })
})

/* ========================================================================== */
/* Garde — la naissance                                                        */
/* ========================================================================== */

describe('un document naît brouillon', () => {
  for (const status of ['confirmed', 'delivered', 'cancelled'] as const) {
    it(`refuse une insertion au statut ${status}, et aucune ligne n'entre`, async () => {
      await inCase(async () => {
        const written = await attempt(
          client,
          `insert into public.sale_document (tenant_id, doc_type, warehouse_id, status, cancellation_reason)
           values ('${fixture.tenant}', 'delivery_note', '${fixture.warehouse}', '${status}', 'motif')`,
        )
        expect(written.ok, `un document est né ${status}`).toBe(false)
        if (written.ok) return
        expect(written.code, written.message).toBe(FROZEN_WRITE)
        expect(written.message).toContain(BORN_OPEN)

        const { rows } = await client.query(
          `select 1 from public.sale_document where status = '${status}' and tenant_id = $1`,
          [fixture.tenant],
        )
        expect(rows).toHaveLength(0)
      })
    })
  }
})

/* ========================================================================== */
/* RÈGLE M3-3 — ni modifié, ni supprimé                                        */
/* ========================================================================== */

describe('un document qui n\'est plus brouillon est figé', () => {
  const frozenStatuses = ['confirmed', 'delivered', 'cancelled'] as const

  for (const status of frozenStatuses) {
    describe(`au statut ${status}`, () => {
      it('refuse la modification de son contenu, et ne change rien', async () => {
        await inCase(async () => {
          const id = await documentIn(status)
          const before = await row(id)

          const edited = await attempt(
            client,
            `update public.sale_document set notes = 'modifié après coup' where id = '${id}'`,
          )
          expect(edited.ok, `FUITE — un document ${status} a été modifié`).toBe(false)
          if (edited.ok) return

          expect(edited.code, edited.message).toBe(FROZEN_WRITE)
          expect(edited.message).toContain(CONTENT_FROZEN)
          expect(edited.message).toContain(`« ${status} »`)
          expect(edited.message).toContain('notes')
          // Le refus d'un contenu figé n'est ni celui d'une transition, ni celui
          // d'une colonne étrangère à la transition : trois phrases, trois gardes.
          expect(edited.message).not.toContain(TRANSITION_REFUSED)
          expect(edited.message).not.toContain(TRANSITION_COLUMNS)

          expect(await row(id)).toEqual(before)
        })
      })

      it('refuse la suppression, et le document reste avec ses lignes', async () => {
        await inCase(async () => {
          const id = await documentIn(status)

          const removed = await attempt(
            client,
            `delete from public.sale_document where id = '${id}'`,
          )
          expect(removed.ok, `FUITE — un document ${status} a été supprimé`).toBe(false)
          if (removed.ok) return

          expect(removed.code, removed.message).toBe(FROZEN_WRITE)
          expect(removed.message).toContain(NOT_DELETABLE)

          await client.query('reset role')
          expect((await row(id)).status).toBe(status)
          expect(await lineCount(id)).toBe(2)
        })
      })

      it('refuse d\'ajouter, de modifier et de retirer une ligne', async () => {
        await inCase(async () => {
          const id = await documentIn(status)

          const refusals = [
            `insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price, line_total)
             values ('${fixture.tenant}', '${id}', '${fixture.variant}', 1, 1, 1)`,
            `update public.sale_line set quantity = 9 where sale_document_id = '${id}'`,
            `delete from public.sale_line where sale_document_id = '${id}'`,
          ]
          for (const sql of refusals) {
            const refused = await attempt(client, sql)
            expect(refused.ok, `FUITE — ${sql}`).toBe(false)
            if (refused.ok) continue
            expect(refused.code, refused.message).toBe(FROZEN_WRITE)
            expect(refused.message).toContain(LINES_FROZEN)
            expect(refused.message).toContain(`« ${status} »`)
          }

          expect(await lineCount(id), 'une ligne a bougé sous un document figé').toBe(2)
          const { rows } = await client.query(
            'select 1 from public.sale_line where sale_document_id = $1 and quantity = 9',
            [id],
          )
          expect(rows).toHaveLength(0)
        })
      })
    })
  }

  it('refuse chaque colonne de contenu, nommée dans le message', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      const columns: Array<[string, string]> = [
        ['notes', "'x'"],
        ['subtotal', '1'],
        ['discount_total', '1'],
        ['total', '1'],
        // Bien formé et libre : si le gel disparaissait, l'écriture passerait —
        // c'est ce que la passe de sabotage doit pouvoir voir. Un numéro mal
        // formé serait refusé par le garde de forme (E4-02) à la place.
        ['doc_number', `'${nextNumber()}'`],
        // Un autre instant que celui de la confirmation, et dans la même année :
        // `now()` rendrait la même valeur (horodatage de transaction), donc une
        // écriture qui ne change rien, et une autre année serait refusée par le
        // garde de forme d'E4-02 à la place du gel.
        ['issued_at', "now() - interval '1 hour'"],
        ['doc_type', "'quote'"],
        ['cancellation_reason', "'motif sans annulation'"],
      ]
      for (const [column, value] of columns) {
        const refused = await attempt(
          client,
          `update public.sale_document set ${column} = ${value} where id = '${id}'`,
        )
        expect(refused.ok, `FUITE — ${column} modifiable sous un document confirmé`).toBe(false)
        if (refused.ok) continue
        expect(refused.code, refused.message).toBe(FROZEN_WRITE)
        expect(refused.message).toContain(column)
      }
    })
  })

  it('laisse passer une écriture qui ne change rien', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      const noop = await attempt(
        client,
        `update public.sale_document set updated_at = updated_at, notes = notes where id = '${id}'`,
      )
      expect(noop.ok, noop.ok ? '' : `${noop.code} ${noop.message}`).toBe(true)
    })
  })

  it('refuse de déplacer une ligne vers un document figé, ou hors de lui', async () => {
    await inCase(async () => {
      const open = await draft()
      const frozen = await documentIn('confirmed')

      const into = await attempt(
        client,
        `update public.sale_line set sale_document_id = '${frozen}'
         where sale_document_id = '${open}' and variant_id = '${fixture.variant}'`,
      )
      expect(into.ok, 'une ligne est entrée sous un document confirmé').toBe(false)
      if (!into.ok) {
        expect(into.code, into.message).toBe(FROZEN_WRITE)
        expect(into.message).toContain(LINES_FROZEN)
      }

      const out = await attempt(
        client,
        `update public.sale_line set sale_document_id = '${open}'
         where sale_document_id = '${frozen}' and variant_id = '${fixture.variant}'`,
      )
      expect(out.ok, 'une ligne est sortie d\'un document confirmé').toBe(false)
      if (!out.ok) {
        expect(out.code, out.message).toBe(FROZEN_WRITE)
        expect(out.message).toContain(LINES_FROZEN)
      }

      expect(await lineCount(frozen)).toBe(2)
      expect(await lineCount(open)).toBe(2)
    })
  })

  /*
   * Le même garde par la porte que l'application emprunte : le rôle
   * `authenticated`, un jeton signé. Si le refus changeait de code ici, c'est
   * qu'un étage — privilège ou policy — parlerait à la place du garde.
   */
  it('refuse aussi à l\'application, sous le jeton du patron', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      await asApplication('owner')

      const edited = await attempt(
        client,
        `update public.sale_document set notes = 'par l''API' where id = '${id}'`,
      )
      expect(edited.ok).toBe(false)
      if (!edited.ok) {
        expect(edited.code, edited.message).toBe(FROZEN_WRITE)
        expect(edited.message).toContain(CONTENT_FROZEN)
      }

      const removed = await attempt(client, `delete from public.sale_document where id = '${id}'`)
      expect(removed.ok).toBe(false)
      if (!removed.ok) expect(removed.code, removed.message).toBe(FROZEN_WRITE)
    })
  })
})

/* ========================================================================== */
/* Garde — TRUNCATE                                                            */
/* ========================================================================== */

describe('TRUNCATE', () => {
  for (const table of ['sale_document', 'sale_line']) {
    it(`est refusé sur ${table}, par son trigger`, async () => {
      await inCase(async () => {
        const refused = await attempt(client, `truncate public.${table} cascade`)
        expect(refused.ok, `FUITE — ${table} s'est vidée d'un coup`).toBe(false)
        if (refused.ok) return
        expect(refused.code, refused.message).toBe(FROZEN_WRITE)
        // La table nommée par le message est celle dont le garde a refusé.
        // `cascade` entraîne `sale_line` : sans ce nom, le garde de l'enfant
        // refuserait à la place de celui du parent, avec la même phrase.
        expect(refused.message).toContain(`${table} ${NOT_TRUNCATABLE}`)
      })
    })

    it(`est refusé à authenticated sur ${table}, par le privilège`, async () => {
      await inCase(async () => {
        await asApplication('owner')
        const refused = await attempt(client, `truncate public.${table}`)
        expect(refused.ok).toBe(false)
        if (!refused.ok) {
          expect(refused.code, refused.message).toBe(INSUFFICIENT_PRIVILEGE)
          expect(refused.message).toContain('permission denied')
        }
      })
    })
  }
})

/* ========================================================================== */
/* Garde — les transitions de statut                                           */
/* ========================================================================== */

describe('le statut avance, le long de transitions déclarées', () => {
  it('laisse un brouillon se confirmer en recevant son numéro, sa date et ses totaux', async () => {
    await inCase(async () => {
      const id = await draft()
      const docNumber = nextNumber()
      const confirmed = await attempt(
        client,
        `update public.sale_document
         set status = 'confirmed', doc_number = '${docNumber}', issued_at = now(),
             subtotal = 29.50, total = 29.50
         where id = '${id}'`,
      )
      expect(confirmed.ok, confirmed.ok ? '' : `${confirmed.code} ${confirmed.message}`).toBe(true)

      const stored = await row(id)
      expect(stored.status).toBe('confirmed')
      expect(stored.doc_number).toBe(docNumber)
      expect(stored.total).toBe('29.50')
    })
  })

  it('laisse un document confirmé être livré', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      const delivered = await attempt(
        client,
        `update public.sale_document set status = 'delivered' where id = '${id}'`,
      )
      expect(delivered.ok, delivered.ok ? '' : `${delivered.code} ${delivered.message}`).toBe(true)
      expect((await row(id)).status).toBe('delivered')
    })
  })

  /*
   * Les transitions absentes de la liste. Cibles `cancelled` éprouvées sous le
   * jeton du patron avec un motif : la capacité et la contrainte du motif sont
   * satisfaites, donc la seule chose qui puisse refuser est la liste.
   */
  const refused: Array<[Status, Status]> = [
    ['draft', 'delivered'],
    ['draft', 'cancelled'],
    ['confirmed', 'draft'],
    ['delivered', 'draft'],
    ['delivered', 'confirmed'],
    ['cancelled', 'draft'],
    ['cancelled', 'confirmed'],
    ['cancelled', 'delivered'],
  ]

  for (const [from, to] of refused) {
    it(`refuse ${from} → ${to}`, async () => {
      await inCase(async () => {
        const id = await documentIn(from)
        await asApplication('owner')

        const moved = await attempt(
          client,
          `update public.sale_document
           set status = '${to}', cancellation_reason = 'motif'
           where id = '${id}'`,
        )
        expect(moved.ok, `FUITE — ${from} → ${to} a passé`).toBe(false)
        if (moved.ok) return

        expect(moved.code, moved.message).toBe(FROZEN_WRITE)
        expect(moved.message).toContain(TRANSITION_REFUSED)
        expect((await row(id)).status).toBe(from)
      })
    })
  }

  /*
   * Une transition admise ne donne pas licence de changer le reste : le statut
   * avance, le contenu ne bouge pas. Troisième phrase du garde de mise à jour.
   */
  it('refuse qu\'une transition change autre chose que le statut', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')

      const withNotes = await attempt(
        client,
        `update public.sale_document set status = 'delivered', notes = 'glissé' where id = '${id}'`,
      )
      expect(withNotes.ok, 'FUITE — le contenu a bougé avec le statut').toBe(false)
      if (!withNotes.ok) {
        expect(withNotes.code, withNotes.message).toBe(FROZEN_WRITE)
        expect(withNotes.message).toContain(TRANSITION_COLUMNS)
        expect(withNotes.message).toContain('notes')
        expect(withNotes.message).not.toContain(TRANSITION_REFUSED)
      }

      await asApplication('owner')
      const withTotal = await attempt(
        client,
        `update public.sale_document
         set status = 'cancelled', cancellation_reason = 'erreur', total = 99
         where id = '${id}'`,
      )
      expect(withTotal.ok, 'FUITE — le total a bougé avec l\'annulation').toBe(false)
      if (!withTotal.ok) {
        expect(withTotal.code, withTotal.message).toBe(FROZEN_WRITE)
        expect(withTotal.message).toContain(TRANSITION_COLUMNS)
        expect(withTotal.message).toContain('total')
      }

      await client.query('reset role')
      expect((await row(id)).status).toBe('confirmed')
    })
  })
})

/* ========================================================================== */
/* L'annulation                                                                */
/* ========================================================================== */

describe('l\'annulation', () => {
  it('inverse chaque mouvement de vente du document, et le niveau revient où il était', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      await postSale(id, fixture.variant, '-2.500')
      await postSale(id, fixture.variant2, '-0.125')
      expect(await level(fixture.variant)).toBe('-2.500')
      expect(await level(fixture.variant2)).toBe('-0.125')

      await asApplication('owner')
      const cancelled = await attempt(
        client,
        `update public.sale_document
         set status = 'cancelled', cancellation_reason = 'client absent'
         where id = '${id}'`,
      )
      expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)

      const stored = await row(id)
      expect(stored.status).toBe('cancelled')
      expect(stored.cancellation_reason).toBe('client absent')

      const movements = await movementsOf(id)
      expect(movements.map((m) => [m.movement_type, m.variant_id, m.quantity])).toEqual(
        expect.arrayContaining([
          ['sale', fixture.variant, '-2.500'],
          ['sale', fixture.variant2, '-0.125'],
          ['sale_cancellation', fixture.variant, '2.500'],
          ['sale_cancellation', fixture.variant2, '0.125'],
        ]),
      )
      expect(movements).toHaveLength(4)

      // Le stock revient où il était, trois décimales comprises.
      expect(await level(fixture.variant)).toBe('0.000')
      expect(await level(fixture.variant2)).toBe('0.000')

      // Le motif voyage avec le mouvement, de quoi relire l'historique d'une variante.
      const reversal = movements.find((m) => m.movement_type === 'sale_cancellation')
      expect(reversal?.note).toContain('client absent')
    })
  })

  it('annule un document livré de la même façon', async () => {
    await inCase(async () => {
      const id = await documentIn('delivered')
      await postSale(id, fixture.variant, '-4')

      await asApplication('owner')
      await client.query(
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'retour total'
         where id = '${id}'`,
      )

      expect(await level(fixture.variant)).toBe('0.000')
      expect((await movementsOf(id)).filter((m) => m.movement_type === 'sale_cancellation')).toHaveLength(1)
    })
  })

  it('n\'inverse que les mouvements de vente de ce document-là', async () => {
    await inCase(async () => {
      const target = await documentIn('confirmed')
      const neighbour = await documentIn('confirmed')
      await postSale(target, fixture.variant, '-3')
      await postSale(neighbour, fixture.variant, '-5')
      // Un mouvement qui nomme le document sans être une vente : pas le sien à inverser.
      await postSale(target, fixture.variant, '7', 'return', 'retour de marchandise')
      expect(await level(fixture.variant)).toBe('-1.000')

      await asApplication('owner')
      await client.query(
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'doublon'
         where id = '${target}'`,
      )

      // +3 seulement : la vente du voisin et le retour n'ont pas bougé.
      expect(await level(fixture.variant)).toBe('2.000')
      expect(await movementsOf(neighbour)).toHaveLength(1)
      expect((await movementsOf(target)).map((m) => m.movement_type).sort()).toEqual([
        'return',
        'sale',
        'sale_cancellation',
      ])
    })
  })

  it('n\'écrit aucun mouvement pour un devis, qui n\'en a jamais écrit', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed', 'quote')

      await asApplication('owner')
      const cancelled = await attempt(
        client,
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'refusé'
         where id = '${id}'`,
      )
      expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)
      expect(await movementsOf(id)).toHaveLength(0)
    })
  })

  it('ne s\'inverse qu\'une fois : annulé, un document ne bouge plus', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      await postSale(id, fixture.variant, '-6')

      await asApplication('owner')
      await client.query(
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'première' where id = '${id}'`,
      )
      expect(await level(fixture.variant)).toBe('0.000')

      await asApplication('owner')
      const again = await attempt(
        client,
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'seconde' where id = '${id}'`,
      )
      expect(again.ok, 'FUITE — un document annulé a été annulé de nouveau').toBe(false)
      if (!again.ok) {
        expect(again.code, again.message).toBe(FROZEN_WRITE)
        expect(again.message).toContain(CONTENT_FROZEN)
      }

      expect(await level(fixture.variant), 'le stock a été inversé deux fois').toBe('0.000')
      expect((await row(id)).cancellation_reason).toBe('première')
    })
  })

  /*
   * Le motif : sans lui, une annulation par l'API serait anonyme, et l'entrée
   * de journal n'aurait rien à retenir. En base, pas seulement à l'écran — même
   * raisonnement que le motif d'un ajustement (E3-03, leçon d'E1-02).
   */
  describe('le motif est obligatoire', () => {
    for (const [label, value] of [
      ['absent', 'null'],
      ['vide', "''"],
      ['en blancs', "'   '"],
    ] as const) {
      it(`refuse une annulation dont le motif est ${label}`, async () => {
        await inCase(async () => {
          const id = await documentIn('confirmed')
          await postSale(id, fixture.variant, '-2')

          await asApplication('owner')
          const refused = await attempt(
            client,
            `update public.sale_document set status = 'cancelled', cancellation_reason = ${value}
             where id = '${id}'`,
          )
          expect(refused.ok, 'FUITE — une annulation anonyme').toBe(false)
          if (refused.ok) return

          expect(refused.code, refused.message).toBe(CHECK_VIOLATION)
          expect(refused.message, 'une autre contrainte a refusé').toContain(
            'sale_document_cancellation_reason',
          )

          expect((await row(id)).status).toBe('confirmed')
          expect(await level(fixture.variant), 'un mouvement est passé sans l\'annulation').toBe('-2.000')
        })
      })
    }
  })

  /*
   * Deux niveaux, deux refus. Le droit d'annuler est vérifié sur la transition ;
   * le mouvement inverse passe, lui, par la policy de son type. Un test par
   * niveau, qui contourne l'autre — sans quoi retirer le premier ne ferait
   * rougir rien (CLAUDE.md, E1-01, E1-02).
   */
  describe('le droit d\'annuler', () => {
    it('refuse l\'employé sur la transition, même quand aucun mouvement n\'est à inverser', async () => {
      await inCase(async () => {
        // Un devis : rien à inverser, donc la policy des mouvements n'a rien à
        // dire. Seul le garde de la transition peut refuser.
        const id = await documentIn('confirmed', 'quote')

        await asApplication('worker')
        const refused = await attempt(
          client,
          `update public.sale_document set status = 'cancelled', cancellation_reason = 'je décide'
           where id = '${id}'`,
        )
        expect(refused.ok, 'FUITE — un employé a annulé un document').toBe(false)
        if (refused.ok) return

        expect(refused.code, refused.message).toBe(INSUFFICIENT_PRIVILEGE)
        expect(refused.message).toContain(NO_CANCEL_RIGHT)

        expect((await row(id)).status).toBe('confirmed')
        expect(await auditEntries()).toHaveLength(0)
      })
    })

    it('refuse l\'employé sur le mouvement inverse, le garde de la transition contourné', async () => {
      await inCase(async () => {
        const id = await documentIn('confirmed')
        await postSale(id, fixture.variant, '-5')

        // On retire le garde de la transition, le temps du cas.
        await client.query('alter table public.sale_document disable trigger require_cancel_capability')

        await asApplication('worker')
        const refused = await attempt(
          client,
          `update public.sale_document set status = 'cancelled', cancellation_reason = 'je décide'
           where id = '${id}'`,
        )
        expect(refused.ok, 'FUITE — un employé a inversé des mouvements de stock').toBe(false)
        if (refused.ok) return

        expect(refused.code, refused.message).toBe(INSUFFICIENT_PRIVILEGE)
        // La policy, et la table qu'elle garde : le message qui nomme le type
        // fermé est l'autre garde, celui du type non ouvert.
        expect(refused.message).toContain(RLS_REFUSAL)
        expect(refused.message).toContain('stock_movement')
        expect(refused.message).not.toContain(NO_CANCEL_RIGHT)
        expect(refused.message).not.toContain(CLOSED_BY_DEFAULT)

        // L'annulation entière a échoué : ni statut, ni mouvement, ni niveau.
        expect((await row(id)).status).toBe('confirmed')
        expect(await level(fixture.variant)).toBe('-5.000')
        expect(await movementsOf(id)).toHaveLength(1)
      })
    })

    it('laisse le patron annuler : la capacité est détenue', async () => {
      await inCase(async () => {
        await asApplication('owner')
        const { can } = await one<{ can: boolean }>("select merx.can('cancel_document') as can")
        expect(can).toBe(true)

        await asApplication('worker')
        const denied = await one<{ can: boolean }>("select merx.can('cancel_document') as can")
        expect(denied.can).toBe(false)
      })
    })
  })
})

/* ========================================================================== */
/* Le type de mouvement ouvert, et lui seul                                    */
/* ========================================================================== */

describe('sale_cancellation', () => {
  it('est ouvert sur cancel_document, et les quatre autres types restent fermés', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ movement_type: string; capability: string }>(
      'select movement_type::text, capability from merx.movement_type_capability order by 1',
    )
    expect(rows).toEqual([
      { movement_type: 'adjustment', capability: 'adjust_stock' },
      { movement_type: 'sale_cancellation', capability: 'cancel_document' },
    ])
  })

  it('est une capacité du patron seul, déjà à la matrice', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ role: string }>(
      "select role::text from merx.role_capability where capability = 'cancel_document' order by 1",
    )
    expect(rows.map((r) => r.role)).toEqual(['owner'])
  })

  for (const type of ['sale', 'return', 'receipt', 'inventory']) {
    it(`laisse ${type} fermé au patron : rien ne s'écrit sans écran`, async () => {
      await inCase(async () => {
        await asApplication('owner')
        const written = await attempt(
          client,
          `insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity)
           values ('${fixture.variant}', '${fixture.warehouse}', '${type}', -1)`,
        )
        expect(written.ok, `FUITE — le type ${type} est ouvert`).toBe(false)
        if (written.ok) return
        expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
        expect(written.message).toContain(CLOSED_BY_DEFAULT)
        expect(written.message).toContain(`« ${type} »`)
      })
    })
  }

  /*
   * Le type est ouvert au patron, mais ne s'écrit pas à la main : sinon il
   * corrigerait un stock sans motif et sans entrée de journal, ce que
   * l'ajustement, lui, ne permet pas. Deux niveaux, deux refus : l'employé est
   * arrêté par la policy, le patron par le garde d'origine.
   */
  it('refuse l\'employé en insertion directe, par la policy', async () => {
    await inCase(async () => {
      await asApplication('worker')
      const written = await attempt(
        client,
        `insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity)
         values ('${fixture.variant}', '${fixture.warehouse}', 'sale_cancellation', 100)`,
      )
      expect(written.ok, 'FUITE — un employé a posé un mouvement d\'annulation').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message).toContain(RLS_REFUSAL)
      expect(written.message).not.toContain(NOT_BY_HAND)
    })
  })

  it('refuse le patron en insertion directe : le mouvement naît de l\'annulation', async () => {
    await inCase(async () => {
      await asApplication('owner')
      const written = await attempt(
        client,
        `insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity, note)
         values ('${fixture.variant}', '${fixture.warehouse}', 'sale_cancellation', 100, 'à la main')`,
      )
      expect(written.ok, 'FUITE — le patron a corrigé un stock sans entrée de journal').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message).toContain(NOT_BY_HAND)
      expect(written.message).not.toContain(RLS_REFUSAL)

      // La variante naît avec sa ligne de stock à zéro (E3-02) : rien n'a bougé.
      expect(await level(fixture.variant)).toBe('0.000')
      expect(await auditEntries()).toHaveLength(0)
    })
  })
})

/* ========================================================================== */
/* RÈGLE M8-1 — la trace                                                       */
/* ========================================================================== */

describe('le journal', () => {
  it('écrit une entrée document_cancellation, signée par le patron, avec le motif', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed')
      const docNumber = (await row(id)).doc_number
      await postSale(id, fixture.variant, '-2')

      await asApplication('owner')
      await client.query(
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'marchandise refusée'
         where id = '${id}'`,
      )

      const entries = await auditEntries()
      expect(entries).toHaveLength(1)
      const [entry] = entries
      expect(entry?.action).toBe('document_cancellation')
      expect(entry?.entity_type).toBe('sale_document')
      expect(entry?.entity_id).toBe(id)
      // L'auteur vient du jeton signé, jamais d'un paramètre (RÈGLE M8-2).
      expect(entry?.user_id).toBe(fixture.appUsers.owner)
      expect(entry?.before).toEqual({
        doc_type: 'delivery_note',
        doc_number: docNumber,
        status: 'confirmed',
        total: '0.00',
        cancellation_reason: null,
      })
      expect(entry?.after).toEqual({
        doc_type: 'delivery_note',
        doc_number: docNumber,
        status: 'cancelled',
        total: '0.00',
        cancellation_reason: 'marchandise refusée',
      })
    })
  })

  it('journalise aussi l\'annulation d\'un devis, qui n\'inverse aucun mouvement', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed', 'quote')

      await asApplication('owner')
      await client.query(
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'sans suite'
         where id = '${id}'`,
      )

      const entries = await auditEntries()
      expect(entries.map((e) => e.action)).toEqual(['document_cancellation'])
    })
  })

  /*
   * La condition de ligne, éprouvée dans le sens inverse : la vie ordinaire
   * d'un document n'est pas une action auditée. Un journal qui note chaque
   * brouillon se noie, et M8-1 ne le demande pas.
   */
  it('n\'écrit rien pour tout le reste de la vie d\'un document', async () => {
    await inCase(async () => {
      await asApplication('owner')
      const created = await one<{ id: string }>(
        `insert into public.sale_document (doc_type, warehouse_id, device_id)
         values ('delivery_note', '${fixture.warehouse}', '${fixture.device}') returning id`,
      )
      await client.query(
        `insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price, line_total)
         values ('${created.id}', '${fixture.variant}', 1, 5, 5)`,
      )
      await client.query(
        `update public.sale_document set notes = 'ajout', total = 5 where id = '${created.id}'`,
      )
      await client.query(
        `update public.sale_document set status = 'confirmed', doc_number = '${nextNumber()}',
                issued_at = now()
         where id = '${created.id}'`,
      )
      await client.query(
        `update public.sale_document set status = 'delivered' where id = '${created.id}'`,
      )

      expect(await auditEntries(), 'le journal note autre chose que l\'annulation').toHaveLength(0)

      const brouillon = await draft()
      await asApplication('owner')
      await client.query(`delete from public.sale_document where id = '${brouillon}'`)
      expect(await auditEntries()).toHaveLength(0)
    })
  })
})

/* ========================================================================== */
/* document_sequence                                                           */
/* ========================================================================== */

/*
 * La **forme** du compteur : son unicité, son appareil obligatoire, son
 * compteur positif, sa clé composite. Ce que le trigger y écrit — et le fait
 * qu'il en soit le seul écrivain — appartient à E4-02 et vit dans
 * `document-numbering.test.ts`.
 *
 * La table est dérivée depuis E4-02 : son garde refuse toute pose à la main
 * (`PT422`). Il est suspendu **nommément** le temps de l'insertion, comme le
 * garde du type de mouvement fermé l'est ailleurs — lever les triggers d'un
 * coup (`session_replication_role`) emporterait aussi les clés étrangères,
 * c'est-à-dire exactement ce que deux de ces cas mesurent (CLAUDE.md).
 */
describe('document_sequence', () => {
  const GUARD = 'public.document_sequence disable trigger reject_derived_insert'

  const insertSequence = (
    over: Partial<{ tenant: string; device: string | null; type: string; year: number; last: number }> = {},
  ): string => {
    const device = over.device === undefined ? fixture.device : over.device
    return (
      `alter table ${GUARD};` +
      'insert into public.document_sequence (tenant_id, device_id, doc_type, year, last_number)' +
      ` values ('${over.tenant ?? fixture.tenant}', ${device === null ? 'null' : `'${device}'`},` +
      ` '${over.type ?? 'delivery_note'}', ${over.year ?? 2026}, ${over.last ?? 0})`
    )
  }

  it('part de zéro et accepte un compteur par (appareil, type, année)', async () => {
    await inCase(async () => {
      await client.query('reset role')
      await client.query(insertSequence({ last: 0 }))
      await client.query(insertSequence({ type: 'quote' }))
      await client.query(insertSequence({ year: 2027 }))
      const { rows } = await client.query('select 1 from public.document_sequence where tenant_id = $1', [
        fixture.tenant,
      ])
      expect(rows).toHaveLength(3)
    })
  })

  it('refuse un second compteur pour le même (appareil, type, année), par son index', async () => {
    await inCase(async () => {
      await client.query('reset role')
      await client.query(insertSequence())
      const duplicate = await attempt(client, insertSequence({ last: 5 }))
      expect(duplicate.ok).toBe(false)
      if (duplicate.ok) return
      expect(duplicate.code, duplicate.message).toBe(UNIQUE_VIOLATION)
      // Le nom de la contrainte : deux index peuvent refuser avec le même code.
      expect(duplicate.message).toContain('document_sequence_per_device_type_year')
    })
  })

  it('exige un appareil : sans lui l\'unicité laisserait passer autant de doublons que de nuls', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const nodevice = await attempt(client, insertSequence({ device: null }))
      expect(nodevice.ok).toBe(false)
      if (!nodevice.ok) expect(nodevice.code, nodevice.message).toBe(NOT_NULL_VIOLATION)
    })
  })

  it('refuse un compteur négatif', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const negative = await attempt(client, insertSequence({ last: -1 }))
      expect(negative.ok).toBe(false)
      if (!negative.ok) {
        expect(negative.code, negative.message).toBe(CHECK_VIOLATION)
        expect(negative.message).toContain('document_sequence_last_number_check')
      }
    })
  })

  it('refuse l\'appareil d\'un autre commerce : la clé est composite', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const foreign = await attempt(client, insertSequence({ device: fixture.other.device }))
      expect(foreign.ok, 'FUITE — un compteur attaché à l\'appareil du voisin').toBe(false)
      if (!foreign.ok) {
        expect(foreign.code, foreign.message).toBe(FOREIGN_KEY_VIOLATION)
        expect(foreign.message).toContain('document_sequence_device_id_fkey')
      }
    })
  })
})

/* ========================================================================== */
/* Clés composites sur tenant_id                                               */
/* ========================================================================== */

describe('clés composites', () => {
  it('refuse un document rattaché au dépôt d\'un autre commerce', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const foreign = await attempt(
        client,
        `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)
         values ('${fixture.tenant}', 'delivery_note', '${fixture.other.warehouse}',
                 '${fixture.device}')`,
      )
      expect(foreign.ok, 'FUITE — un document sur le dépôt du voisin').toBe(false)
      if (!foreign.ok) {
        expect(foreign.code, foreign.message).toBe(FOREIGN_KEY_VIOLATION)
        expect(foreign.message).toContain('sale_document_warehouse_id_fkey')
      }
    })
  })

  it('refuse une ligne rattachée au document d\'un autre commerce', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const neighbour = await one<{ id: string }>(
        `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)
         values ($1, 'delivery_note', $2, $3) returning id`,
        [fixture.other.tenant, fixture.other.warehouse, fixture.other.device],
      )
      const foreign = await attempt(
        client,
        `insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price, line_total)
         values ('${fixture.tenant}', '${neighbour.id}', '${fixture.variant}', 1, 1, 1)`,
      )
      expect(foreign.ok, 'FUITE — une ligne sous le document du voisin').toBe(false)
      if (!foreign.ok) {
        expect(foreign.code, foreign.message).toBe(FOREIGN_KEY_VIOLATION)
        expect(foreign.message).toContain('sale_line_sale_document_id_fkey')
      }
    })
  })

  it('refuse une ligne qui vise la variante d\'un autre commerce', async () => {
    await inCase(async () => {
      const id = await draft()
      const foreign = await attempt(
        client,
        `insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price, line_total)
         values ('${fixture.tenant}', '${id}', '${fixture.other.variant}', 1, 1, 1)`,
      )
      expect(foreign.ok, 'FUITE — une ligne sur la variante du voisin').toBe(false)
      if (!foreign.ok) {
        expect(foreign.code, foreign.message).toBe(FOREIGN_KEY_VIOLATION)
        expect(foreign.message).toContain('sale_line_variant_id_fkey')
      }
    })
  })

  it('refuse l\'écriture d\'une ligne par un jeton sans commerce, sous un document que le garde ne peut pas lire', async () => {
    await inCase(async () => {
      const id = await draft()
      // Le garde des lignes lit le document sous la RLS de l'appelant. Un jeton
      // d'un autre commerce ne voit pas ce document : le garde se tait, et c'est
      // la policy `tenant_isolation` qui refuse — pas lui (E3-01, un garde
      // BEFORE ne doit pas refuser avant la policy).
      await client.query('reset role')
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({
          sub: authUsers.owner,
          role: 'authenticated',
          app_metadata: { tenant_id: fixture.other.tenant, role: 'owner' },
        }),
      ])
      await client.query('set local role authenticated')

      const foreign = await attempt(
        client,
        `insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price, line_total)
         values ('${fixture.tenant}', '${id}', '${fixture.variant}', 1, 1, 1)`,
      )
      expect(foreign.ok).toBe(false)
      if (!foreign.ok) {
        expect(foreign.code, foreign.message).toBe(INSUFFICIENT_PRIVILEGE)
        expect(foreign.message).toContain('row-level security')
        expect(foreign.message).not.toContain(LINES_FROZEN)
      }
    })
  })
})

/* ========================================================================== */
/* Hors session                                                                */
/* ========================================================================== */

describe('hors session', () => {
  /*
   * `merx.log_audit()` refuse toute écriture journalisée sans commerce ni auteur
   * dans le jeton (RÈGLE M8-1). Une annulation passée sans le garde de capacité
   * — donc ici seulement, jamais en production — se heurte à lui : le journal
   * est le dernier étage, et il tient.
   */
  it('refuse une annulation sans jeton quand le garde de capacité est retiré', async () => {
    await inCase(async () => {
      const id = await documentIn('confirmed', 'quote')
      await client.query('alter table public.sale_document disable trigger require_cancel_capability')

      const refused = await attempt(
        client,
        `update public.sale_document set status = 'cancelled', cancellation_reason = 'sans jeton'
         where id = '${id}'`,
      )
      expect(refused.ok, 'FUITE — une annulation sans commerce ni auteur').toBe(false)
      if (!refused.ok) {
        expect(refused.message).toContain(NO_TENANT)
        expect(refused.message).not.toContain(NO_CANCEL_RIGHT)
      }
      expect((await row(id)).status).toBe('confirmed')
    })
  })
})
