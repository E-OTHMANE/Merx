// @vitest-environment node

/*
 * E3-01 — mouvements de stock et niveaux.
 * SPEC § 2.4 (dépôt unique), § 3.1 (matrice), § 4 (domaines nommés),
 * § 7 M2 (RÈGLES M2-1, M2-2, M2-3).
 *
 * Quatre sujets, et chacun son garde :
 *
 *   — **la série** (le critère de la story) : une suite de mouvements produit
 *     le `stock_level` attendu, et le niveau est relu après *chaque* étape. Il
 *     est aussi comparé à la somme des mouvements, qui est une seconde façon de
 *     calculer la même chose : un trigger qui dériverait d'un centième ne
 *     passerait pas les deux ;
 *
 *   — **RÈGLE M2-3** : un niveau qui passe sous zéro est accepté, y compris au
 *     premier mouvement. Un grossiste vend ce qui est encore sur le camion. La
 *     seule chose à prouver est qu'aucune contrainte ne refuse ;
 *
 *   — **RÈGLE M2-1** : `stock_level` ne s'écrit pas à la main. Éprouvé sous
 *     `authenticated` *et* sous `postgres`, qui porte BYPASSRLS : si seule la
 *     policy tenait la ligne, le second passerait ;
 *
 *   — **RÈGLE M2-2** : un mouvement ne se modifie ni ne se supprime. Deux
 *     gardes, deux codes — `42501` pour le privilège retiré, que rencontre
 *     l'application, `2F004` pour le trigger, que rencontre tout le reste. Et
 *     le TRUNCATE a sa propre phrase, parce qu'un trigger de ligne ne le voit
 *     pas passer ;
 *
 *   — **fermé par défaut** : un type qu'aucune story n'a ouvert n'est écrit
 *     par personne. Les cinq types sont lus au catalogue et les types ouverts
 *     au registre, aucune liste n'est écrite ici : un sixième type ajouté sans
 *     capacité entre dans ce test tout seul, et le type qu'ouvrira E3-04 en
 *     sort tout seul.
 *
 * E3-03 a ouvert `adjustment`, et ce type a quitté ce fichier : il exige
 * désormais un motif et une session porteuse d'un auteur — son insertion
 * journalise (RÈGLE M8-1) et `merx.log_audit()` refuse sans jeton. Or ce
 * fichier ne crée aucun utilisateur d'authentification. Tout ce qui le concerne
 * est mesuré dans `stock-adjustment.test.ts` ; ici, là où le type n'était qu'un
 * prétexte, c'est `inventory` — encore fermé — qui sert de cas d'épreuve.
 *
 * Deux gardes se partagent le fermé par défaut, et le test doit pouvoir dire
 * lequel a refusé (CLAUDE.md, E1-02) : le trigger nomme le type, la policy rend
 * la phrase générique de la RLS. Les deux assertions portent donc sur le
 * message, pas seulement sur le code — qui est `42501` dans les deux cas,
 * puisque les deux refusent pour défaut de droit.
 *
 * Ce qui n'est pas ici, parce que les balayages le tiennent pour toute table :
 * l'isolation entre commerces et l'inversion du contrôle positif sur les tables
 * dérivées (`isolation.test.ts`), la forme des clés, les domaines nommés et les
 * gardes des registres (`conventions.test.ts`).
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DERIVED_WRITE, INSUFFICIENT_PRIVILEGE, actAs, attempt, tokenFor, withoutTrigger } from './isolation'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/** Le code de l'ajout seul, posé en E1-04 : *modifying_sql_data_not_permitted*. */
const APPEND_ONLY = '2F004'

/** Une contrainte `check` violée, et une clé étrangère — celle du registre. */
const CHECK_VIOLATION = '23514'
const FOREIGN_KEY_VIOLATION = '23503'

/* Ce que chaque garde du fermé par défaut, et lui seul, répond. */
const CLOSED_BY_DEFAULT = 'Aucune capacité n\'ouvre les mouvements de type'

/*
 * Postgres nomme la policy qui a refusé. C'est ce qui rend les deux gardes du
 * fermé par défaut distinguables sans ambiguïté : celui-ci est la policy
 * `column_capability_insert`, l'autre est un trigger et nomme le type.
 */
const RLS_REFUSAL = 'row-level security policy "column_capability_insert"'

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

/*
 * Les cinq types sont lus au catalogue, et à l'heure où `it.each` a besoin de
 * ses cas. Une liste écrite ici aurait vieilli en silence : le jour où un type
 * s'ajoute sans capacité, c'est ce test-ci qui doit le dire.
 */
const MOVEMENT_TYPES = await movementTypesUnderTest()

/*
 * Les types qu'une migration a ouverts, lus au registre pour la même raison que
 * les cinq étiquettes sont lues au catalogue : le balayage du fermé par défaut
 * doit porter sur ce qui est fermé *aujourd'hui*, sans qu'une liste écrite ici
 * ait à suivre E3-04, E4 et E8-02 à la main.
 */
const OPEN_TYPES = await openMovementTypes()

/** Ce qui reste fermé : c'est là que le garde du fermé par défaut se mesure. */
const CLOSED_TYPES = MOVEMENT_TYPES.filter((type) => !OPEN_TYPES.has(type))

