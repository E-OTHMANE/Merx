// @vitest-environment node

/*
 * E1-04 — le journal d'audit : un seul chemin d'écriture, aucune rature.
 * SPEC § 9 M8, RÈGLE M8-1 ; § 3, § 3.1 ; docs/BACKLOG.md E1-04.
 *
 * Aucune des six actions de la RÈGLE M8-1 n'existe encore — elles arrivent avec
 * leurs modules (E4, E6, E8, E9). Ce fichier ne les attend donc pas : il éprouve
 * ce qui est vrai aujourd'hui et qui devra le rester quand elles arriveront —
 * le helper, ses refus, l'ajout seul, et le fait que le journal ne se lise pas
 * sans `view_audit_log`.
 *
 * Tout passe par une session Postgres directe, en transaction annulée, comme
 * `isolation.test.ts`. Ce n'est pas un raccourci : `set local role
 * authenticated` place la session dans l'état exact d'une requête PostgREST —
 * mêmes privilèges, mêmes policies, mêmes claims. Et c'est le seul moyen
 * praticable ici : une ligne de journal validée par une requête HTTP ne peut
 * plus être retirée — c'est ce que « ajout seul » veut dire — et laisserait
 * derrière elle un commerce que les tests suivants ne pourraient plus nettoyer.
 *
 * Un garde, un test, un code asserté. Les trois gardes de l'ajout seul rendent
 * des réponses distinctes, et chaque test dit laquelle il attend :
 *
 *   privilège retiré      42501, rencontré par l'application ;
 *   trigger de ligne      2F004 « ne se modifie ni ne se supprime » ;
 *   trigger d'instruction 2F004 « ne se vide pas », sur un chemin que le
 *                         trigger de ligne ne voit pas.
 */

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { INSUFFICIENT_PRIVILEGE, attempt } from './isolation'
import { createAuthUser, deleteAuthUser } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/** SQLSTATE des deux gardes d'ajout seul — *modifying_sql_data_not_permitted*. */
const APPEND_ONLY = '2F004'
/** SQLSTATE d'un enum qui refuse une étiquette inconnue. */
const INVALID_TEXT_REPRESENTATION = '22P02'
/** SQLSTATE du corollaire de `user_id NOT NULL` : aucun auteur à inscrire. */
const NO_AUTHOR = '23502'

/**
 * Les sept actions de la RÈGLE M8-1, dans l'ordre où le spec les énumère.
 *
 * Six en E1-04 ; `stock_adjustment` ajoutée en E3-03, en queue d'enum comme
 * `alter type ... add value` la pose.
 */
const M8_1_ACTIONS = [
  'price_override',
  'document_cancellation',
  'credit_limit_override',
  'stock_variance_approval',
  'role_change',
  'purchase_price_change',
  'stock_adjustment',
] as const

let client: Client

/*
 * `app_user.auth_user_id` porte une clé étrangère sur `auth.users` : les deux
 * comptes d'authentification sont donc créés pour de bon, par l'API Admin, et
 * vivent hors de la transaction — comme dans l'application, où le compte
 * précède la fiche. Le reste (commerce, fiches, lignes de journal) naît et
 * meurt dans la transaction de chaque test.
 */
const AUTH: { owner: string; worker: string } = { owner: '', worker: '' }

/* Le commerce d'essai et ses deux comptes, recréés à chaque test. */
interface Fixture {
  tenant: string
  owner: { appUser: string; authUser: string }
  worker: { appUser: string; authUser: string }
}

let fixture: Fixture

beforeAll(async () => {
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

  const stamp = Date.now()
  AUTH.owner = await createAuthUser(`journal-patron-${stamp}@merx.test`, 'motdepasse-essai')
  AUTH.worker = await createAuthUser(`journal-vendeur-${stamp}@merx.test`, 'motdepasse-essai')
})

