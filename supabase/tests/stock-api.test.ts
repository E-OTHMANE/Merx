// @vitest-environment node

/*
 * E3-02 — la consultation du stock vue de PostgREST.
 *
 * `stock-consultation.test.ts` éprouve les gardes et les plans en SQL, dans une
 * transaction annulée. Il ne peut pas éprouver l'API : PostgREST est un autre
 * processus, qui ne verrait rien d'une transaction ouverte ici. Or ce sont les
 * **requêtes de l'écran** qui doivent fonctionner — une jointure incorporée mal
 * formée, un filtre que PostgREST n'accepte pas sur une ressource imbriquée,
 * et l'écran est vide sans qu'aucun test SQL ne bouge.
 *
 * Trois requêtes, les trois que `src/modules/stock/` émet, à l'octet près :
 *
 *   1. les niveaux d'une liste de variantes — ce qui complète la recherche ;
 *   2. la liste filtrée, avec ses deux jointures `!inner` ;
 *   3. `list_stock_movements()`, appelée comme `supabase.rpc()` l'appelle.
 *
 * Et à chaque fois sous le jeton de l'**employé** : c'est lui l'acteur de la
 * story, c'est lui qui a le moins de droits, et c'est à lui que `app_user` est
 * fermé.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'stock-e3-02-password'
const emails = {
  worker: `worker.stock.${Date.now()}@merx.test`,
  neighbour: `voisin.stock.${Date.now()}@merx.test`,
}

let client: Client
const authUsers: Record<'worker' | 'neighbour', string> = { worker: '', neighbour: '' }
const tokens: Record<'worker' | 'neighbour', string> = { worker: '', neighbour: '' }

interface Shop {
  tenant: string
  warehouse: string
  owner: string
  /** Trois produits : un négatif, un à zéro compté, un jamais saisi. */
  negative: string
  counted: string
  never: string
}

const shops: Record<'a' | 'b', Shop> = {
  a: { tenant: '', warehouse: '', owner: '', negative: '', counted: '', never: '' },
  b: { tenant: '', warehouse: '', owner: '', negative: '', counted: '', never: '' },
}

async function one<T>(sql: string, values: unknown[] = []): Promise<T> {
  const { rows } = await client.query<T>(sql, values)
  if (rows[0] === undefined) throw new Error(`aucune ligne rendue : ${sql}`)
  return rows[0]
}

/*
 * Les types de mouvement sont ouverts le temps du fichier. La migration n'en
 * ouvre aucun — fermé par défaut, RÈGLE M2-5 — et le peuplement a besoin d'un
 * `receipt` et d'un `sale` pour produire un stock. Remis en place à la fin.
 */
async function openTypes(): Promise<void> {
  await client.query(
    "insert into merx.movement_type_capability (movement_type, capability) values" +
      " ('receipt', 'receive_goods'), ('sale', 'create_sale')" +
      ' on conflict (movement_type) do update set capability = excluded.capability',
  )
}

async function seedShop(side: 'a' | 'b'): Promise<void> {
  const shop = shops[side]
  shop.tenant = (
    await one<{ id: string }>(
      'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
      [`Stock API ${side.toUpperCase()}`],
    )
  ).id

  shop.warehouse = (
    await one<{ id: string }>(
      'insert into public.warehouse (tenant_id, name, is_default) values ($1, $2, true) returning id',
      [shop.tenant, 'Dépôt'],
    )
  ).id

  shop.owner = (
    await one<{ id: string }>(
      'insert into public.app_user (tenant_id, full_name, role) values ($1, $2, $3) returning id',
      [shop.tenant, `Patron ${side.toUpperCase()}`, 'owner'],
    )
  ).id

  const product = async (name: string, code: string): Promise<string> =>
    (
      await one<{ id: string }>(
        'insert into public.product (tenant_id, name_fr, code, created_by) values ($1, $2, $3, $4)' +
          ' returning id',
        [shop.tenant, name, code, shop.owner],
      )
    ).id

  // La variante par défaut porte l'identifiant de son produit depuis E2-01.
  shop.negative = await product('Savon 500 g', `${side.toUpperCase()}-SAV`)
  shop.counted = await product('Crème hydratante', `${side.toUpperCase()}-CRE`)
  shop.never = await product('Shampoing 1 L', `${side.toUpperCase()}-SHA`)

  const move = async (variant: string, type: string, quantity: string): Promise<void> => {
    await client.query(
      'insert into public.stock_movement' +
        ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_by)' +
        ' values ($1, $2, $3, $4::public.stock_movement_type, $5, $6)',
      [shop.tenant, variant, shop.warehouse, type, quantity, shop.owner],
    )
  }

  // Négatif : RÈGLE M2-3, un grossiste vend ce qui est encore sur le camion.
  await move(shop.negative, 'sale', '-4.500')
  // Zéro **compté** : entré puis sorti.
  await move(shop.counted, 'receipt', '12')
  await move(shop.counted, 'sale', '-12')
  // `shop.never` ne reçoit rien : sa ligne existe, à zéro, sans date.
}

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING })
  await client.connect()

  await openTypes()
  authUsers.worker = await createAuthUser(emails.worker, PASSWORD)
  authUsers.neighbour = await createAuthUser(emails.neighbour, PASSWORD)

  await seedShop('a')
  await seedShop('b')

  await client.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      " values ($1, $2, 'Employé', 'worker')",
    [shops.a.tenant, authUsers.worker],
  )
  await client.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      " values ($1, $2, 'Employé du voisin', 'worker')",
    [shops.b.tenant, authUsers.neighbour],
  )

  tokens.worker = (await sessionFor(emails.worker, PASSWORD)).accessToken
  tokens.neighbour = (await sessionFor(emails.neighbour, PASSWORD)).accessToken
}, 60_000)

