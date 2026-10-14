// @vitest-environment node

/*
 * E3-03 — l'ajustement manuel.
 * SPEC § 2.6 (charge de saisie), § 3.1 (matrice), § 7 M2 (RÈGLES M2-1, M2-5),
 * § 9 (RÈGLES M8-1, M8-2).
 *
 * La première story qui ouvre un type de mouvement. Quatre propriétés, et
 * chacune son garde — aucun ne refuse comme un autre, sans quoi le test de
 * l'un passerait sur le refus du voisin (CLAUDE.md ; E1-01, E1-02, E2-01) :
 *
 *   — **le type est ouvert, et lui seul.** `adjustment` sur `adjust_stock`, au
 *     registre `merx.movement_type_capability`. Les quatre autres restent
 *     fermés, et c'est `stock-movements.test.ts` qui le balaie ;
 *
 *   — **réservé au patron.** La policy `column_capability_insert` répond pour
 *     le rôle, avec la phrase de la RLS, qui la nomme. Le garde du fermé par
 *     défaut n'a rien à dire sur un type ouvert : son apparition dans le
 *     message serait la preuve que ce test mesure l'autre garde ;
 *
 *   — **le motif est obligatoire.** `stock_movement_adjustment_reason`, en
 *     `23514`, et le nom de la contrainte est asserté : deux `check` refusent
 *     de la même façon, et celui qu'on croit mesurer n'est pas toujours celui
 *     qui a refusé (CLAUDE.md, E2-01). § 2.6 ne s'y applique pas — le motif
 *     n'est pas un accessoire de l'ajustement, il en est le contenu ;
 *
 *   — **tracé.** Une entrée `audit_log` par ajustement, sous l'étiquette
 *     `stock_adjustment` (RÈGLE M8-1), et **aucune** pour un autre type : la
 *     condition de ligne du trigger est éprouvée dans les deux sens. L'entrée
 *     est relue hors RLS, parce que sous le jeton d'un employé la policy
 *     rendrait zéro ligne que l'entrée existe ou non.
 *
 * Tout est posé en `postgres` dans une transaction annulée en fin de fichier.
 * Les deux comptes d'authentification, eux, vivent hors transaction — la clé
 * étrangère d'`app_user.auth_user_id` les exige réellement présents — et sont
 * supprimés au démontage.
 *
 * Pourquoi des comptes réels ici alors que `stock-movements.test.ts` s'en
 * passe : l'insertion d'un ajustement journalise, et `merx.log_audit()` prend
 * son auteur du jeton. Un jeton sans `sub`, ou un `sub` sans fiche `app_user`,
 * est refusé — c'est la RÈGLE M8-1 et le dernier cas de ce fichier.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client, type QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'stock-e3-03-password'

/** Une contrainte `check` violée. */
const CHECK_VIOLATION = '23514'
/** Le corollaire de `user_id NOT NULL` : aucun auteur à inscrire (E1-04). */
const NO_AUTHOR = '23502'

/** La contrainte du motif, nommée : c'est elle qu'on mesure, pas une voisine. */
const REASON_CONSTRAINT = 'stock_movement_adjustment_reason'

/** Ce que la policy, et elle seule, répond. Postgres la nomme. */
const RLS_REFUSAL = 'row-level security policy "column_capability_insert"'

/** Ce que le garde du fermé par défaut, et lui seul, répond. */
const CLOSED_BY_DEFAULT = 'Aucune capacité n\'ouvre les mouvements de type'

/** Ce que `merx.log_audit()` répond à une écriture hors session. */
const NO_TENANT = 'Aucun commerce rattaché à ce compte'

const emails = {
  owner: `patron.ajust.${Date.now()}@merx.test`,
  worker: `employe.ajust.${Date.now()}@merx.test`,
}

let client: Client

const authUsers: Record<'owner' | 'worker', string> = { owner: '', worker: '' }