afterAll(async () => {
  await client?.end()
  if (AUTH.owner !== '') await deleteAuthUser(AUTH.owner)
  if (AUTH.worker !== '') await deleteAuthUser(AUTH.worker)
})

beforeEach(async () => {
  await client.query('begin')
  fixture = await seed()
})

afterEach(async () => {
  await client.query('rollback')
})

async function seed(): Promise<Fixture> {
  const { rows } = await client.query<{
    tenant: string
    owner_app: string
    owner_auth: string
    worker_app: string
    worker_auth: string
  }>(`
    with t as (
      insert into public.tenant (tenant_id, business_name)
      values (gen_random_uuid(), 'Journal — commerce d''essai')
      returning id
    ),
    o as (
      insert into public.app_user (tenant_id, full_name, role, auth_user_id)
      select t.id, 'Patron', 'owner', $1::uuid from t
      returning id, tenant_id, auth_user_id
    ),
    w as (
      insert into public.app_user (tenant_id, full_name, role, auth_user_id)
      select t.id, 'Vendeur', 'worker', $2::uuid from t
      returning id, auth_user_id
    )
    select o.tenant_id as tenant,
           o.id as owner_app, o.auth_user_id as owner_auth,
           w.id as worker_app, w.auth_user_id as worker_auth
    from o, w
  `,
    [AUTH.owner, AUTH.worker],
  )

  const row = rows[0]
  if (row === undefined) throw new Error('Commerce d\'essai non créé.')

  return {
    tenant: row.tenant,
    owner: { appUser: row.owner_app, authUser: row.owner_auth },
    worker: { appUser: row.worker_app, authUser: row.worker_auth },
  }
}

/* -------------------------------------------------------------------------- */
/* Deux façons d'être quelqu'un                                                */
/* -------------------------------------------------------------------------- */

function claimsFor(tenant: string | null, role: string, authUser: string | null): string {
  return JSON.stringify({
    ...(authUser === null ? {} : { sub: authUser }),
    role: 'authenticated',
    app_metadata: { ...(tenant === null ? {} : { tenant_id: tenant }), role },
  })
}

/**
 * L'état dans lequel `merx.log_audit()` sera réellement appelée : depuis une
 * fonction `security definer` de `public`, donc sous le propriétaire, avec les
 * claims de l'appelant posés. Le rôle Postgres ne bascule pas — c'est
 * exactement ce qui distingue ce contexte du suivant.
 */
async function asDefinerFor(who: { authUser: string }, role = 'owner'): Promise<void> {
  await client.query('reset role')
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    claimsFor(fixture.tenant, role, who.authUser),
  ])
}

/** L'état d'une requête PostgREST : claims posés, puis rôle `authenticated`. */
async function asApplication(who: { authUser: string }, role: string): Promise<void> {
  await client.query('reset role')
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    claimsFor(fixture.tenant, role, who.authUser),
  ])
  await client.query('set local role authenticated')
}

/** Une ligne de journal écrite par le seul chemin qui existe. */
async function logged(action = 'price_override', entity = 'variant'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `select merx.log_audit($1::public.audit_action, $2, gen_random_uuid(),
                           '{"unit_price": "10.00"}'::jsonb,
                           '{"unit_price": "8.00"}'::jsonb) as id`,
    [action, entity],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('Le helper n\'a rien rendu.')
  return id
}

/*
 * Les lignes du commerce d'essai, jamais celles de la table entière : une ligne
 * en ajout seul survit à son test — c'est la propriété même — et un fichier
 * voisin qui en laisse une derrière lui fausserait tous les comptes d'ici. Le
 * test mesurerait alors le désordre des autres.
 */
async function countRows(): Promise<number> {
  await client.query('reset role')
  const { rows } = await client.query<{ n: string }>(
    'select count(*)::text as n from public.audit_log where tenant_id = $1',
    [fixture.tenant],
  )
  return Number(rows[0]?.n ?? '0')
}

