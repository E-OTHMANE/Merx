// @vitest-environment node

/*
 * E3-02 — consultation du stock.
 * SPEC § 2.1 (exception nommée), § 2.5 (une valeur incertaine ne se présente
 * pas comme certaine), § 3.1 (matrice), § 7 M2 (RÈGLE M2-3).
 *
 * Quatre sujets :
 *
 *   — **la ligne de stock existe dès la variante.** C'est ce qui rend les deux
 *     filtres indexables et la quantité lisible juste après un import. Éprouvé
 *     sur le chemin réel — un produit créé par PostgREST — et non sur un
 *     `insert` de harnais : la variante par défaut naît elle-même d'un trigger,
 *     et c'est cet enchaînement-là qui doit tenir ;
 *
 *   — **`last_movement_at` sépare « 0 compté » de « jamais saisi »** (§ 2.5).
 *     La valeur écrite par `greatest()` est éprouvée dans
 *     `stock-movements.test.ts`, où vit l'écrivain ; ici on vérifie que la
 *     lecture la rend, et que la distinction arrive jusqu'à l'API ;
 *
 *   — **les deux filtres emprunte nt leur index partiel.** Sous RLS, ni
 *     `numeric_eq` ni `numeric_lt` ne sont `leakproof` : aucune condition
 *     d'index n'est possible sur `quantity`, et seul un index **partiel** sort
 *     de là. Le plan est lu sur une session chaude, deux fois, parce qu'un
 *     sabotage de plan resté vert sur un seul tour ne prouve rien (E2-04) ;
 *
 *   — **`list_stock_movements()` et ses trois gardes**, chacun avec un test, et
 *     chacun répondant quelque chose qu'aucun autre ne répond (CLAUDE.md,
 *     E1-02). La fonction est `security definer` : aucune policy ne s'applique,
 *     et ces trois lignes sont tout ce qui sépare l'historique d'un commerce de
 *     celui du voisin.
 *
 * Ce qui n'est pas ici : la forme des clés, les domaines nommés, les registres
 * (`conventions.test.ts`), l'isolation table par table
 * (`isolation.test.ts`), et l'écrivain de `stock_level`
 * (`stock-movements.test.ts`).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { actAs, attempt, tokenFor, withoutTrigger } from './isolation'
import { indexesUsed, planOfStatement, seqScansOf } from './stock-plan'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/** Le code du privilège manquant — celui du premier garde, et de lui seul. */
const INSUFFICIENT_PRIVILEGE = '42501'

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: CONNECTION_STRING })
  await client.connect()
  return client
}

let client: Client

/*
 * Deux commerces, chacun avec son dépôt, ses produits et un employé. Le second
 * n'est là que pour une chose : être le voisin dont on essaie de lire
 * l'historique.
 */
interface Shop {
  tenant: string
  warehouse: string
  owner: string
  /** La variante par défaut du produit « Savon », celle qui reçoit les mouvements. */
  variant: string
  /** Une seconde variante, qui n'a jamais eu de mouvement. */
  quiet: string
}

const shops: { a: Shop; b: Shop } = {
  a: { tenant: '', warehouse: '', owner: '', variant: '', quiet: '' },
  b: { tenant: '', warehouse: '', owner: '', variant: '', quiet: '' },
}

async function makeShop(name: string): Promise<Shop> {
  const { rows: tenants } = await client.query<{ id: string }>(
    'insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), $1) returning id',
    [name],
  )
  const tenant = tenants[0]!.id


  /*
   * Le dépôt n'est pas créé ici : le trigger `open_default_warehouse` l'ouvre
   * avec le commerce (E3-02). On lit le sien.
   */
  const { rows: warehouses } = await client.query<{ id: string }>(
    'select id from public.warehouse where tenant_id = $1 and is_default',
    [tenant],
  )

  const { rows: users } = await client.query<{ id: string }>(
    'insert into public.app_user (tenant_id, full_name, role) values ($1, $2, $3) returning id',
    [tenant, `Patron de ${name}`, 'owner'],
  )
  const owner = users[0]!.id

  const variants: string[] = []
  for (const label of ['Savon 500 g', 'Crème hydratante']) {
    const { rows: products } = await client.query<{ id: string }>(
      'insert into public.product (tenant_id, name_fr, created_by) values ($1, $2, $3) returning id',
      [tenant, label, owner],
    )
    variants.push(products[0]!.id)
  }

  return {
    tenant,
    warehouse: warehouses[0]!.id,
    owner,
    // La variante par défaut porte l'identifiant de son produit depuis E2-01.
    variant: variants[0]!,
    quiet: variants[1]!,
  }
}