const fixture = {
  tenant: '',
  warehouse: '',
  variant: '',
  /** Les fiches `app_user`, dont l'identifiant signe les entrées de journal. */
  appUsers: { owner: '', worker: '' } as Record<'owner' | 'worker', string>,
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

beforeAll(async () => {
  for (const role of ['owner', 'worker'] as const) {
    authUsers[role] = await createAuthUser(emails[role], PASSWORD)
  }

  client = await connect()
  await client.query('begin')

  fixture.tenant = (
    await one<{ id: string }>(
      "insert into public.tenant (tenant_id, business_name) values (gen_random_uuid(), 'Ajustement E3-03')" +
        ' returning id',
    )
  ).id

  // Le dépôt naît avec le commerce depuis E3-02 : on lit le sien (SPEC § 2.4).
  fixture.warehouse = (
    await one<{ id: string }>('select id from public.warehouse where tenant_id = $1 and is_default', [
      fixture.tenant,
    ])
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

  const product = await one<{ id: string }>(
    "insert into public.product (tenant_id, name_fr) values ($1, 'Crème hydratante') returning id",
    [fixture.tenant],
  )

  // La variante par défaut porte l'identifiant de son produit depuis E2-01.
  fixture.variant = (
    await one<{ id: string }>(
      'select id from public.variant where tenant_id = $1 and product_id = $2 and is_default',
      [fixture.tenant, product.id],
    )
  ).id
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

/**
 * L'ordre d'insertion d'un mouvement, tel que l'écran l'envoie : ni `tenant_id`
 * — il a pour défaut le commerce du jeton (SPEC § 4) — ni `created_by`, qui a
 * pour défaut la fiche de l'appelant depuis E3-03. La charge est complète par
 * ailleurs, pour qu'un refus ne puisse venir que du garde mesuré (CLAUDE.md,
 * gardes RLS en écriture).
 */
function movementSql(
  movementType: string,
  quantity: string,
  note: string | null = 'inventaire de l’étagère',
): string {
  return (
    'insert into public.stock_movement (variant_id, warehouse_id, movement_type, quantity, note)' +
    ` values ('${fixture.variant}'::uuid, '${fixture.warehouse}'::uuid,` +
    ` '${movementType}'::public.stock_movement_type, ${quantity},` +
    ` ${note === null ? 'null' : `'${note}'`})`
  )
}

/** Le niveau de la paire (variante, dépôt), relu hors RLS. */
async function level(): Promise<string | null> {
  await client.query('reset role')
  const { rows } = await client.query<{ quantity: string }>(
    'select quantity from public.stock_level where variant_id = $1 and warehouse_id = $2',
    [fixture.variant, fixture.warehouse],
  )
  return rows[0]?.quantity ?? null
}

/** Les mouvements de la variante, relus hors RLS. */
async function movements(): Promise<
  Array<{ movement_type: string; quantity: string; note: string | null; created_by: string | null }>
> {
  await client.query('reset role')
  const { rows } = await client.query<{
    movement_type: string
    quantity: string
    note: string | null
    created_by: string | null
  }>(
    'select movement_type::text, quantity::text, note, created_by from public.stock_movement' +
      ' where variant_id = $1 order by created_at',
    [fixture.variant],
  )
  return rows
}

/**
 * Les entrées de journal du commerce, relues **hors RLS**.
 *
 * `audit_log` porte une policy restrictive qui exige `view_audit_log` : sous le
 * jeton de l'employé elle rendrait zéro ligne que l'entrée existe ou non, et un
 * « zéro » ne dirait rien (CLAUDE.md).
 */
async function auditEntries(): Promise<
  Array<{
    action: string
    entity_type: string
    entity_id: string
    user_id: string
    before: unknown
    after: unknown
  }>
> {
  await client.query('reset role')
  /*
   * La quantité est relue en **texte**, `->>` et non `->` : le pilote rend un
   * nombre JSON comme un flottant JavaScript, et « -3.500 » reviendrait en
   * `-3.5`. La valeur en base est exacte — `jsonb` stocke un `numeric` tel quel
   * — mais une assertion qui passe par un flottant ne peut pas le dire, et
   * c'est le seul endroit du projet où un flottant pourrait se glisser sans
   * qu'on le voie (SPEC § 4, jamais de flottant). Même procédé qu'en E2-03 pour
   * `cost_price`.
   */
  const state = (column: 'before' | 'after'): string =>
    `case when "${column}" is null then null else jsonb_build_object(
       'variant_id', "${column}" ->> 'variant_id',
       'quantity',   "${column}" ->> 'quantity',
       'note',       "${column}" ->> 'note') end`

  const { rows } = await client.query<{
    action: string
    entity_type: string
    entity_id: string
    user_id: string
    before: unknown
    after: unknown
  }>(
    `select action::text as action, entity_type, entity_id, user_id,
            ${state('before')} as before, ${state('after')} as after
     from public.audit_log where tenant_id = $1 order by created_at`,
    [fixture.tenant],
  )
  return rows
}

/**
 * Un cas, dans son point de sauvegarde, rôle remis avant de le relâcher : sans
 * quoi l'ordre des tests déciderait de leur résultat.
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

/** Ouvre un type de mouvement le temps du cas. */
async function openType(movementType: string, capability: string): Promise<void> {
  await client.query('reset role')
  await client.query(
    'insert into merx.movement_type_capability (movement_type, capability)' +
      ' values ($1::public.stock_movement_type, $2)' +
      ' on conflict (movement_type) do update set capability = excluded.capability',
    [movementType, capability],
  )
}

/* ========================================================================== */
/* Le type ouvert, et la capacité qui l'ouvre                                  */
/* ========================================================================== */

describe('la capacité adjust_stock', () => {
  it('ouvre le type adjustment, et figure à la matrice § 3.1 pour le owner seul', async () => {
    await client.query('reset role')

    const registry = await one<{ capability: string }>(
      "select capability from merx.movement_type_capability where movement_type = 'adjustment'",
    )
    expect(registry.capability).toBe('adjust_stock')

    const { rows } = await client.query<{ role: string }>(
      "select role::text from merx.role_capability where capability = 'adjust_stock' order by role::text",
    )
    expect(
      rows.map((r) => r.role),
      'adjust_stock n’est pas la capacité du patron seul',
    ).toEqual(['owner'])
  })

  /*
   * Le contrôle positif du helper : `merx.can()` est le seul point de
   * vérification des droits (SPEC § 3), et c'est par lui que la policy passe.
   * Sans ce cas, « le worker est refusé » serait satisfait par une capacité que
   * personne ne détient.
   */
  it('est détenue par le patron et refusée à l’employé, lue par merx.can()', async () => {
    await inCase(async () => {
      await asApplication('owner')
      expect((await one<{ can: boolean }>("select merx.can('adjust_stock') as can")).can).toBe(true)
    })

    await inCase(async () => {
      await asApplication('worker')
      expect((await one<{ can: boolean }>("select merx.can('adjust_stock') as can")).can).toBe(false)
    })
  })
})

/* ========================================================================== */
/* Le critère : une quantité corrigée produit un mouvement de la différence    */
/* ========================================================================== */

describe('l’ajustement d’un patron', () => {
  it('écrit le mouvement et déplace le niveau de la différence', async () => {
    await inCase(async () => {
      await asApplication('owner')

      // Le stock lu à l'écran vaut 0 : corriger à 12 est un ajustement de +12.
      const written = await attempt(client, movementSql('adjustment', '12'))
      expect(
        written.ok,
        `un ajustement légitime est refusé : ${written.ok ? '' : `${written.code} ${written.message}`}`,
      ).toBe(true)

      expect(await level(), 'le niveau n’a pas suivi l’ajustement').toBe('12.000')

      const [movement, ...rest] = await movements()
      expect(rest, 'plus d’un mouvement pour un ajustement').toHaveLength(0)
      expect(movement?.movement_type).toBe('adjustment')
      expect(movement?.quantity).toBe('12.000')
      expect(movement?.note).toBe('inventaire de l’étagère')
      /*
       * L'auteur vient du défaut, donc du jeton : l'écran ne l'envoie pas — le
       * jeton ne porte pas l'identifiant `app_user` — et l'historique d'E3-02
       * afficherait « Auteur inconnu » sans lui.
       */
      expect(movement?.created_by, 'le mouvement n’est pas signé').toBe(fixture.appUsers.owner)
    })
  })

  /*
   * Une correction à la baisse, en trois décimales, qui passe sous zéro :
   * RÈGLE M2-3, le stock négatif est accepté, signalé à l'écran, jamais refusé
   * en base. Et RÈGLE M2-2 — la première correction ne se rature pas, la
   * seconde s'y ajoute.
   */
  it('accepte une différence négative, trois décimales comprises, sous zéro', async () => {
    await inCase(async () => {
      await asApplication('owner')

      await client.query(movementSql('adjustment', '2.500', 'retour fournisseur'))
      await client.query(movementSql('adjustment', '-4.750', 'casse en rayon'))

      expect(await level(), 'le niveau n’est pas la somme des deux ajustements').toBe('-2.250')
      expect(await movements(), 'une correction a raturé la précédente').toHaveLength(2)
    })
  })
})

/* ========================================================================== */
/* Réservé au patron — la policy, et pas le garde du fermé par défaut          */
/* ========================================================================== */

describe('l’ajustement est réservé au patron', () => {
  it('refuse l’employé par la policy, et aucune ligne n’entre', async () => {
    await inCase(async () => {
      await asApplication('worker')

      const written = await attempt(client, movementSql('adjustment', '-1000'))
      expect(written.ok, 'FUITE — un employé a posé un ajustement').toBe(false)
      if (written.ok) return

      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      /*
       * Les deux assertions comptent autant l'une que l'autre. Le type est
       * ouvert, donc le garde du fermé par défaut n'a rien à dire : si sa
       * phrase apparaissait ici, ce test mesurerait l'autre garde, et la policy
       * pourrait disparaître sans qu'il tombe (CLAUDE.md, E1-02).
       */
      expect(written.message, 'refusé par la RLS, mais pas par cette policy').toContain(RLS_REFUSAL)
      expect(
        written.message,
        'c’est le garde du fermé par défaut qui a refusé, pas la policy',
      ).not.toContain(CLOSED_BY_DEFAULT)

      expect(await level(), 'un ajustement refusé a bougé le niveau').toBe('0.000')
      expect(await movements(), 'un ajustement refusé a laissé une ligne').toHaveLength(0)
      expect(await auditEntries(), 'un ajustement refusé a écrit au journal').toHaveLength(0)
    })
  })
})

/* ========================================================================== */
/* Le motif, obligatoire                                                       */
/* ========================================================================== */

describe('le motif d’un ajustement', () => {
  it.each([
    ['absent', null],
    ['vide', ''],
    ['en blancs', '   '],
  ])('est refusé %s, par sa contrainte nommée', async (_label, note) => {
    await inCase(async () => {
      await asApplication('owner')

      const written = await attempt(client, movementSql('adjustment', '12', note))
      expect(written.ok, 'FUITE — un ajustement sans motif est entré en base').toBe(false)
      if (written.ok) return

      expect(written.code, written.message).toBe(CHECK_VIOLATION)
      expect(written.message, 'une autre contrainte a refusé à sa place').toContain(
        REASON_CONSTRAINT,
      )

      expect(await movements(), 'un ajustement refusé a laissé une ligne').toHaveLength(0)
    })
  })

  /*
   * Et sur aucun autre type : une vente, une réception, un inventaire sont
   * justifiés par leur document. Sans ce cas, une contrainte posée sur tous les
   * types passerait les trois précédents.
   */
  it('n’est pas réclamé aux autres types', async () => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await asApplication('worker')

      const written = await attempt(client, movementSql('receipt', '100', null))
      expect(
        written.ok,
        `une réception sans motif est refusée : ${written.ok ? '' : written.message}`,
      ).toBe(true)
    })
  })
})

/* ========================================================================== */
/* La trace — RÈGLE M8-1                                                       */
/* ========================================================================== */

describe('la trace au journal', () => {
  it('écrit une entrée stock_adjustment par ajustement, signée par le jeton', async () => {
    await inCase(async () => {
      await asApplication('owner')
      await client.query(movementSql('adjustment', '-3.500', 'casse en rayon'))

      const [entry, ...rest] = await auditEntries()
      expect(rest, 'plus d’une entrée pour un ajustement').toHaveLength(0)
      expect(entry?.action, 'l’ajustement n’est pas tracé').toBe('stock_adjustment')
      expect(entry?.entity_type).toBe('stock_movement')

      const [movement] = await client
        .query<{ id: string }>('select id from public.stock_movement where variant_id = $1', [
          fixture.variant,
        ])
        .then((r) => r.rows)
      expect(entry?.entity_id, 'l’entrée ne vise pas le mouvement').toBe(movement?.id)

      /*
       * L'auteur vient du jeton signé, jamais des paramètres (RÈGLE M8-2) :
       * c'est ce qui fait qu'un ajustement ne peut pas être mis sur le compte
       * d'un autre, même en forçant `created_by`.
       */
      expect(entry?.user_id).toBe(fixture.appUsers.owner)

      // Création : rien avant, et après, les trois colonnes déclarées.
      expect(entry?.before).toBeNull()
      expect(entry?.after).toEqual({
        variant_id: fixture.variant,
        quantity: '-3.500',
        note: 'casse en rayon',
      })
    })
  })

  /*
   * L'autre sens de la condition de ligne. Sans ce cas, un trigger posé sans
   * `when` passerait le précédent et journaliserait chaque vente — M8-1 ne le
   * demande pas, et le journal d'un commerce qui vend trois cents lignes par
   * jour ne se relirait plus.
   */
  it('ne journalise aucun autre type de mouvement', async () => {
    await inCase(async () => {
      await openType('receipt', 'receive_goods')
      await asApplication('worker')

      await client.query(movementSql('receipt', '100', null))

      expect(await level(), 'la réception n’a pas été écrite').toBe('100.000')
      expect(await auditEntries(), 'une réception a été journalisée').toHaveLength(0)
    })
  })

  /*
   * Hors session, une écriture journalisée est refusée (RÈGLE M8-1) — et donc
   * l'ajustement avec. `postgres` porte BYPASSRLS : ni la policy ni le garde du
   * fermé par défaut ne l'arrêtent, et c'est précisément pourquoi ce cas-ci
   * mesure autre chose que les précédents. Un ajustement sans auteur n'entre
   * pas en base.
   */
  it('refuse un ajustement posé hors session, jusqu’à postgres', async () => {
    await inCase(async () => {
      await client.query('reset role')

      const written = await attempt(
        client,
        'insert into public.stock_movement' +
          ' (tenant_id, variant_id, warehouse_id, movement_type, quantity, note)' +
          ` values ('${fixture.tenant}'::uuid, '${fixture.variant}'::uuid,` +
          ` '${fixture.warehouse}'::uuid, 'adjustment'::public.stock_movement_type, 5,` +
          " 'sans jeton')",
      )

      expect(written.ok, 'FUITE — un ajustement anonyme est entré en base').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(INSUFFICIENT_PRIVILEGE)
      expect(written.message).toContain(NO_TENANT)

      expect(await movements(), 'un ajustement refusé a laissé une ligne').toHaveLength(0)
      expect(await level(), 'un ajustement refusé a bougé le niveau').toBe('0.000')
    })
  })

  /*
   * La variante du cas précédent où le commerce est connu mais la fiche
   * absente : le code diffère, et c'est ce qui permet de dire lequel des deux
   * gardes de `merx.log_audit()` a refusé (E1-04).
   */
  it('refuse un ajustement dont le jeton n’a pas de fiche utilisateur', async () => {
    await inCase(async () => {
      await client.query('reset role')
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({
          sub: '00000000-0000-0000-0000-000000000000',
          role: 'authenticated',
          app_metadata: { tenant_id: fixture.tenant, role: 'owner' },
        }),
      ])

      const written = await attempt(client, movementSql('adjustment', '5', 'sans fiche'))
      expect(written.ok, 'FUITE — un ajustement sans auteur est entré en base').toBe(false)
      if (written.ok) return
      expect(written.code, written.message).toBe(NO_AUTHOR)

      expect(await movements(), 'un ajustement refusé a laissé une ligne').toHaveLength(0)
    })
  })
})