/** Les types ouverts à l'écriture, et par quelle capacité. */
async function openMovementTypes(): Promise<Map<string, string>> {
  const client = await connect()
  try {
    const { rows } = await client.query<{ movement_type: string; capability: string }>(
      'select movement_type::text, capability from merx.movement_type_capability',
    )
    return new Map(rows.map((r) => [r.movement_type, r.capability]))
  } finally {
    await client.end()
  }
}

async function movementTypesUnderTest(): Promise<string[]> {
  const client = await connect()
  try {
    const { rows } = await client.query<{ label: string }>(`
      select e.enumlabel as label
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid and t.typname = 'stock_movement_type'
      order by e.enumsortorder
    `)
    if (rows.length === 0) {
      throw new Error(
        'Aucune étiquette pour public.stock_movement_type : le balayage ne vérifierait rien.\n' +
          'Reconstruire la base : npx supabase db reset',
      )
    }
    return rows.map((r) => r.label)
  } finally {
    await client.end()
  }
}

let client: Client

/*
 * Un commerce, son dépôt unique, un produit et sa variante par défaut — qui
 * porte l'identifiant de son produit depuis E2-01. Tout est posé en `postgres`
 * dans une transaction annulée en fin de fichier.
 */
const fixture = { tenant: '', warehouse: '', spare: '', variant: '', untouched: '' }

beforeAll(async () => {
  client = await connect()
  await client.query('begin')

  const { rows: tenants } = await client.query<{ id: string }>(
    "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Stock E3-01')" +
      ' returning id',
  )
  fixture.tenant = tenants[0]!.id

  /*
   * Le dépôt n'est pas créé ici : le trigger `open_default_warehouse` l'ouvre
   * avec le commerce (E3-02). On lit le sien.
   */
  const { rows: warehouses } = await client.query<{ id: string }>(
    'select id from public.warehouse where tenant_id = $1 and is_default',
    [fixture.tenant],
  )
  fixture.warehouse = warehouses[0]!.id

  /*
   * Un second dépôt, non par défaut. Depuis E3-02 toute variante naît avec sa
   * ligne de `stock_level` sur le dépôt par défaut : la paire
   * `(variante, dépôt par défaut)` est donc **toujours** prise, et une
   * insertion à la main y est refusée par l'unicité (`23505`) avant que le
   * garde d'agrégat ait à se prononcer. La seule paire vierge d'un commerce est
   * celle d'un second dépôt — et c'est un chemin réel, `authenticated` détenant
   * INSERT sur `warehouse`. C'est par là que le garde se mesure.
   *
   * `is_default` à false : `warehouse_one_default_per_tenant` n'admet qu'un
   * dépôt par défaut vivant par commerce.
   */
  const { rows: spares } = await client.query<{ id: string }>(
    'insert into public.warehouse (tenant_id, name, is_default) values ($1, $2, false) returning id',
    [fixture.tenant, 'Dépôt annexe'],
  )
  fixture.spare = spares[0]!.id

  const { rows: products } = await client.query<{ id: string }>(
    'insert into public.product (tenant_id, name_fr) values ($1, $2) returning id',
    [fixture.tenant, 'Savon 500 g'],
  )

  const { rows: variants } = await client.query<{ id: string }>(
    'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
    [fixture.tenant, products[0]!.id],
  )
  fixture.variant = variants[0]?.id ?? ''

  /*
   * La variante par défaut porte l'identifiant de son produit depuis E2-01.
   * Sans elle, tout ce fichier mesurerait sa propre erreur de préparation : une
   * exception ici, et non une assertion, parce que c'est le harnais qui est en
   * cause, pas une propriété du schéma.
   */
  if (fixture.variant !== products[0]!.id) {
    throw new Error(
      `Aucune variante par défaut sous l'identifiant du produit ${products[0]!.id} : ` +
        'E2-01 ne tient plus, et rien de ce fichier ne prouverait quoi que ce soit.',
    )
  }

  /*
   * Une seconde variante, qui ne reçoit jamais de mouvement. Avec le dépôt
   * annexe ci-dessus, elle forme la paire vierge des cas d'insertion directe
   * dans `stock_level` — et ce n'est pas un détail.
   *
   * Sur une paire qui a déjà un niveau, une insertion à la main est refusée par
   * l'unicité `(variant_id, warehouse_id)` (`23505`), **avant** que le garde
   * d'agrégat ait à se prononcer : le premier jet de ce test passait sur le
   * refus du voisin, et le garde pouvait disparaître sans qu'il tombe
   * (CLAUDE.md, un refus qui prend le crédit d'un autre). Jusqu'à E3-02 une
   * variante sans mouvement suffisait à obtenir cette paire vierge ; depuis que
   * la ligne naît avec la variante, il faut aussi un dépôt où elle n'est pas.
   * Le cas « l'unicité refuse la paire occupée » est écrit plus bas, et il
   * assert le nom de la contrainte : les deux refus restent distinguables.
   */
  const { rows: others } = await client.query<{ id: string }>(
    'insert into public.product (tenant_id, name_fr) values ($1, $2) returning id',
    [fixture.tenant, 'Variante sans mouvement'],
  )
  fixture.untouched = others[0]!.id
})

afterAll(async () => {
  await client?.query('rollback')
  await client?.end()
})

/* -------------------------------------------------------------------------- */
/* Outillage                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Le niveau de la paire (variante, dépôt), relu **hors RLS**. Sous le jeton
 * d'un commerce, la policy rend le même résultat que la ligne existe ou non :
 * un `null` ne dirait rien (CLAUDE.md). `postgres` porte BYPASSRLS, donc ce
 * qu'il lit est ce qui est écrit.
 */
