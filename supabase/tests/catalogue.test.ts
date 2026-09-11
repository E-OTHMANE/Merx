// @vitest-environment node

/*
 * E2-01 — le modèle produit / variante. SPEC § 2.3, § 4 (RÈGLE des clés
 * étrangères composites), § 6 M1 (RÈGLE M1-1), § 3.1.
 *
 * La story qui fixe le modèle pour tout le reste du projet. Chaque garde posé
 * par la migration a ici son test, et chaque test son contrôle positif à côté :
 * un refus n'est probant que si la même opération, faite comme il faut, passe.
 * Les refus assertent leur code, et là où deux gardes partagent un code — les
 * deux gardes « au moins une variante » (23514), les policies de `product` et
 * de `variant` (42501) — le message, qui seul dit lequel a refusé (CLAUDE.md,
 * E1-02).
 *
 * Ce qui n'est pas ici, parce que les balayages le tiennent déjà pour toute
 * table, présente et à venir :
 *   — l'isolation entre commerces des quatre tables (`isolation.test.ts`) ;
 *   — le droit d'écrire, par table et par rôle (`settings.test.ts`, balayage
 *     du registre des écritures restreintes) ;
 *   — « aucune table ne référence product_id », « aucun coût sur variant », et
 *     la forme composite des clés (`conventions.test.ts`).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor } from './isolation'
import { rawBody } from './permissions'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'

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

/* Deux commerces. A a un patron et un employé réels ; B, un patron en base. */
const fixture = {
  a: { tenant: '', owner: '', category: '', product: '' },
  b: { tenant: '', owner: '', category: '', product: '' },
}
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

async function seedTenant(side: 'a' | 'b'): Promise<void> {
  const target = fixture[side]
  target.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ($1, gen_random_uuid()) returning id",
      [`Catalogue ${side.toUpperCase()}`],
    )
  ).id
  target.owner = (
    await one<{ id: string }>(
      `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
       values ($1, $2, 'Patron', 'owner') returning id`,
      [target.tenant, side === 'a' ? authUsers.owner : null],
    )
  ).id
  target.category = (
    await one<{ id: string }>(
      "insert into public.category (tenant_id, name_fr) values ($1, 'Parfums') returning id",
      [target.tenant],
    )
  ).id
  target.product = (
    await one<{ id: string }>(
      `insert into public.product (tenant_id, name_fr, code) values ($1, 'Eau de toilette', $2)
       returning id`,
      [target.tenant, `${side.toUpperCase()}-REF`],
    )
  ).id
}

beforeAll(async () => {
  client = await connect()

  authUsers.owner = await createAuthUser(emails.owner, PASSWORD)
  authUsers.worker = await createAuthUser(emails.worker, PASSWORD)

  await seedTenant('a')
  await seedTenant('b')

  await client.query(
    `insert into public.app_user (tenant_id, auth_user_id, full_name, role)
     values ($1, $2, 'Employé', 'worker')`,
    [fixture.a.tenant, authUsers.worker],
  )

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    for (const side of ['a', 'b'] as const) {
      const tenant = fixture[side].tenant
      if (tenant === '') continue
      // La cascade emporte variantes et paliers.
      await client.query('delete from public.product where tenant_id = $1', [tenant])
      await client.query('delete from public.category where tenant_id = $1', [tenant])
      await client.query('delete from public.app_user where tenant_id = $1', [tenant])
      await client.query('delete from public.tenant where id = $1', [tenant])
    }
  }
  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/**
 * Exécute `body` sous le jeton d'un rôle, dans une transaction annulée : aucun
 * test ne laisse de trace pour le suivant.
 */
async function as(
  side: 'a' | 'b',
  role: 'owner' | 'worker',
  body: () => Promise<void>,
): Promise<void> {
  await client.query('begin')
  try {
    await actAs(client, tokenFor(fixture[side].tenant, role))
    await body()
  } finally {
    await client.query('rollback')
  }
}

/** Crée un produit sous la session courante et rend son identifiant. */
async function newProduct(side: 'a' | 'b', code: string | null = null): Promise<string> {
  return (
    await one<{ id: string }>(
      `insert into public.product (tenant_id, name_fr, code) values ($1, 'Produit', $2)
       returning id`,
      [fixture[side].tenant, code],
    )
  ).id
}

async function variantsOf(product: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    'select count(*) as n from public.variant where product_id = $1',
    [product],
  )
  return Number(rows[0]!.n)
}