/* ========================================================================== */
/* La liste de la RÈGLE M8-1                                                   */
/* ========================================================================== */

/*
 * La RÈGLE M8-1 est une liste fermée et arbitrée ; le type la porte. Ce test
 * est ce qui empêche la liste de perdre une entrée entre aujourd'hui et E8 :
 * personne ne relira le spec le jour où il ajoutera une étiquette, mais tout le
 * monde verra un test rouge.
 */
describe('les sept actions de la RÈGLE M8-1', () => {
  it('sont exactement les étiquettes de public.audit_action', async () => {
    const { rows } = await client.query<{ label: string }>(`
      select e.enumlabel as label
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      where t.typname = 'audit_action'
      order by e.enumsortorder
    `)

    expect(rows.map((r) => r.label)).toEqual([...M8_1_ACTIONS])
  })
})

/* ========================================================================== */
/* Le helper unique                                                            */
/* ========================================================================== */

describe('merx.log_audit — le seul chemin d\'écriture', () => {
  it('écrit une ligne, signée par le jeton', async () => {
    await asDefinerFor(fixture.owner)
    const id = await logged('price_override', 'sale_line')

    await client.query('reset role')
    const { rows } = await client.query<{
      tenant_id: string
      user_id: string
      created_by: string
      action: string
      entity_type: string
      before: unknown
      after: unknown
    }>(
      `select tenant_id, user_id, created_by, action::text, entity_type, "before", "after"
       from public.audit_log where id = $1`,
      [id],
    )

    expect(rows[0]).toMatchObject({
      tenant_id: fixture.tenant,
      user_id: fixture.owner.appUser,
      created_by: fixture.owner.appUser,
      action: 'price_override',
      entity_type: 'sale_line',
      before: { unit_price: '10.00' },
      after: { unit_price: '8.00' },
    })
  })

  /*
   * Le commerce et l'auteur ne sont pas des paramètres : ils viennent du jeton
   * signé (SPEC § 2.1). Un appelant ne peut donc ni signer au nom d'un autre,
   * ni déposer la ligne chez le voisin — c'est le point qui fait qu'on peut
   * croire le journal quand on le lit.
   */
  it('signe avec l\'employé quand c\'est l\'employé qui agit', async () => {
    await asDefinerFor(fixture.worker, 'worker')
    const id = await logged()

    await client.query('reset role')
    const { rows } = await client.query<{ user_id: string }>(
      'select user_id from public.audit_log where id = $1',
      [id],
    )
    expect(rows[0]?.user_id).toBe(fixture.worker.appUser)
  })

  it('refuse une action que la RÈGLE M8-1 ne nomme pas', async () => {
    await asDefinerFor(fixture.owner)

    const written = await attempt(
      client,
      `select merx.log_audit('shoplifting'::public.audit_action, 'variant', gen_random_uuid())`,
    )

    expect(written.ok, 'une action hors liste a été journalisée').toBe(false)
    if (written.ok) return
    expect(written.code).toBe(INVALID_TEXT_REPRESENTATION)
    expect(await countRows()).toBe(0)
  })

  it('refuse un compte sans commerce', async () => {
    await client.query('reset role')
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      claimsFor(null, 'owner', fixture.owner.authUser),
    ])

    const written = await attempt(
      client,
      `select merx.log_audit('role_change'::public.audit_action, 'app_user', gen_random_uuid())`,
    )

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(await countRows()).toBe(0)
  })

  /*
   * Le corollaire assumé de `user_id NOT NULL` (migration E1-04) : un compte
   * sans fiche `app_user` — l'éditeur, typiquement — ne déclenche pas une
   * action auditée. Mieux vaut un refus lisible qu'une ligne sans auteur, sur
   * un journal dont c'est la seule question.
   */
  it('refuse un compte sans fiche app_user, avec son propre code', async () => {
    await client.query('reset role')
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      claimsFor(fixture.tenant, 'super_admin', '00000000-0000-4000-8000-000000000000'),
    ])

    const written = await attempt(
      client,
      `select merx.log_audit('role_change'::public.audit_action, 'app_user', gen_random_uuid())`,
    )

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code, 'refusé, mais pas pour l\'absence d\'auteur').toBe(NO_AUTHOR)
    expect(await countRows()).toBe(0)
  })

  it('refuse une action sans entité visée', async () => {
    await asDefinerFor(fixture.owner)

    const written = await attempt(
      client,
      `select merx.log_audit('price_override'::public.audit_action, '  ', gen_random_uuid())`,
    )

    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.code).toBe('23514')
    expect(await countRows()).toBe(0)
  })

  /*
   * Le cœur de « un helper unique ». Si l'application pouvait l'appeler, un
   * employé fabriquerait des lignes — un forçage de prix qu'il n'a pas fait,
   * une annulation attribuée au patron. Le journal ne vaut que si ses lignes
   * ne peuvent naître que d'une action réelle.
   */
  it('n\'est pas exécutable par l\'application', async () => {
    await asApplication(fixture.owner, 'owner')

    const called = await attempt(
      client,
      `select merx.log_audit('price_override'::public.audit_action, 'variant', gen_random_uuid())`,
    )

    expect(called.ok, 'FUITE — l\'application forge ses propres lignes de journal').toBe(false)
    if (called.ok) return
    expect(called.code).toBe(INSUFFICIENT_PRIVILEGE)
  })

  it('n\'est pas non plus une route PostgREST', async () => {
    const { rows } = await client.query<{ nspname: string }>(`
      select n.nspname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'log_audit'
    `)

    /* `merx` n'est pas exposé par PostgREST (SPEC § 4, placement des schémas). */
    expect(rows.map((r) => r.nspname)).toEqual(['merx'])
  })
})

