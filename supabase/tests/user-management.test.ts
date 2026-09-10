// @vitest-environment node

/*
 * E1-02 — la gestion des employés, de l'écran du patron jusqu'au refus opposé à
 * un employé qui essaie d'y entrer par la porte de service.
 *
 * Le critère qui compte n'est pas « le patron crée un employé » : c'est que
 * personne d'autre ne le puisse, et qu'un compte coupé ne rentre plus. Or ce
 * droit est gardé à quatre niveaux, et un test par critère laisserait trois de
 * ces gardes sans preuve — celui du dessus masquerait leur disparition
 * (CLAUDE.md, vérifié en E1-01 : le garde de `create_tenant()` retiré, 18 tests
 * sur 19 restaient verts).
 *
 * Ce fichier a donc un test par niveau, et chacun contourne les autres :
 *
 *   interface  → `src/modules/admin/users.test.tsx`, pas ici.
 *   Edge       → appel HTTP à `create-user` avec le jeton d'un employé.
 *   RPC        → appel direct à `/rest/v1/rpc/create_worker`, sans la fonction
 *                Edge. Les fonctions étant `security definer`, la policy ne
 *                s'applique pas à elles : seul leur garde répond.
 *   policy     → `POST`/`GET`/`PATCH` direct sur `/rest/v1/app_user`, sans
 *                aucune fonction. Seule la policy restrictive répond.
 *   trigger    → `PATCH` du patron sur sa propre ligne, ce qu'aucune policy ne
 *                sait refuser : elle ne compare pas l'ancienne ligne à la
 *                nouvelle.
 *   hook       → demande de jeton, connexion **et** rafraîchissement.
 *
 * Chaque refus asserte le **code d'erreur** attendu, et là où un code ne suffit
 * pas, l'absence d'effet : aucune ligne créée, aucun rôle changé. Un test qui
 * se contente de « l'appel a échoué » passe au vert sur une clé étrangère en
 * croyant mesurer une autorisation (E1-01, again).
 *
 * Il écrit hors transaction, comme `tenant-creation.test.ts` : PostgREST,
 * GoTrue et le runtime Edge sont trois autres processus. Le ménage est donc
 * explicite, et fait même en cas d'échec.
 */

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  ANON_KEY,
  API_URL,
  createAuthUser,
  deleteAuthUser,
  payloadOf,
  refreshSession,
  rest,
  sessionFor,
  signInWithPassword,
} from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'
const WORKER_PASSWORD = 'mot-de-passe-employe-0000'

let db: Client

/** Ce qu'un cas a fait naître, à défaire après lui. */
const createdTenants: string[] = []
const createdAuthUsers: string[] = []

/*
 * Un numéro par appel. Le stack local n'est pas remis à zéro entre deux
 * lancements et l'adresse dérivée est unique par construction : deux exécutions
 * sur le même numéro se heurteraient au « déjà rattaché à un compte », un échec
 * sans rapport avec ce qui est vérifié.
 */
function freshPhone(): string {
  const suffix = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')
  return `06${suffix}`
}

interface Person {
  authUser: string
  appUser: string
  email: string
  token: string
}

/**
 * Un commerce et sa population : un patron, et autant d'employés que demandé.
 *
 * Tout est posé en base sous `postgres`, jamais par l'application : ce fichier
 * vérifie ce que l'application a le droit de faire, il ne peut pas se servir de
 * ce droit pour préparer ses propres cas.
 */
async function seedTenant(workers = 0): Promise<{ tenant: string; owner: Person; workers: Person[] }> {
  const { rows } = await db.query<{ id: string }>(
    "insert into public.tenant (business_name, tenant_id) values ('Employés', gen_random_uuid()) returning id",
  )
  const tenant = rows[0]!.id
  createdTenants.push(tenant)

  const person = async (role: 'owner' | 'worker', password: string): Promise<Person> => {
    const email = `${role}-${crypto.randomUUID()}@merx.test`
    const authUser = await createAuthUser(email, password)
    createdAuthUsers.push(authUser)

    const created = await db.query<{ id: string }>(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, phone, role)' +
        ' values ($1, $2, $3, $4, $5) returning id',
      [tenant, authUser, role === 'owner' ? 'Patron' : 'Employé', freshPhone(), role],
    )

    const { accessToken } = await sessionFor(email, password)
    return { authUser, appUser: created.rows[0]!.id, email, token: accessToken }
  }

  const owner = await person('owner', PASSWORD)
  const staff: Person[] = []
  for (let n = 0; n < workers; n += 1) staff.push(await person('worker', WORKER_PASSWORD))

  return { tenant, owner, workers: staff }
}

