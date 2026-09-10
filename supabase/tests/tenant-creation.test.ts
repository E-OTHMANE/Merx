// @vitest-environment node

/*
 * E1-01 — la création d'un commerce, du formulaire jusqu'à la première
 * connexion du patron.
 *
 * Le critère d'acceptation qui compte est « le patron peut se connecter
 * immédiatement », et il ne se vérifie qu'en le faisant : mot de passe posé par
 * l'éditeur, jeton demandé au point d'émission, claims relus. Vérifier qu'une
 * ligne `app_user` existe ne prouve rien — c'est l'état qu'on obtient aussi
 * quand le compte d'authentification n'a pas été créé, ou qu'il l'a été sous
 * une adresse que la connexion ne saura pas reconstruire.
 *
 * Le chemin traversé est celui de l'application, en entier :
 *
 *   fonction Edge → API Admin (compte) → RPC sous le jeton de l'éditeur
 *                 → RLS → tenant, warehouse, device, app_user
 *                 → /auth/v1/token → claims du patron
 *
 * Il écrit hors transaction, comme `auth.test.ts` : PostgREST, GoTrue et le
 * runtime Edge sont trois autres processus, aucun ne verrait une transaction
 * ouverte ici. Le ménage est donc explicite, et fait même en cas d'échec.
 */

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { normalizePhone } from '../functions/_shared/phone'
import {
  ANON_KEY,
  API_URL,
  createAuthUser,
  deleteAuthUser,
  payloadOf,
  sessionFor,
  signInWithPassword,
} from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const EDITOR_PASSWORD = 'mot-de-passe-editeur-0000'
const OWNER_PASSWORD = 'mot-de-passe-patron-0000'

/*
 * Un numéro par exécution. Le stack local n'est pas remis à zéro entre deux
 * lancements, et l'adresse dérivée est unique par construction : deux
 * exécutions sur le même numéro se heurteraient au « déjà rattaché à un
 * compte » — un échec qui n'aurait rien à voir avec ce qui est vérifié.
 */
function freshPhone(): string {
  const suffix = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')
  return `06${suffix}`
}

let db: Client

/** Les comptes et commerces créés par un cas, à défaire après lui. */
const createdTenants: string[] = []
const createdAuthUsers: string[] = []

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fabrique un utilisateur complet — compte d'authentification, fiche
 * `app_user`, commerce — et rend son jeton.
 *
 * L'éditeur a lui aussi un `tenant_id` : `app_user.tenant_id` est NOT NULL, et
 * la colonne n'a pas de sens particulier pour un `super_admin` — la policy
 * `super_admin_all` lui ouvre tous les commerces indépendamment de celui où sa
 * fiche est rangée (E0-03). Ce commerce d'attache n'est pas créé par E1-01 ;
 * il l'est ici, directement, comme il le serait à l'installation de l'éditeur.
 */