async function level(): Promise<string | null> {
  await client.query('reset role')
  const { rows } = await client.query<{ quantity: string }>(
    'select quantity from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [fixture.variant, fixture.warehouse],
  )
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} lignes de stock_level pour une seule paire : l'unicité ` +
        '(variant_id, warehouse_id) ne tient plus.',
    )
  }
  return rows[0]?.quantity ?? null
}

/**
 * `last_movement_at` de la paire, relu hors RLS comme `level()`. NULL dit
 * « aucun mouvement n'a jamais touché cette variante » — ce que l'écran lit
 * « stock non saisi » plutôt que « 0 » (SPEC § 2.5, E3-02).
 */
async function lastMovement(): Promise<string | null> {
  await client.query('reset role')
  // `to_jsonb(...)::text` plutôt que la colonne : le pilote rend un `Date`, que
  // deux assertions d'égalité stricte ne savent pas comparer. Un instant en
  // texte se compare.
  const { rows } = await client.query<{ at: string | null }>(
    'select to_char(last_movement_at at time zone $3, $4) as at' +
      ' from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [fixture.variant, fixture.warehouse, 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'],
  )
  return rows[0]?.at ?? null
}

/** La somme des mouvements de la paire — l'autre façon de calculer le niveau. */
async function movementSum(): Promise<string> {
  await client.query('reset role')
  const { rows } = await client.query<{ total: string }>(
    'select coalesce(sum(quantity), 0)::text as total from public.stock_movement' +
      ' where variant_id = $1 and warehouse_id = $2',
    [fixture.variant, fixture.warehouse],
  )
  return rows[0]!.total
}

/** Ouvre un type de mouvement, le temps du cas en cours. */
async function openType(movementType: string, capability: string): Promise<void> {
  await client.query('reset role')
  await client.query(
    'insert into merx.movement_type_capability (movement_type, capability)' +
      ' values ($1::public.stock_movement_type, $2)' +
      ' on conflict (movement_type) do update set capability = excluded.capability',
    [movementType, capability],
  )
}

/**
 * Pose un mouvement en `postgres`, triggers actifs : l'agrégat doit tourner.
 *
 * `createdAt` sert à rejouer ce que la synchronisation d'E9 produira — un
 * mouvement saisi hors ligne, arrivé après de plus récents. Laissé de côté, la
 * colonne prend son défaut, `now()`.
 *
 * Seul `require_sale_origin` est suspendu (E4-05) : un mouvement `sale` naît de
 * la confirmation d'un bon, et ce peuplement-ci produit une série de
 * quantités, pas une vente. Un `withoutTriggers()` emporterait l'agrégat que
 * ces cas mesurent (CLAUDE.md, `session_replication_role`) ; le garde, lui, est
 * mesuré dans `sale-lifecycle.test.ts`.
 */
async function postMovement(
  movementType: string,
  quantity: string,
  createdAt?: string,
): Promise<void> {
  await client.query('reset role')
  await withoutTrigger(client, 'public.stock_movement', 'require_sale_origin', async () => {
    await client.query(
      'insert into public.stock_movement' +
        ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, created_at)' +
        ' values ($1, $2, $3, $4::public.stock_movement_type, $5, coalesce($6::timestamptz, now()))',
      [
        fixture.tenant,
        fixture.variant,
        fixture.warehouse,
        movementType,
        quantity,
        createdAt ?? null,
      ],
    )
  })
}

/** L'ordre d'insertion d'un mouvement, tel qu'un rôle applicatif l'enverrait. */
function movementSql(movementType: string, quantity: string, tenant = fixture.tenant): string {
  return (
    'insert into public.stock_movement' +
    ' (tenant_id, variant_id, warehouse_id, movement_type, quantity)' +
    ` values ('${tenant}'::uuid, '${fixture.variant}'::uuid, '${fixture.warehouse}'::uuid,` +
    ` '${movementType}'::public.stock_movement_type, ${quantity})`
  )
}

/*
 * Chaque cas écrit dans la même transaction que les autres. Un point de
 * sauvegarde par cas, donc, et le rôle remis à `postgres` avant de le relâcher :
 * sans quoi l'ordre des tests déciderait de leur résultat.
 */
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

/* ========================================================================== */
/* Le critère : une série de mouvements produit le niveau attendu              */
/* ========================================================================== */