/* ========================================================================== */
/* RÈGLE M1-1                                                                  */
/* ========================================================================== */

describe('RÈGLE M1-1 — un produit naît avec sa variante par défaut', () => {
  it('par le chemin réel : exactement une variante, par défaut, sous l’identifiant du produit', async () => {
    const created = await rest('product', {
      token: tokens.owner,
      method: 'POST',
      body: { tenant_id: fixture.a.tenant, name_fr: 'Crème de nuit', code: '  LOR-12 ' },
    })
    expect(created.status, created.body).toBe(201)
    const product = created.rows[0]!.id!

    const variants = await rest(
      `variant?product_id=eq.${product}&select=id,is_default,sku,attributes`,
      { token: tokens.owner },
    )

    // `toEqual` sur la liste entière : « exactement une », pas « au moins une ».
    expect(variants.rows).toEqual([
      { id: product, is_default: true, sku: 'LOR-12', attributes: {} },
    ])
  })

  it('sans code, la variante existe quand même — sans SKU', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')

      expect(await variantsOf(product)).toBe(1)
      const variant = await one<{ sku: string | null; is_default: boolean }>(
        'select sku, is_default from public.variant where product_id = $1',
        [product],
      )
      expect(variant).toEqual({ sku: null, is_default: true })
    })
  })
})

/* ========================================================================== */
/* Unicités                                                                    */
/* ========================================================================== */

/*
 * Trois index uniques, un seul code `23505`. Et deux d'entre eux se doublent :
 * un produit sous une référence déjà prise engendre, par la RÈGLE M1-1, une
 * variante sous un SKU déjà pris. Index de `product` retiré, celui de `variant`
 * refusait à sa place, et le test du premier restait vert — constaté par
 * sabotage. Chaque test assert donc le nom de *sa* contrainte.
 */
describe('product.code — unique par commerce', () => {
  it('refuse la même référence, à la casse et aux espaces près', async () => {
    await as('a', 'owner', async () => {
      await newProduct('a', 'DUP-1')

      const duplicate = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr, code)
         values ('${fixture.a.tenant}', 'Doublon', ' dup-1 ')`,
      )
      expect(duplicate.ok, 'deux produits sous la même référence').toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.code).toBe(UNIQUE_VIOLATION)
        expect(duplicate.message, 'refusé, mais pas par l’unicité de la référence').toContain(
          'product_code_per_tenant',
        )
      }

      const { rows } = await client.query(
        "select 1 from public.product where lower(code) = 'dup-1'",
      )
      expect(rows).toHaveLength(1)
    })
  })

  it('laisse la même référence à un autre commerce', async () => {
    await as('a', 'owner', async () => {
      await newProduct('a', 'DUP-1')
      await actAs(client, tokenFor(fixture.b.tenant, 'owner'))

      const other = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr, code)
         values ('${fixture.b.tenant}', 'Même référence ailleurs', 'DUP-1')`,
      )
      expect(other.ok, other.ok ? '' : other.message).toBe(true)
    })
  })

  it('libère la référence d’un produit supprimé', async () => {
    await as('a', 'owner', async () => {
      const removed = await newProduct('a', 'DEL-1')
      await client.query('update public.product set deleted_at = now() where id = $1', [removed])

      const recreated = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr, code)
         values ('${fixture.a.tenant}', 'Recréé', 'DEL-1')`,
      )
      expect(recreated.ok, recreated.ok ? '' : recreated.message).toBe(true)
    })
  })
})

describe('variant.sku — unique par commerce', () => {
  it('refuse un SKU déjà pris dans le commerce, accepte le même ailleurs', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a', 'SKU-1')

      const duplicate = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id, sku)
         values ('${fixture.a.tenant}', '${product}', 'sku-1')`,
      )
      expect(duplicate.ok, 'deux variantes sous le même SKU').toBe(false)
      if (!duplicate.ok) {
        expect(duplicate.code).toBe(UNIQUE_VIOLATION)
        expect(duplicate.message).toContain('variant_sku_per_tenant')
      }

      const distinct = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id, sku)
         values ('${fixture.a.tenant}', '${product}', 'SKU-1-B')`,
      )
      expect(distinct.ok, distinct.ok ? '' : distinct.message).toBe(true)

      await actAs(client, tokenFor(fixture.b.tenant, 'owner'))
      const elsewhere = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr, code)
         values ('${fixture.b.tenant}', 'Ailleurs', 'SKU-1')`,
      )
      expect(elsewhere.ok, elsewhere.ok ? '' : elsewhere.message).toBe(true)
    })
  })
})