beforeAll(async () => {
  client = await connect()
  await client.query('begin')
  shops.a = await makeShop('Stock A')
  shops.b = await makeShop('Stock B')
})

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
})

/** Un cas par point de sauvegarde : l'ordre des tests ne doit rien décider. */
async function inCase(body: () => Promise<void>): Promise<void> {
  await client.query('reset role')
  await client.query('savepoint case_under_test')
  try {
    await body()
  } finally {
    await client.query('reset role')
    await client.query('rollback to savepoint case_under_test')
  }
}

/** Ouvre un type de mouvement le temps du cas — la migration n'en ouvre aucun. */
async function openType(movementType: string, capability: string): Promise<void> {
  await client.query('reset role')
  await client.query(
    'insert into merx.movement_type_capability (movement_type, capability)' +
      ' values ($1::public.stock_movement_type, $2)' +
      ' on conflict (movement_type) do update set capability = excluded.capability',
    [movementType, capability],
  )
}

/*
 * `require_sale_origin` (E4-05) refuse l'insertion directe d'un mouvement
 * `sale` : il naît de la confirmation d'un bon. Ce peuplement produit un stock
 * à consulter, pas une vente ; le garde est suspendu pour lui seul, et non par
 * `withoutTriggers()`, qui emporterait l'agrégat que ce fichier lit (CLAUDE.md,
 * `session_replication_role`).
 */
async function postMovement(
  shop: Shop,
  variant: string,
  movementType: string,
  quantity: string,
  createdAt?: string,
): Promise<void> {
  await client.query('reset role')
  await withoutTrigger(client, 'public.stock_movement', 'require_sale_origin', async () => {
    await client.query(
      'insert into public.stock_movement' +
        ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_by, created_at)' +
        ' values ($1, $2, $3, $4::public.stock_movement_type, $5, $6,' +
        ' coalesce($7::timestamptz, now()))',
      [shop.tenant, variant, shop.warehouse, movementType, quantity, shop.owner, createdAt ?? null],
    )
  })
}

/* ========================================================================== */
/* SPEC § 2.4 — le dépôt naît avec le commerce, quel que soit le chemin         */
/* ========================================================================== */

describe('le dépôt par défaut', () => {
  /*
   * « Une seule ligne par commerce, créée automatiquement. » Jusqu'en E3-02,
   * « automatiquement » voulait dire « par `create_tenant()` », et un commerce
   * inséré autrement n'en avait pas — ce qui n'a été remarqué que le jour où
   * la naissance d'une variante s'est mise à en dépendre.
   *
   * Le commerce est donc inséré **sans passer par `create_tenant()`**, comme le
   * font tous les jeux d'essai du projet : c'est précisément le chemin que la
   * garantie doit couvrir.
   */
  it('existe pour un commerce inséré sans passer par create_tenant()', async () => {
    await inCase(async () => {
      await client.query('reset role')
      const { rows } = await client.query<{ id: string }>(
        'insert into public.tenant (tenant_id, business_name)' +
          " values (gen_random_uuid(), 'Commerce sans create_tenant') returning id",
      )
      const tenant = rows[0]!.id

      const { rows: depots } = await client.query<{ name: string; is_default: boolean }>(
        'select name, is_default from public.warehouse where tenant_id = $1',
        [tenant],
      )

      expect(depots, 'aucun dépôt pour un commerce créé à la main').toHaveLength(1)
      expect(depots[0]!.is_default).toBe(true)
    })
  })

  /*
   * Et exactement un : le trigger en garantit au moins un, l'index partiel
   * `warehouse_one_default_per_tenant` au plus un. Si `create_tenant()`
   * écrivait encore le sien, ce commerce-ci en aurait deux — ou la fonction
   * échouerait sur l'unicité.
   */
  it('reste unique quand le commerce passe par create_tenant()', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ n: string }>(`
      select count(*)::text as n
      from public.tenant t
      join public.warehouse w on w.tenant_id = t.id and w.is_default
      group by t.id
      having count(*) <> 1
    `)
    expect(rows, 'un commerce a plus d’un dépôt par défaut').toHaveLength(0)
  })
})