describe('la série de mouvements', () => {
  /*
   * Les cinq types sont ouverts le temps du cas, sur les capacités que leurs
   * stories leur donneront. C'est le contournement de harnais de ce fichier, et
   * il est explicite : la migration n'ouvre rien, et le cas « aucun type n'est
   * ouvert » plus bas le vérifie.
   */
  const open = async (): Promise<void> => {
    await openType('receipt', 'receive_goods')
    await openType('sale', 'create_sale')
    await openType('return', 'create_sale')
    await openType('inventory', 'approve_stock_variance')
  }

  it('produit le stock_level attendu à chaque étape, négatif compris', async () => {
    await inCase(async () => {
      await open()
      /*
       * Depuis E3-02 la ligne existe avant tout mouvement — elle naît avec la
       * variante — et c'est `last_movement_at` qui dit que rien n'a bougé.
       * Les deux sont affirmés : une ligne absente ferait disparaître la
       * variante de la liste des quantités et des deux filtres, et un
       * horodatage posé d'avance ferait lire « 0 compté » un stock que
       * personne n'a compté.
       */
      expect(await level(), 'la ligne de stock n’est pas ouverte à la naissance').toBe('0.000')
      expect(await lastMovement(), 'un stock jamais saisi porte une date').toBeNull()

      const steps = [
        { type: 'receipt', quantity: '100', expected: '100.000' },
        { type: 'sale', quantity: '-30', expected: '70.000' },
        { type: 'return', quantity: '5', expected: '75.000' },
        { type: 'sale', quantity: '-80', expected: '-5.000' },
        /*
         * Une demi-pièce vendue : les trois décimales du domaine `quantity`,
         * sur un type qui n'exige ni motif ni session. L'`adjustment` tenait ce
         * rôle avant E3-03 ; il est désormais mesuré sous jeton, avec son
         * motif et son entrée de journal, dans `stock-adjustment.test.ts`.
         */
        { type: 'sale', quantity: '-0.500', expected: '-5.500' },
        { type: 'inventory', quantity: '12.250', expected: '6.750' },
      ] as const

      for (const step of steps) {
        await postMovement(step.type, step.quantity)
        expect(await level(), `après ${step.type} ${step.quantity}`).toBe(step.expected)
      }

      /*
       * La même quantité, calculée autrement. Un trigger qui additionnerait de
       * travers — un arrondi, un signe inversé sur un type — produirait un
       * niveau cohérent avec lui-même et faux par rapport à l'historique.
       */
      expect(await movementSum(), 'le niveau n’est plus la somme des mouvements').toBe('6.750')
    })
  })

  /*
   * `last_movement_at` et la synchronisation. E3-02 — SPEC § 2.5.
   *
   * En E9 un mouvement saisi hors ligne il y a trois jours arrivera **après**
   * des mouvements plus récents : c'est la propriété qui rend l'ajout seul
   * synchronisable (RÈGLE M2-2), et c'est exactement le cas où une colonne
   * écrite avec `new.created_at` reculerait. Un écran qui annonce « dernier
   * mouvement avant-hier » alors qu'il y en a eu un ce matin se lit comme une
   * perte de données.
   *
   * Les deux mouvements sont posés dans le désordre, et la date relue : c'est
   * `greatest()` qui est mesuré, pas l'ordre d'arrivée. La quantité, elle, est
   * commutative — elle doit tenir dans les deux sens, et l'assertion le dit.
   */
  it('la date du dernier mouvement ne recule pas quand un retardataire arrive', async () => {
    await inCase(async () => {
      await open()

      const recent = '2026-10-08T09:00:00Z'
      const late = '2026-10-05T09:00:00Z'

      await postMovement('receipt', '10', recent)
      const afterRecent = await lastMovement()
      expect(afterRecent, 'aucune date après le premier mouvement').not.toBeNull()

      // Le retardataire, synchronisé après coup.
      await postMovement('sale', '-4', late)

      expect(await lastMovement(), 'la date a reculé sur un mouvement synchronisé en retard').toBe(
        afterRecent,
      )
      expect(afterRecent).toBe(recent)
      // La quantité, elle, prend bien les deux.
      expect(await level(), 'le retardataire n’a pas été additionné').toBe('6.000')
    })
  })

  it('tient les trois décimales du domaine quantity', async () => {
    await inCase(async () => {
      await open()

      for (const quantity of ['0.001', '0.002', '0.003']) {
        await postMovement('receipt', quantity)
      }

      expect(await level()).toBe('0.006')
    })
  })

  it('n’ouvre qu’une ligne de stock_level par paire (variante, dépôt)', async () => {
    await inCase(async () => {
      await open()
      await postMovement('receipt', '10')
      await postMovement('sale', '-4')

      await client.query('reset role')
      const { rows } = await client.query<{ count: string }>(
        'select count(*)::text from public.stock_level where variant_id = $1',
        [fixture.variant],
      )
      expect(rows[0]!.count).toBe('1')
    })
  })

  /*
   * L'unicité du spec § 7 M2, lue au catalogue. Elle ne se teste pas par une
   * insertion en double : personne ne peut insérer dans `stock_level`. Ce qui
   * la rend vérifiable, c'est son nom et ses colonnes — et le cas précédent,
   * qui la montre à l'œuvre.
   */
  it('porte l’unicité (variant_id, warehouse_id) du spec', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ definition: string }>(`
      select pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      where i.indrelid = 'public.stock_level'::regclass and i.indisunique
        and i.indexrelid = 'public.stock_level_variant_warehouse'::regclass
    `)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.definition).toContain('(variant_id, warehouse_id)')
  })
})

/* ========================================================================== */
/* RÈGLE M2-3 — le stock négatif est signalé, jamais refusé                   */
/* ========================================================================== */

describe('RÈGLE M2-3 — le stock négatif', () => {
  it('est accepté dès le premier mouvement', async () => {
    await inCase(async () => {
      await openType('sale', 'create_sale')

      // Le cas réel : la marchandise part du camion avant d'être entrée en
      // stock. Rien ne doit refuser, et le niveau doit le dire.
      await postMovement('sale', '-25')

      expect(await level()).toBe('-25.000')
    })
  })

  it('n’est refusé par aucune contrainte, même très en dessous de zéro', async () => {
    await inCase(async () => {
      await openType('sale', 'create_sale')
      await openType('receipt', 'receive_goods')

      await postMovement('receipt', '5')
      await postMovement('sale', '-999999.999')

      expect(await level()).toBe('-999994.999')
    })
  })
})

