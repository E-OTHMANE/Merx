// @vitest-environment node

/*
 * E4-06 — les retours, vus de la base.
 * SPEC § 7 M2 (RÈGLES M2-1, M2-5 et son addendum E4-06), § 8 M3 (RÈGLES M3-2,
 * M3-3, M3-4, M3-8, M3-9), § 4 (refus en 4xx).
 *
 * Un retour est un **quatrième type de document de vente**, pas une table à
 * part : le gel, la numérotation locale, la filiation, les totaux et
 * l'annulation valent pour lui mot pour mot. Ce fichier mesure les six choses
 * qui n'appartiennent qu'à lui, et chacune a sa phrase — sans quoi le test de
 * l'une passerait sur le refus de l'autre (CLAUDE.md ; E1-01, E1-02, E2-01,
 * E4-01, E4-05) :
 *
 *   — **un retour est lié à un bon.** Le `check` interdit un retour sans
 *     origine, la chaîne de `merx.document_transformation` interdit une origine
 *     qui n'est pas un bon ;
 *
 *   — **`RT-A-26-00001`**, et une séquence propre : le compteur est clé par
 *     `doc_type` (E4-02) ;
 *
 *   — **RÈGLE M3-9 : on ne rend jamais plus que le bon n'a livré.** Deux
 *     branches, deux phrases — la quantité, et l'avoir. L'excès créerait du
 *     stock à partir de rien **et** un avoir à partir de rien ;
 *
 *   — **le mouvement `return` naît de la confirmation**, et l'écriture à la
 *     main est refusée. Le type est ouvert sur `create_sale`, donc la policy
 *     laisse passer les deux rôles : un refus ne peut venir que du garde ;
 *
 *   — **un bon qui porte un retour vivant ne s'annule pas.** Sans ce garde,
 *     l'inversion des mouvements `sale` recréditerait un stock que le retour
 *     avait déjà rendu — et le stock finirait au-dessus de son départ ;
 *
 *   — **le plancher ne gouverne pas un avoir.** Un retour rend le prix du
 *     papier ; la vente, elle, reste tenue.
 *
 * Les statuts HTTP de ces refus sont mesurés ailleurs — `returns-api.test.ts` —,
 * parce que PostgREST est un autre processus et ne verrait rien de la
 * transaction ouverte ici.
 *
 * Ce qui n'est **pas** mesuré, et qui est écrit dans `docs/PENDING-CHECKS.md` :
 * deux retours du même bon qui se **croisent**, et un retour qui se confirme
 * pendant que le bon s'annule. Le garde prend un verrou `for update` sur le bon
 * d'origine, qui est la ligne que les deux chemins doivent traverser ; le
 * mesurer demande deux connexions entrelacées, ce que le harnais ne sait pas
 * faire (même limite qu'E4-01 et E4-02).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FROZEN_WRITE, INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'returns-e4-06-password'

/** Une contrainte `check` violée, rendue 400 (§ 4). */
const CHECK_VIOLATION = '23514'
/** Ce que lève le garde de la filiation (E4-05), rendu 400. */
const INVALID_SHAPE = '22023'
/** Ce que lève le registre du bon : « demande impossible à satisfaire » → 400. */
const UNSATISFIABLE = 'PT400'

/** Ce que chaque garde, et lui seul, répond. */
const OVER_QUANTITY = "rend plus que le bon n'a livré"
const OVER_CREDIT = "crédite plus que le bon n'a facturé"
const RETURN_BLOCKS_CANCEL = 'porte un retour non annulé'
const NOT_BY_HAND = "ne s'écrit pas à la main"
const CHAIN_REFUSED = 'ne donne pas un document de type'
const BELOW_FLOOR = 'Prix sous le plancher'

const emails = {
  owner: `patron.retour.${Date.now()}@merx.test`,
  worker: `employe.retour.${Date.now()}@merx.test`,
}

let client: Client