/* ========================================================================== */
/* L'ajout seul — trois gardes, trois réponses                                 */
/* ========================================================================== */

describe('audit_log est en ajout seul', () => {
  /*
   * Garde 1 — le privilège. C'est celui que l'application rencontre : PostgREST
   * refuse en 42501 sans atteindre la table, donc sans réveiller le trigger.
   *
   * Le test le distingue du garde 2 par le code. Si le `revoke` disparaissait,
   * la requête irait jusqu'au trigger, qui répondrait 2F004 : la ligne resterait
   * intacte, mais ce test-ci tomberait — ce qu'on lui demande.
   */
  it('garde 1 — l\'application n\'a ni UPDATE, ni DELETE, ni TRUNCATE', async () => {
    await asDefinerFor(fixture.owner)
    const id = await logged()

    await asApplication(fixture.owner, 'owner')

    for (const [what, sql] of [
      ['modifier', `update public.audit_log set entity_type = 'raturé' where id = '${id}'::uuid`],
      ['supprimer', `delete from public.audit_log where id = '${id}'::uuid`],
      ['vider', 'truncate public.audit_log'],
    ] as const) {
      const done = await attempt(client, sql)

      expect(done.ok, `RATURE — l'application vient de ${what} le journal`).toBe(false)
      if (done.ok) continue
      expect(done.code, `refusé, mais pas par le privilège : ${done.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    }

    expect(await countRows()).toBe(1)
  })

  /*
   * Garde 2 — le trigger de ligne. Il arrête tout ce que le privilège ne voit
   * pas : `service_role`, une fonction `security definer`, une console `psql`,
   * la synchronisation de E10. Le test se place donc en `postgres`, c'est-à-dire
   * là où le garde 1 n'existe pas.
   */
  it('garde 2 — le trigger de ligne refuse même à postgres', async () => {
    await asDefinerFor(fixture.owner)
    const id = await logged()
    await client.query('reset role')

    for (const [what, sql] of [
      ['modifiée', `update public.audit_log set entity_type = 'raturé' where id = '${id}'::uuid`],
      ['supprimée', `delete from public.audit_log where id = '${id}'::uuid`],
    ] as const) {
      const done = await attempt(client, sql)

      expect(done.ok, `RATURE — une ligne a été ${what} en tant que postgres`).toBe(false)
      if (done.ok) continue
      expect(done.code).toBe(APPEND_ONLY)
      expect(done.message, 'refusé, mais pas par le garde de ligne').toContain(
        'ne se modifie ni ne se supprime',
      )
    }

    expect(await countRows()).toBe(1)
  })

  /*
   * Garde 3 — TRUNCATE, que le garde 2 ne voit pas : l'instruction ne produit
   * aucune ligne, donc ne déclenche aucun trigger de ligne. C'est un garde
   * distinct, sur un chemin distinct, et il porte sa propre phrase pour qu'on
   * puisse dire lequel des deux a refusé. Retirer l'un doit faire tomber son
   * test à lui seul — E1-03, où l'index total et le verrou consultatif tombent
   * séparément.
   */
  it('garde 3 — le trigger d\'instruction refuse TRUNCATE, même à postgres', async () => {
    await asDefinerFor(fixture.owner)
    await logged()
    await client.query('reset role')

    const emptied = await attempt(client, 'truncate public.audit_log')

    expect(emptied.ok, 'RATURE — le journal a été vidé d\'un coup').toBe(false)
    if (emptied.ok) return
    expect(emptied.code).toBe(APPEND_ONLY)
    expect(emptied.message, 'refusé, mais pas par le garde de TRUNCATE').toContain(
      'ne se vide pas',
    )
    expect(await countRows()).toBe(1)
  })

  it('mais l\'insertion, elle, passe — par le helper', async () => {
    await asDefinerFor(fixture.owner)
    await logged()
    await logged('document_cancellation', 'sale')

    expect(await countRows()).toBe(2)
  })
})

/* ========================================================================== */
/* La consultation — `owner` seul, filtrable                                   */
/* ========================================================================== */

describe('la consultation du journal', () => {
  it('est refusée à l\'employé, du même commerce', async () => {
    await asDefinerFor(fixture.owner)
    await logged()

    await asApplication(fixture.worker, 'worker')
    const { rows } = await client.query('select id from public.audit_log')

    expect(rows, 'FUITE — un employé lit le journal de son patron').toHaveLength(0)
  })

  it('est ouverte au patron', async () => {
    await asDefinerFor(fixture.owner)
    await logged()

    await asApplication(fixture.owner, 'owner')
    const { rows } = await client.query('select id from public.audit_log')

    expect(rows, 'la policy refuse le patron lui-même').toHaveLength(1)
  })

  /*
   * E1-04 : « filtrable par utilisateur et par date ». Le filtre est une
   * requête, pas une policy — mais il s'applique *sous* la policy, et c'est
   * cela qu'on vérifie : filtrer sur un auteur ne fait pas apparaître de lignes
   * que la RLS retenait, et le patron retrouve bien celles de son employé.
   */
  it('se filtre par utilisateur et par date', async () => {
    await asDefinerFor(fixture.owner)
    await logged('price_override', 'variant')

    await asDefinerFor(fixture.worker, 'worker')
    await logged('document_cancellation', 'sale')

    await asApplication(fixture.owner, 'owner')

    const byUser = await client.query<{ user_id: string }>(
      'select user_id from public.audit_log where user_id = $1',
      [fixture.worker.appUser],
    )
    expect(byUser.rows.map((r) => r.user_id)).toEqual([fixture.worker.appUser])

    const today = await client.query(
      'select id from public.audit_log where created_at >= date_trunc(\'day\', now())',
    )
    expect(today.rows).toHaveLength(2)

    const yesterday = await client.query(
      'select id from public.audit_log where created_at < date_trunc(\'day\', now())',
    )
    expect(yesterday.rows).toHaveLength(0)
  })
})
