// @vitest-environment node

/*
 * E4-05 — le cycle des documents, vu de la base.
 * SPEC § 7 M2 (RÈGLES M2-1, M2-5 et son addendum E4-01), § 8 M3 (RÈGLES M3-3,
 * M3-4, M3-5), § 4 (clés composites, refus en 4xx).
 *
 * Quatre propriétés, et chacune son garde — aucun ne refuse comme un autre,
 * sans quoi le test de l'un passerait sur le refus du voisin (CLAUDE.md ;
 * E1-01, E1-02, E2-01, E4-01) :
 *
 *   — **le stock bouge à la confirmation d'un bon, et là seulement.**
 *     `merx.write_sale_movements()` écrit un mouvement `sale` négatif par
 *     ligne. Le devis et la commande confirmés n'écrivent **rien** : les deux
 *     cas négatifs portent la RÈGLE M3-5 autant que le cas positif ;
 *
 *   — **le mouvement de vente ne s'écrit pas à la main.**
 *     `merx.require_sale_origin()` refuse en `42501` avec sa phrase, qui n'est
 *     ni celle de la policy ni celle du garde de l'annulation. Le type est
 *     ouvert sur `create_sale`, donc la policy laisse passer l'employé : sans
 *     ce garde-ci, `create_sale` serait un `POST` de mouvements sans écran ;
 *
 *   — **l'annulation inverse exactement**, et une seule fois. C'est ici que
 *     l'inversion d'E4-01 trouve enfin quelque chose à inverser : jusqu'à cette
 *     story, aucun mouvement `sale` n'existait ;
 *
 *   — **la filiation.** Une colonne, une clé composite, et quatre branches de
 *     garde à quatre phrases. L'original n'est jamais muté (RÈGLE M3-4), et le
 *     lien se lit dans les deux sens.
 *
 * Les statuts HTTP de ces refus sont mesurés ailleurs —
 * `sale-lifecycle-api.test.ts` —, parce que PostgREST est un autre processus et
 * ne verrait rien de la transaction ouverte ici.
 *
 * Tout est posé en `postgres` dans une transaction annulée en fin de fichier.
 * Les deux comptes d'authentification vivent hors transaction — la clé
 * étrangère d'`app_user.auth_user_id` les exige réellement présents — et sont
 * supprimés au démontage : l'annulation exige `cancel_document` et un auteur
 * pour son entrée de journal (E1-04, E4-01).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'sale-lifecycle-e4-05-password'

/** Une clé étrangère violée — la clé composite de la filiation. */
const FOREIGN_KEY_VIOLATION = '23503'
/** Ce que lève le garde de la filiation, et rendu 400 (§ 4). */
const INVALID_SHAPE = '22023'

/** Ce que chaque garde, et lui seul, répond. */
const NOT_BY_HAND = "ne s'écrit pas à la main"
const SELF_SOURCE = 'issu de lui-même'
const SOURCE_DRAFT = 'encore un brouillon'
const SOURCE_CANCELLED = 'est annulé'
const CHAIN_REFUSED = 'ne donne pas un document de type'
const FROZEN_ROW = 'ne se modifie plus'

const emails = {
  owner: `patron.cycle.${Date.now()}@merx.test`,
  worker: `employe.cycle.${Date.now()}@merx.test`,
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
  /** Un second commerce, pour la clé composite de la filiation. */
  other: { tenant: '', warehouse: '', device: '', variant: '', owner: '' },
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

/** La variante par défaut d'un produit neuf — elle porte son identifiant (E2-01). */
async function seedVariant(tenant: string, name: string): Promise<string> {
  const product = await one<{ id: string }>(
    'insert into public.product (tenant_id, name_fr) values ($1, $2) returning id',
    [tenant, name],
  )
  return (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [tenant, product.id],
    )
  ).id
}