/* ========================================================================== */
/* La ligne de stock naît avec la variante                                     */
/* ========================================================================== */

describe('la ligne de stock naît avec la variante', () => {
  /*
   * Le chemin réel : un produit inséré comme l'application l'insère, sous le
   * jeton du patron. Deux triggers s'enchaînent — la variante par défaut
   * d'E2-01, puis `open_stock_level`. Un `insert` de harnais dans `variant`
   * mesurerait le second sans le premier.
   */
  it('un produit créé sous le jeton du patron ouvre le stock de sa variante', async () => {
    await inCase(async () => {
      await actAs(client, tokenFor(shops.a.tenant, 'owner'))

      const { rows: created } = await client.query<{ id: string }>(
        "insert into public.product (name_fr) values ('Shampoing 1 L') returning id",
      )
      const productId = created[0]!.id

      await client.query('reset role')
      const { rows } = await client.query<{
        quantity: string
        warehouse_id: string
        at: string | null
      }>(
        'select l.quantity, l.warehouse_id, l.last_movement_at::text as at' +
          ' from public.stock_level l' +
          ' join public.variant v on v.tenant_id = l.tenant_id and v.id = l.variant_id' +
          ' where v.product_id = $1',
        [productId],
      )

      expect(rows, 'aucune ligne de stock pour la variante par défaut').toHaveLength(1)
      expect(rows[0]!.quantity).toBe('0.000')
      // Le dépôt unique du commerce, jamais choisi (SPEC § 2.4).
      expect(rows[0]!.warehouse_id).toBe(shops.a.warehouse)
      // SPEC § 2.5 : rien n'a été compté, et la colonne le dit.
      expect(rows[0]!.at, 'un stock jamais saisi porte une date').toBeNull()
    })
  })

  /*
   * Le rattrapage de la migration, vu de l'autre bout : il ne doit rester
   * aucune variante vivante sans ligne de stock, dans aucun commerce. C'est la
   * propriété dont dépendent les deux filtres — une variante sans ligne sort du
   * filtre « stock à zéro », qui est précisément celui qui doit tout montrer
   * après un import.
   */
  it('aucune variante ne reste sans ligne de stock', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ orphans: string }>(`
      select count(*)::text as orphans
      from public.variant v
      where v.deleted_at is null
        and not exists (
          select 1 from public.stock_level l
          where l.tenant_id = v.tenant_id and l.variant_id = v.id
        )
    `)
    expect(rows[0]!.orphans, 'des variantes vivantes sans ligne de stock').toBe('0')
  })
})

/* ========================================================================== */
/* « 0 compté » et « jamais saisi » ne se lisent pas pareil                     */
/* ========================================================================== */

describe('un zéro compté ne se lit pas comme un stock jamais saisi', () => {
  it('distingue les deux par last_movement_at', async () => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await openType('sale', 'create_sale')

      // La variante bruyante revient à zéro — un zéro **compté**.
      await postMovement(shops.a, shops.a.variant, 'receipt', '10')
      await postMovement(shops.a, shops.a.variant, 'sale', '-10')

      await client.query('reset role')
      const { rows } = await client.query<{
        variant_id: string
        quantity: string
        at: string | null
      }>(
        'select variant_id, quantity, last_movement_at::text as at from public.stock_level' +
          ' where tenant_id = $1 and variant_id = any($2::uuid[]) order by variant_id',
        [shops.a.tenant, [shops.a.variant, shops.a.quiet]],
      )

      const counted = rows.find((r) => r.variant_id === shops.a.variant)!
      const never = rows.find((r) => r.variant_id === shops.a.quiet)!

      // Même quantité, deux significations : c'est tout l'objet de la colonne.
      expect(counted.quantity).toBe('0.000')
      expect(never.quantity).toBe('0.000')
      expect(counted.at, 'un zéro compté n’a pas de date').not.toBeNull()
      expect(never.at, 'un stock jamais saisi porte une date').toBeNull()
    })
  })
})

/* ========================================================================== */
/* RÈGLE M2-3 — le stock négatif se lit, il ne se refuse pas                   */
/* ========================================================================== */