async function signedInAs(role: 'super_admin' | 'owner' | 'worker'): Promise<string> {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@merx.test`
  const authUser = await createAuthUser(email, EDITOR_PASSWORD)
  createdAuthUsers.push(authUser)

  const { rows } = await db.query<{ id: string }>(
    "insert into public.tenant (business_name) values ('Commerce d''attache') returning id",
  )
  const tenant = rows[0]!.id
  createdTenants.push(tenant)

  await db.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role)' +
      ' values ($1, $2, $3, $4)',
    [tenant, authUser, `Compte ${role}`, role],
  )

  const { accessToken } = await sessionFor(email, EDITOR_PASSWORD)
  return accessToken
}

/* -------------------------------------------------------------------------- */
/* La fonction Edge                                                            */
/* -------------------------------------------------------------------------- */

interface CreateOutcome {
  status: number
  tenantId: string | null
  phone: string | null
  error: string | null
}

interface CreateInput {
  businessName?: string
  ownerName?: string
  phone?: string
  city?: string
  password?: string
}

/** Un appel à `create-tenant`, exactement comme le front l'émet. */
async function createTenant(token: string | null, input: CreateInput): Promise<CreateOutcome> {
  const response = await fetch(`${API_URL}/functions/v1/create-tenant`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })

  const text = await response.text()
  let body: { tenantId?: string; phone?: string; error?: string }
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(
      `Réponse illisible de create-tenant (${response.status}) : ${text}\n` +
        'Le runtime Edge est-il démarré ? npx supabase start',
    )
  }

  if (body.tenantId !== undefined) createdTenants.push(body.tenantId)

  return {
    status: response.status,
    tenantId: body.tenantId ?? null,
    phone: body.phone ?? null,
    error: body.error ?? null,
  }
}

/** Un commerce valide, avec un numéro neuf. */
function validInput(overrides: CreateInput = {}): CreateInput {
  return {
    businessName: 'Droguerie Atlas',
    ownerName: 'Rachid Benali',
    phone: freshPhone(),
    city: 'Casablanca',
    password: OWNER_PASSWORD,
    ...overrides,
  }
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
  // Dans l'ordre inverse des dépendances : les lignes filles d'abord, sinon les
  // clés étrangères refusent.
  for (const tenant of createdTenants.splice(0)) {
    // E1-05 : `create_tenant()` pose aussi les réglages du commerce.
    await db.query('delete from public.tenant_setting where tenant_id = $1', [tenant])
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
/* Le critère : le patron peut se connecter immédiatement                      */
/* ========================================================================== */

describe('un commerce créé par l’éditeur', () => {
  it('laisse son patron se connecter tout de suite, avec son numéro', async () => {
    const editor = await signedInAs('super_admin')
    const input = validInput()

    const created = await createTenant(editor, input)
    expect(created.error).toBeNull()
    expect(created.status).toBe(201)
    expect(created.tenantId).not.toBeNull()

    /*
     * Le cœur de la story. Pas une lecture en base : une vraie demande de jeton
     * au point d'émission, avec le numéro et le mot de passe que l'éditeur
     * vient de poser.
     */
    const session = await signInWithPassword(
      `${created.phone}@merx.invalid`,
      OWNER_PASSWORD,
    )
    expect(session.accessToken, `connexion refusée : ${session.errorCode ?? session.status}`)
      .not.toBeNull()

    const claims = payloadOf(session.accessToken!)
    expect(claims.app_metadata?.tenant_id).toBe(created.tenantId)
    expect(claims.app_metadata?.role).toBe('owner')
  })

  /*
   * Le même numéro s'écrit de six façons. Si la forme stockée dépendait de la
   * ponctuation saisie, le patron qui tape son numéro autrement qu'à
   * l'inscription se verrait refuser sa connexion — et le mot de passe serait
   * bon, le compte existerait, rien ne signalerait la cause.
   */
  it('rend le numéro sous sa forme canonique, quelle qu’ait été la saisie', async () => {
    const editor = await signedInAs('super_admin')
    const phone = freshPhone()
    const spaced = phone.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5')

    const created = await createTenant(editor, validInput({ phone: spaced }))

    expect(created.phone).toBe(phone)
    expect(normalizePhone(spaced)).toBe(phone)

    const session = await signInWithPassword(`${phone}@merx.invalid`, OWNER_PASSWORD)
    expect(session.accessToken).not.toBeNull()
  })

  /* E1-01 : « Crée le `tenant`, le premier `app_user` en `owner` ». */
  it('crée un seul patron, et personne d’autre', async () => {
    const editor = await signedInAs('super_admin')
    const created = await createTenant(editor, validInput({ ownerName: 'Rachid Benali' }))

    const { rows } = await db.query<{ full_name: string; role: string; phone: string }>(
      'select full_name, role, phone from public.app_user where tenant_id = $1',
      [created.tenantId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ full_name: 'Rachid Benali', role: 'owner' })
  })

  /*
   * SPEC § 2.4, RÈGLE : le dépôt est une constante invisible, créée à
   * l'inscription. C'est ce qui évite de réécrire l'historique de stock de tous
   * les commerces installés le jour où l'un d'eux aurait un dépôt séparé — et
   * cela ne vaut que si la ligne est là dès le premier jour.
   */
  it('crée l’unique dépôt, sans que personne l’ait demandé', async () => {
    const editor = await signedInAs('super_admin')
    const created = await createTenant(editor, validInput())

    const { rows } = await db.query<{ is_default: boolean }>(
      'select is_default from public.warehouse where tenant_id = $1',
      [created.tenantId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.is_default).toBe(true)
  })

  /* SPEC § 2.5, RÈGLE numérotation : sans préfixe, les bons se dupliquent. */
  it('crée l’appareil par défaut, préfixe « A »', async () => {
    const editor = await signedInAs('super_admin')
    const created = await createTenant(editor, validInput())

    const { rows } = await db.query<{ prefix: string; is_active: boolean }>(
      'select prefix, is_active from public.device where tenant_id = $1',
      [created.tenantId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ prefix: 'A', is_active: true })
  })
})

/* ========================================================================== */
/* Qui a le droit                                                              */
/* ========================================================================== */

describe('le droit de créer un commerce', () => {
  /*
   * Le message est asserté, et pas seulement le 403. Les deux gardes — le
   * pré-contrôle de la fonction Edge et celui de `create_tenant()` — rendent le
   * même statut, puisque c'est le même refus pour le client. Sur le seul statut,
   * ce cas resterait vert le pré-contrôle retiré : la RPC reprendrait le refus à
   * son compte sous une réponse indistinguable. Le libellé est ce qui dit lequel
   * des deux a répondu, et la migration en donne un autre à la base, exprès.
   */
  it.each([['owner'], ['worker']] as const)(
    'est refusé à un %s par le pré-contrôle de la fonction Edge',
    async (role) => {
      const token = await signedInAs(role)

      const created = await createTenant(token, validInput())

      expect(created.status).toBe(403)
      expect(
        created.error,
        'refusé, mais par la base — le pré-contrôle de la fonction Edge ne répond plus',
      ).toBe("Seul l'éditeur crée un commerce.")
      expect(created.tenantId).toBeNull()
    },
  )

  it('est refusé sans session', async () => {
    const created = await createTenant(null, validInput())

    expect(created.status).toBe(401)
    expect(created.tenantId).toBeNull()
  })

  /*
   * L'autorité est à la base, pas dans la fonction Edge. Un appel direct à la
   * RPC — en contournant la fonction — doit buter sur le même refus, sinon le
   * contrôle ne serait qu'une politesse de l'applicatif.
   */
  it('est refusé à un `owner` qui appelle la RPC directement', async () => {
    const token = await signedInAs('owner')

    /*
     * Le compte d'authentification est réel, et c'est tout l'enjeu de ce cas.
     *
     * Avec un `auth_user_id` inventé, la clé étrangère refuse l'insertion et
     * l'appel échoue de toute façon : le test resterait rouge en retirant le
     * garde, mais sur un `23503` — une panne d'intégrité, pas un refus de
     * droit. Il aurait alors mesuré une contrainte de schéma en croyant
     * mesurer une autorisation.
     *
     * Avec un compte réel, plus rien ne sépare un `owner` d'un commerce créé,
     * sauf `merx.is_super_admin()`. Le garde retiré, l'appel réussit — et c'est
     * précisément ce que les deux dernières assertions attrapent.
     */
    const authUser = await createAuthUser(
      `victime-${Date.now()}-${Math.random().toString(36).slice(2)}@merx.test`,
      OWNER_PASSWORD,
    )
    createdAuthUsers.push(authUser)

    const before = await db.query<{ count: string }>('select count(*) as count from public.tenant')

    const response = await fetch(`${API_URL}/rest/v1/rpc/create_tenant`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_name: 'Commerce volé',
        owner_name: 'Quelqu’un',
        phone: freshPhone(),
        city: null,
        auth_user_id: authUser,
      }),
    })

    // Si le garde tombe, la RPC rend l'identifiant du commerce qu'elle vient de
    // créer : il faut le défaire, sinon l'échec du test laisse des lignes
    // derrière lui et fausse les cas suivants.
    if (response.ok) {
      const created = (await response.clone().json()) as string | null
      if (typeof created === 'string') createdTenants.push(created)
    }

    expect(response.ok, 'la RPC a laissé un `owner` créer un commerce').toBe(false)

    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code).toBe('42501')
    // Le libellé propre à ce niveau : c'est la base qui a refusé, pas le
    // pré-contrôle de la fonction Edge, qui n'est pas sur ce chemin.
    expect(body.message).toContain("n'a pas le droit de créer un commerce")

    // La preuve qui ne dépend d'aucun code d'erreur : rien n'est né.
    const after = await db.query<{ count: string }>('select count(*) as count from public.tenant')
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
  })

  it('est refusé à un appelant anonyme sur la RPC', async () => {
    const response = await fetch(`${API_URL}/rest/v1/rpc/create_tenant`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_name: 'Commerce volé',
        owner_name: 'Quelqu’un',
        phone: freshPhone(),
        city: null,
        auth_user_id: '00000000-0000-0000-0000-000000000001',
      }),
    })

    expect(response.ok).toBe(false)
  })
})

/* ========================================================================== */
/* Ce qui est refusé, et ce qui reste derrière                                 */
/* ========================================================================== */

describe('une saisie incomplète', () => {
  it.each([
    ['sans nom de commerce', { businessName: '' }],
    ['sans nom de patron', { ownerName: '' }],
    ['sans téléphone', { phone: '' }],
    ['avec un téléphone invalide', { phone: '0612' }],
    ['avec un mot de passe trop court', { password: '123' }],
  ])('est refusée %s', async (_label, override) => {
    const editor = await signedInAs('super_admin')

    const created = await createTenant(editor, validInput(override))

    expect(created.status).toBe(400)
    expect(created.tenantId).toBeNull()
    expect(created.error).not.toBeNull()
  })

  /* SPEC § 2.6 : ce qui est facultatif l'est vraiment. */
  it('accepte un commerce sans ville', async () => {
    const editor = await signedInAs('super_admin')

    const created = await createTenant(editor, validInput({ city: '' }))

    expect(created.status).toBe(201)
    const { rows } = await db.query<{ city: string | null }>(
      'select city from public.tenant where id = $1',
      [created.tenantId],
    )
    expect(rows[0]?.city).toBeNull()
  })
})

describe('un numéro déjà rattaché', () => {
  it('est refusé, et ne laisse pas un second commerce derrière lui', async () => {
    const editor = await signedInAs('super_admin')
    const phone = freshPhone()

    const first = await createTenant(editor, validInput({ phone }))
    expect(first.status).toBe(201)

    const second = await createTenant(editor, validInput({ phone, businessName: 'Autre' }))
    expect(second.status).toBe(409)
    expect(second.tenantId).toBeNull()

    const { rows } = await db.query<{ count: string }>(
      'select count(*) as count from public.tenant where phone = $1',
      [phone],
    )
    expect(rows[0]?.count).toBe('1')
  })
})

/*
 * L'atomicité. `create_tenant()` est transactionnelle, mais le compte Auth lui
 * est extérieur : deux systèmes, pas de transaction commune. Ce qui est vérifié
 * ici est le résidu — il ne doit jamais y avoir de commerce sans patron, c'est-
 * à-dire une ligne visible dans la liste de l'éditeur où personne ne peut
 * entrer et que rien ne distingue d'un commerce valide.
 */
describe('un échec en cours de route', () => {
  it('ne laisse aucun commerce à moitié créé', async () => {
    const editor = await signedInAs('super_admin')
    const before = await db.query<{ count: string }>('select count(*) as count from public.tenant')

    // Refusé par la RPC, après que la fonction Edge a franchi ses propres
    // contrôles : `create_tenant()` exige un nom de patron non vide, la
    // fonction Edge aussi — on passe donc par un refus que seule la base peut
    // rendre, en visant la contrainte de préfixe d'appareil.
    await db.query(
      "create or replace function merx.break_device() returns trigger language plpgsql as $$" +
        " begin raise exception 'panne simulée'; end; $$",
    )
    await db.query(
      'create trigger break_device before insert on public.device' +
        ' for each row execute function merx.break_device()',
    )

    try {
      const created = await createTenant(editor, validInput())
      expect(created.status).toBeGreaterThanOrEqual(400)
      expect(created.tenantId).toBeNull()
    } finally {
      await db.query('drop trigger break_device on public.device')
      await db.query('drop function merx.break_device()')
    }

    const after = await db.query<{ count: string }>('select count(*) as count from public.tenant')
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
  })
})

/* ========================================================================== */
/* La dernière activité                                                        */
/* ========================================================================== */

/*
 * E1-01 : « Liste des commerces avec date de création et dernière activité. »
 * `last_seen_at` était une colonne que rien n'écrivait ; l'estampille est posée
 * par le hook d'émission de jeton, seul point que tout accès traverse.
 */
describe('la dernière activité', () => {
  it('est nulle avant la première connexion, et posée après', async () => {
    const editor = await signedInAs('super_admin')
    const input = validInput()
    const created = await createTenant(editor, input)

    const seenAt = async (): Promise<string | null> => {
      const { rows } = await db.query<{ last_seen_at: string | null }>(
        'select last_seen_at from public.app_user where tenant_id = $1',
        [created.tenantId],
      )
      return rows[0]?.last_seen_at ?? null
    }

    expect(await seenAt()).toBeNull()

    await sessionFor(`${created.phone}@merx.invalid`, OWNER_PASSWORD)

    expect(await seenAt()).not.toBeNull()
  })
})