beforeAll(async () => {
  for (const role of ['owner', 'worker'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

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
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Cycle E4-05')" +
        ' returning id',
    )
  ).id

  // Le dépôt naît avec le commerce (E3-02) : on lit le sien, on ne le crée pas.
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

  for (const role of ['owner', 'worker'] as const) {
    fixture.appUsers[role] = (
      await one<{ id: string }>(
        'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
          ' values ($1, $2, $3, $4) returning id',
        [fixture.tenant, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
      )
    ).id
  }

  fixture.variant = await seedVariant(fixture.tenant, 'Crème hydratante')
  fixture.variant2 = await seedVariant(fixture.tenant, 'Savon noir')

  const other = (
    await one<{ id: string }>(
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Voisin E4-05')" +
        ' returning id',
    )
  ).id
  fixture.other = {
    tenant: other,
    warehouse: (
      await one<{ id: string }>(
        'select id from public.warehouse where tenant_id = $1 and is_default',
        [other],
      )
    ).id,
    device: (
      await one<{ id: string }>(
        "insert into public.device (tenant_id, label, prefix) values ($1, 'Comptoir', 'A')" +
          ' returning id',
        [other],
      )
    ).id,
    variant: await seedVariant(other, 'Shampoing 1 L'),
    /*
     * Sa propre fiche de patron : `created_by` a pour défaut
     * `merx.current_app_user()`, qui rendrait celle du commerce A quand un cas
     * a posé son jeton — et c'est alors `sale_document_created_by_fkey` qui
     * refuserait, à la place de la clé qu'on mesure (CLAUDE.md, E1-01).
     */
    owner: (
      await one<{ id: string }>(
        'insert into public.app_user (tenant_id, full_name, role)' +
          " values ($1, 'Patron voisin', 'owner') returning id",
        [other],
      )
    ).id,
  }

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

beforeEach(async () => {
  await client.query('reset role')
  await client.query('savepoint case_under_test')
})

afterEach(async () => {
  await client.query('rollback to savepoint case_under_test')
  await client.query('reset role')
})

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'état d'une requête PostgREST : les claims du jeton signé, puis le rôle
 * `authenticated`. Le `sub` compte autant que le reste — c'est par lui que
 * `merx.current_app_user()` trouve la fiche qui signera l'entrée de journal.
 */
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

const DOC_CODES: Record<string, string> = { quote: 'DV', order: 'CM', delivery_note: 'BL' }

let numbered = 0

/** `BL-A-26-00001`, pour l'appareil « A » du commerce et l'année du comptoir. */
function nextNumber(docType: string): string {
  numbered += 1
  return `${DOC_CODES[docType]}-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`
}

type Line = readonly [variant: string, quantity: string, unitPrice: string]

/**
 * Un brouillon et ses lignes, posés en `postgres`. Les totaux disent la vérité
 * sur les lignes — `merx.require_consistent_totals()` les relit à la
 * confirmation (E4-04) — et `line_total` n'est pas écrite : la base l'engendre.
 */
async function draft(
  docType: string,
  lines: readonly Line[],
  source: string | null = null,
): Promise<string> {
  await client.query('reset role')
  const subtotal = lines
    .reduce((sum, [, quantity, price]) => sum + Number(quantity) * Number(price), 0)
    .toFixed(2)

  const doc = await one<{ id: string }>(
    'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,' +
      ' created_by, subtotal, total, source_document_id)' +
      ' values ($1, $2::public.sale_doc_type, $3, $4, $5, $6, $6, $7) returning id',
    [
      fixture.tenant,
      docType,
      fixture.warehouse,
      fixture.device,
      fixture.appUsers.owner,
      subtotal,
      source,
    ],
  )

  for (const [variant, quantity, price] of lines) {
    await client.query(
      'insert into public.sale_line (tenant_id, sale_document_id, variant_id, quantity, unit_price,' +
        ' created_by) values ($1, $2, $3, $4, $5, $6)',
      [fixture.tenant, doc.id, variant, quantity, price, fixture.appUsers.owner],
    )
  }
  return doc.id
}

/**
 * La confirmation, telle que l'appareil l'envoie : le statut, le numéro et la
 * date d'un seul geste (E4-02). Sous le jeton demandé, parce que les mouvements
 * sont écrits en `invoker` — la policy du type s'applique à l'auteur de la
 * confirmation.
 */
async function confirm(
  document: string,
  docType: string,
  role: 'owner' | 'worker' = 'worker',
): Promise<ReturnType<typeof attempt>> {
  await asApplication(role)
  return await attempt(
    client,
    `update public.sale_document
     set status = 'confirmed', doc_number = '${nextNumber(docType)}', issued_at = now()
     where id = '${document}'`,
  )
}

/** Confirme, et exige que ça ait abouti : un préparatif ne mesure rien. */
async function confirmed(
  docType: string,
  lines: readonly Line[],
  source: string | null = null,
): Promise<string> {
  const id = await draft(docType, lines, source)
  const result = await confirm(id, docType)
  expect(result.ok, result.ok ? '' : `${result.code} ${result.message}`).toBe(true)
  await client.query('reset role')
  return id
}

/** Le stock d'une variante, hors RLS. `null` : aucune ligne — jamais de mouvement. */
async function level(variant: string): Promise<string | null> {
  await client.query('reset role')
  const { rows } = await client.query<{ quantity: string }>(
    'select quantity::text from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [variant, fixture.warehouse],
  )
  return rows[0]?.quantity ?? null
}

/**
 * Pose du stock avant la vente, par un `adjustment` — le seul type qu'un
 * commerce peut écrire à la main (E3-03), et son motif est obligatoire.
 *
 * Sous le jeton du patron, et non en `postgres` : l'ajustement est audité, et
 * `merx.log_audit()` exige un commerce et un auteur dans le jeton (E1-04,
 * E3-03). Un peuplement sans jeton serait refusé par la trace, pas par le
 * stock.
 */
async function stockUp(variant: string, quantity: string): Promise<void> {
  await asApplication('owner')
  await client.query(
    'insert into public.stock_movement (variant_id, warehouse_id, movement_type,' +
      " quantity, note) values ($1, $2, 'adjustment', $3, 'mise en stock')",
    [variant, fixture.warehouse, quantity],
  )
  await client.query('reset role')
}

async function movementsOf(document: string): Promise<
  Array<{
    movement_type: string
    variant_id: string
    quantity: string
    source_type: string | null
    device_id: string | null
    note: string | null
  }>
> {
  await client.query('reset role')
  const { rows } = await client.query<{
    movement_type: string
    variant_id: string
    quantity: string
    source_type: string | null
    device_id: string | null
    note: string | null
  }>(
    'select movement_type::text, variant_id, quantity::text, source_type::text, device_id, note' +
      ' from public.stock_movement where source_id = $1 order by created_at, quantity',
    [document],
  )
  return rows
}

async function row(document: string): Promise<{
  doc_type: string
  status: string
  doc_number: string | null
  subtotal: string
  source_document_id: string | null
  updated_at: string
}> {
  await client.query('reset role')
  return await one(
    'select doc_type::text, status::text, doc_number, subtotal::text, source_document_id,' +
      ' updated_at::text from public.sale_document where id = $1',
    [document],
  )
}

/** Les enfants d'un document — le sens descendant de la filiation. */
async function childrenOf(document: string): Promise<Array<{ id: string; doc_type: string }>> {
  await client.query('reset role')
  const { rows } = await client.query<{ id: string; doc_type: string }>(
    'select id, doc_type::text from public.sale_document where tenant_id = $1' +
      ' and source_document_id = $2 order by created_at',
    [fixture.tenant, document],
  )
  return rows
}

/* ========================================================================== */
/* 1. Le stock à la confirmation — RÈGLE M3-5                                  */
/* ========================================================================== */

describe('la confirmation d’un bon de livraison', () => {
  it('écrit un mouvement de vente par ligne, et décrémente le stock', async () => {
    await stockUp(fixture.variant, '20')
    await stockUp(fixture.variant2, '5')

    const id = await confirmed('delivery_note', [
      [fixture.variant, '2.500', '10.00'],
      [fixture.variant2, '1', '4.50'],
    ])

    const movements = await movementsOf(id)
    expect(movements.map((m) => [m.movement_type, m.variant_id, m.quantity])).toEqual(
      expect.arrayContaining([
        ['sale', fixture.variant, '-2.500'],
        ['sale', fixture.variant2, '-1.000'],
      ]),
    )
    expect(movements).toHaveLength(2)

    // Le document est désigné, et c'est par là que l'inversion les retrouve.
    expect(movements.every((m) => m.source_type === 'sale_document')).toBe(true)
    // L'appareil qui a vendu, pas celui qui synchronisera (E9).
    expect(movements.every((m) => m.device_id === fixture.device)).toBe(true)
    expect(movements[0]?.note).toContain(`BL-A-${fixture.shortYear}-`)

    // Trois décimales comprises : la quantité est un numeric(12,3).
    expect(await level(fixture.variant)).toBe('17.500')
    expect(await level(fixture.variant2)).toBe('4.000')
  })

  it('se fait par l’employé, qui est celui qui vend', async () => {
    await stockUp(fixture.variant, '10')
    const id = await confirmed('delivery_note', [[fixture.variant, '3', '10.00']])

    // La capacité du type est `create_sale`, partagée par les deux rôles (§ 3.1).
    expect((await movementsOf(id)).map((m) => m.quantity)).toEqual(['-3.000'])
    expect(await level(fixture.variant)).toBe('7.000')
  })

  /*
   * Les deux cas négatifs de la RÈGLE M3-5, et ils portent la règle autant que
   * le cas positif : un devis est une offre, une commande une promesse. Si la
   * condition de type du trigger disparaissait, ce sont ces deux-là qui
   * tomberaient — le cas positif, lui, resterait vert.
   */
  for (const docType of ['quote', 'order'] as const) {
    it(`n’écrit aucun mouvement pour ${docType === 'quote' ? 'un devis' : 'une commande'}`, async () => {
      await stockUp(fixture.variant, '10')
      const id = await confirmed(docType, [[fixture.variant, '3', '10.00']])

      expect(await movementsOf(id)).toHaveLength(0)
      expect(await level(fixture.variant)).toBe('10.000')
    })
  }

  it('ne bouge rien quand le document reste brouillon', async () => {
    await stockUp(fixture.variant, '10')
    await draft('delivery_note', [[fixture.variant, '3', '10.00']])

    expect(await level(fixture.variant)).toBe('10.000')
  })
})

/* ========================================================================== */
/* 2. Le mouvement de vente ne s'écrit pas à la main                           */
/* ========================================================================== */

describe('un mouvement de type sale', () => {
  it('est ouvert sur create_sale, et les deux rôles passent la policy', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ capability: string }>(
      "select capability from merx.movement_type_capability where movement_type = 'sale'",
    )
    expect(rows.map((r) => r.capability)).toEqual(['create_sale'])

    for (const role of ['owner', 'worker'] as const) {
      await asApplication(role)
      const can = await one<{ can: boolean }>("select merx.can('create_sale') as can")
      expect(can.can, role).toBe(true)
    }
  })

  /*
   * Le garde d'origine, et c'est tout ce qui sépare `create_sale` d'un `POST`
   * de mouvements sans écran. La policy, elle, laisse passer les deux rôles —
   * le test ci-dessus le mesure —, donc un refus ici ne peut venir que de lui.
   */
  for (const role of ['owner', 'worker'] as const) {
    it(`refuse l’insertion directe par le ${role === 'owner' ? 'patron' : 'employé'}`, async () => {
      await asApplication(role)
      const written = await attempt(
        client,
        `insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity)
         values ('${fixture.variant}', '${fixture.warehouse}', 'sale', -1)`,
      )

      expect(written.ok, 'FUITE — un mouvement de vente posé à la main').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message).toContain(NOT_BY_HAND)
      // Aucun effet : la ligne de stock, ouverte à zéro avec la variante
      // (E3-02), est restée à zéro.
      expect(await level(fixture.variant)).toBe('0.000')
    })
  }

  it('est déclaré à merx.movement_writer, avec son écrivain', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ function_name: string; movement_type: string }>(
      'select function_name, movement_type::text from merx.movement_writer order by 1',
    )
    expect(rows).toEqual([
      { function_name: 'reverse_sale_movements', movement_type: 'sale_cancellation' },
      { function_name: 'write_sale_movements', movement_type: 'sale' },
    ])
  })
})