describe('une seule variante par défaut par produit', () => {
  it('refuse une seconde variante par défaut, accepte une variante ordinaire', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')

      const second = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id, is_default)
         values ('${fixture.a.tenant}', '${product}', true)`,
      )
      expect(second.ok, 'deux variantes par défaut').toBe(false)
      if (!second.ok) {
        expect(second.code).toBe(UNIQUE_VIOLATION)
        expect(second.message).toContain('variant_one_default_per_product')
      }

      const ordinary = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id)
         values ('${fixture.a.tenant}', '${product}')`,
      )
      expect(ordinary.ok, ordinary.ok ? '' : ordinary.message).toBe(true)
      expect(await variantsOf(product)).toBe(2)
    })
  })
})

/* ========================================================================== */
/* SPEC § 2.3 — « toujours »                                                   */
/* ========================================================================== */

describe('un produit garde toujours au moins une variante', () => {
  /*
   * Deux gardes, un même code `23514`. Chaque test assert le message de *son*
   * garde et refuse celui de l'autre : retirer l'un ne peut pas être masqué par
   * l'autre.
   */
  const LAST_VARIANT = 'au moins une variante'
  const PINNED = 'ne change pas de produit'

  it('refuse de supprimer la dernière variante', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')

      const removed = await attempt(client, `delete from public.variant where id = '${product}'`)
      expect(removed.ok, 'la dernière variante a été supprimée').toBe(false)
      if (!removed.ok) {
        expect(removed.code).toBe(CHECK_VIOLATION)
        expect(removed.message).toContain(LAST_VARIANT)
      }
      expect(await variantsOf(product)).toBe(1)
    })
  })

  it('refuse de les supprimer toutes d’un coup', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')
      await client.query(
        'insert into public.variant (tenant_id, product_id) values ($1, $2)',
        [fixture.a.tenant, product],
      )

      const removed = await attempt(
        client,
        `delete from public.variant where product_id = '${product}'`,
      )
      expect(removed.ok, 'toutes les variantes ont été supprimées').toBe(false)
      if (!removed.ok) {
        expect(removed.code).toBe(CHECK_VIOLATION)
        expect(removed.message).toContain(LAST_VARIANT)
      }
      expect(await variantsOf(product)).toBe(2)
    })
  })

  it('laisse supprimer une variante quand il en reste une', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')
      await client.query(
        'insert into public.variant (tenant_id, product_id) values ($1, $2)',
        [fixture.a.tenant, product],
      )

      const removed = await attempt(client, `delete from public.variant where id = '${product}'`)
      expect(removed.ok, removed.ok ? '' : removed.message).toBe(true)
      if (removed.ok) expect(removed.rowCount).toBe(1)
      expect(await variantsOf(product)).toBe(1)
    })
  })

  it('laisse supprimer le produit, variantes comprises', async () => {
    await as('a', 'owner', async () => {
      const product = await newProduct('a')

      const removed = await attempt(client, `delete from public.product where id = '${product}'`)
      expect(removed.ok, removed.ok ? '' : removed.message).toBe(true)
      if (removed.ok) expect(removed.rowCount).toBe(1)
      expect(await variantsOf(product)).toBe(0)
    })
  })

  it('refuse de déplacer une variante vers un autre produit — sous son propre message', async () => {
    await as('a', 'owner', async () => {
      const from = await newProduct('a')
      const to = await newProduct('a')

      const moved = await attempt(
        client,
        `update public.variant set product_id = '${to}' where id = '${from}'`,
      )
      expect(moved.ok, 'une variante a changé de produit').toBe(false)
      if (!moved.ok) {
        expect(moved.code).toBe(CHECK_VIOLATION)
        expect(moved.message).toContain(PINNED)
        expect(moved.message).not.toContain(LAST_VARIANT)
      }
      expect(await variantsOf(from)).toBe(1)

      const edited = await attempt(
        client,
        `update public.variant set sku = 'NOUVEAU' where id = '${from}'`,
      )
      expect(edited.ok, edited.ok ? '' : edited.message).toBe(true)
      if (edited.ok) expect(edited.rowCount).toBe(1)
    })
  })
})

