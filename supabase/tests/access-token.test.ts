// @vitest-environment node

/*
 * E0-03 — le claim que lisent les policies existe-t-il vraiment ?
 *
 * `isolation.test.ts` pose les claims lui-même, comme PostgREST les pose. Cela
 * prouve que les policies lisent correctement un jeton — pas qu'un jeton émis
 * par Supabase Auth porte quoi que ce soit. Les deux se vérifient séparément,
 * sinon on peut livrer des policies parfaites branchées sur un claim que rien
 * ne remplit : la base serait close pour tout le monde, y compris ses
 * utilisateurs légitimes, et le test d'isolation resterait vert.
 *
 * Ce fichier ferme la chaîne : `app_user` → hook → jeton signé → claim.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54521'

/* Clé de service du stack local, publique et sans valeur ailleurs. */
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const configPath = fileURLToPath(new URL('../config.toml', import.meta.url))

interface AppMetadata {
  tenant_id?: string
  role?: string
}

/** Le contenu d'un JWT, sans en vérifier la signature — c'est Supabase qui signe. */
function payloadOf(token: string): { app_metadata?: AppMetadata; role?: string } {
  const [, payload] = token.split('.')
  if (payload === undefined) throw new Error('jeton illisible')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

/*
 * Le hook n'est pas du code : c'est une ligne de configuration. Elle se
 * désactive d'un caractère, et rien dans le schéma ne s'en apercevrait.
 */
describe('le hook est branché', () => {
  const config = readFileSync(configPath, 'utf8')

  it('est activé dans config.toml et pointe sur la fonction', () => {
    const section = config.match(/\[auth\.hook\.custom_access_token\][^[]*/)?.[0]

    expect(section, 'section [auth.hook.custom_access_token] absente').toBeDefined()
    expect(section).toMatch(/^\s*enabled\s*=\s*true\s*$/m)
    expect(section).toMatch(/^\s*uri\s*=\s*"pg-functions:\/\/postgres\/merx\/custom_access_token"\s*$/m)
  })
})

/*
 * La fonction seule, sur des cas qu'on ne peut pas produire à la demande par
 * l'API : fiche absente, désactivée, supprimée, et jeton déjà porteur d'un
 * tenant qui n'est pas le sien.
 */
describe('merx.custom_access_token', () => {
  let client: Client
  let tenant: string
  let authUser: string

  beforeAll(async () => {
    client = new Client({ connectionString: CONNECTION_STRING })
    await client.connect()
    await client.query('begin')

    const { rows } = await client.query<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Hook', gen_random_uuid()) returning id",
    )
    tenant = rows[0]!.id

    const auth = await client.query<{ id: string }>(`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', 'hook@merx.test')
      returning id
    `)
    authUser = auth.rows[0]!.id
  })

  afterAll(async () => {
    await client?.query('rollback')
    await client?.end()
  })

  const claimsFor = async (user: string, incoming: object = {}): Promise<AppMetadata> => {
    const { rows } = await client.query<{ metadata: AppMetadata }>(
      `select merx.custom_access_token($1::jsonb) -> 'claims' -> 'app_metadata' as metadata`,
      [JSON.stringify({ user_id: user, claims: incoming })],
    )
    return rows[0]?.metadata ?? {}
  }

  it('ne donne aucun tenant à un compte sans fiche app_user', async () => {
    expect(await claimsFor(authUser)).toEqual({})
  })

  it('donne le tenant et le rôle métier de la fiche', async () => {
    await client.query(
      "insert into public.app_user (auth_user_id, full_name, role, tenant_id) values ($1, 'Patron', 'owner', $2)",
      [authUser, tenant],
    )

    expect(await claimsFor(authUser)).toEqual({ tenant_id: tenant, role: 'owner' })
  })

  it('retire un tenant déjà présent dans le jeton entrant', async () => {
    const forged = { app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' } }

    expect(await claimsFor(authUser, forged)).toEqual({ tenant_id: tenant, role: 'owner' })
  })

  it('ne donne rien à une fiche désactivée', async () => {
    await client.query('savepoint deactivated')
    await client.query('update public.app_user set is_active = false where auth_user_id = $1', [
      authUser,
    ])

    expect(await claimsFor(authUser)).toEqual({})
    await client.query('rollback to savepoint deactivated')
  })

  it('ne donne rien à une fiche supprimée', async () => {
    await client.query('savepoint deleted')
    await client.query('update public.app_user set deleted_at = now() where auth_user_id = $1', [
      authUser,
    ])

    expect(await claimsFor(authUser)).toEqual({})
    await client.query('rollback to savepoint deleted')
  })

  it('laisse intacts les autres claims du jeton', async () => {
    const { rows } = await client.query<{ claims: Record<string, unknown> }>(
      `select merx.custom_access_token($1::jsonb) -> 'claims' as claims`,
      [
        JSON.stringify({
          user_id: authUser,
          claims: { sub: authUser, role: 'authenticated', email: 'hook@merx.test' },
        }),
      ],
    )

    expect(rows[0]?.claims).toMatchObject({
      sub: authUser,
      role: 'authenticated',
      email: 'hook@merx.test',
    })
  })
})

/*
 * La chaîne entière, à travers Supabase Auth : c'est le seul test qui prouve
 * qu'un jeton réellement émis porte le tenant. Il écrit hors transaction — le
 * service d'authentification est un autre processus, il ne verrait rien d'une
 * transaction ouverte ici.
 */
describe('un jeton émis par Supabase Auth porte le tenant', () => {
  let client: Client
  let tenant: string
  let authUser: string
  const email = `e2e-${crypto.randomUUID()}@merx.test`
  const password = crypto.randomUUID()

  const admin = async (path: string, init: RequestInit): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })

  const signIn = async (): Promise<string> => {
    const response = await admin('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    const body = (await response.json()) as { access_token?: string; error_description?: string }

    if (body.access_token === undefined) {
      throw new Error(`connexion refusée : ${JSON.stringify(body)}`)
    }
    return body.access_token
  }

  beforeAll(async () => {
    client = new Client({ connectionString: CONNECTION_STRING })
    await client.connect()

    const created = await admin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    const body = (await created.json()) as { id?: string }
    if (body.id === undefined) {
      throw new Error(
        `Service d'authentification injoignable sur ${API_URL} : ${JSON.stringify(body)}\n` +
          'Démarrer le stack : npx supabase start',
      )
    }
    authUser = body.id

    const { rows } = await client.query<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('E2E', gen_random_uuid()) returning id",
    )
    tenant = rows[0]!.id

    await client.query(
      "insert into public.app_user (auth_user_id, full_name, role, tenant_id) values ($1, 'Patron', 'owner', $2)",
      [authUser, tenant],
    )
  })

  afterAll(async () => {
    // Écrit hors transaction : le ménage est explicite, et fait même en échec.
    if (authUser !== undefined) {
      await client?.query('delete from public.app_user where auth_user_id = $1', [authUser])
      await admin(`/auth/v1/admin/users/${authUser}`, { method: 'DELETE' })
    }
    if (tenant !== undefined) {
      // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
      await client?.query('delete from public.warehouse where tenant_id = $1', [tenant])
      await client?.query('delete from public.tenant where id = $1', [tenant])
    }
    await client?.end()
  })

  it('dépose tenant_id et le rôle métier dans app_metadata', async () => {
    const claims = payloadOf(await signIn())

    expect(claims.app_metadata?.tenant_id, 'le hook ne remplit pas le jeton').toBe(tenant)
    expect(claims.app_metadata?.role).toBe('owner')
  })

  it('laisse le rôle Postgres au premier niveau — les deux ne se confondent pas', async () => {
    const claims = payloadOf(await signIn())

    expect(claims.role).toBe('authenticated')
  })

  /*
   * E1-02 : le hook ne se contente plus de retirer le commerce d'un compte
   * désactivé, il refuse d'émettre le jeton. Le cas mesure donc la réponse du
   * point d'émission, et non plus le contenu d'un jeton qui n'existe plus.
   */
  it("ne délivre plus de jeton dès que la fiche est désactivée", async () => {
    await client.query('update public.app_user set is_active = false where auth_user_id = $1', [
      authUser,
    ])

    const response = await admin('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    const body = (await response.json()) as { access_token?: string }

    expect(body.access_token, 'un compte désactivé obtient encore un jeton').toBeUndefined()
    expect(response.status).toBe(403)

    await client.query('update public.app_user set is_active = true where auth_user_id = $1', [
      authUser,
    ])

    // Le compte revient : c'est une porte fermée, pas une fiche perdue.
    expect(payloadOf(await signIn()).app_metadata?.tenant_id).toBe(tenant)
  })
})