describe('RÈGLE M2-3 — le négatif se lit', () => {
  it('rend un niveau négatif sans que rien ne le refuse', async () => {
    await inCase(async () => {
      await openType('sale', 'create_sale')
      await postMovement(shops.a, shops.a.variant, 'sale', '-7.500')

      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const { rows } = await client.query<{ quantity: string }>(
        'select quantity from public.stock_level where variant_id = $1',
        [shops.a.variant],
      )

      // Lisible par l'employé : « voir le catalogue et le stock » est à deux
      // rôles (SPEC § 3.1), et c'est lui qui répond au client.
      expect(rows[0]!.quantity).toBe('-7.500')
    })
  })
})

/* ========================================================================== */
/* Les deux filtres empruntent leur index partiel                              */
/* ========================================================================== */

describe('les filtres de stock empruntent leur index partiel', () => {
  /*
   * La forme que PostgREST émet : le prédicat sur `quantity`, et rien sur le
   * commerce — il vient de la policy. Si le `tenant_id` apparaissait dans la
   * requête, le test mesurerait un filtre applicatif, ce que SPEC § 2.1 refuse.
   */
/*
   * Le marqueur est un commentaire SQL, et non un fragment du plan : quand le
   * prédicat du filtre est entièrement couvert par celui de l'index partiel,
   * Postgres ne le réécrit nulle part dans le plan — ni en `Index Cond`, ni en
   * `Filter`. C'est le signe que l'index fait le travail, et cela rend le plan
   * impossible à reconnaître par son contenu. `auto_explain` rapporte en
   * revanche le texte de la requête, où le commentaire survit.
   */
  const cases = [
    {
      label: 'stock à zéro',
      sql:
        'select /* plan_probe_zero */ variant_id, quantity, last_movement_at' +
        ' from public.stock_level where quantity = 0',
      marker: 'plan_probe_zero',
      index: 'stock_level_zero',
    },
    {
      label: 'stock négatif',
      sql:
        'select /* plan_probe_negative */ variant_id, quantity, last_movement_at' +
        ' from public.stock_level where quantity < 0 order by quantity',
      marker: 'plan_probe_negative',
      index: 'stock_level_negative',
    },
  ] as const

  /*
   * **Deux tours.** Le choix de plan est limite et bascule d'un tour à l'autre
   * sur les mêmes données : en E2-04, un sabotage resté vert une fois a conduit
   * à retirer un index qu'il fallait garder. Un plan se juge sur plus d'un tour.
   */
  for (const round of [1, 2]) {
    it.each(cases)(
      `%s passe par son index, tour ${round}`,
      async ({ sql, marker, index }) => {
        await inCase(async () => {
          await openType('sale', 'create_sale')
          await postMovement(shops.a, shops.a.variant, 'sale', '-3')

          /*
           * Une table peuplée, et **dont la forme est connue** : beaucoup de
           * lignes non nulles, une poignée à zéro ou en négatif. Deux raisons,
           * payées toutes les deux :
           *
           *   — sur les six lignes du peuplement, un parcours séquentiel est le
           *     bon plan, et l'assertion tomberait en accusant l'index alors
           *     que le planificateur a raison (même leçon qu'E2-04) ;
           *   — surtout, un index partiel ne sert que si son prédicat est
           *     **sélectif**. Quand presque tout le catalogue est à zéro — ce
           *     qui est exactement l'état d'un commerce qui vient d'importer
           *     ses 2 000 références — balayer est le bon plan, et le refuser
           *     serait exiger du planificateur qu'il ait tort. Le filtre
           *     « stock à zéro » doit emprunter son index quand les zéros sont
           *     une minorité ; c'est cela qui se mesure ici.
           *
           * Et `analyze` : `product-import` laisse derrière lui des
           * statistiques qui décrivent une table immense et presque toute à
           * zéro. Sans rafraîchir, ce test lisait le plan d'une table qui
           * n'existe plus — vert seul, rouge dans la suite complète.
           *
           * Les lignes sont posées en `replica` : la table dérivée refuse toute
           * écriture directe (RÈGLE M2-1) et les clés étrangères refuseraient
           * des variantes inventées. C'est un peuplement de harnais, et il
           * disparaît avec la transaction.
           */
          await client.query('reset role')
          await client.query('set session_replication_role = replica')
          await client.query(
            'insert into public.stock_level' +
              ' (tenant_id, variant_id, warehouse_id, quantity, last_movement_at)' +
              ' select $1, gen_random_uuid(), $2, 7, now() from generate_series(1, 3000)',
            [shops.a.tenant, shops.a.warehouse],
          )
          await client.query('set session_replication_role = origin')
          await client.query('analyze public.stock_level')

          const nodes = await planOfStatement(
            client,
            tokenFor(shops.a.tenant, 'worker'),
            sql,
            marker,
          )

          expect(
            seqScansOf(nodes, 'stock_level').length,
            'parcours séquentiel de stock_level — tous les commerces sont lus',
          ).toBe(0)
          expect(indexesUsed(nodes)).toContain(index)
        })
      },
    )
  }

  /*
   * Et le contenu, à travers PostgREST — ce que le plan ne dit pas. Les deux
   * chemins doivent rendre les mêmes lignes : un index partiel dont le prédicat
   * ne couvrirait pas exactement le filtre rendrait un plan parfait et une
   * réponse fausse.
   */
  it('le filtre négatif ne rend que les lignes négatives du commerce', async () => {
    await inCase(async () => {
      await openType('sale', 'create_sale')
      await postMovement(shops.a, shops.a.variant, 'sale', '-3')
      // Le voisin aussi a du négatif : il ne doit pas apparaître.
      await postMovement(shops.b, shops.b.variant, 'sale', '-99')

      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const { rows } = await client.query<{ variant_id: string; quantity: string }>(
        'select variant_id, quantity from public.stock_level where quantity < 0',
      )

      expect(rows).toHaveLength(1)
      expect(rows[0]!.variant_id).toBe(shops.a.variant)
      expect(rows[0]!.quantity).toBe('-3.000')
    })
  })
})

