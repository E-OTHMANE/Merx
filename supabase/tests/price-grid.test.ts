// @vitest-environment node

/*
 * E2-03 — la grille de prix par palier, et le prix d'achat.
 * SPEC § 3 (RÈGLE de placement des coûts), § 3.1, § 6 M1 (RÈGLE M1-2).
 *
 * Deux sujets, et chacun ses gardes :
 *
 *   — la ligne `min_qty = 1` : créée d'office avec chaque variante, puis
 *     défendue par deux triggers (G1 contre la suppression, G2 contre ce qui
 *     la déplacerait). Les deux répondent `23514` ; le message, seul, dit
 *     lequel a refusé (CLAUDE.md, E1-02) ;
 *   — `variant_cost` : le prix d'achat vit sur une relation que l'employé ne
 *     lit pas, et la clé `cost_price` n'apparaît dans aucun corps qui lui est
 *     rendu. Vérifié sur le **texte** de la réponse PostgREST, pas sur un
 *     objet parsé — `{"cost_price": null}` passerait un test sur l'objet.
 *
 * Chaque refus assert son code, relit la valeur quand l'opération ne lève pas
 * (UPDATE et DELETE refusés par la RLS rendent 0 ligne), et a son contrôle
 * positif à côté : la même opération, faite par qui en a le droit, passe.
 *
 * Ce qui n'est pas ici, parce que les balayages le tiennent pour toute table :
 * l'isolation entre commerces (`isolation.test.ts`), le droit d'écrire par
 * rôle sur `price_break` et `variant` (`settings.test.ts`), la forme composite
 * des clés et l'absence de coût hors d'une relation restreinte
 * (`conventions.test.ts`). La résolution du prix est un test unitaire, sur
 * l'appareil : `src/modules/catalogue/pricing.test.ts`.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor } from './isolation'
import { rawBody } from './permissions'
import { createAuthUser, deleteAuthUser, rest, sessionFor, withoutTriggers } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const UNDEFINED_COLUMN = '42703'

/* Ce que chaque garde de la ligne à l'unité, et lui seul, répond. */
const G1_MESSAGE = 'ne se supprime pas tant que la variante existe'
const G2_MESSAGE = 'reste à la quantité 1, sur sa variante'

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

let client: Client

/*
 * Un commerce, un patron et un employé réels. Deux produits : `priced` porte un
 * prix d'achat dès la préparation, `bare` n'en a pas. La variante par défaut de
 * chacun porte l'identifiant du produit, et sa ligne à l'unité aussi.
 */
const fixture = { tenant: '', priced: '', bare: '' }
const COST = '42.50'

const authUsers = {} as Record<'owner' | 'worker', string>
const tokens = {} as Record<'owner' | 'worker', string>
const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client.query(sql, params)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0] as T
}