/* ========================================================================== */
/* RÈGLE M2-1 — `stock_level` n'est jamais écrit directement                  */
/* ========================================================================== */

describe('RÈGLE M2-1 — stock_level ne s’écrit pas à la main', () => {
  /** Un niveau existant, pour que les refus portent sur une ligne réelle. */
  const withLevel = async (body: (levelId: string) => Promise<void>): Promise<void> => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await postMovement('receipt', '40')

      await client.query('reset role')
      const { rows } = await client.query<{ id: string }>(
        'select id from public.stock_level where variant_id = $1',
        [fixture.variant],
      )
      await body(rows[0]!.id)
    })
  }

  /**
   * L'ordre d'insertion d'un niveau, tel qu'une main l'écrirait — sur la
   * variante qui n'a aucun mouvement, donc aucun niveau, pour que l'unicité
   * `(variant_id, warehouse_id)` n'ait rien à refuser à la place du garde.
   */
  const insertSql = (): string =>
    'insert into public.stock_level (tenant_id, variant_id, warehouse_id, quantity) values' +
    ` ('${fixture.tenant}'::uuid, '${fixture.untouched}'::uuid, '${fixture.spare}'::uuid, 1)`

  it('refuse l’insertion directe d’un owner', async () => {
    await withLevel(async () => {
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      const written = await attempt(client, insertSql())

      expect(written.ok, 'FUITE — un niveau a été écrit à la main').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(DERIVED_WRITE)
      expect(written.message).toContain('stock_level')
      expect(written.message).toContain('agrégat')
    })
  })

  /*
   * L'autre refus du même geste, et il faut qu'il se distingue. Sur la paire
   * **occupée** — celle que la naissance de la variante a ouverte — c'est
   * l'unicité qui parle, pas le garde. Le test l'assert par le **nom de la
   * contrainte**, jamais par le seul `23505` : deux index peuvent refuser la
   * même insertion avec le même code, et celui qu'on croit mesurer n'est pas
   * toujours celui qui a refusé (CLAUDE.md ; E2-01, E2-06).
   *
   * Sans ce cas, rien ne rappellerait que le garde d'insertion ne se mesure que
   * sur une paire vierge — et le prochain à écrire un test d'insertion directe
   * le poserait sur la paire par défaut, où il passerait sur le refus du
   * voisin.
   */
  it('sur une paire déjà ouverte, c’est l’unicité qui refuse, pas le garde', async () => {
    await withLevel(async () => {
      await client.query('reset role')

      const written = await attempt(
        client,
        'insert into public.stock_level (tenant_id, variant_id, warehouse_id, quantity) values' +
          ` ('${fixture.tenant}'::uuid, '${fixture.variant}'::uuid, '${fixture.warehouse}'::uuid, 1)`,
      )

      expect(written.ok, 'FUITE — un second niveau pour la même paire').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe('23505')
      expect(written.message).toContain('stock_level_variant_warehouse')
      // Et surtout : ce n'est pas ce refus-là qui tient la RÈGLE M2-1.
      expect(written.code).not.toBe(DERIVED_WRITE)
    })
  })

  it('refuse la modification et la suppression d’un owner, et la valeur ne bouge pas', async () => {
    await withLevel(async (levelId) => {
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      for (const [label, sql] of [
        ['modification', `update public.stock_level set quantity = 9999 where id = '${levelId}'`],
        ['suppression', `delete from public.stock_level where id = '${levelId}'`],
      ] as const) {
        const touched = await attempt(client, sql)
        expect(touched.ok, `RATURE — la ${label} a été acceptée`).toBe(false)
        if (touched.ok) continue
        expect(touched.code, `${label} : ${touched.message}`).toBe(DERIVED_WRITE)
      }

      expect(await level(), 'la valeur a changé malgré les refus').toBe('40.000')
    })
  })

  /*
   * Le même refus en `postgres`, qui porte BYPASSRLS. Si la ligne n'était tenue
   * que par une policy, ce cas-ci passerait — et le garde n'arrêterait ni la
   * synchronisation de E9, ni une fonction `security definer` écrite en E4, ni
   * une console `psql`. C'est le contrôle qui distingue un garde d'une policy.
   */
  it('refuse la même chose à postgres, que la RLS n’arrête pas', async () => {
    await withLevel(async (levelId) => {
      await client.query('reset role')

      for (const [label, sql] of [
        ['insertion', insertSql()],
        ['modification', `update public.stock_level set quantity = 9999 where id = '${levelId}'`],
        ['suppression', `delete from public.stock_level where id = '${levelId}'`],
      ] as const) {
        const touched = await attempt(client, sql)
        expect(touched.ok, `RATURE — la ${label} a été acceptée en postgres`).toBe(false)
        if (touched.ok) continue
        expect(touched.code, `${label} : ${touched.message}`).toBe(DERIVED_WRITE)
      }

      expect(await level()).toBe('40.000')
    })
  })

  /*
   * TRUNCATE, que le garde de ligne ne voit pas passer. Sa phrase est la
   * sienne : retirer l'un des deux gardes doit faire tomber son test à lui
   * seul, et le code ne suffirait pas à les distinguer.
   */
  it('refuse TRUNCATE, avec sa propre phrase', async () => {
    await withLevel(async () => {
      await client.query('reset role')

      const emptied = await attempt(client, 'truncate public.stock_level')
      expect(emptied.ok, 'RATURE — la table dérivée a été vidée').toBe(false)
      if (emptied.ok) return
      expect(emptied.code, emptied.message).toBe(DERIVED_WRITE)
      expect(emptied.message).toContain('ne se vide pas')
      expect(emptied.message).not.toContain('à la main')
    })
  })

  it('n’accorde TRUNCATE à personne d’applicatif', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ privilege_type: string }>(
      'select privilege_type from information_schema.role_table_grants' +
        " where table_schema = 'public' and table_name = 'stock_level'" +
        " and grantee = 'authenticated' and privilege_type = 'TRUNCATE'",
    )
    expect(rows).toEqual([])
  })
})