/* ========================================================================== */
/* `list_stock_movements()` — l'historique, et ses trois gardes                 */
/* ========================================================================== */

describe('list_stock_movements — l’historique d’une variante', () => {
  /** Trois mouvements, dont deux du même type, pour que l'ordre se voie. */
  const withHistory = async (body: () => Promise<void>): Promise<void> => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await openType('sale', 'create_sale')
      /*
       * Des horodatages explicites et distincts. `now()` est l'instant de la
       * **transaction**, identique pour les trois lignes : laissées au défaut,
       * elles s'ordonnaient par identifiant et le critère « du plus récent au
       * plus ancien » ne mesurait rien. Mesuré — l'ordre rendu était celui des
       * uuid.
       */
      await postMovement(shops.a, shops.a.variant, 'receipt', '100', '2026-10-01T08:00:00Z')
      await postMovement(shops.a, shops.a.variant, 'sale', '-30', '2026-10-03T08:00:00Z')
      await postMovement(shops.a, shops.a.variant, 'sale', '-80', '2026-10-06T08:00:00Z')
      await postMovement(shops.b, shops.b.variant, 'receipt', '55', '2026-10-02T08:00:00Z')
      await body()
    })
  }

  interface Row {
    movement_type: string
    quantity: string
    author_name: string | null
    created_at: string
  }

  const history = async (variant: string): Promise<Row[]> => {
    const { rows } = await client.query<Row>(
      'select movement_type, quantity, author_name, created_at::text as created_at' +
        ' from public.list_stock_movements($1)',
      [variant],
    )
    return rows
  }

  /*
   * Le critère de la story, vu par le **vendeur** : date, type, quantité,
   * auteur. L'auteur est la raison d'être de la fonction — `app_user` est fermé
   * à qui n'a pas `manage_users`, et l'employé ne l'a pas.
   */
  it('rend l’historique complet à un employé, du plus récent au plus ancien', async () => {
    await withHistory(async () => {
      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const rows = await history(shops.a.variant)

      expect(rows).toHaveLength(3)
      expect(rows.map((r) => r.quantity)).toEqual(['-80.000', '-30.000', '100.000'])
      expect(rows.map((r) => r.movement_type)).toEqual(['sale', 'sale', 'receipt'])
      // L'auteur, que la lecture directe d'app_user refuserait à ce rôle.
      expect(rows.map((r) => r.author_name)).toEqual([
        'Patron de Stock A',
        'Patron de Stock A',
        'Patron de Stock A',
      ])
    })
  })

  /*
   * Et la preuve que l'exception sert à quelque chose : le même employé ne lit
   * pas `app_user` lui-même. Si ce test passait au vert sans la fonction, c'est
   * que la policy restrictive d'E1-02 aurait sauté.
   */
  it('le même employé ne peut pas lire app_user directement', async () => {
    await inCase(async () => {
      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const { rows } = await client.query<{ full_name: string }>(
        'select full_name from public.app_user',
      )
      expect(rows, 'FUITE — un employé lit le registre des employés').toHaveLength(0)
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Garde 1 — la capacité                                                   */
  /* ---------------------------------------------------------------------- */

  /*
   * Doublé par `RequireCapability` sur la route : celui-ci est le seul qui
   * compte quand l'appel arrive sans passer par l'écran. Sa phrase n'est celle
   * d'aucun autre garde de cette fonction — les deux autres ne refusent pas, ils
   * rendent zéro ligne.
   */
  it('refuse une session sans view_catalogue, avec sa propre phrase', async () => {
    await withHistory(async () => {
      await actAs(client, tokenFor(shops.a.tenant, 'nobody'))

      const called = await attempt(
        client,
        `select * from public.list_stock_movements('${shops.a.variant}'::uuid)`,
      )

      expect(called.ok, 'FUITE — l’historique sort sans view_catalogue').toBe(false)
      if (called.ok) return
      expect(called.code, called.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(called.message).toContain('consulter le catalogue et le stock')
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Garde 2 — la variante appartient au commerce du jeton                   */
  /* ---------------------------------------------------------------------- */

  /*
   * L'identifiant **réel** d'une variante du voisin, pas un uuid inventé : un
   * identifiant inexistant rendrait zéro ligne de toute façon, et le test
   * passerait sans rien mesurer. Le voisin a des mouvements, et aucun ne doit
   * sortir — ni sous l'employé, ni sous le patron, qui n'a pas plus de droits
   * sur le commerce d'en face.
   */
  it.each([['worker'], ['owner']])(
    'rend zéro ligne sur une variante du voisin, sous un %s',
    async (role) => {
      await withHistory(async () => {
        await actAs(client, tokenFor(shops.a.tenant, role))

        const rows = await history(shops.b.variant)

        expect(rows, 'FUITE — l’historique du voisin est lisible').toHaveLength(0)
      })
    },
  )

  /*
   * Et l'autre moitié de la propriété : la variante du voisin a bien des
   * mouvements. Sans ce contrôle, le cas ci-dessus serait satisfait par un
   * voisin vide, et le garde pourrait disparaître sans qu'il tombe — la famille
   * de pièges que CLAUDE.md enregistre depuis E1-01.
   */
  it('le voisin a bien un historique, lisible de chez lui', async () => {
    await withHistory(async () => {
      await actAs(client, tokenFor(shops.b.tenant, 'worker'))
      const rows = await history(shops.b.variant)

      expect(rows, 'le voisin n’a aucun mouvement : le cas précédent ne mesure rien').toHaveLength(
        1,
      )
      expect(rows[0]!.quantity).toBe('55.000')
      expect(rows[0]!.author_name).toBe('Patron de Stock B')
    })
  })

  /*
   * Le cas que **seul** le garde 2 peut arrêter, et sans lequel son test
   * n'existe que pour la forme.
   *
   * Demander l'historique d'une variante du voisin ne prouve rien : le garde 3
   * filtre déjà les mouvements sur le commerce du jeton, et rend zéro ligne de
   * lui-même. Retirer le garde 2 laissait la suite entièrement verte — constaté
   * à la passe de sabotage, deuxième cas.
   *
   * Il faut donc un mouvement que le garde 3 **laisserait passer** : porté par
   * le commerce du jeton, mais posé sur une variante du voisin. La clé composite
   * `(tenant_id, variant_id)` l'interdit, et la RLS aussi — il est écrit en
   * `postgres`, gardes levés, parce que c'est exactement la forme qu'aurait une
   * ligne produite par une fonction `security definer` mal écrite en E4, ou par
   * une synchronisation qui confond deux variantes (E9). Le garde 2 est ce qui
   * fait que la question ne se pose pas.
   */
  it('refuse la question elle-même, même quand un mouvement du commerce la suivrait', async () => {
    await withHistory(async () => {
      await client.query('reset role')
      await client.query('set session_replication_role = replica')
      await client.query(
        'insert into public.stock_movement' +
          ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_by)' +
          " values ($1, $2, $3, 'receipt', 42, $4)",
        [shops.a.tenant, shops.b.variant, shops.a.warehouse, shops.a.owner],
      )
      await client.query('set session_replication_role = origin')

      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const rows = await history(shops.b.variant)

      // Le garde 3 rendrait cette ligne : son `tenant_id` est le bon.
      expect(rows, 'FUITE — une variante du voisin rend un mouvement').toHaveLength(0)
      expect(rows.map((r) => r.quantity)).not.toContain('42.000')
    })
  })

  /* ---------------------------------------------------------------------- */
  /* Garde 3 — le filtre du commerce sur les mouvements rendus                */
  /* ---------------------------------------------------------------------- */

  /*
   * Le garde 2 borne la question, le 3 borne la réponse, et ils se mesurent
   * différemment : ici la variante **appartient** au commerce du jeton, donc le
   * garde 2 laisse passer, et seul le 3 peut écarter les mouvements d'ailleurs.
   *
   * Le cas est construit par la seule voie qui le rende possible : un mouvement
   * du commerce B sur la variante de A. Les policies l'interdisent, et la clé
   * composite aussi — il est donc posé en `postgres`, hors RLS, exactement comme
   * une fonction `security definer` mal écrite en E4 pourrait le faire. C'est ce
   * dont le garde 3 protège.
   */
  it('écarte un mouvement d’un autre commerce posé sur une variante du sien', async () => {
    await withHistory(async () => {
      await client.query('reset role')
      await client.query('set session_replication_role = replica')
      await client.query(
        'insert into public.stock_movement' +
          ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_by)' +
          " values ($1, $2, $3, 'receipt', 999, $4)",
        [shops.b.tenant, shops.a.variant, shops.b.warehouse, shops.b.owner],
      )
      await client.query('set session_replication_role = origin')

      await actAs(client, tokenFor(shops.a.tenant, 'worker'))
      const rows = await history(shops.a.variant)

      expect(rows, 'FUITE — un mouvement d’un autre commerce est rendu').toHaveLength(3)
      expect(rows.map((r) => r.quantity)).not.toContain('999.000')
    })
  })

  /*
   * L'index de lecture d'E3-01, posé pour cette story et nommé dans son
   * commentaire. La fonction est `security definer`, donc hors RLS : les deux
   * colonnes de tête sont de simples égalités, la condition d'index est entière,
   * et le tri `created_at desc` est déjà celui de l'index.
   */
  it('lit l’historique par l’index d’E3-01, sans parcours séquentiel', async () => {
    await withHistory(async () => {
      /*
       * Une table peuplée, sans quoi le test ne mesure rien. Sur les quatre
       * mouvements du peuplement, un parcours séquentiel **est** le bon plan, et
       * l'assertion tomberait en accusant l'index alors que le planificateur a
       * raison. Les lignes vont sur d'autres variantes, pour que celle dont on
       * lit l'historique reste à ses trois mouvements : c'est le cas réel — une
       * variante parmi des milliers de mouvements.
       *
       * Posées **triggers suspendus** : ce sont du lest pour le planificateur,
       * pas des mouvements dont on lit le résultat. Avec l'agrégat actif, le
       * trigger tournait 4 000 fois et le cas dépassait les cinq secondes dès
       * qu'un autre fichier l'avait précédé — un échec de délai qui se lisait
       * comme un mauvais plan.
       */
      await client.query('reset role')
      await client.query('set session_replication_role = replica')
      await client.query(
        'insert into public.stock_movement' +
          ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_by, created_at)' +
          " select $1, $2, $3, 'receipt', 1, $4," +
          " timestamptz '2026-01-01T00:00:00Z' + (n || ' minutes')::interval" +
          ' from generate_series(1, 4000) n',
        [shops.b.tenant, shops.b.quiet, shops.b.warehouse, shops.b.owner],
      )
      await client.query('set session_replication_role = origin')
      await client.query('analyze public.stock_movement')
      // Même raison que pour les filtres : des statistiques fraîches, sinon le
      // plan lu est celui d'une table que les autres fichiers ont laissée.
      await client.query('analyze public.stock_level')

      const nodes = await planOfStatement(
        client,
        tokenFor(shops.a.tenant, 'worker'),
        `select * from public.list_stock_movements('${shops.a.variant}'::uuid)`,
        // La requête de la fonction, pas l'appel : le plan extérieur n'est
        // qu'un Function Scan, et la jointure n'existe que dans son corps.
        'left join public.app_user',
      )

      expect(
        seqScansOf(nodes, 'stock_movement').length,
        'parcours séquentiel de stock_movement — tous les commerces sont lus',
      ).toBe(0)
      expect(indexesUsed(nodes)).toContain('stock_movement_variant_created_at')
    })
  })
})
