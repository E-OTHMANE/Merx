// @vitest-environment node

/*
 * E4-04 — la résolution du prix, vue de la base.
 * SPEC § 3.1 (astérisque du plancher), § 6 M1 (`floor_price`), § 8 M3
 * (RÈGLE M3-7, `sale_line`), § 9 (RÈGLE M8-1).
 *
 * Quatre propriétés, et chacune son garde — aucun ne refuse comme un autre,
 * sans quoi le test de l'un passerait sur le refus du voisin (CLAUDE.md ;
 * E1-01, E1-02, E2-01) :
 *
 *   — **l'arrondi n'est plus affirmé par l'appareil.** `line_total` est une
 *     colonne engendrée : une valeur fournie est refusée, et la base calcule
 *     `round(quantity × unit_price, 2) − line_discount`. Le même centime que
 *     `src/modules/sales/amounts.ts`, **mesuré** ici sur la vraie base plutôt
 *     que supposé des deux côtés ;
 *
 *   — **le plancher**. `merx.require_floor_price()` refuse en `42501` avec sa
 *     phrase, qui n'est pas celle de l'écran ; le patron passe par
 *     `override_price_below_floor` (§ 3.1). Le garde ne regarde pas
 *     `price_source` : sinon il se contournerait en posant `auto` ;
 *
 *   — **les deux sortes de `manual`**. `sale_line_override_shape` tient les
 *     trois états admis, et le nom de la contrainte est asserté : deux `check`
 *     refusent de la même façon, et celui qu'on croit mesurer n'est pas
 *     toujours celui qui a refusé (E2-01) ;
 *
 *   — **la cohérence des totaux**. Un `check` dans la ligne du document, et
 *     `merx.require_consistent_totals()` pour la somme, à la confirmation
 *     seulement — un brouillon s'écrit avant ses lignes (E4-03) ;
 *
 *   — **la trace**. Une entrée `price_override` par forçage, et **aucune** pour
 *     une ligne sans prix ni pour une ligne au palier : la condition de ligne du
 *     trigger est éprouvée dans les deux sens. Son auteur est **celui qui
 *     écrit** la ligne, ce qui est toute la raison pour laquelle la trace n'est
 *     pas posée à la confirmation du document.
 *
 * Les statuts HTTP de ces refus sont mesurés ailleurs — `sale-price-api.test.ts`
 * —, parce que PostgREST est un autre processus et ne verrait rien de la
 * transaction ouverte ici.
 *
 * Tout est posé en `postgres` dans une transaction annulée en fin de fichier.
 * Les deux comptes d'authentification vivent hors transaction — la clé
 * étrangère d'`app_user.auth_user_id` les exige réellement présents — et sont
 * supprimés au démontage. Ils sont nécessaires : un forçage journalise, et
 * `merx.log_audit()` prend son auteur du `sub` du jeton (E1-04, E3-03).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { lineTotalText } from '../../src/modules/sales/amounts'
import { INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'sale-price-e4-04-password'

/** Une contrainte `check` violée. */
const CHECK_VIOLATION = '23514'
/** Ce que Postgres répond à une valeur fournie pour une colonne engendrée. */
const GENERATED_ALWAYS = '428C9'

/** Les contraintes, nommées : c'est elles qu'on mesure, pas une voisine. */
const OVERRIDE_SHAPE = 'sale_line_override_shape'
const DOCUMENT_TOTAL = 'sale_document_total_consistent'

/** Ce que chaque garde, et lui seul, répond. */
const BELOW_FLOOR = 'Prix sous le plancher de cette variante'
const FLOOR_CAPABILITY = 'override_price_below_floor'
const TOTALS_LIE = 'ne dit pas la vérité sur ses lignes'

const emails = {
  owner: `patron.prix.${Date.now()}@merx.test`,
  worker: `employe.prix.${Date.now()}@merx.test`,
}

let client: Client

const authUsers: Record<'owner' | 'worker', string> = { owner: '', worker: '' }