describe('la suppression douce du produit se propage à ses variantes', () => {
  /*
   * Trois variantes : la variante par défaut, une seconde vivante, et une
   * troisième supprimée pour elle-même la veille. La troisième est le contrôle
   * de chaque test : la propagation ne doit toucher que ce qui suit le produit.
   * Les dates sont comparées en texte, à la microseconde : « exactement cette
   * date » est ce qui permet la restauration.
   */
  async function productWithVariants(): Promise<{ product: string; extra: string; earlier: string }> {
    const product = await newProduct('a', 'SOFT-1')
    const insertVariant = async (sku: string): Promise<string> =>
      (
        await one<{ id: string }>(
          'insert into public.variant (tenant_id, product_id, sku) values ($1, $2, $3) returning id',
          [fixture.a.tenant, product, sku],
        )
      ).id
    const extra = await insertVariant('SOFT-1-B')
    const earlier = await insertVariant('SOFT-1-C')
    await client.query(
      "update public.variant set deleted_at = now() - interval '1 day' where id = $1",
      [earlier],
    )
    return { product, extra, earlier }
  }

  const deletedAt = async (table: 'product' | 'variant', id: string): Promise<string | null> =>
    (
      await one<{ at: string | null }>(
        `select deleted_at::text as at from public."${table}" where id = $1`,
        [id],
      )
    ).at

  it('supprimer le produit supprime ses variantes vivantes, à la même date', async () => {
    await as('a', 'owner', async () => {
      const { product, extra, earlier } = await productWithVariants()
      const earlierAt = await deletedAt('variant', earlier)

      await client.query('update public.product set deleted_at = now() where id = $1', [product])
      const productAt = await deletedAt('product', product)

      expect(productAt).not.toBeNull()
      expect(await deletedAt('variant', product), 'variante par défaut').toBe(productAt)
      expect(await deletedAt('variant', extra), 'seconde variante').toBe(productAt)
      expect(await deletedAt('variant', earlier), 'variante déjà supprimée, redatée').toBe(
        earlierAt,
      )
    })
  })

  it('restaurer le produit rétablit celles qui portent sa date, et celles-là seulement', async () => {
    await as('a', 'owner', async () => {
      const { product, extra, earlier } = await productWithVariants()
      const earlierAt = await deletedAt('variant', earlier)

      /*
       * L'état supprimé est posé à la main, variantes d'abord, et **ne dépend
       * pas** de la propagation à la suppression. Sinon ce test était masqué par
       * le précédent — constaté par sabotage : trigger retiré, les variantes ne
       * sont jamais supprimées, donc « nulles après restauration » est vrai
       * d'office, et le test restait vert sans rien mesurer. `now()` est figé
       * pour la transaction : variantes et produit portent la même date.
       */
      await client.query(
        'update public.variant set deleted_at = now() where id = any($1)',
        [[product, extra]],
      )
      await client.query('update public.product set deleted_at = now() where id = $1', [product])
      expect(await deletedAt('variant', extra), 'préparation : la variante n’est pas supprimée').toBe(
        await deletedAt('product', product),
      )

      await client.query('update public.product set deleted_at = null where id = $1', [product])

      expect(await deletedAt('product', product)).toBeNull()
      expect(await deletedAt('variant', product), 'variante par défaut').toBeNull()
      expect(await deletedAt('variant', extra), 'seconde variante').toBeNull()
      expect(
        await deletedAt('variant', earlier),
        'une variante supprimée pour elle-même est revenue avec le produit',
      ).toBe(earlierAt)
    })
  })
})