/* ========================================================================== */
/* 3. L'annulation a enfin quelque chose à inverser — RÈGLE M3-3              */
/* ========================================================================== */

describe('l’annulation d’un bon confirmé', () => {
  it('remet le stock exactement où il était', async () => {
    await stockUp(fixture.variant, '20')
    await stockUp(fixture.variant2, '5')
    const before = [await level(fixture.variant), await level(fixture.variant2)]

    const id = await confirmed('delivery_note', [
      [fixture.variant, '2.500', '10.00'],
      [fixture.variant2, '1', '4.50'],
    ])
    expect(await level(fixture.variant)).toBe('17.500')

    await asApplication('owner')
    const cancelled = await attempt(
      client,
      `update public.sale_document set status = 'cancelled', cancellation_reason = 'client absent'
       where id = '${id}'`,
    )
    expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)

    // Ni un recalcul depuis les lignes, ni un arrondi de plus : l'inverse.
    expect([await level(fixture.variant), await level(fixture.variant2)]).toEqual(before)

    const movements = await movementsOf(id)
    expect(movements.map((m) => [m.movement_type, m.quantity])).toEqual(
      expect.arrayContaining([
        ['sale', '-2.500'],
        ['sale', '-1.000'],
        ['sale_cancellation', '2.500'],
        ['sale_cancellation', '1.000'],
      ]),
    )
    expect(movements).toHaveLength(4)
  })

  it('ne rejoue rien à la seconde annulation', async () => {
    await stockUp(fixture.variant, '10')
    const id = await confirmed('delivery_note', [[fixture.variant, '3', '10.00']])

    await asApplication('owner')
    await client.query(
      `update public.sale_document set status = 'cancelled', cancellation_reason = 'doublon'
       where id = '${id}'`,
    )
    expect(await level(fixture.variant)).toBe('10.000')

    // `cancelled` est terminal : aucune transition n'en part (RÈGLE M3-3).
    const again = await attempt(
      client,
      `update public.sale_document set status = 'cancelled', cancellation_reason = 'encore'
       where id = '${id}'`,
    )
    expect(again.ok, 'FUITE — un document annulé deux fois').toBe(false)
    if (!again.ok) {
      expect(again.code, again.message).toBe(FROZEN_WRITE)
      expect(again.message).toContain(FROZEN_ROW)
    }

    // Et surtout : aucun second mouvement inverse, donc aucun stock inventé.
    expect(await level(fixture.variant)).toBe('10.000')
    expect((await movementsOf(id)).filter((m) => m.movement_type === 'sale_cancellation'))
      .toHaveLength(1)
  })

  it('n’inverse rien pour un devis, qui n’a jamais rien écrit', async () => {
    await stockUp(fixture.variant, '10')
    const id = await confirmed('quote', [[fixture.variant, '3', '10.00']])

    await asApplication('owner')
    const cancelled = await attempt(
      client,
      `update public.sale_document set status = 'cancelled', cancellation_reason = 'abandonné'
       where id = '${id}'`,
    )
    expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)

    expect(await movementsOf(id)).toHaveLength(0)
    expect(await level(fixture.variant)).toBe('10.000')
  })
})