const fixture = {
  tenant: '',
  device: '',
  /** Sans plancher : le garde n'a alors aucun avis. */
  variant: '',
  /** Plancher à 11,50 — le cas du garde. */
  floored: '',
  appUsers: { owner: '', worker: '' } as Record<'owner' | 'worker', string>,
}

async function one<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

/** Une variante, et son plancher s'il en a un. */
async function seedVariant(name: string, floor: string | null): Promise<string> {
  const product = await one<{ id: string }>(
    'insert into public.product (tenant_id, name_fr) values ($1, $2) returning id',
    [fixture.tenant, name],
  )
  // La variante par défaut porte l'identifiant de son produit depuis E2-01.
  const variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [fixture.tenant, product.id],
    )
  ).id
  if (floor !== null) {
    await client.query('update public.variant set floor_price = $2 where id = $1', [variant, floor])
  }
  return variant
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
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Prix E4-04')" +
        ' returning id',
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

  fixture.variant = await seedVariant('Crème hydratante', null)
  fixture.floored = await seedVariant('Savon noir', '11.50')
})

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()

  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== '') await deleteAuthUser(authUsers[role])
  }
}, 30_000)

/*
 * Un cas par point de sauvegarde, rôle remis avant de le relâcher. Le journal
 * est relu en entier par `overrideEntries()` : sans cela, les entrées d'un cas
 * se compteraient dans le suivant, et « aucune entrée » ne voudrait rien dire.
 */
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

/** Un brouillon, posé hors mesure en `postgres`. Un préparatif ne mesure rien. */
async function draft(totals = '0'): Promise<string> {
  await client.query('reset role')
  return (
    await one<{ id: string }>(
      'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,' +
        ' created_by, subtotal, total)' +
        " values ($1, 'delivery_note'," +
        ' (select id from public.warehouse where tenant_id = $1 and is_default), $2, $3, $4, $4)' +
        ' returning id',
      [fixture.tenant, fixture.device, fixture.appUsers.owner, totals],
    )
  ).id
}

/**
 * L'ordre d'insertion d'une ligne, tel que l'écran l'envoie : ni `tenant_id` ni
 * `created_by` — ils ont pour défaut le commerce et la fiche du jeton —, et
 * **jamais `line_total`**, que la base engendre. La charge est complète par
 * ailleurs, pour qu'un refus ne puisse venir que du garde mesuré (CLAUDE.md,
 * gardes RLS en écriture).
 */
function lineSql(
  document: string,
  variant: string,
  quantity: string,
  unitPrice: string,
  source: 'auto' | 'manual' = 'auto',
  overridden: string | null = null,
): string {
  return (
    'insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price,' +
    ' price_source, overridden_price)' +
    ` values ('${document}'::uuid, '${variant}'::uuid, ${quantity}, ${unitPrice},` +
    ` '${source}'::public.price_source, ${overridden === null ? 'null' : overridden})`
  )
}

/** Les lignes d'un document, relues hors RLS. */
async function linesOf(document: string): Promise<
  Array<{
    quantity: string
    unit_price: string
    line_total: string
    price_source: string
    overridden_price: string | null
    created_by: string | null
  }>
> {
  await client.query('reset role')
  const { rows } = await client.query<{
    quantity: string
    unit_price: string
    line_total: string
    price_source: string
    overridden_price: string | null
    created_by: string | null
  }>(
    'select quantity::text, unit_price::text, line_total::text, price_source::text,' +
      ' overridden_price::text, created_by from public.sale_line' +
      ' where sale_document_id = $1 order by created_at',
    [document],
  )
  return rows
}

/**
 * Les entrées de journal du commerce, relues **hors RLS**.
 *
 * `audit_log` porte une policy restrictive qui exige `view_audit_log` : sous le
 * jeton de l'employé elle rendrait zéro ligne que l'entrée existe ou non, et un
 * « zéro » ne dirait rien (CLAUDE.md, E3-03).
 *
 * Les montants sont relus en **texte** (`->>` et non `->`) : le pilote rend un
 * nombre JSON comme un flottant JavaScript, et « 12.00 » reviendrait en `12`.
 * La valeur en base est exacte ; une assertion qui passe par un flottant ne
 * peut pas le dire (SPEC § 4, jamais de flottant).
 */