/* ========================================================================== */
/* RÈGLE M2-2 — un mouvement est immuable                                      */
/* ========================================================================== */

describe('RÈGLE M2-2 — stock_movement est en ajout seul', () => {
  const withMovement = async (body: (movementId: string) => Promise<void>): Promise<void> => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await postMovement('receipt', '40')

      await client.query('reset role')
      const { rows } = await client.query<{ id: string }>(
        'select id from public.stock_movement where variant_id = $1',
        [fixture.variant],
      )
      await body(rows[0]!.id)
    })
  }

  /*
   * Le garde que rencontre l'application : le privilège, retiré. PostgREST
   * refuse en `42501` sans atteindre la table.
   */
  it('refuse la modification et la suppression à un owner, par le privilège', async () => {
    await withMovement(async (movementId) => {
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      for (const [label, sql] of [
        ['modification', `update public.stock_movement set note = 'x' where id = '${movementId}'`],
        ['suppression', `delete from public.stock_movement where id = '${movementId}'`],
      ] as const) {
        const touched = await attempt(client, sql)
        expect(touched.ok, `RATURE — la ${label} a été acceptée`).toBe(false)
        if (touched.ok) continue
        expect(touched.code, `${label} : ${touched.message}`).toBe(INSUFFICIENT_PRIVILEGE)
      }
    })
  })

  /*
   * Et le second garde, celui qui arrête ce que le privilège ne voit pas :
   * `postgres`, la synchronisation de E9, une fonction `security definer`. Code
   * différent du premier, donc chaque test ne peut tomber que pour son garde
   * (CLAUDE.md, E1-02).
   */
  it('refuse la même chose à postgres, par le trigger, et la ligne ne bouge pas', async () => {
    await withMovement(async (movementId) => {
      await client.query('reset role')

      for (const [label, sql] of [
        ['modification', `update public.stock_movement set quantity = 1 where id = '${movementId}'`],
        ['suppression', `delete from public.stock_movement where id = '${movementId}'`],
      ] as const) {
        const touched = await attempt(client, sql)
        expect(touched.ok, `RATURE — la ${label} a été acceptée en postgres`).toBe(false)
        if (touched.ok) continue
        expect(touched.code, `${label} : ${touched.message}`).toBe(APPEND_ONLY)
        expect(touched.message).toContain('ajout seul')
      }

      await client.query('reset role')
      const { rows } = await client.query<{ quantity: string }>(
        'select quantity from public.stock_movement where id = $1',
        [movementId],
      )
      expect(rows[0]?.quantity, 'le mouvement a été raturé').toBe('40.000')
      expect(await level(), 'le niveau a suivi une rature').toBe('40.000')
    })
  })

  it('refuse TRUNCATE, avec sa propre phrase', async () => {
    await withMovement(async () => {
      await client.query('reset role')

      const emptied = await attempt(client, 'truncate public.stock_movement')
      expect(emptied.ok, 'RATURE — l’historique a été vidé').toBe(false)
      if (emptied.ok) return
      expect(emptied.code, emptied.message).toBe(APPEND_ONLY)
      expect(emptied.message).toContain('même en une fois')
    })
  })

  /*
   * La correction d'une erreur est un mouvement inverse, jamais une rature
   * (RÈGLE M2-2). C'est le contrôle positif de tout ce bloc : sans lui,
   * « modifier échoue » serait satisfait aussi bien par l'ajout seul que par
   * une table verrouillée à tout le monde.
   */
  it('laisse corriger par un mouvement inverse', async () => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      /*
       * `inventory` et non `adjustment` : la correction réelle d'un zéro de
       * trop est un ajustement, mais ce type exige depuis E3-03 un motif et une
       * session porteuse d'un auteur, que ce fichier n'a pas. Ce qui est en jeu
       * ici est l'ajout seul — qu'une erreur se corrige par un mouvement de
       * plus et non par une rature — et le type n'y change rien.
       */
      await openType('inventory', 'approve_stock_variance')

      await postMovement('receipt', '400') // un zéro de trop
      await postMovement('inventory', '-360')

      expect(await level()).toBe('40.000')

      await client.query('reset role')
      const { rows } = await client.query<{ count: string }>(
        'select count(*)::text from public.stock_movement where variant_id = $1',
        [fixture.variant],
      )
      expect(rows[0]!.count, 'l’historique ne garde pas les deux écritures').toBe('2')
    })
  })
})

/* ========================================================================== */
/* Fermé par défaut — aucun type n'est ouvert en E3-01                        */
/* ========================================================================== */