/* ========================================================================== */
/* 4. La filiation — RÈGLE M3-4                                               */
/* ========================================================================== */

describe('la transformation', () => {
  it('va du devis à la commande puis au bon, sans muter l’original', async () => {
    await stockUp(fixture.variant, '20')
    const quote = await confirmed('quote', [[fixture.variant, '4', '10.00']])
    const before = await row(quote)

    const order = await confirmed('order', [[fixture.variant, '4', '10.00']], quote)
    const note = await confirmed('delivery_note', [[fixture.variant, '4', '10.00']], order)

    // Le lien, dans le sens montant.
    expect((await row(order)).source_document_id).toBe(quote)
    expect((await row(note)).source_document_id).toBe(order)

    // Et dans le sens descendant.
    expect(await childrenOf(quote)).toEqual([{ id: order, doc_type: 'order' }])
    expect(await childrenOf(order)).toEqual([{ id: note, doc_type: 'delivery_note' }])
    expect(await childrenOf(note)).toEqual([])

    // L'original n'a pas bougé d'un champ, `updated_at` compris.
    expect(await row(quote)).toEqual(before)
    // Et seul le bon a fait bouger le stock.
    expect(await level(fixture.variant)).toBe('16.000')
  })

  /*
   * La livraison en deux camions, et c'est l'arbitrage de la story : aucune
   * unicité sur `source_document_id`. Un parent, plusieurs enfants.
   */
  it('laisse un parent donner deux enfants', async () => {
    await stockUp(fixture.variant, '100')
    const order = await confirmed('order', [[fixture.variant, '100', '10.00']])

    const first = await confirmed('delivery_note', [[fixture.variant, '60', '10.00']], order)
    const second = await confirmed('delivery_note', [[fixture.variant, '40', '10.00']], order)

    expect((await childrenOf(order)).map((c) => c.id)).toEqual([first, second])
    expect(await level(fixture.variant)).toBe('0.000')
  })

  it('admet le saut du devis au bon, sans commande', async () => {
    await stockUp(fixture.variant, '10')
    const quote = await confirmed('quote', [[fixture.variant, '2', '10.00']])
    const note = await confirmed('delivery_note', [[fixture.variant, '2', '10.00']], quote)

    expect((await row(note)).source_document_id).toBe(quote)
  })

  it('énumère la chaîne admise, et rien de plus', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ source_type: string; target_type: string }>(
      'select source_type::text, target_type::text from merx.document_transformation order by 1, 2',
    )
    expect(rows).toEqual([
      { source_type: 'order', target_type: 'delivery_note' },
      { source_type: 'quote', target_type: 'delivery_note' },
      { source_type: 'quote', target_type: 'order' },
    ])
  })

  /* ------------------------------------------------------------------------ */
  /* Les quatre branches du garde, chacune sa phrase                           */
  /* ------------------------------------------------------------------------ */

  it('refuse un document issu de lui-même', async () => {
    const id = (await one<{ id: string }>('select gen_random_uuid() as id')).id
    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (id, tenant_id, doc_type, warehouse_id, device_id,
                                         source_document_id)
       values ('${id}', '${fixture.tenant}', 'order', '${fixture.warehouse}',
               '${fixture.device}', '${id}')`,
    )

    expect(written.ok, 'FUITE — un document issu de lui-même').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain(SELF_SOURCE)
  })

  it('refuse un original encore brouillon', async () => {
    const quote = await draft('quote', [[fixture.variant, '2', '10.00']])
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         source_document_id)
       values ('${fixture.tenant}', 'order', '${fixture.warehouse}', '${fixture.device}',
               '${quote}')`,
    )

    expect(written.ok, 'FUITE — une transformation d’un brouillon').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain(SOURCE_DRAFT)
  })

  it('refuse un original annulé', async () => {
    const quote = await confirmed('quote', [[fixture.variant, '2', '10.00']])
    await asApplication('owner')
    await client.query(
      `update public.sale_document set status = 'cancelled', cancellation_reason = 'erreur'
       where id = '${quote}'`,
    )

    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         source_document_id)
       values ('${fixture.tenant}', 'order', '${fixture.warehouse}', '${fixture.device}',
               '${quote}')`,
    )

    expect(written.ok, 'FUITE — une transformation d’un document annulé').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain(SOURCE_CANCELLED)
  })

  /*
   * Rien ne part d'un bon, et rien ne remonte la chaîne. Les deux cas, parce
   * que ce sont deux fautes différentes de celui qui transforme.
   */
  it.each([
    ['delivery_note', 'order'],
    ['order', 'quote'],
  ])('refuse %s → %s', async (sourceType, targetType) => {
    await stockUp(fixture.variant, '10')
    const source = await confirmed(sourceType, [[fixture.variant, '2', '10.00']])

    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         source_document_id)
       values ('${fixture.tenant}', '${targetType}', '${fixture.warehouse}',
               '${fixture.device}', '${source}')`,
    )

    expect(written.ok, `FUITE — ${sourceType} → ${targetType}`).toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain(CHAIN_REFUSED)
  })

  /* ------------------------------------------------------------------------ */
  /* La clé composite — SPEC § 4                                              */
  /* ------------------------------------------------------------------------ */

  /*
   * Les deux documents existent **au même instant**, dans cette transaction-ci :
   * c'est la seule façon de mesurer la propriété. Deux écritures dans deux
   * transactions annulées séparément ne se rencontrent jamais, et une clé
   * étrangère à qui manque `tenant_id` passerait exactement comme une clé
   * complète (CLAUDE.md, E2-06).
   *
   * Le contrôle positif est juste en dessous : le voisin rattache son bon à son
   * propre devis, et ça passe. Sans lui, un refus pour toute autre raison
   * tiendrait lieu de garde.
   */
  it('refuse un original qui appartient au commerce voisin', async () => {
    const mine = await confirmed('quote', [[fixture.variant, '2', '10.00']])

    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         created_by, source_document_id)
       values ('${fixture.other.tenant}', 'order', '${fixture.other.warehouse}',
               '${fixture.other.device}', '${fixture.other.owner}', '${mine}')`,
    )

    expect(written.ok, 'FUITE — un bon rattaché au devis du voisin').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(FOREIGN_KEY_VIOLATION)
    expect(written.message).toContain('sale_document_source_document_id_fkey')
  })

  it('laisse le voisin se rattacher à son propre devis', async () => {
    const theirs = (
      await one<{ id: string }>(
        'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,' +
          " created_by, status) values ($1, 'quote', $2, $3, $4, 'draft') returning id",
        [fixture.other.tenant, fixture.other.warehouse, fixture.other.device, fixture.other.owner],
      )
    ).id
    await client.query(
      "update public.sale_document set status = 'confirmed'," +
        ` doc_number = 'DV-A-${fixture.shortYear}-99000', issued_at = now() where id = $1`,
      [theirs],
    )

    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         created_by, source_document_id)
       values ('${fixture.other.tenant}', 'order', '${fixture.other.warehouse}',
               '${fixture.other.device}', '${fixture.other.owner}', '${theirs}')`,
    )
    expect(written.ok, written.ok ? '' : `${written.code} ${written.message}`).toBe(true)
  })

  /*
   * Le plancher et l'arrondi d'E4-04 s'appliquent aux lignes copiées, et c'est
   * **voulu** : une ligne copiée est une ligne neuve, et le plancher dit ce que
   * l'article ne se vend pas moins cher *aujourd'hui*. Un devis vieux d'un mois
   * sous un plancher relevé depuis est donc refusé à l'employé — refus qui tombe
   * au comptoir, devant quelqu'un qui peut encore agir (faire forcer, ou faire
   * baisser le plancher). C'est l'inverse du cas hors ligne, où le même refus
   * arriverait des jours après la vente : celui-là est en attente de décision
   * (PENDING-CHECKS, BACKLOG E9-03).
   */
  it('refuse une ligne copiée passée sous un plancher relevé depuis', async () => {
    const quote = await confirmed('quote', [[fixture.variant2, '2', '4.50']])

    // Le patron relève le plancher après coup — la grille bouge, le devis non.
    await client.query('reset role')
    await client.query('update public.variant set floor_price = 6.00 where id = $1', [
      fixture.variant2,
    ])

    const order = await draft('order', [], quote)
    await asApplication('worker')
    const copied = await attempt(
      client,
      `insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price)
       values ('${order}', '${fixture.variant2}', 2, 4.50)`,
    )

    expect(copied.ok, 'FUITE — une ligne sous le plancher').toBe(false)
    if (copied.ok) return
    expect(copied.code, copied.message).toBe(INSUFFICIENT_PRIVILEGE)
    expect(copied.message).toContain('Prix sous le plancher')

    // Le patron, lui, passe : la capacité existe, et c'est l'issue au comptoir.
    await asApplication('owner')
    const forced = await attempt(
      client,
      `insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price)
       values ('${order}', '${fixture.variant2}', 2, 4.50)`,
    )
    expect(forced.ok, forced.ok ? '' : `${forced.code} ${forced.message}`).toBe(true)
  })

  /* ------------------------------------------------------------------------ */
  /* Les lignes restent modifiables pendant la transformation                  */
  /* ------------------------------------------------------------------------ */

  it('laisse modifier les lignes de l’enfant tant qu’il est brouillon', async () => {
    const quote = await confirmed('quote', [
      [fixture.variant, '4', '10.00'],
      [fixture.variant2, '1', '4.50'],
    ])
    const order = await draft('order', [[fixture.variant, '4', '10.00']], quote)

    await asApplication('worker')
    const changed = await attempt(
      client,
      `update public.sale_line set quantity = 6 where sale_document_id = '${order}'`,
    )
    expect(changed.ok, changed.ok ? '' : `${changed.code} ${changed.message}`).toBe(true)

    const removed = await attempt(
      client,
      `delete from public.sale_line where sale_document_id = '${order}'`,
    )
    expect(removed.ok, removed.ok ? '' : `${removed.code} ${removed.message}`).toBe(true)

    // L'original, lui, est figé : ses lignes ne bougent plus (RÈGLE M3-3).
    const frozen = await attempt(
      client,
      `update public.sale_line set quantity = 6 where sale_document_id = '${quote}'`,
    )
    expect(frozen.ok, 'FUITE — une ligne modifiée sous un document confirmé').toBe(false)
    if (!frozen.ok) expect(frozen.code, frozen.message).toBe(FROZEN_WRITE)
  })
})