async function overrideEntries(): Promise<
  Array<{
    action: string
    entity_type: string
    entity_id: string
    user_id: string
    before_overridden: string | null
    after_overridden: string | null
    after_unit_price: string | null
    after_quantity: string | null
  }>
> {
  await client.query('reset role')
  const { rows } = await client.query<{
    action: string
    entity_type: string
    entity_id: string
    user_id: string
    before_overridden: string | null
    after_overridden: string | null
    after_unit_price: string | null
    after_quantity: string | null
  }>(
    'select action::text, entity_type, entity_id, user_id,' +
      " \"before\" ->> 'overridden_price' as before_overridden," +
      " \"after\" ->> 'overridden_price' as after_overridden," +
      " \"after\" ->> 'unit_price' as after_unit_price," +
      " \"after\" ->> 'quantity' as after_quantity" +
      ' from public.audit_log where tenant_id = $1 order by created_at',
    [fixture.tenant],
  )
  return rows
}

/* ========================================================================== */
/* 1. L'arrondi — RÈGLE M3-7                                                   */
/* ========================================================================== */

describe('le total d’une ligne', () => {
  it('ne s’envoie pas : la base l’engendre', async () => {
    const document = await draft()
    await asApplication('owner')

    const refused = await attempt(
      client,
      'insert into public.sale_line (sale_document_id, variant_id, quantity, unit_price, line_total)' +
        ` values ('${document}'::uuid, '${fixture.variant}'::uuid, 3, 10.00, 30.00)`,
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe(GENERATED_ALWAYS)
  })

  /*
   * Les cinq décimales du produit ramenées à deux, demi loin de zéro. Les cas
   * sont ceux où une autre convention tomberait ailleurs : le demi exact
   * (2,5 × 3,33 = 8,325 → 8,33 ; une troncature dirait 8,32, un demi vers le
   * pair 8,32), et le demi d'un rang pair.
   */
  it.each([
    ['3', '10.00', '30.00'],
    ['2.5', '3.33', '8.33'],
    ['1.5', '0.01', '0.02'],
    ['0.125', '1.00', '0.13'],
    ['24', '11.00', '264.00'],
    ['0.001', '0.01', '0.00'],
  ])('vaut round(%s × %s, 2) = %s', async (quantity, price, expected) => {
    const document = await draft()
    await asApplication('owner')

    const written = await attempt(client, lineSql(document, fixture.variant, quantity, price))
    expect(written.ok).toBe(true)

    const [line] = await linesOf(document)
    expect(line?.line_total).toBe(expected)
  })

  /*
   * L'accord sur le centime, **mesuré**. `amounts.ts` calcule le même total pour
   * afficher ; si les deux règles divergeaient d'un centime, le bon imprimé
   * dirait autre chose que le bon stocké — et c'est ce test qui le dirait, non
   * une relecture des deux codes.
   */
  it('tombe sur le même centime que l’appareil', async () => {
    const document = await draft()
    await asApplication('owner')

    const cases: Array<[string, string]> = [
      ['2.5', '3.33'],
      ['0.125', '1.00'],
      ['1.5', '0.01'],
      ['7.777', '9.99'],
      ['120', '9.50'],
      ['0.001', '0.01'],
      ['48.333', '12.34'],
    ]

    for (const [quantity, price] of cases) {
      await client.query('savepoint agreement')
      await asApplication('owner')
      await client.query(lineSql(document, fixture.variant, quantity, price))
      const [line] = await linesOf(document)
      expect(line?.line_total).toBe(lineTotalText(quantity, price))
      await client.query('rollback to savepoint agreement')
    }
  })

  /*
   * Un brouillon est libre (RÈGLE M3-3) : sa quantité change, et le total suit
   * tout seul. C'est la seconde raison de la colonne engendrée — E4-01 devait
   * réécrire les deux à la main, donc pouvait les désaccorder.
   */
  it('suit la quantité d’un brouillon sans qu’on l’y invite', async () => {
    const document = await draft()
    await asApplication('owner')
    await client.query(lineSql(document, fixture.variant, '3', '10.00'))

    await asApplication('owner')
    await client.query(
      `update public.sale_line set quantity = 9 where sale_document_id = '${document}'`,
    )

    const [line] = await linesOf(document)
    expect(line?.line_total).toBe('90.00')
  })
})

/* ========================================================================== */
/* 2. Le plancher — § 3.1                                                      */
/* ========================================================================== */

describe('le plancher', () => {
  it('refuse l’employé sous le plancher, en nommant la capacité', async () => {
    const document = await draft()
    await asApplication('worker')

    const refused = await attempt(
      client,
      lineSql(document, fixture.floored, '1', '10.00', 'manual', '12.00'),
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(refused.message).toContain(BELOW_FLOOR)
      expect(refused.message).toContain(FLOOR_CAPABILITY)
    }
    // Et rien n'est créé : un refus qui laisserait la ligne ne refuserait rien.
    expect(await linesOf(document)).toHaveLength(0)
  })

  /*
   * Le contrôle positif. Sans lui, tous les cas de refus passeraient pour
   * n'importe quelle raison — une policy, un privilège, une charge incomplète.
   */
  it('laisse passer l’employé au-dessus du plancher', async () => {
    const document = await draft()
    await asApplication('worker')

    const written = await attempt(
      client,
      lineSql(document, fixture.floored, '1', '12.00', 'manual', '13.00'),
    )

    expect(written.ok).toBe(true)
    expect(await linesOf(document)).toHaveLength(1)
  })

  it('laisse passer l’employé au plancher exactement', async () => {
    const document = await draft()
    await asApplication('worker')

    const written = await attempt(
      client,
      lineSql(document, fixture.floored, '1', '11.50', 'manual', '13.00'),
    )
    expect(written.ok).toBe(true)
  })

  it('laisse passer le patron en dessous — override_price_below_floor', async () => {
    const document = await draft()
    await asApplication('owner')

    const written = await attempt(
      client,
      lineSql(document, fixture.floored, '1', '10.00', 'manual', '12.00'),
    )

    expect(written.ok).toBe(true)
    const [line] = await linesOf(document)
    expect(line?.unit_price).toBe('10.00')
  })

  it('n’a aucun avis sur une variante sans plancher', async () => {
    const document = await draft()
    await asApplication('worker')

    const written = await attempt(
      client,
      lineSql(document, fixture.variant, '1', '0.50', 'manual', '12.00'),
    )
    expect(written.ok).toBe(true)
  })

  /*
   * Le garde ne regarde pas `price_source`. S'il ne valait que pour `manual`,
   * un employé poserait `auto` par l'API et passerait dessous — le contrôle
   * serait une politesse. Conséquence assumée : un palier réglé sous le
   * plancher est invendable par l'employé (BACKLOG E2-03).
   */
  it('vaut aussi pour une ligne au palier, source auto', async () => {
    const document = await draft()
    await asApplication('worker')

    const refused = await attempt(client, lineSql(document, fixture.floored, '1', '9.00'))

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain(BELOW_FLOOR)
  })

  /*
   * Et il tient la modification, pas seulement la naissance : les lignes d'un
   * brouillon se modifient (RÈGLE M3-3), donc un prix peut descendre après
   * coup.
   */
  it('tient aussi la modification d’une ligne de brouillon', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.floored, '1', '12.00', 'manual', '13.00'))

    await asApplication('worker')
    const refused = await attempt(
      client,
      `update public.sale_line set unit_price = 9.00 where sale_document_id = '${document}'`,
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain(BELOW_FLOOR)

    const [line] = await linesOf(document)
    expect(line?.unit_price).toBe('12.00')
  })
})