describe('l’écriture d’un mouvement est fermée par défaut', () => {
  it('ne connaît les six types du spec, et rien de plus', () => {
    // Les cinq de SPEC § 7 M2, plus `sale_cancellation` (E4-01, RÈGLE M2-5).
    expect(MOVEMENT_TYPES).toEqual([
      'sale',
      'return',
      'receipt',
      'adjustment',
      'inventory',
      'sale_cancellation',
    ])
  })

  /*
   * Un type ouvert est un écran livré, et rien d'autre. E3-03 a ouvert
   * `adjustment` ; E4-01 a ouvert `sale_cancellation`, que l'annulation d'un
   * document écrit ; E4-05 a ouvert `sale`, que la confirmation d'un bon de
   * livraison écrit — et lui non plus ne s'écrit pas à la main
   * (`merx.require_sale_origin()`). `inventory` attend E3-04, `return` E4-06,
   * `receipt` E8-02. Ce test est ce qui empêche une porte de s'ouvrir sans
   * story : il tombe aussi bien sur un type ouvert trop tôt que sur un type
   * fermé par mégarde.
   */
  it('n’ouvre que les types dont une story a livré l’écran', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ movement_type: string; capability: string }>(
      'select movement_type::text, capability from merx.movement_type_capability' +
        ' order by movement_type::text',
    )
    expect(rows).toEqual([
      { movement_type: 'adjustment', capability: 'adjust_stock' },
      { movement_type: 'sale', capability: 'create_sale' },
      { movement_type: 'sale_cancellation', capability: 'cancel_document' },
    ])
  })

  /*
   * Le cas demandé : un `owner` — le rôle le plus large après l'éditeur — ne
   * peut écrire aucun type. Le code **et** le message, parce que c'est le
   * message qui distingue ce garde-ci de la policy, et parce que c'est lui que
   * lit celui qui tombe dessus.
   */
  it.each(CLOSED_TYPES)('refuse un mouvement de type %s à un owner', async (movementType) => {
    await inCase(async () => {
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      const written = await attempt(client, movementSql(movementType, '10'))

      expect(written.ok, `FUITE — un mouvement ${movementType} a été écrit`).toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message, 'le refus ne nomme pas le type').toContain(CLOSED_BY_DEFAULT)
      expect(written.message).toContain(movementType)

      expect(await level(), 'un mouvement refusé a bougé le niveau').toBe('0.000')
      expect(await lastMovement(), 'un mouvement refusé a posé sa date').toBeNull()
    })
  })

  /* Et le `super_admin` non plus : un type que personne n'a ouvert n'est pas
   * une question de rôle. Le type est pris à la liste des types fermés, jamais
   * écrit ici — `adjustment` est ouvert depuis E3-03. */
  it('refuse aussi à super_admin', async () => {
    await inCase(async () => {
      await actAs(client, tokenFor(fixture.tenant, 'super_admin'))

      const written = await attempt(client, movementSql(CLOSED_TYPES[0]!, '10'))
      expect(written.ok, 'FUITE — l’éditeur a écrit un mouvement de type fermé').toBe(false)
      if (written.ok) return
      expect(written.message).toContain(CLOSED_BY_DEFAULT)
    })
  })
})

/* ========================================================================== */
/* La policy par type — le rôle doit détenir la capacité du type               */
/* ========================================================================== */

/*
 * Ce bloc ouvre un type, le temps du cas, pour éprouver la **policy** : une
 * fois le type ouvert, le trigger du fermé par défaut laisse passer, et c'est
 * la capacité du rôle qui décide. Sans cela la policy serait intestable
 * aujourd'hui — tout étant refusé en amont, la retirer ne changerait rien
 * d'observable (CLAUDE.md, E1-02).
 *
 * `inventory` sur `approve_stock_variance` : une capacité que le `owner`
 * détient et que le `worker` n'a pas (SPEC § 3.1). C'est la forme qu'E3-04
 * donnera à ce type, et elle sert ici de cas d'épreuve, pas de livrable — la
 * migration ne l'ouvre pas. `adjustment`, qui tenait ce rôle avant E3-03, est
 * désormais ouvert pour de bon : la même policy est mesurée sur lui, sous
 * jeton et avec son motif, dans `stock-adjustment.test.ts`.
 */
describe('la policy d’insertion exige la capacité du type', () => {
  const withOpenType = async (body: () => Promise<void>): Promise<void> => {
    await inCase(async () => {
      await openType('inventory', 'approve_stock_variance')
      await body()
    })
  }

  it('laisse écrire le rôle qui détient la capacité', async () => {
    await withOpenType(async () => {
      await actAs(client, tokenFor(fixture.tenant, 'owner'))

      const written = await attempt(client, movementSql('inventory', '-3'))
      expect(
        written.ok,
        `la policy refuse une écriture légitime : ${written.ok ? '' : `${written.code} ${written.message}`}`,
      ).toBe(true)

      expect(await level()).toBe('-3.000')
    })
  })

  it('refuse le rôle qui ne la détient pas, et par la policy, pas par le trigger', async () => {
    await withOpenType(async () => {
      await actAs(client, tokenFor(fixture.tenant, 'worker'))

      const written = await attempt(client, movementSql('inventory', '-3'))
      expect(written.ok, 'FUITE — un worker a écrit un mouvement d’inventaire').toBe(false)
      if (written.ok) return

      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      /*
       * Les deux assertions comptent autant l'une que l'autre. Le type est
       * ouvert, donc le garde du fermé par défaut n'a rien à dire : si sa
       * phrase apparaissait ici, ce test mesurerait l'autre garde et la policy
       * pourrait disparaître sans qu'il tombe.
       */
      expect(written.message, 'refusé par la RLS, pas par la policy').toContain(RLS_REFUSAL)
      expect(written.message, 'c’est le garde du fermé par défaut qui a refusé').not.toContain(
        CLOSED_BY_DEFAULT,
      )

      expect(await level(), 'un mouvement refusé a bougé le niveau').toBe('0.000')
      expect(await lastMovement(), 'un mouvement refusé a posé sa date').toBeNull()
    })
  })

  it('laisse écrire un type ouvert aux deux rôles', async () => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await actAs(client, tokenFor(fixture.tenant, 'worker'))

      const written = await attempt(client, movementSql('receipt', '12'))
      expect(
        written.ok,
        `un worker ne peut pas saisir une réception : ${written.ok ? '' : written.message}`,
      ).toBe(true)

      expect(await level()).toBe('12.000')
    })
  })
})