const authUsers: Record<'owner' | 'worker', string> = { owner: '', worker: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  device: '',
  variant: '',
  variant2: '',
  shortYear: '',
  appUsers: { owner: '', worker: '' } as Record<'owner' | 'worker', string>,
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
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Retours E4-06')" +
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

const DOC_CODES: Record<string, string> = {
  quote: 'DV',
  order: 'CM',
  delivery_note: 'BL',
  return: 'RT',
}

let numbered = 0

/** `BL-A-26-00001`, pour l'appareil « A » du commerce et l'année du comptoir. */
function nextNumber(docType: string): string {
  numbered += 1
  return `${DOC_CODES[docType]}-A-${fixture.shortYear}-${String(numbered).padStart(5, '0')}`
}

/** Les cinq chiffres de séquence d'un numéro — la lecture du front (E4-02). */
function sequenceOf(docNumber: string | null): number {
  return docNumber === null ? 0 : Number(docNumber.slice(-5))
}

type Line = readonly [variant: string, quantity: string, unitPrice: string]

/** Un brouillon et ses lignes, posés en `postgres`. Les totaux disent la vérité. */
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

/** La confirmation, telle que l'appareil l'envoie — sous le jeton demandé. */
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

/** Le stock d'une variante, hors RLS. `null` : aucune ligne. */
async function level(variant: string): Promise<string | null> {
  await client.query('reset role')
  const { rows } = await client.query<{ quantity: string }>(
    'select quantity::text from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [variant, fixture.warehouse],
  )
  return rows[0]?.quantity ?? null
}

/** Pose du stock avant la vente, par un `adjustment` — le seul type écrit à la main. */
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
  source_document_id: string | null
}> {
  await client.query('reset role')
  return await one(
    'select doc_type::text, status::text, doc_number, source_document_id' +
      ' from public.sale_document where id = $1',
    [document],
  )
}

/** Annule un document, sous le jeton du patron — `cancel_document` l'exige. */
async function cancel(document: string, reason = 'erreur de saisie'): Promise<ReturnType<typeof attempt>> {
  await asApplication('owner')
  return await attempt(
    client,
    `update public.sale_document set status = 'cancelled', cancellation_reason = '${reason}'
     where id = '${document}'`,
  )
}

/**
 * Un bon livré, prêt à être retourné : le stock est posé, le bon est confirmé.
 * Rend l'identifiant du bon.
 */
async function delivered(lines: readonly Line[]): Promise<string> {
  for (const [variant, quantity] of lines) await stockUp(variant, quantity)
  return await confirmed('delivery_note', lines)
}

/* ========================================================================== */
/* 1. Un retour est lié à un bon existant                                      */
/* ========================================================================== */