/* ========================================================================== */
/* 3. Les deux sortes de `manual`                                              */
/* ========================================================================== */

describe('la forme d’un forçage', () => {
  it.each([
    ['le prix du palier', 'auto', null],
    ['aucun prix n’existait', 'manual', null],
    ['un forçage', 'manual', '12.00'],
  ] as Array<[string, 'auto' | 'manual', string | null]>)(
    'admet %s',
    async (_label, source, overridden) => {
      const document = await draft()
      await asApplication('owner')

      const written = await attempt(
        client,
        lineSql(document, fixture.variant, '1', '10.00', source, overridden),
      )
      expect(written.ok).toBe(true)
    },
  )

  /*
   * Un prix remplacé posé sur une ligne `auto` : la ligne dirait qu'elle est au
   * palier *et* qu'elle en remplace un. Le journal, qui lit `overridden_price`,
   * compterait un forçage que `price_source` démentirait.
   */
  it('refuse un prix remplacé sur une ligne au palier', async () => {
    const document = await draft()
    await asApplication('owner')

    const refused = await attempt(
      client,
      lineSql(document, fixture.variant, '1', '10.00', 'auto', '12.00'),
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain(OVERRIDE_SHAPE)
    }
  })

  /* Un prix remplacé égal au prix retenu ne remplace rien. */
  it('refuse un prix remplacé égal au prix retenu', async () => {
    const document = await draft()
    await asApplication('owner')

    const refused = await attempt(
      client,
      lineSql(document, fixture.variant, '1', '10.00', 'manual', '10.00'),
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain(OVERRIDE_SHAPE)
    }
  })
})