/* ========================================================================== */
/* SPEC § 4 — aucune référence ne franchit la frontière                        */
/* ========================================================================== */

describe('les clés étrangères restent dans le commerce', () => {
  /*
   * Une clé étrangère ne passe pas par la RLS : sans `tenant_id` dans la clé,
   * le patron de A rattacherait ses lignes à celles de B. Chaque cas est tenté
   * deux fois, par le même patron, dans le même commerce : vers la ligne de B
   * (refusé, `23503` — la clé, pas la RLS, qui rendrait `42501`), puis vers la
   * sienne (accepté). Le second prouve que le premier refuse pour la bonne
   * raison.
   */
  const cases: ReadonlyArray<{
    label: string
    target: (side: 'a' | 'b') => string
    sql: (tenant: string, target: string) => string
    table: string
    column: string
  }> = [
    {
      label: 'une variante sur le produit',
      target: (side) => fixture[side].product,
      sql: (tenant, target) =>
        `insert into public.variant (tenant_id, product_id) values ('${tenant}', '${target}')`,
      table: 'variant',
      column: 'product_id',
    },
    {
      label: 'un produit dans la catégorie',
      target: (side) => fixture[side].category,
      sql: (tenant, target) =>
        `insert into public.product (tenant_id, name_fr, category_id)
         values ('${tenant}', 'Rattaché', '${target}')`,
      table: 'product',
      column: 'category_id',
    },
    {
      label: 'une sous-catégorie sous la catégorie',
      target: (side) => fixture[side].category,
      sql: (tenant, target) =>
        `insert into public.category (tenant_id, name_fr, parent_id)
         values ('${tenant}', 'Sous-catégorie', '${target}')`,
      table: 'category',
      column: 'parent_id',
    },
    {
      // La variante par défaut porte l'identifiant du produit.
      label: 'un palier sur la variante',
      target: (side) => fixture[side].product,
      sql: (tenant, target) =>
        `insert into public.price_break (tenant_id, variant_id, min_qty, unit_price)
         values ('${tenant}', '${target}', 5, '1.00')`,
      table: 'price_break',
      column: 'variant_id',
    },
    {
      // `created_by`, ramené à la forme composite par cette story.
      label: 'une ligne signée par l’utilisateur',
      target: (side) => fixture[side].owner,
      sql: (tenant, target) =>
        `insert into public.category (tenant_id, name_fr, created_by)
         values ('${tenant}', 'Signée', '${target}')`,
      table: 'category',
      column: 'created_by',
    },
  ]

  it.each(cases)('$label : refusé vers le voisin, accepté chez soi', async (c) => {
    await as('a', 'owner', async () => {
      const foreign = c.target('b')
      const across = await attempt(client, c.sql(fixture.a.tenant, foreign))

      expect(across.ok, `FUITE — ${c.table}.${c.column} vise une ligne du commerce B`).toBe(false)
      if (!across.ok) expect(across.code, across.message).toBe(FOREIGN_KEY_VIOLATION)

      const { rows } = await client.query(
        `select 1 from public."${c.table}" where "${c.column}" = $1`,
        [foreign],
      )
      expect(rows, 'la ligne refusée existe quand même').toHaveLength(0)

      const own = await attempt(client, c.sql(fixture.a.tenant, c.target('a')))
      expect(own.ok, own.ok ? '' : `${own.code} ${own.message}`).toBe(true)
    })
  })
})