afterAll(async () => {
  if (client !== undefined) {
    await client.query('reset role')
    for (const side of ['a', 'b'] as const) {
      const tenant = shops[side].tenant
      if (tenant === '') continue
      /*
       * Les mouvements d'abord, et garde levé : ils sont en ajout seul, et leur
       * clé étrangère sans cascade retient les variantes. Puis les niveaux, que
       * leur propre garde défend. Le harnais lève les gardes pour ranger ; les
       * propriétés, elles, sont éprouvées sur leur chemin réel.
       */
      await client.query('set session_replication_role = replica')
      await client.query('delete from public.stock_movement where tenant_id = $1', [tenant])
      await client.query('delete from public.stock_level where tenant_id = $1', [tenant])
      await client.query('set session_replication_role = origin')
      await client.query('delete from public.product where tenant_id = $1', [tenant])
      await client.query('delete from public.app_user where tenant_id = $1', [tenant])
      await client.query('delete from public.tenant where id = $1', [tenant])
    }
    // Refermer les types ouverts pour le peuplement : la migration n'en ouvre aucun.
    await client.query('delete from merx.movement_type_capability')
  }
  for (const role of ['worker', 'neighbour'] as const) {
    if (authUsers[role] !== '') await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/* ========================================================================== */
/* 1. Les niveaux d'une liste de variantes                                     */
/* ========================================================================== */

describe('les niveaux qui complètent la recherche', () => {
  /** Exactement ce que `stockLevelsFor()` émet. */
  const levelsFor = (variants: readonly string[], token: string) =>
    rest(
      `stock_level?select=variant_id,quantity::text,last_movement_at` +
        `&variant_id=in.(${variants.join(',')})`,
      { token },
    )

  it('rend la quantité et la date des variantes demandées', async () => {
    const { a } = shops
    const result = await levelsFor([a.negative, a.counted, a.never], tokens.worker)

    expect(result.ok, result.body).toBe(true)
    const rows = result.rows as unknown as Array<{
      variant_id: string
      quantity: string
      last_movement_at: string | null
    }>
    expect(rows).toHaveLength(3)

    const by = new Map(rows.map((r) => [r.variant_id, r]))
    // Négatif rendu tel quel : rien ne le bloque, rien ne le masque (M2-3).
    expect(by.get(a.negative)!.quantity).toBe('-4.500')
    // Un zéro compté, et un zéro jamais saisi — même quantité, deux sens (§ 2.5).
    expect(by.get(a.counted)!.quantity).toBe('0.000')
    expect(by.get(a.counted)!.last_movement_at).not.toBeNull()
    expect(by.get(a.never)!.quantity).toBe('0.000')
    expect(by.get(a.never)!.last_movement_at).toBeNull()
  })

  /*
   * La même requête, avec les variantes du voisin dans la liste. Les
   * identifiants sont réels : un uuid inventé ne rendrait rien de toute façon,
   * et le test passerait sans mesurer la policy.
   */
  it('ne rend rien des variantes du voisin, même nommées', async () => {
    const result = await levelsFor(
      [shops.b.negative, shops.b.counted, shops.b.never],
      tokens.worker,
    )

    expect(result.ok, result.body).toBe(true)
    expect(result.rows, 'FUITE — le stock du voisin est lisible').toHaveLength(0)
  })

  it('et le voisin, lui, lit bien les siennes', async () => {
    const result = await levelsFor([shops.b.negative], tokens.neighbour)

    expect(result.ok, result.body).toBe(true)
    // Sans ce contrôle, le cas précédent serait satisfait par un voisin vide.
    expect(result.rows, 'le voisin n’a pas de stock : le cas précédent ne mesure rien').toHaveLength(
      1,
    )
  })
})

/* ========================================================================== */
/* 2. La liste filtrée                                                         */
/* ========================================================================== */

describe('les deux filtres, à travers l’API', () => {
  /** Exactement ce que `listByStockFilter()` émet. */
  const filtered = (predicate: string, token: string) =>
    rest(
      'stock_level?select=variant_id,quantity::text,last_movement_at,' +
        'variant!inner(sku,deleted_at,product!inner(id,name_fr,name_ar,code,photo_url,deleted_at))' +
        `&variant.deleted_at=is.null&variant.product.deleted_at=is.null&${predicate}` +
        '&order=quantity.asc,variant_id.asc&limit=50',
      { token },
    )

  interface Row {
    variant_id: string
    quantity: string
    last_movement_at: string | null
    variant: { sku: string | null; product: { id: string; name_fr: string } | null } | null
  }

  it('le filtre négatif rend la variante négative, avec son produit', async () => {
    const result = await filtered('quantity=lt.0', tokens.worker)

    expect(result.ok, result.body).toBe(true)
    const rows = result.rows as unknown as Row[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.variant_id).toBe(shops.a.negative)
    expect(rows[0]!.quantity).toBe('-4.500')
    // La jointure incorporée porte bien le produit : sans elle, aucun nom à afficher.
    expect(rows[0]!.variant?.product?.name_fr).toBe('Savon 500 g')
    expect(rows[0]!.variant?.product?.id).toBe(shops.a.negative)
  })

  /*
   * Le filtre « à zéro » rend **les deux** sortes de zéro — le compté et le
   * jamais saisi. C'est la décision de la story : la question du vendeur est
   * « ai-je quelque chose à vendre », et la réponse est non dans les deux cas.
   * C'est la ligne, et non le filtre, qui dit de quelle sorte de non il s'agit.
   *
   * Et c'est ce cas qui dépend du rattrapage de la migration : avant E3-02 la
   * variante jamais saisie n'avait pas de ligne, donc n'apparaissait pas — au
   * moment précis où presque tout le catalogue est dans son état.
   */
  it('le filtre à zéro rend le zéro compté **et** le jamais saisi', async () => {
    const result = await filtered('quantity=eq.0', tokens.worker)

    expect(result.ok, result.body).toBe(true)
    const rows = result.rows as unknown as Row[]
    expect(rows.map((r) => r.variant_id).sort()).toEqual(
      [shops.a.counted, shops.a.never].sort(),
    )

    const never = rows.find((r) => r.variant_id === shops.a.never)!
    const counted = rows.find((r) => r.variant_id === shops.a.counted)!
    expect(never.last_movement_at, 'un stock jamais saisi porte une date').toBeNull()
    expect(counted.last_movement_at, 'un zéro compté n’a pas de date').not.toBeNull()
  })

  it('aucun filtre ne traverse la frontière du commerce', async () => {
    for (const predicate of ['quantity=lt.0', 'quantity=eq.0']) {
      const mine = await filtered(predicate, tokens.worker)
      const theirs = await filtered(predicate, tokens.neighbour)

      expect(mine.ok && theirs.ok, `${mine.body} / ${theirs.body}`).toBe(true)
      const ids = (rows: Array<{ id?: string }>) =>
        (rows as unknown as Row[]).map((r) => r.variant_id)

      // Chacun voit quelque chose, et aucun ne voit la ligne de l'autre.
      expect(ids(mine.rows).length).toBeGreaterThan(0)
      expect(ids(theirs.rows).length).toBeGreaterThan(0)
      for (const id of ids(mine.rows)) expect(ids(theirs.rows)).not.toContain(id)
    }
  })
})

/* ========================================================================== */
/* 3. L'historique                                                             */
/* ========================================================================== */

describe('list_stock_movements, à travers l’API', () => {
  /** Exactement ce que `supabase.rpc('list_stock_movements', …)` émet. */
  const history = (variant: string, token: string) =>
    rest('rpc/list_stock_movements', {
      token,
      method: 'POST',
      body: { p_variant_id: variant },
    })

  interface Row {
    movement_type: string
    quantity: string
    author_name: string | null
    source_type: string | null
  }

  it('rend l’historique et l’auteur à un employé', async () => {
    const result = await history(shops.a.counted, tokens.worker)

    expect(result.ok, result.body).toBe(true)
    const rows = result.rows as unknown as Row[]
    expect(rows).toHaveLength(2)
    // L'auteur, que la lecture directe d'app_user refuse à ce rôle.
    expect(rows.map((r) => r.author_name)).toEqual(['Patron A', 'Patron A'])
    // Aucun document : l'ajustement et la réception d'E3-03/E8 n'existent pas,
    // et aucune table de document n'existe avant E4.
    expect(rows.map((r) => r.source_type)).toEqual([null, null])
  })

  /*
   * Et la démonstration que l'exception § 2.1 sert à quelque chose : le même
   * jeton ne lit pas `app_user`. Si cette assertion tombait, c'est la policy
   * restrictive d'E1-02 qui aurait sauté, pas cette story.
   */
  it('le même employé ne lit pas app_user par l’API', async () => {
    const direct = await rest('app_user?select=full_name', { token: tokens.worker })

    expect(direct.ok, direct.body).toBe(true)
    expect(direct.rows, 'FUITE — un employé lit le registre des employés').toHaveLength(0)
  })

  it('rend zéro ligne sur une variante du voisin', async () => {
    const result = await history(shops.b.counted, tokens.worker)

    expect(result.ok, result.body).toBe(true)
    expect(result.rows, 'FUITE — l’historique du voisin est lisible').toHaveLength(0)

    // Et le voisin, lui, la lit : sans quoi le cas ci-dessus ne mesure rien.
    const theirs = await history(shops.b.counted, tokens.neighbour)
    expect(theirs.ok, theirs.body).toBe(true)
    expect(theirs.rows).toHaveLength(2)
  })
})