/* ========================================================================== */
/* 4. La cohérence des totaux — RÈGLE M3-7                                     */
/* ========================================================================== */

describe('les totaux du document', () => {
  it('refuse un total qui n’est pas le sous-total moins la remise', async () => {
    await client.query('reset role')
    const refused = await attempt(
      client,
      'insert into public.sale_document (tenant_id, doc_type, warehouse_id, device_id,' +
        ` created_by, subtotal, discount_total, total) values ('${fixture.tenant}'::uuid,` +
        " 'delivery_note'," +
        ` (select id from public.warehouse where tenant_id = '${fixture.tenant}'::uuid and is_default),` +
        ` '${fixture.device}'::uuid, '${fixture.appUsers.owner}'::uuid, 100.00, 0, 90.00)`,
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain(DOCUMENT_TOTAL)
    }
  })

  /*
   * Un brouillon s'écrit **avant** ses lignes (E4-03) : si la somme était tenue
   * en permanence, le brouillon lui-même serait refusé. La propriété se mesure
   * donc là où elle doit être vraie — et nulle part avant.
   */
  it('laisse un brouillon incohérent avec ses lignes', async () => {
    const document = await draft('500')
    await asApplication('owner')

    const written = await attempt(client, lineSql(document, fixture.variant, '3', '10.00'))
    expect(written.ok).toBe(true)
  })

  it('refuse la confirmation d’un sous-total qui ne dit pas la vérité', async () => {
    const document = await draft('500')
    await asApplication('owner')
    await client.query(lineSql(document, fixture.variant, '3', '10.00'))

    await asApplication('owner')
    const refused = await attempt(
      client,
      "update public.sale_document set status = 'confirmed'," +
        ` doc_number = 'BL-A-${new Date().getFullYear() % 100}-00001', issued_at = now()` +
        ` where id = '${document}'`,
    )

    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe(CHECK_VIOLATION)
      expect(refused.message).toContain(TOTALS_LIE)
    }
    await client.query('reset role')
    const still = await one<{ status: string }>(
      'select status from public.sale_document where id = $1',
      [document],
    )
    expect(still.status).toBe('draft')
  })

  it('laisse passer la confirmation d’un sous-total juste', async () => {
    const document = await draft('30')
    await asApplication('owner')
    await client.query(lineSql(document, fixture.variant, '3', '10.00'))

    await asApplication('owner')
    const confirmed = await attempt(
      client,
      "update public.sale_document set status = 'confirmed'," +
        ` doc_number = 'BL-A-${new Date().getFullYear() % 100}-00002', issued_at = now()` +
        ` where id = '${document}'`,
    )

    expect(confirmed.ok).toBe(true)
  })

  /* La somme porte sur les totaux de ligne arrondis — c'est eux qui s'impriment. */
  it('somme les totaux de ligne arrondis, et non le produit exact', async () => {
    // 3 × 2,5 × 3,33 : chaque ligne vaut 8,33 arrondie, 8,325 exacte. La somme
    // des arrondies est 24,99 ; celle des exactes, 24,975 — qui ne s'écrit pas
    // sur un papier.
    const document = await draft('24.99')
    for (let nth = 0; nth < 3; nth += 1) {
      await asApplication('owner')
      await client.query(lineSql(document, fixture.variant, '2.5', '3.33'))
    }

    await asApplication('owner')
    const confirmed = await attempt(
      client,
      "update public.sale_document set status = 'confirmed'," +
        ` doc_number = 'BL-A-${new Date().getFullYear() % 100}-00003', issued_at = now()` +
        ` where id = '${document}'`,
    )

    expect(confirmed.ok).toBe(true)
  })
})