describe('un retour', () => {
  it('se rattache à un bon de livraison confirmé', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '3', '9.00']], note)

    expect((await row(back)).source_document_id).toBe(note)
    expect((await row(back)).doc_type).toBe('return')
  })

  /*
   * Sans ce `check`, un retour sans origine passe tout : le garde de chaîne ne
   * se déclenche que si `source_document_id` est posé (c'est la condition de
   * son trigger). Il rendrait du stock qu'aucun bon n'a livré.
   */
  it('ne peut pas naître sans bon d’origine', async () => {
    await client.query('reset role')
    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id)
       values ('${fixture.tenant}', 'return', '${fixture.warehouse}', '${fixture.device}')`,
    )

    expect(written.ok, 'FUITE — un retour issu de rien').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(CHECK_VIOLATION)
    // La contrainte se nomme : deux `check` répondent le même code (CLAUDE.md).
    expect(written.message).toContain('sale_document_return_has_source')
  })

  it('ne se rattache pas à un devis : rien n’y a été livré', async () => {
    const quote = await confirmed('quote', [[fixture.variant, '3', '9.00']])
    await client.query('reset role')

    const written = await attempt(
      client,
      `insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,
                                         source_document_id)
       values ('${fixture.tenant}', 'return', '${fixture.warehouse}', '${fixture.device}',
               '${quote}')`,
    )

    expect(written.ok, 'FUITE — un retour sur un devis').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain(CHAIN_REFUSED)
  })

  it('énumère la chaîne admise, retour compris', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ source_type: string; target_type: string }>(
      'select source_type::text, target_type::text from merx.document_transformation order by 1, 2',
    )
    expect(rows).toEqual([
      { source_type: 'delivery_note', target_type: 'return' },
      { source_type: 'order', target_type: 'delivery_note' },
      { source_type: 'quote', target_type: 'delivery_note' },
      { source_type: 'quote', target_type: 'order' },
    ])
  })
})

/* ========================================================================== */
/* 2. Le papier : RT-A-26-00001 — RÈGLE M3-2                                   */
/* ========================================================================== */

describe('le numéro d’un retour', () => {
  it('porte le code RT', async () => {
    await client.query('reset role')
    const code = await one<{ code: string }>(
      "select merx.doc_type_code('return'::public.sale_doc_type) as code",
    )
    expect(code.code).toBe('RT')
  })

  it('refuse le code d’un autre type', async () => {
    const note = await delivered([[fixture.variant, '5', '9.00']])
    const back = await draft('return', [[fixture.variant, '1', '9.00']], note)

    await asApplication('worker')
    const written = await attempt(
      client,
      `update public.sale_document
       set status = 'confirmed', doc_number = 'BL-A-${fixture.shortYear}-09999', issued_at = now()
       where id = '${back}'`,
    )

    expect(written.ok, 'FUITE — un retour numéroté en BL').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INVALID_SHAPE)
    expect(written.message).toContain("n'est pas celui du type")
  })

  /*
   * La séquence est clé par `(commerce, appareil, doc_type, année)` : le retour
   * a son propre compteur sans qu'une ligne ait été ajoutée à la table. Le
   * serveur **constate**, il n'attribue pas (RÈGLE M3-2).
   */
  it('avance une séquence qui n’est pas celle des bons', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '2', '9.00']], note)

    await client.query('reset role')
    const { rows } = await client.query<{ doc_type: string; last_number: number }>(
      'select doc_type::text, last_number from public.document_sequence' +
        ' where tenant_id = $1 and device_id = $2 order by doc_type',
      [fixture.tenant, fixture.device],
    )

    const bySeq = new Map(rows.map((r) => [r.doc_type, r.last_number]))
    expect(bySeq.get('return')).toBe(sequenceOf((await row(back)).doc_number))
    expect(bySeq.get('delivery_note')).toBe(sequenceOf((await row(note)).doc_number))
  })
})

/* ========================================================================== */
/* 3. RÈGLE M3-9 — on ne rend jamais plus que le bon n'a livré                 */
/* ========================================================================== */

describe('le registre du bon', () => {
  it('laisse passer un retour partiel, et remet le stock', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    expect(await level(fixture.variant)).toBe('0.000')

    const back = await confirmed('return', [[fixture.variant, '3', '9.00']], note)

    expect(await level(fixture.variant)).toBe('3.000')
    expect((await movementsOf(back)).map((m) => [m.movement_type, m.quantity])).toEqual([
      ['return', '3.000'],
    ])
  })

  it('laisse passer un retour total', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await confirmed('return', [[fixture.variant, '10', '9.00']], note)

    expect(await level(fixture.variant)).toBe('10.000')
  })

  /*
   * Le cas qui porte la RÈGLE. Sans le garde, ces 12 pièces entreraient au
   * dépôt sans jamais en être sorties, et le client serait crédité de 108 DH
   * pour 90 DH de marchandise.
   */
  it('refuse de rendre plus que le bon n’a livré', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await draft('return', [[fixture.variant, '12', '9.00']], note)

    const written = await confirm(back, 'return')

    expect(written.ok, 'FUITE — un retour de 12 sur un bon de 10').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(UNSATISFIABLE)
    expect(written.message).toContain(OVER_QUANTITY)

    // Aucun effet : le retour est resté brouillon, et rien n'est entré.
    expect((await row(back)).status).toBe('draft')
    expect(await movementsOf(back)).toHaveLength(0)
    expect(await level(fixture.variant)).toBe('0.000')
  })

  it('déduit les retours déjà enregistrés', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await confirmed('return', [[fixture.variant, '6', '9.00']], note)
    await confirmed('return', [[fixture.variant, '4', '9.00']], note)
    expect(await level(fixture.variant)).toBe('10.000')

    // Le onzième n'existe pas.
    const third = await draft('return', [[fixture.variant, '1', '9.00']], note)
    const written = await confirm(third, 'return')

    expect(written.ok, 'FUITE — onze pièces rendues sur un bon de dix').toBe(false)
    if (written.ok) return
    expect(written.message).toContain(OVER_QUANTITY)
    expect(await level(fixture.variant)).toBe('10.000')
  })

  /* Un retour annulé a rendu son stock : son registre se libère avec lui. */
  it('rend sa place à un retour annulé', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const first = await confirmed('return', [[fixture.variant, '10', '9.00']], note)

    const undone = await cancel(first, 'retour enregistré par erreur')
    expect(undone.ok, undone.ok ? '' : `${undone.code} ${undone.message}`).toBe(true)
    expect(await level(fixture.variant)).toBe('0.000')

    const second = await confirmed('return', [[fixture.variant, '10', '9.00']], note)
    expect((await movementsOf(second)).map((m) => m.quantity)).toEqual(['10.000'])
    expect(await level(fixture.variant)).toBe('10.000')
  })

  /*
   * Un brouillon ne consomme rien : un retour abandonné bloquerait le bon pour
   * toujours. C'est l'autre moitié de l'arbitrage sur « ce qui compte comme
   * déjà rendu ».
   */
  it('ne compte pas un retour resté brouillon', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await draft('return', [[fixture.variant, '10', '9.00']], note)

    const real = await confirmed('return', [[fixture.variant, '10', '9.00']], note)
    expect((await movementsOf(real)).map((m) => m.quantity)).toEqual(['10.000'])
  })

  it('tient le registre variante par variante', async () => {
    const note = await delivered([
      [fixture.variant, '10', '9.00'],
      [fixture.variant2, '2', '4.00'],
    ])

    // Deux de la seconde variante : le registre de la première n'y est pour rien.
    const back = await draft('return', [[fixture.variant2, '3', '4.00']], note)
    const written = await confirm(back, 'return')

    expect(written.ok, 'FUITE — trois rendus sur deux livrés').toBe(false)
    if (written.ok) return
    expect(written.message).toContain(OVER_QUANTITY)

    // Et la variante bien livrée passe.
    const other = await confirmed('return', [[fixture.variant, '10', '9.00']], note)
    expect((await movementsOf(other)).map((m) => m.quantity)).toEqual(['10.000'])
  })

  /*
   * La seconde branche, et c'est pour elle qu'elle existe : la quantité est
   * juste, le prix ne l'est pas. Sans elle, un `POST` crédite 120 DH pour
   * 90 DH de marchandise, et la première branche ne voit rien passer.
   */
  it('refuse de créditer plus que le bon n’a facturé', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await draft('return', [[fixture.variant, '10', '12.00']], note)

    const written = await confirm(back, 'return')

    expect(written.ok, 'FUITE — un avoir de 120 DH sur un bon de 90 DH').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(UNSATISFIABLE)
    expect(written.message).toContain(OVER_CREDIT)
    expect(await level(fixture.variant)).toBe('0.000')
  })

  /*
   * **Les deux branches tombent séparément**, et ce cas-ci est né de la passe
   * de sabotage : retirer la branche quantité laissait la suite verte, parce
   * que tous les retours excessifs qu'elle mesurait dépassaient *aussi* en
   * montant, et la branche avoir refusait à sa place. Douze pièces à 7 DH
   * créditent 84 DH sur un bon de 90 : l'avoir est dans les clous, et douze
   * pièces entrent au dépôt sans jamais en être sorties.
   */
  it('refuse plus de pièces que livrées, même à un prix plus bas', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await draft('return', [[fixture.variant, '12', '7.00']], note)

    const written = await confirm(back, 'return')

    expect(written.ok, 'FUITE — douze pièces rendues sous le total du bon').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(UNSATISFIABLE)
    expect(written.message).toContain(OVER_QUANTITY)
    expect(await level(fixture.variant)).toBe('0.000')
  })

  it('laisse passer un prix plus bas que celui du bon', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '10', '8.00']], note)

    expect((await movementsOf(back)).map((m) => m.quantity)).toEqual(['10.000'])
  })
})

/* ========================================================================== */
/* 4. Le mouvement `return` — RÈGLE M2-5, addendum E4-06                      */
/* ========================================================================== */

describe('un mouvement de type return', () => {
  it('naît de la confirmation, un par ligne, positif', async () => {
    const note = await delivered([
      [fixture.variant, '10', '9.00'],
      [fixture.variant2, '4', '4.00'],
    ])
    const back = await confirmed(
      'return',
      [
        [fixture.variant, '2.500', '9.00'],
        [fixture.variant2, '1', '4.00'],
      ],
      note,
    )

    const movements = (await movementsOf(back)).filter((m) => m.movement_type === 'return')
    expect(movements.map((m) => [m.variant_id, m.quantity])).toEqual(
      expect.arrayContaining([
        [fixture.variant, '2.500'],
        [fixture.variant2, '1.000'],
      ]),
    )
    expect(movements).toHaveLength(2)

    // Le document est désigné : c'est par là que l'inversion les retrouve.
    expect(movements.every((m) => m.source_type === 'sale_document')).toBe(true)
    // L'appareil qui a pris le retour, pas celui qui synchronisera (E9).
    expect(movements.every((m) => m.device_id === fixture.device)).toBe(true)
    expect(movements[0]?.note).toContain(`RT-A-${fixture.shortYear}-`)

    // Trois décimales comprises : la quantité est un numeric(12,3).
    expect(await level(fixture.variant)).toBe('2.500')
  })

  it('ne bouge rien tant que le retour est brouillon', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await draft('return', [[fixture.variant, '3', '9.00']], note)

    expect(await level(fixture.variant)).toBe('0.000')
  })

  /*
   * Le cas négatif de la condition de type du trigger : un bon confirmé écrit
   * des `sale`, jamais des `return`. Si la condition disparaissait, c'est celui-ci
   * qui tomberait — pas le cas positif.
   */
  it('n’est écrit par aucun autre type de document', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const quote = await confirmed('quote', [[fixture.variant, '3', '9.00']])

    expect((await movementsOf(note)).every((m) => m.movement_type === 'sale')).toBe(true)
    expect(await movementsOf(quote)).toHaveLength(0)
  })

  it('est ouvert sur create_sale, et les deux rôles passent la policy', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ capability: string }>(
      "select capability from merx.movement_type_capability where movement_type = 'return'",
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
   * de stock sans écran. La policy laisse passer les deux rôles — le cas
   * ci-dessus le mesure —, donc un refus ici ne peut venir que de lui.
   */
  for (const role of ['owner', 'worker'] as const) {
    it(`refuse l’insertion directe par le ${role === 'owner' ? 'patron' : 'employé'}`, async () => {
      await asApplication(role)
      const written = await attempt(
        client,
        `insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity)
         values ('${fixture.variant}', '${fixture.warehouse}', 'return', 5)`,
      )

      expect(written.ok, 'FUITE — du stock rendu sans bon de retour').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message).toContain(NOT_BY_HAND)
      // Et la phrase est la sienne, pas celle de la vente.
      expect(written.message).toContain('bon de retour')
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
      { function_name: 'write_return_movements', movement_type: 'return' },
      { function_name: 'write_sale_movements', movement_type: 'sale' },
    ])
  })
})

/* ========================================================================== */
/* 5. L'annulation, des deux côtés du lien                                     */
/* ========================================================================== */

describe('l’annulation', () => {
  it('d’un retour reprend ce qu’il avait rendu', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '4', '9.00']], note)
    expect(await level(fixture.variant)).toBe('4.000')

    const undone = await cancel(back, 'le client est revenu le chercher')
    expect(undone.ok, undone.ok ? '' : `${undone.code} ${undone.message}`).toBe(true)

    expect(await level(fixture.variant)).toBe('0.000')
    expect((await movementsOf(back)).map((m) => [m.movement_type, m.quantity])).toEqual(
      expect.arrayContaining([
        ['return', '4.000'],
        ['sale_cancellation', '-4.000'],
      ]),
    )
  })

  /*
   * Le trou que le quatrième `doc_type` ouvrait, et que ce garde ferme : un bon
   * de 10 (−10), un retour de 3 (+3), puis l'annulation du bon (+10) — le stock
   * finirait à +3 de trop, et l'avoir du retour survivrait à une vente qui
   * n'existe plus.
   */
  it('d’un bon est refusée tant qu’un retour vit', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '3', '9.00']], note)
    expect(await level(fixture.variant)).toBe('3.000')

    const refused = await cancel(note, 'client introuvable')

    expect(refused.ok, 'FUITE — un bon annulé sous un retour vivant').toBe(false)
    if (refused.ok) return
    expect(refused.code, refused.message).toBe(FROZEN_WRITE)
    expect(refused.message).toContain(RETURN_BLOCKS_CANCEL)
    // La phrase nomme le retour : « annulez vos retours » sans dire lesquels
    // n'apprend rien à personne.
    expect(refused.message).toContain((await row(back)).doc_number ?? '—')

    // Aucun effet : le bon est resté confirmé, et le stock n'a pas bougé.
    expect((await row(note)).status).toBe('confirmed')
    expect(await level(fixture.variant)).toBe('3.000')
  })

  it('d’un bon passe une fois son retour annulé', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const back = await confirmed('return', [[fixture.variant, '3', '9.00']], note)

    const undone = await cancel(back, 'retour saisi en double')
    expect(undone.ok, undone.ok ? '' : `${undone.code} ${undone.message}`).toBe(true)

    const then = await cancel(note, 'client introuvable')
    expect(then.ok, then.ok ? '' : `${then.code} ${then.message}`).toBe(true)

    // Le stock revient exactement à son départ : les trois pièces rendues ont
    // été reprises, puis les dix du bon rendues une seule fois.
    expect(await level(fixture.variant)).toBe('10.000')
  })

  /* Le contrôle positif : sans retour, rien n'a changé pour un bon. */
  it('d’un bon sans retour reste libre', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    const cancelled = await cancel(note, 'client absent')

    expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)
    expect(await level(fixture.variant)).toBe('10.000')
  })

  /* Un brouillon de retour n'a rien rendu : il ne bloque rien. */
  it('d’un bon reste libre sous un retour resté brouillon', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await draft('return', [[fixture.variant, '3', '9.00']], note)

    const cancelled = await cancel(note, 'client absent')
    expect(cancelled.ok, cancelled.ok ? '' : `${cancelled.code} ${cancelled.message}`).toBe(true)
    expect(await level(fixture.variant)).toBe('10.000')
  })
})

/* ========================================================================== */
/* 6. Le plancher ne gouverne pas un avoir — RÈGLE M3-8                        */
/* ========================================================================== */

describe('le plancher', () => {
  /** Pose un plancher sur la variante, hors RLS. */
  async function floorAt(price: string): Promise<void> {
    await client.query('reset role')
    await client.query('update public.variant set floor_price = $1 where id = $2', [
      price,
      fixture.variant,
    ])
  }

  /*
   * Un bon ancien, un plancher relevé depuis : le retour rend le prix du
   * papier, et le garde de vente n'a rien à y voir. Sans la sortie, ce serait
   * un refus de vente appliqué à un remboursement.
   */
  it('ne s’applique pas à une ligne de retour', async () => {
    const note = await delivered([[fixture.variant, '10', '9.00']])
    await floorAt('11.00')

    const back = await confirmed('return', [[fixture.variant, '10', '9.00']], note)
    expect((await movementsOf(back)).map((m) => m.quantity)).toEqual(['10.000'])
  })

  /* Le contrôle positif : la vente, elle, reste tenue. */
  it('reste opposé à l’employé qui vend sous lui', async () => {
    await floorAt('11.00')
    const note = await draft('delivery_note', [])

    await asApplication('worker')
    const written = await attempt(
      client,
      `insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price)
       values ('${note}', '${fixture.variant}', 1, 9.00)`,
    )

    expect(written.ok, 'FUITE — une vente sous le plancher par l’employé').toBe(false)
    if (written.ok) return
    expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
    expect(written.message).toContain(BELOW_FLOOR)
  })
})