/* ========================================================================== */
/* Le registre type → capacité                                                 */
/* ========================================================================== */

describe('merx.movement_type_capability', () => {
  /*
   * La clé étrangère que `merx.role_capability` ne peut pas offrir : sa clé
   * primaire est `(capability, role)`, donc `capability` seule n'est pas unique
   * et ne peut pas être visée. Sans ce garde, une capacité mal orthographiée
   * verrouillerait le type en silence — `merx.can()` d'une capacité absente est
   * faux pour tout le monde, et la ligne donnerait l'illusion d'un type ouvert.
   */
  it('refuse une capacité absente de la matrice § 3.1', async () => {
    await inCase(async () => {
      await client.query('reset role')

      const written = await attempt(
        client,
        "insert into merx.movement_type_capability (movement_type, capability)" +
          " values ('inventory', 'manage_stock_adjustments')",
      )

      expect(written.ok, 'une capacité inconnue a été inscrite').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(FOREIGN_KEY_VIOLATION)
      expect(written.message).toContain('manage_stock_adjustments')
    })
  })

  it('accepte une capacité de la matrice', async () => {
    await inCase(async () => {
      // Un type encore fermé : la ligne d'`adjustment` est posée par la
      // migration d'E3-03, et la poser deux fois ne mesurerait rien.
      await openType('inventory', 'approve_stock_variance')

      await client.query('reset role')
      const { rows } = await client.query<{ capability: string }>(
        "select capability from merx.movement_type_capability where movement_type = 'inventory'",
      )
      expect(rows).toEqual([{ capability: 'approve_stock_variance' }])
    })
  })
})

/* ========================================================================== */
/* Les contraintes de la ligne de mouvement                                    */
/* ========================================================================== */

describe('la forme d’un mouvement', () => {
  it('refuse une quantité nulle', async () => {
    await inCase(async () => {
      await openType('inventory', 'approve_stock_variance')
      await client.query('reset role')

      const written = await attempt(client, movementSql('inventory', '0'))
      expect(written.ok, 'un mouvement de zéro a été accepté').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(CHECK_VIOLATION)
      expect(written.message).toContain('stock_movement_quantity_check')
    })
  })

  /*
   * `source_type` et `source_id` vont par deux : un identifiant sans type ne se
   * résout nulle part, et un type sans identifiant ne désigne rien. Le nom de
   * la contrainte est asserté, pas seulement le code — deux `check` refusent de
   * la même façon, et celui qu'on croit mesurer n'est pas toujours celui qui a
   * refusé (CLAUDE.md, E2-01).
   */
  it.each([
    ['un type sans identifiant', "'sale_document'::public.stock_source_type, null"],
    ['un identifiant sans type', 'null, gen_random_uuid()'],
  ])('refuse %s', async (_label, pair) => {
    await inCase(async () => {
      await openType('sale', 'create_sale')
      await client.query('reset role')

      const written = await attempt(
        client,
        'insert into public.stock_movement (tenant_id, variant_id, warehouse_id,' +
          ' movement_type, quantity, source_type, source_id) values' +
          ` ('${fixture.tenant}'::uuid, '${fixture.variant}'::uuid,` +
          ` '${fixture.warehouse}'::uuid, 'sale', -1, ${pair})`,
      )

      expect(written.ok, 'un couple source incomplet a été accepté').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(CHECK_VIOLATION)
      expect(written.message).toContain('stock_movement_source_complete')
    })
  })

  it('accepte un couple source complet', async () => {
    await inCase(async () => {
      await openType('sale', 'create_sale')
      await client.query('reset role')

      // `require_sale_origin` (E4-05) refuserait cette insertion directe : ce
      // cas-ci mesure la contrainte de forme du couple source, pas l'origine.
      const written = await withoutTrigger(
        client,
        'public.stock_movement',
        'require_sale_origin',
        async () =>
          await attempt(
            client,
            'insert into public.stock_movement (tenant_id, variant_id, warehouse_id,' +
              ' movement_type, quantity, source_type, source_id) values' +
              ` ('${fixture.tenant}'::uuid, '${fixture.variant}'::uuid,` +
              ` '${fixture.warehouse}'::uuid, 'sale', -1, 'sale_document', gen_random_uuid())`,
          ),
      )

      expect(written.ok, written.ok ? '' : written.message).toBe(true)
      expect(await level()).toBe('-1.000')
    })
  })
})