/* ========================================================================== */
/* 5. La trace — RÈGLE M8-1                                                    */
/* ========================================================================== */

describe('la trace du forçage', () => {
  it('écrit une entrée price_override, signée de celui qui force', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.variant, '2', '10.00', 'manual', '12.00'))

    const entries = await overrideEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry?.action).toBe('price_override')
    expect(entry?.entity_type).toBe('sale_line')
    /*
     * L'auteur est **l'employé qui a forcé**, et c'est toute la raison pour
     * laquelle la trace n'est pas posée à la confirmation du document : elle
     * désignerait alors celui qui confirme (SPEC § 8).
     */
    expect(entry?.user_id).toBe(fixture.appUsers.worker)
    // L'« avant » du forçage est le prix remplacé, que la ligne porte.
    expect(entry?.after_overridden).toBe('12.00')
    expect(entry?.after_unit_price).toBe('10.00')
    expect(entry?.after_quantity).toBe('2.000')
  })

  it('n’écrit rien pour une ligne au palier', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.variant, '1', '12.00'))

    expect(await overrideEntries()).toHaveLength(0)
  })

  /*
   * L'autre sorte de `manual` : le vendeur a saisi un prix parce qu'aucun
   * n'existait (E4-03). Ce n'est pas un forçage, et le journal des forçages ne
   * doit pas le compter — sans `overridden_price`, il le compterait.
   */
  it('n’écrit rien pour une ligne dont aucun prix n’existait', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.variant, '1', '13.00', 'manual'))

    expect(await overrideEntries()).toHaveLength(0)
  })

  /* Les lignes d'un brouillon se modifient : un forçage posé après coup est tracé. */
  it('écrit l’entrée d’un forçage posé par modification', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.variant, '1', '12.00'))
    expect(await overrideEntries()).toHaveLength(0)

    await asApplication('worker')
    await client.query(
      'update public.sale_line set unit_price = 10.00,' +
        " price_source = 'manual', overridden_price = 12.00" +
        ` where sale_document_id = '${document}'`,
    )

    const entries = await overrideEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.before_overridden).toBeNull()
    expect(entries[0]?.after_overridden).toBe('12.00')
  })

  it('désigne la ligne forcée, et elle seule', async () => {
    const document = await draft()
    await asApplication('worker')
    await client.query(lineSql(document, fixture.variant, '1', '12.00'))
    await asApplication('worker')
    await client.query(lineSql(document, fixture.floored, '1', '13.00', 'manual', '14.00'))

    const lines = await linesOf(document)
    const forced = lines.find((line) => line.overridden_price !== null)
    const entries = await overrideEntries()

    expect(entries).toHaveLength(1)
    expect(forced?.unit_price).toBe('13.00')
    const [line] = await client
      .query<{ id: string }>(
        "select id from public.sale_line where sale_document_id = $1 and overridden_price is not null",
        [document],
      )
      .then((result) => result.rows)
    expect(entries[0]?.entity_id).toBe(line?.id)
  })
})