beforeAll(async () => {
  client = await connect()

  authUsers.owner = await createAuthUser(emails.owner, PASSWORD)
  authUsers.worker = await createAuthUser(emails.worker, PASSWORD)

  fixture.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Grille', gen_random_uuid()) returning id",
    )
  ).id
  for (const role of ['owner', 'worker'] as const) {
    await client.query(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
       values ($1, $2, $3, $4)`,
      [fixture.tenant, authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role],
    )
  }

  for (const key of ['priced', 'bare'] as const) {
    fixture[key] = (
      await one<{ id: string }>(
        `insert into public.product (tenant_id, name_fr, code) values ($1, $2, $3) returning id`,
        [fixture.tenant, `Produit ${key}`, `PG-${key}`],
      )
    ).id
  }
  // Hors session, le journal du prix d'achat refuserait la ligne (RÈGLE M8-1,
  // addendum E2-03) : le harnais la pose triggers suspendus.
  await withoutTriggers(client, () =>
    client.query(
      'insert into public.variant_cost (tenant_id, variant_id, cost_price) values ($1, $2, $3)',
      [fixture.tenant, fixture.priced, COST],
    ),
  )

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined && fixture.tenant !== '') {
    await client.query('reset role')
    /*
     * Les écritures du patron ont laissé leurs entrées au journal, en ajout
     * seul, qui tiennent le commerce et le patron par clé étrangère ; et une
     * ligne de coût ne se supprime pas hors session. Le harnais range les deux
     * triggers suspendus — le seul endroit où ce contournement a sa place.
     */
    await withoutTriggers(client, async () => {
      await client.query('delete from public.audit_log where tenant_id = $1', [fixture.tenant])
      await client.query('delete from public.variant_cost where tenant_id = $1', [fixture.tenant])
    })
    // La cascade emporte variantes et paliers — ligne à l'unité comprise, le
    // garde voyant la variante disparue.
    await client.query('delete from public.product where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.app_user where tenant_id = $1', [fixture.tenant])
    await client.query('delete from public.tenant where id = $1', [fixture.tenant])
  }
  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/** Exécute `body` sous le jeton d'un rôle, dans une transaction annulée. */
async function as(role: 'owner' | 'worker', body: () => Promise<void>): Promise<void> {
  await client.query('begin')
  try {
    await actAs(client, tokenFor(fixture.tenant, role))
    await body()
  } finally {
    await client.query('rollback')
  }
}

interface BreakRow {
  variant_id: string
  min_qty: string
  unit_price: string | null
  deleted_at: string | null
}

/** Une ligne de palier, relue telle quelle — `undefined` si elle a disparu. */
async function breakRow(id: string): Promise<BreakRow | undefined> {
  const { rows } = await client.query<BreakRow>(
    `select variant_id, min_qty::text, unit_price::text, deleted_at::text
     from public.price_break where id = $1`,
    [id],
  )
  return rows[0]
}

/**
 * La ligne à l'unité, relue — et exigée. Sans elle, un DELETE ou un UPDATE
 * refusé ne touche rien parce qu'il n'y a rien à toucher, et le test crierait à
 * la fuite ou créditerait un garde qui n'a rien refusé. Constaté par sabotage :
 * le trigger de la RÈGLE M1-2 retiré, G1 et G2 annonçaient « FUITE ».
 */
async function requireBase(id: string): Promise<BreakRow> {
  const row = await breakRow(id)
  expect(row, 'précondition — aucune ligne à l’unité : le trigger de la RÈGLE M1-2 n’a pas tourné').toBeDefined()
  return row!
}

/** Ajoute une variante au produit, sous la session courante. */
async function newVariant(product: string): Promise<string> {
  return (
    await one<{ id: string }>(
      'insert into public.variant (tenant_id, product_id) values ($1, $2) returning id',
      [fixture.tenant, product],
    )
  ).id
}

/* ========================================================================== */
/* RÈGLE M1-2 — la ligne à l'unité naît avec la variante                       */
/* ========================================================================== */

describe('RÈGLE M1-2 — une ligne min_qty = 1, créée par défaut', () => {
  it('par le chemin réel : un produit créé a exactement une ligne, à 1, sans prix, sous l’identifiant de sa variante', async () => {
    const created = await rest('product', {
      token: tokens.owner,
      method: 'POST',
      body: { name_fr: 'Savon au laurier' },
    })
    expect(created.status, created.body).toBe(201)
    const product = created.rows[0]!.id!

    const breaks = await rest(
      `price_break?variant_id=eq.${product}&select=id,min_qty::text,unit_price::text,deleted_at`,
      { token: tokens.owner },
    )
    expect(breaks.status, breaks.body).toBe(200)
    // Prix absent, pas 0 : un oubli ne fait pas vendre gratuitement (E2-03).
    expect(breaks.rows).toEqual([
      { id: product, min_qty: '1.000', unit_price: null, deleted_at: null },
    ])
  })

  it('toute variante en reçoit une, pas seulement la variante par défaut', async () => {
    await as('owner', async () => {
      const variant = await newVariant(fixture.priced)
      expect(await breakRow(variant)).toEqual({
        variant_id: variant,
        min_qty: '1.000',
        unit_price: null,
        deleted_at: null,
      })
    })
  })
})

/* ========================================================================== */
/* G1 — la ligne à l'unité ne se supprime pas                                  */
/* ========================================================================== */

describe('G1 — la ligne à l’unité ne se supprime pas', () => {
  it('refuse de la supprimer — sous son propre message ; un palier ordinaire, lui, se supprime', async () => {
    await as('owner', async () => {
      await requireBase(fixture.priced)
      const refused = await attempt(
        client,
        `delete from public.price_break where id = '${fixture.priced}'::uuid`,
      )
      expect(refused.ok, 'FUITE — la ligne à l’unité a été supprimée').toBe(false)
      if (!refused.ok) {
        expect(refused.code).toBe(CHECK_VIOLATION)
        expect(refused.message, 'refusée, mais pas par G1').toContain(G1_MESSAGE)
      }
      expect(await breakRow(fixture.priced), 'la ligne a disparu').toBeDefined()

      const tier = await one<{ id: string }>(
        `insert into public.price_break (tenant_id, variant_id, min_qty, unit_price)
         values ($1, $2, 10, '11.00') returning id`,
        [fixture.tenant, fixture.priced],
      )
      const removed = await attempt(client, `delete from public.price_break where id = '${tier.id}'::uuid`)
      expect(removed).toEqual({ ok: true, rowCount: 1 })
    })
  })

  it('laisse partir la ligne avec sa variante', async () => {
    await as('owner', async () => {
      const variant = await newVariant(fixture.priced)
      expect(await breakRow(variant)).toBeDefined()

      const removed = await attempt(client, `delete from public.variant where id = '${variant}'::uuid`)
      expect(removed.ok, removed.ok ? '' : `${removed.code} ${removed.message}`).toBe(true)
      expect(await breakRow(variant), 'la ligne a survécu à sa variante').toBeUndefined()
    })
  })

  it('laisse partir la ligne avec son produit', async () => {
    await as('owner', async () => {
      const product = (
        await one<{ id: string }>(
          "insert into public.product (tenant_id, name_fr) values ($1, 'Éphémère') returning id",
          [fixture.tenant],
        )
      ).id
      const removed = await attempt(client, `delete from public.product where id = '${product}'::uuid`)
      expect(removed.ok, removed.ok ? '' : `${removed.code} ${removed.message}`).toBe(true)
      expect(await breakRow(product)).toBeUndefined()
    })
  })
})

/* ========================================================================== */
/* G2 — la ligne à l'unité reste à 1, vivante, sur sa variante                 */
/* ========================================================================== */

describe('G2 — la ligne à l’unité reste à 1, sur sa variante', () => {
  const moves: ReadonlyArray<[string, (other: string) => string]> = [
    ['min_qty déplacé', () => 'min_qty = 2'],
    ['suppression douce', () => 'deleted_at = now()'],
    // Sous sabotage de G2, c'est l'unicité des paliers qui refuserait — en
    // `23505`, que l'assertion sur le code distingue.
    ['changement de variante', (other) => `variant_id = '${other}'::uuid`],
  ]

  it.each(moves)('%s : refusé — sous son propre message, ligne inchangée', async (_label, set) => {
    await as('owner', async () => {
      const other = await newVariant(fixture.priced)
      const before = await requireBase(fixture.priced)

      const refused = await attempt(
        client,
        `update public.price_break set ${set(other)} where id = '${fixture.priced}'::uuid`,
      )
      expect(refused.ok, 'FUITE — la ligne à l’unité a quitté sa place').toBe(false)
      if (!refused.ok) {
        expect(refused.code).toBe(CHECK_VIOLATION)
        expect(refused.message, 'refusée, mais pas par G2').toContain(G2_MESSAGE)
      }
      expect(await breakRow(fixture.priced)).toEqual(before)
    })
  })

  it('son prix, lui, se modifie', async () => {
    await as('owner', async () => {
      await requireBase(fixture.priced)
      const updated = await attempt(
        client,
        `update public.price_break set unit_price = '12.00' where id = '${fixture.priced}'::uuid`,
      )
      expect(updated).toEqual({ ok: true, rowCount: 1 })
      expect((await breakRow(fixture.priced))?.unit_price).toBe('12.00')
    })
  })
})

describe('une seule ligne par quantité et par variante', () => {
  it('refuse une seconde ligne à 1 — par l’unicité des paliers ; un autre palier passe', async () => {
    await as('owner', async () => {
      const insert = (quantity: number): string =>
        `insert into public.price_break (tenant_id, variant_id, min_qty, unit_price)
         values ('${fixture.tenant}', '${fixture.priced}', ${quantity}, '9.00')`

      // La première ligne à 1 doit exister : sinon l'insertion passe sans
      // doublon, et le test accuserait l'unicité à tort.
      await requireBase(fixture.priced)
      const duplicate = await attempt(client, insert(1))
      expect(duplicate.ok, 'deux lignes à l’unité pour une variante').toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.code).toBe(UNIQUE_VIOLATION)
        expect(duplicate.message).toContain('price_break_min_qty_per_variant')
      }

      const other = await attempt(client, insert(5))
      expect(other.ok, other.ok ? '' : other.message).toBe(true)
    })
  })
})

/* ========================================================================== */
/* SPEC § 3.1 — la grille et le plancher, le patron seul                       */
/* ========================================================================== */

describe('la grille se lit par tous, s’écrit par le patron — par le chemin réel', () => {
  it('l’employé ne change pas un prix ; le patron, si', async () => {
    const path = `price_break?id=eq.${fixture.bare}`
    await requireBase(fixture.bare)

    const refused = await rest(path, {
      token: tokens.worker,
      method: 'PATCH',
      body: { unit_price: '1.00' },
    })
    expect(refused.status, refused.body).toBe(200)
    expect(refused.rows).toHaveLength(0)
    expect((await breakRow(fixture.bare))?.unit_price, 'FUITE — le prix a changé').toBeNull()

    const accepted = await rest(path, {
      token: tokens.owner,
      method: 'PATCH',
      body: { unit_price: '15.00' },
    })
    expect(accepted.rows).toHaveLength(1)
    expect((await breakRow(fixture.bare))?.unit_price).toBe('15.00')
  })

  it('l’employé n’ajoute pas de palier — 42501, aucune ligne ; le patron, si', async () => {
    const tier = { variant_id: fixture.bare, min_qty: 20, unit_price: '13.00' }
    const count = async (): Promise<number> => {
      const { rows } = await client.query(
        'select 1 from public.price_break where variant_id = $1 and min_qty = 20',
        [fixture.bare],
      )
      return rows.length
    }

    const refused = await rest('price_break', { token: tokens.worker, method: 'POST', body: tier })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(await count(), 'FUITE — un palier a été ajouté').toBe(0)

    // La même charge passe pour le patron : le refus ne venait que du droit.
    const accepted = await rest('price_break', { token: tokens.owner, method: 'POST', body: tier })
    expect(accepted.status, accepted.body).toBe(201)
    expect(await count()).toBe(1)
  })

  it('l’employé lit la grille — il vend ce qu’il lit', async () => {
    const read = await rest(`price_break?variant_id=eq.${fixture.bare}&select=id`, {
      token: tokens.worker,
    })
    expect(read.status).toBe(200)
    expect(read.rows.length).toBeGreaterThan(0)
  })
})

describe('floor_price — saisi par le patron, lu par tous', () => {
  const floorOf = async (): Promise<string | null> =>
    (
      await one<{ floor: string | null }>(
        'select floor_price::text as floor from public.variant where id = $1',
        [fixture.bare],
      )
    ).floor

  it('l’employé ne le change pas ; le patron, si ; l’employé le lit', async () => {
    const path = `variant?id=eq.${fixture.bare}`

    const refused = await rest(path, {
      token: tokens.worker,
      method: 'PATCH',
      body: { floor_price: '1.00' },
    })
    expect(refused.rows).toHaveLength(0)
    expect(await floorOf(), 'FUITE — le plancher a changé').toBeNull()

    const accepted = await rest(path, {
      token: tokens.owner,
      method: 'PATCH',
      body: { floor_price: '9.50' },
    })
    expect(accepted.rows).toHaveLength(1)
    expect(await floorOf()).toBe('9.50')

    // Ce n'est pas un coût : c'est un prix de vente minimum, lisible par tous.
    const read = await rawBody(`${path}&select=floor_price::text`, tokens.worker)
    expect(read.body).toContain('"floor_price":"9.50"')
  })
})

/* ========================================================================== */
/* SPEC § 3 — le prix d'achat, absent de toute réponse faite à l'employé       */
/* ========================================================================== */

describe('variant_cost — la clé cost_price n’apparaît jamais chez l’employé', () => {
  /*
   * Les trois façons de demander le coût : la relation, la colonne nommément,
   * et l'imbrication depuis la variante — celle qu'un écran de vente écrirait
   * sans y penser. Le patron, sur le même chemin, reçoit la clé et la valeur :
   * c'est ce qui prouve que l'absence chez l'employé vient du droit, et non
   * d'une relation vide ou d'un chemin mal écrit.
   */
  const paths = [
    ['la relation', 'variant_cost?select=*'],
    ['la colonne, nommément', 'variant_cost?select=cost_price'],
    ['l’imbrication depuis la variante', 'variant?select=*,variant_cost(*)'],
  ] as const

  it.each(paths)('%s : absente du corps de l’employé, présente dans celui du patron', async (_label, path) => {
    const worker = await rawBody(path, tokens.worker)
    expect(worker.status, worker.body).toBe(200)
    expect(worker.body).not.toContain('cost_price')

    const owner = await rawBody(path, tokens.owner)
    expect(owner.status, owner.body).toBe(200)
    expect(owner.body).toContain('cost_price')
    expect(owner.body).toContain('42.50')
  })

  it('variant ne porte pas la colonne : la demander est une erreur, même pour le patron', async () => {
    const onVariant = await rest('variant?select=cost_price', { token: tokens.owner })
    expect(onVariant.status).toBe(400)
    expect(onVariant.code).toBe(UNDEFINED_COLUMN)

    const onCost = await rest('variant_cost?select=cost_price', { token: tokens.owner })
    expect(onCost.status).toBe(200)
  })
})

describe('variant_cost — saisi par le patron seul', () => {
  const costOf = async (variant: string): Promise<string | undefined> => {
    const { rows } = await client.query<{ cost: string }>(
      'select cost_price::text as cost from public.variant_cost where variant_id = $1',
      [variant],
    )
    return rows[0]?.cost
  }

  it('l’employé n’en crée pas — 42501, aucune ligne ; le patron, si', async () => {
    const cost = { variant_id: fixture.bare, cost_price: '10.00' }

    const refused = await rest('variant_cost', { token: tokens.worker, method: 'POST', body: cost })
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(refused.body).toContain('variant_cost')
    expect(await costOf(fixture.bare), 'FUITE — un coût a été posé').toBeUndefined()

    const accepted = await rest('variant_cost', { token: tokens.owner, method: 'POST', body: cost })
    expect(accepted.status, accepted.body).toBe(201)
    expect(await costOf(fixture.bare)).toBe('10.00')

    await withoutTriggers(client, () =>
      client.query('delete from public.variant_cost where variant_id = $1', [fixture.bare]),
    )
  })

  it('l’employé ne le modifie pas ; le patron, si', async () => {
    const path = `variant_cost?variant_id=eq.${fixture.priced}`

    const refused = await rest(path, {
      token: tokens.worker,
      method: 'PATCH',
      body: { cost_price: '1.00' },
    })
    expect(refused.rows).toHaveLength(0)
    expect(await costOf(fixture.priced), 'FUITE — le coût a changé').toBe(COST)

    const accepted = await rest(path, {
      token: tokens.owner,
      method: 'PATCH',
      body: { cost_price: '43.00' },
    })
    expect(accepted.rows).toHaveLength(1)
    expect(await costOf(fixture.priced)).toBe('43.00')

    await withoutTriggers(client, () =>
      client.query('update public.variant_cost set cost_price = $2 where variant_id = $1', [
        fixture.priced,
        COST,
      ]),
    )
  })

  it('l’employé ne le supprime pas ; le patron, si', async () => {
    const refused = await rest(`variant_cost?variant_id=eq.${fixture.priced}`, {
      token: tokens.worker,
      method: 'DELETE',
    })
    expect(refused.rows).toHaveLength(0)
    expect(await costOf(fixture.priced), 'FUITE — le coût a été supprimé').toBe(COST)

    // Le patron, par le chemin de l'application : son jeton porte l'auteur que
    // le journal du prix d'achat exige (RÈGLE M8-1, addendum E2-03).
    const accepted = await rest(`variant_cost?variant_id=eq.${fixture.priced}`, {
      token: tokens.owner,
      method: 'DELETE',
    })
    expect(accepted.rows).toHaveLength(1)
    expect(await costOf(fixture.priced)).toBeUndefined()

    // La suppression est validée pour de bon : le coût est remis pour la suite.
    await withoutTriggers(client, () =>
      client.query(
        'insert into public.variant_cost (tenant_id, variant_id, cost_price) values ($1, $2, $3)',
        [fixture.tenant, fixture.priced, COST],
      ),
    )
  })

  it('une ligne par variante, au plus — par son unicité ; une autre variante en reçoit une', async () => {
    await as('owner', async () => {
      const duplicate = await attempt(
        client,
        `insert into public.variant_cost (tenant_id, variant_id, cost_price)
         values ('${fixture.tenant}', '${fixture.priced}', '1.00')`,
      )
      expect(duplicate.ok, 'deux coûts pour une variante').toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.code).toBe(UNIQUE_VIOLATION)
        expect(duplicate.message).toContain('variant_cost_one_per_variant')
      }
    })

    // Contrôle positif : une autre variante reçoit la sienne — par le chemin
    // de l'application, dont le jeton porte l'auteur que le journal exige.
    const other = await newVariant(fixture.priced)
    const accepted = await rest('variant_cost', {
      token: tokens.owner,
      method: 'POST',
      body: { variant_id: other, cost_price: '1.00' },
    })
    expect(accepted.status, accepted.body).toBe(201)
  })
})