/* ========================================================================== */
/* SPEC § 3.1 — le patron écrit, l'employé lit                                 */
/* ========================================================================== */

describe('créer un produit exige manage_product, à chaque niveau', () => {
  /*
   * Deux gardes sur le chemin de l'employé qui crée un produit : la policy de
   * `product`, puis — le trigger de la RÈGLE M1-1 s'exécutant sous son
   * identité — celle de `variant`. Même code, `42501`. Sans l'assertion sur le
   * nom de table, retirer la policy de `product` laisserait ce test vert : celle
   * de `variant` refuserait à sa place, un étage plus bas. C'est le cas des
   * gardes indistinguables de E1-02.
   */
  it('niveau product — l’employé est refusé par la policy de product elle-même', async () => {
    await as('a', 'worker', async () => {
      const written = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr) values ('${fixture.a.tenant}', 'Interdit')`,
      )
      expect(written.ok, 'FUITE — l’employé a créé un produit').toBe(false)
      if (!written.ok) {
        expect(written.code).toBe(INSUFFICIENT_PRIVILEGE)
        expect(written.message, 'refusé, mais pas par la policy de product').toContain(
          'table "product"',
        )
      }
    })

    await as('a', 'owner', async () => {
      const written = await attempt(
        client,
        `insert into public.product (tenant_id, name_fr) values ('${fixture.a.tenant}', 'Permis')`,
      )
      expect(written.ok, written.ok ? '' : written.message).toBe(true)
    })
  })

  it('niveau variant — l’employé est refusé par la policy de variant', async () => {
    await as('a', 'worker', async () => {
      const written = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id)
         values ('${fixture.a.tenant}', '${fixture.a.product}')`,
      )
      expect(written.ok, 'FUITE — l’employé a créé une variante').toBe(false)
      if (!written.ok) {
        expect(written.code).toBe(INSUFFICIENT_PRIVILEGE)
        expect(written.message).toContain('table "variant"')
      }
    })

    await as('a', 'owner', async () => {
      const written = await attempt(
        client,
        `insert into public.variant (tenant_id, product_id)
         values ('${fixture.a.tenant}', '${fixture.a.product}')`,
      )
      expect(written.ok, written.ok ? '' : written.message).toBe(true)
    })
  })

  it('par le chemin réel, l’employé ne crée pas de produit', async () => {
    const name = `Tentative ${crypto.randomUUID()}`
    const refused = await rest('product', {
      token: tokens.worker,
      method: 'POST',
      body: { tenant_id: fixture.a.tenant, name_fr: name },
    })

    expect(refused.ok).toBe(false)
    expect(refused.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect((JSON.parse(refused.body) as { message: string }).message).toContain('table "product"')

    const { rows } = await client.query('select 1 from public.product where name_fr = $1', [name])
    expect(rows).toHaveLength(0)
  })
})

describe('l’employé lit le catalogue, sans aucun coût', () => {
  it('voit les variantes de son commerce, et aucune colonne de coût dans le corps', async () => {
    const { status, body } = await rawBody('variant?select=*', tokens.worker)

    expect(status).toBe(200)
    // Contrôle positif : la réponse porte bien des variantes, et leur plancher,
    // qui est un prix de vente lisible par tous.
    expect(body).toContain(fixture.a.product)
    expect(body).toContain('floor_price')
    // Et jamais le voisin.
    expect(body).not.toContain(fixture.b.product)
    // SPEC § 3, RÈGLE de placement des coûts : la clé est absente, pas masquée.
    expect(body).not.toMatch(/cost|margin/)
  })
})