/* -------------------------------------------------------------------------- */
/* La fonction Edge                                                            */
/* -------------------------------------------------------------------------- */

interface CreateOutcome {
  status: number
  userId: string | null
  phone: string | null
  error: string | null
}

interface CreateInput {
  fullName?: string
  phone?: string
  password?: string
}

/** Un appel à `create-user`, exactement comme le front l'émet. */
async function createUser(token: string | null, input: CreateInput): Promise<CreateOutcome> {
  const response = await fetch(`${API_URL}/functions/v1/create-user`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  const text = await response.text()
  let body: { userId?: string; phone?: string; error?: string }
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(
      `Réponse illisible de create-user (${response.status}) : ${text}\n` +
        'Le runtime Edge est-il démarré ? npx supabase start',
    )
  }

  return {
    status: response.status,
    userId: body.userId ?? null,
    phone: body.phone ?? null,
    error: body.error ?? null,
  }
}

function validInput(overrides: CreateInput = {}): CreateInput {
  return {
    fullName: 'Yassine Alaoui',
    phone: freshPhone(),
    password: WORKER_PASSWORD,
    ...overrides,
  }
}

/** Un appel direct à une RPC, sans passer par la fonction Edge. */
async function rpc(
  name: string,
  token: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; code: string | null; message: string; body: unknown }> {
  const response = await fetch(`${API_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  const asError = parsed as { code?: string; message?: string } | null
  return {
    status: response.status,
    ok: response.ok,
    code: asError?.code ?? null,
    message: asError?.message ?? text,
    body: parsed,
  }
}

async function usersOf(tenant: string): Promise<Array<{ id: string; role: string; is_active: boolean; full_name: string; created_by: string | null }>> {
  const { rows } = await db.query(
    'select id, role, is_active, full_name, created_by from public.app_user' +
      ' where tenant_id = $1 order by full_name',
    [tenant],
  )
  return rows
}

beforeAll(async () => {
  db = new Client({ connectionString: CONNECTION_STRING })
  try {
    await db.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }
})

afterEach(async () => {
  for (const tenant of createdTenants.splice(0)) {
    await db.query('delete from public.app_user where tenant_id = $1', [tenant])
    await db.query('delete from public.device where tenant_id = $1', [tenant])
    await db.query('delete from public.warehouse where tenant_id = $1', [tenant])
    await db.query('delete from public.tenant where id = $1', [tenant])
  }

  for (const user of createdAuthUsers.splice(0)) {
    await deleteAuthUser(user)
  }
})

afterAll(async () => {
  await db.end()
})

/* ========================================================================== */
/* Le critère : le patron crée un employé qui se connecte                      */
/* ========================================================================== */

describe('un employé créé par le patron', () => {
  it('se connecte tout de suite, avec son numéro, en `worker`', async () => {
    const { tenant, owner } = await seedTenant()
    const input = validInput()

    const created = await createUser(owner.token, input)
    expect(created.error).toBeNull()
    expect(created.status).toBe(201)

    /*
     * Le cœur de la story, et il ne se lit pas en base : une vraie demande de
     * jeton, avec le numéro et le mot de passe que le patron vient de poser.
     * Une ligne `app_user` présente ne prouve rien — c'est aussi l'état qu'on
     * obtient quand le compte d'authentification n'a pas été créé.
     */
    const session = await signInWithPassword(`${created.phone}@merx.invalid`, WORKER_PASSWORD)
    expect(session.accessToken, `connexion refusée : ${session.errorCode ?? session.status}`)
      .not.toBeNull()

    const claims = payloadOf(session.accessToken!)
    expect(claims.app_metadata?.tenant_id).toBe(tenant)
    expect(claims.app_metadata?.role).toBe('worker')
  })

  it('est rangé dans le commerce du patron, et créé par lui', async () => {
    const { tenant, owner } = await seedTenant()

    await createUser(owner.token, validInput({ fullName: 'Yassine Alaoui' }))

    const users = await usersOf(tenant)
    const worker = users.find((u) => u.full_name === 'Yassine Alaoui')

    expect(worker).toBeDefined()
    expect(worker!.role).toBe('worker')
    expect(worker!.is_active).toBe(true)
    // SPEC § 4 : `created_by` répond à « qui a fait cela ? ».
    expect(worker!.created_by).toBe(owner.appUser)
  })

  /*
   * Le même numéro s'écrit de six façons. Si la forme stockée dépendait de la
   * ponctuation saisie, l'employé qui tape son numéro autrement qu'à
   * l'inscription se verrait refuser sa connexion — mot de passe bon, compte
   * existant, et rien pour signaler la cause.
   */
  it('rend le numéro sous sa forme canonique', async () => {
    const { owner } = await seedTenant()
    const phone = freshPhone()
    const spaced = phone.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5')

    const created = await createUser(owner.token, validInput({ phone: spaced }))

    expect(created.phone).toBe(phone)
    const session = await signInWithPassword(`${phone}@merx.invalid`, WORKER_PASSWORD)
    expect(session.accessToken).not.toBeNull()
  })

  it.each([
    ['sans nom', { fullName: '' }],
    ['sans téléphone', { phone: '' }],
    ['avec un téléphone invalide', { phone: '0612' }],
    ['avec un mot de passe trop court', { password: '123' }],
  ])('est refusé %s', async (_label, override) => {
    const { tenant, owner } = await seedTenant()

    const created = await createUser(owner.token, validInput(override))

    expect(created.status).toBe(400)
    expect(created.userId).toBeNull()
    // Un compte d'authentification créé puis abandonné laisserait un employé
    // fantôme : la fiche n'existe pas, le compte si.
    expect(await usersOf(tenant)).toHaveLength(1)
  })

  it('refuse un numéro déjà rattaché à un compte', async () => {
    const { tenant, owner } = await seedTenant()
    const phone = freshPhone()

    expect((await createUser(owner.token, validInput({ phone }))).status).toBe(201)
    const second = await createUser(owner.token, validInput({ phone, fullName: 'Autre' }))

    expect(second.status).toBe(409)
    expect(second.userId).toBeNull()
    // Le patron, plus un seul employé.
    expect(await usersOf(tenant)).toHaveLength(2)
  })
})

/* ========================================================================== */
/* Le rôle n'est pas un paramètre                                              */
/* ========================================================================== */

/*
 * `create_worker()` écrit `'worker'` elle-même. Ce n'est pas une précaution
 * d'écriture : c'est ce qui fait qu'aucun contrôle de rôle n'a besoin d'exister,
 * donc qu'aucun ne peut se relâcher. Le test le vérifie par la seule chose
 * observable — la signature refuse un rôle.
 */
describe('le rôle', () => {
  it("ne peut pas être choisi par l'appelant", async () => {
    const { owner } = await seedTenant()
    const authUser = await createAuthUser(`escalade-${crypto.randomUUID()}@merx.test`, PASSWORD)
    createdAuthUsers.push(authUser)

    const attempt = await rpc('create_worker', owner.token, {
      full_name: 'Faux patron',
      phone: freshPhone(),
      auth_user_id: authUser,
      role: 'owner',
    })

    // PGRST202 : aucune fonction de ce nom n'accepte ces paramètres.
    expect(attempt.ok).toBe(false)
    expect(attempt.code).toBe('PGRST202')
  })
})

/* ========================================================================== */
/* Un test par niveau de garde, chacun contournant les autres                   */
/* ========================================================================== */

describe('le droit de gérer les employés', () => {
  /* — Niveau « fonction Edge » — */
  /*
   * Le message est asserté, et pas seulement le 403. Les deux gardes — le
   * pré-contrôle d'ici et celui de la RPC — rendent le même statut, puisque
   * c'est le même refus pour le client. Sur le seul statut, ce cas restait donc
   * vert le pré-contrôle retiré : la RPC reprenait le refus à son compte sous
   * une réponse indistinguable. Vérifié par sabotage — 0 test sur 180 tombait.
   * Le libellé est ce qui dit lequel des deux a répondu, et il ne peut pas être
   * celui de la RPC : la migration lui en donne un autre, exprès.
   */
  it('est refusé à un `worker` par le pré-contrôle de la fonction Edge', async () => {
    const { tenant, workers } = await seedTenant(1)

    const created = await createUser(workers[0]!.token, validInput())

    expect(created.status).toBe(403)
    expect(
      created.error,
      'refusé, mais par la base — le pré-contrôle de la fonction Edge ne répond plus',
    ).toBe('Seul le patron crée un employé.')
    expect(await usersOf(tenant)).toHaveLength(2)
  })

  it('est refusé sans session', async () => {
    const created = await createUser(null, validInput())

    expect(created.status).toBe(401)
    expect(created.userId).toBeNull()
  })

  /* — Niveau « RPC » : contourne la fonction Edge — */
  it('est refusé à un `worker` qui appelle la RPC directement', async () => {
    const { tenant, workers } = await seedTenant(1)

    /*
     * Le compte d'authentification est réel, et c'est tout l'enjeu de ce cas.
     * Avec un `auth_user_id` inventé, la clé étrangère refuserait l'insertion
     * de toute façon : le test resterait rouge en retirant le garde, mais sur
     * un `23503` — une panne d'intégrité prise pour un refus de droit (E1-01).
     * Avec un compte réel, plus rien ne sépare l'employé d'une fiche créée,
     * sauf `merx.can('manage_users')`.
     */
    const authUser = await createAuthUser(`victime-${crypto.randomUUID()}@merx.test`, PASSWORD)
    createdAuthUsers.push(authUser)

    const attempt = await rpc('create_worker', workers[0]!.token, {
      full_name: 'Employé volé',
      phone: freshPhone(),
      auth_user_id: authUser,
    })

    expect(attempt.ok, 'la RPC a laissé un `worker` créer un employé').toBe(false)
    expect(attempt.code).toBe('42501')
    // Le libellé propre à ce niveau : c'est la base qui a refusé, pas le
    // pré-contrôle de la fonction Edge, qui n'est pas sur ce chemin.
    expect(attempt.message).toContain("n'a pas le droit de créer un employé")
    // La preuve qui ne dépend d'aucun code d'erreur : rien n'est né.
    expect(await usersOf(tenant)).toHaveLength(2)
  })

  it('est refusé à un `worker` qui appelle `set_user_active` directement', async () => {
    const { tenant, workers } = await seedTenant(2)

    const attempt = await rpc('set_user_active', workers[0]!.token, {
      target_user: workers[1]!.appUser,
      active: false,
    })

    expect(attempt.ok).toBe(false)
    expect(attempt.code).toBe('42501')

    const users = await usersOf(tenant)
    expect(users.every((u) => u.is_active), 'un employé en a désactivé un autre').toBe(true)
  })

  it('est refusé à un appelant anonyme sur la RPC', async () => {
    const attempt = await rpc('create_worker', null, {
      full_name: 'Anonyme',
      phone: freshPhone(),
      auth_user_id: '00000000-0000-0000-0000-000000000001',
    })

    expect(attempt.ok).toBe(false)
  })

  /* — Niveau « policy » : contourne la fonction Edge *et* les RPC — */
  it("ne laisse pas un `worker` lire la liste des employés", async () => {
    const { workers } = await seedTenant(1)

    const read = await rest('app_user?select=id,full_name,role', { token: workers[0]!.token })

    // 200 et zéro ligne, pas une erreur : la RLS ne dit pas « interdit », elle
    // ne rend rien. C'est ce qui rend l'écran vide pour lui.
    expect(read.status).toBe(200)
    expect(read.rows, 'FUITE — un employé lit la liste des utilisateurs').toHaveLength(0)
  })

  it("ne laisse pas un `worker` s'ajouter une fiche par PostgREST", async () => {
    const { tenant, workers } = await seedTenant(1)

    const written = await rest('app_user', {
      token: workers[0]!.token,
      method: 'POST',
      body: {
        tenant_id: tenant,
        full_name: 'Auto-promotion',
        role: 'owner',
        phone: freshPhone(),
      },
    })

    expect(written.ok).toBe(false)
    expect(written.code).toBe('42501')
    expect(await usersOf(tenant)).toHaveLength(2)
  })

  /*
   * La cible est un *autre* employé, et ce n'est pas un détail : sur sa propre
   * ligne, le trigger `app_user_protect_own_role` refuse le changement de rôle
   * avant que la policy n'ait à se prononcer. Le test aurait mesuré le trigger
   * en croyant mesurer la policy — et serait resté vert la policy retirée. Le
   * sabotage l'a montré, ce cas est celui d'après.
   */
  it("ne laisse pas un `worker` en promouvoir un autre par PostgREST", async () => {
    const { tenant, workers } = await seedTenant(2)

    const patched = await rest(`app_user?id=eq.${workers[1]!.appUser}`, {
      token: workers[0]!.token,
      method: 'PATCH',
      body: { role: 'owner' },
    })

    expect(patched.rows, 'FUITE — un employé en a promu un autre').toHaveLength(0)

    const users = await usersOf(tenant)
    expect(users.filter((u) => u.role === 'owner')).toHaveLength(1)
  })

  /* — Le contrôle positif : sans lui, tout ce qui précède passerait sur une
       base qui refuse simplement tout le monde. — */
  it('est accordé au patron, qui lit sa propre liste', async () => {
    const { owner } = await seedTenant(1)

    const read = await rest('app_user?select=id,full_name,role', { token: owner.token })

    expect(read.status).toBe(200)
    expect(read.rows).toHaveLength(2)
  })
})

/* ========================================================================== */
/* On ne se retire pas son propre rôle                                         */
/* ========================================================================== */

describe('le patron', () => {
  /* — Niveau « trigger » : contourne les deux RPC — */
  it('ne peut pas se retirer son rôle `owner` par un PATCH direct', async () => {
    const { tenant, owner } = await seedTenant()

    const patched = await rest(`app_user?id=eq.${owner.appUser}`, {
      token: owner.token,
      method: 'PATCH',
      body: { role: 'worker' },
    })

    expect(patched.ok, 'le patron s’est rétrogradé lui-même').toBe(false)
    expect(patched.code).toBe('42501')
    expect(patched.body).toContain('propre rôle')

    const users = await usersOf(tenant)
    expect(users.find((u) => u.id === owner.appUser)!.role).toBe('owner')
  })

  it('ne peut pas se désactiver par un PATCH direct', async () => {
    const { tenant, owner } = await seedTenant()

    const patched = await rest(`app_user?id=eq.${owner.appUser}`, {
      token: owner.token,
      method: 'PATCH',
      body: { is_active: false },
    })

    expect(patched.ok).toBe(false)
    expect(patched.code).toBe('42501')

    const users = await usersOf(tenant)
    expect(users.find((u) => u.id === owner.appUser)!.is_active).toBe(true)
  })

  /* — Niveau « RPC » : le même refus, un étage plus haut, et un autre message.
       Les deux libellés diffèrent pour que chaque test sache lequel des deux
       gardes l'a arrêté — sans quoi le trigger masquerait la disparition du
       contrôle de `set_user_active()`. — */
  it('ne peut pas se désactiver par `set_user_active`', async () => {
    const { tenant, owner } = await seedTenant()

    const attempt = await rpc('set_user_active', owner.token, {
      target_user: owner.appUser,
      active: false,
    })

    expect(attempt.ok).toBe(false)
    expect(attempt.code).toBe('42501')
    expect(attempt.message).toContain('depuis cet écran')

    const users = await usersOf(tenant)
    expect(users.find((u) => u.id === owner.appUser)!.is_active).toBe(true)
  })

  /* — L'autre commerce : la fonction est `security definer`, donc hors RLS. La
       frontière y est réécrite à la main, et c'est ici qu'on le vérifie. — */
  it("ne peut pas désactiver l'employé d'un autre commerce", async () => {
    const mine = await seedTenant()
    const theirs = await seedTenant(1)

    const attempt = await rpc('set_user_active', mine.owner.token, {
      target_user: theirs.workers[0]!.appUser,
      active: false,
    })

    expect(attempt.ok).toBe(false)
    // « Introuvable » plutôt que « pas à vous » : ne pas confirmer l'existence
    // d'une fiche qu'on n'a pas le droit de voir.
    expect(attempt.message).toContain('introuvable')

    const users = await usersOf(theirs.tenant)
    expect(users.find((u) => u.id === theirs.workers[0]!.appUser)!.is_active).toBe(true)
  })
})

/* ========================================================================== */
/* Un compte désactivé ne se connecte plus                                     */
/* ========================================================================== */

describe('un compte désactivé', () => {
  it('se désactive sans être supprimé', async () => {
    const { tenant, owner, workers } = await seedTenant(1)

    const attempt = await rpc('set_user_active', owner.token, {
      target_user: workers[0]!.appUser,
      active: false,
    })
    expect(attempt.ok, attempt.message).toBe(true)

    // E1-02 : « désactiver un compte sans le supprimer ». La fiche reste —
    // les documents porteront son `created_by`.
    const users = await usersOf(tenant)
    const worker = users.find((u) => u.id === workers[0]!.appUser)
    expect(worker).toBeDefined()
    expect(worker!.is_active).toBe(false)
  })

  it('ne peut plus ouvrir de session', async () => {
    const { owner, workers } = await seedTenant(1)

    await rpc('set_user_active', owner.token, { target_user: workers[0]!.appUser, active: false })

    const refused = await signInWithPassword(workers[0]!.email, WORKER_PASSWORD)

    /*
     * Le refus est au point d'émission, pas dans l'application. Un jeton sans
     * claims aurait laissé une session s'ouvrir : vide, certes, mais ouverte —
     * et le refus n'aurait tenu que tant que l'accès passait par le front.
     */
    expect(refused.accessToken, 'un compte désactivé obtient encore un jeton').toBeNull()
    expect(refused.status).toBe(403)
  })

  /*
   * Le cas d'exploitation, et il ne se déduit pas du précédent : un employé
   * désactivé à 14 h a déjà un jeton en poche. S'il fallait attendre qu'il se
   * reconnecte, il resterait dedans jusqu'au soir. Le hook tourne aussi au
   * rafraîchissement — c'est ce qui le fait sortir au renouvellement suivant.
   */
  it('sort au premier rafraîchissement, sans attendre une reconnexion', async () => {
    const { owner, workers } = await seedTenant(1)

    /*
     * La séquence est celle de l'exploitation, dans l'ordre : l'employé ouvre
     * sa session à 14 h, jeton valide en poche ; le patron le coupe à 14 h 05 ;
     * le jeton arrive à échéance à 15 h et l'application le renouvelle toute
     * seule. La question est ce que rend ce renouvellement-là.
     */
    const session = await sessionFor(workers[0]!.email, WORKER_PASSWORD)

    /*
     * Le contrôle positif, et il n'est pas décoratif : sans lui, tout ce qui
     * suit serait vert si le rafraîchissement ne marchait jamais dans ce
     * montage — le test n'aurait mesuré que sa propre panne. On échange donc le
     * jeton une première fois, compte actif, et l'on exige que ça marche.
     *
     * GoTrue fait tourner les jetons de rafraîchissement : celui qui sert à la
     * suite est celui que cet échange vient de rendre, pas celui de la
     * connexion — sinon le refus attendu plus bas pourrait n'être qu'un jeton
     * déjà consommé.
     */
    const active = await refreshSession(session.refreshToken)
    expect(active.accessToken, 'le rafraîchissement ne marche pas, même compte actif')
      .not.toBeNull()
    expect(payloadOf(active.accessToken!).app_metadata?.role).toBe('worker')
    expect(active.refreshToken).not.toBeNull()

    await rpc('set_user_active', owner.token, { target_user: workers[0]!.appUser, active: false })

    const renewed = await refreshSession(active.refreshToken!)

    expect(renewed.accessToken, 'un compte désactivé renouvelle encore son jeton').toBeNull()
    /*
     * Le code, pas « ça a échoué ». 403 est celui que le hook demande
     * (`http_code` de son objet d'erreur) ; un 400 dirait tout autre chose —
     * jeton illisible, déjà consommé, expiré — c'est-à-dire un refus qui ne
     * viendrait pas de la désactivation, et le test prendrait le crédit d'un
     * garde qui n'a pas répondu.
     */
    expect(renewed.status, `refusé, mais pas par le hook : ${renewed.errorCode ?? 'sans code'}`)
      .toBe(403)
  })

  it('se reconnecte une fois réactivé', async () => {
    const { owner, workers } = await seedTenant(1)

    await rpc('set_user_active', owner.token, { target_user: workers[0]!.appUser, active: false })
    expect((await signInWithPassword(workers[0]!.email, WORKER_PASSWORD)).accessToken).toBeNull()

    const back = await rpc('set_user_active', owner.token, {
      target_user: workers[0]!.appUser,
      active: true,
    })
    expect(back.ok, back.message).toBe(true)

    const session = await signInWithPassword(workers[0]!.email, WORKER_PASSWORD)
    expect(session.accessToken).not.toBeNull()
    expect(payloadOf(session.accessToken!).app_metadata?.role).toBe('worker')
  })

  /*
   * Le mode de défaillance à ne pas produire : refuser aussi les comptes
   * d'authentification sans fiche. E1-01 crée le compte du patron *avant* sa
   * fiche ; un refus à cet endroit casserait la création de commerce, et le
   * symptôme ressemblerait à une panne d'authentification.
   */
  it("ne refuse pas un compte qui n'a pas encore de fiche", async () => {
    const email = `sans-fiche-${crypto.randomUUID()}@merx.test`
    const authUser = await createAuthUser(email, PASSWORD)
    createdAuthUsers.push(authUser)

    const session = await signInWithPassword(email, PASSWORD)

    expect(session.accessToken, 'un compte sans fiche ne peut plus obtenir de jeton').not.toBeNull()
    expect(payloadOf(session.accessToken!).app_metadata?.tenant_id).toBeUndefined()
  })
})
