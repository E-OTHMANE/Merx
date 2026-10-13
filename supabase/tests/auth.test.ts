// @vitest-environment node

/*
 * E0-04 — la connexion, jusqu'aux lignes qu'elle donne le droit de lire.
 *
 * Trois maillons étaient déjà tenus séparément :
 *   — `isolation.test.ts`   : les policies sont justes, claims posés à la main.
 *   — `access-token.test.ts`: un jeton émis porte `tenant_id`.
 *   — les tests du front    : la session s'ouvre, se garde, se ferme.
 *
 * Aucun ne parcourt le chemin que l'application emprunte réellement. C'est ce
 * que fait ce fichier : un mot de passe entre, un jeton signé sort, il part
 * dans un en-tête HTTP vers PostgREST, et l'on regarde ce qui revient.
 *
 * Le balayage part de `merx.convention_registry` — jamais d'une liste écrite à
 * la main. Les tables du catalogue (E2), du stock (E3) et la suite entrent
 * d'elles-mêmes dans ce test le jour où elles sont créées. Une table qui
 * fuirait à travers un vrai jeton serait signalée sans que personne ait pensé
 * à l'ajouter ici.
 *
 * Il écrit hors transaction : PostgREST est un autre processus, il ne verrait
 * rien d'une transaction ouverte ici. Le ménage est donc explicite, et fait
 * même en cas d'échec.
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registeredTables, seedTwoTenants, type Seeded } from './isolation'
import {
  createAuthUser,
  deleteAuthUser,
  deleteRows,
  payloadOf,
  refreshSession,
  rest,
  sessionFor,
  signInWithPassword,
} from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

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

/* Les cas doivent exister à la collecte du fichier, avant les hooks. */
const TABLES = await tablesUnderTest()

async function tablesUnderTest(): Promise<string[]> {
  const client = await connect()
  try {
    const tables = await registeredTables(client)
    if (tables.length === 0) {
      throw new Error(
        'Registre de conventions vide : le balayage ne vérifierait rien.\n' +
          'Reconstruire la base : npx supabase db reset',
      )
    }
    return tables
  } finally {
    await client.end()
  }
}

/* ========================================================================== */
/* Ce que Supabase Auth accepte, et ce qu'il refuse                            */
/* ========================================================================== */

describe('la connexion par email et mot de passe', () => {
  let client: Client
  let authUser: string
  let tenant: string
  let appUser: string
  const email = `login-${crypto.randomUUID()}@merx.test`

  beforeAll(async () => {
    client = await connect()
    authUser = await createAuthUser(email, PASSWORD)

    const { rows } = await client.query<{ id: string }>(
      "insert into public.tenant (business_name, tenant_id) values ('Connexion', gen_random_uuid()) returning id",
    )
    tenant = rows[0]!.id

    const created = await client.query<{ id: string }>(
      'insert into public.app_user (auth_user_id, full_name, role, tenant_id)' +
        " values ($1, 'Patron', 'owner', $2) returning id",
      [authUser, tenant],
    )
    appUser = created.rows[0]!.id
  })

  afterAll(async () => {
    if (appUser !== undefined) {
      await client?.query('delete from public.app_user where id = $1', [appUser])
    }
    if (tenant !== undefined) {
      // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
      await client?.query('delete from public.warehouse where tenant_id = $1', [tenant])
      await client?.query('delete from public.tenant where id = $1', [tenant])
    }
    if (authUser !== undefined) await deleteAuthUser(authUser)
    await client?.end()
  })

  it('rend un jeton porteur du commerce', async () => {
    const { accessToken } = await sessionFor(email, PASSWORD)

    expect(payloadOf(accessToken).app_metadata?.tenant_id).toBe(tenant)
  })

  it('refuse un mot de passe faux, sans dire lequel des deux est faux', async () => {
    const outcome = await signInWithPassword(email, 'ce-nest-pas-le-bon')

    expect(outcome.accessToken).toBeNull()
    expect(outcome.status).toBe(400)
    expect(outcome.errorCode).toBe('invalid_credentials')
  })

  it('refuse un compte inconnu avec le même refus', async () => {
    const outcome = await signInWithPassword(`inconnu-${crypto.randomUUID()}@merx.test`, PASSWORD)

    expect(outcome.accessToken).toBeNull()
    expect(outcome.errorCode).toBe('invalid_credentials')
  })

  /*
   * « Session persistante entre les redémarrages » : au démarrage,
   * l'application ne se reconnecte pas, elle rejoue son `refresh_token`. Si le
   * commerce ne survivait pas à ce rejeu, l'utilisateur se retrouverait
   * authentifié et sans données — le seul mode de panne qu'on ne voit pas venir.
   */
  it('conserve le commerce après un rafraîchissement de jeton', async () => {
    const { refreshToken } = await sessionFor(email, PASSWORD)

    const renewed = await refreshSession(refreshToken)

    expect(renewed.accessToken).not.toBeNull()
    expect(payloadOf(renewed.accessToken!).app_metadata?.tenant_id).toBe(tenant)
  })

  /*
   * E1-02 a durci ce cas. Jusque-là, une fiche désactivée obtenait un jeton
   * sans commerce : la session s'ouvrait, vide, et c'est le front qui la
   * refermait. Le hook refuse désormais d'émettre le jeton (migration
   * `user_management.sql`) — « un compte désactivé ne peut plus se connecter »
   * se vérifie au point d'émission, pas dans l'application.
   *
   * Ce que ce cas garde de E0-04 : c'est bien la connexion réelle qui est
   * mesurée, par le même chemin que l'application. Le refus au rafraîchissement
   * est éprouvé dans `user-management.test.ts`.
   */
  it('refuse la connexion dès que la fiche est désactivée', async () => {
    await client.query('update public.app_user set is_active = false where id = $1', [appUser])

    const refused = await signInWithPassword(email, PASSWORD)
    expect(refused.accessToken, 'un compte désactivé obtient encore un jeton').toBeNull()
    expect(refused.status).toBe(403)

    await client.query('update public.app_user set is_active = true where id = $1', [appUser])

    // Et il revient : la désactivation coupe l'accès, elle ne détruit rien.
    expect((await signInWithPassword(email, PASSWORD)).accessToken).not.toBeNull()
  })
})

/* ========================================================================== */
/* Le jeton réel, à travers PostgREST                                          */
/* ========================================================================== */

describe('un jeton émis par Auth ne franchit pas la frontière', () => {
  let client: Client
  let seeded: Seeded
  let authUser: string
  let appUser: string
  let accessToken: string
  const email = `rest-${crypto.randomUUID()}@merx.test`

  beforeAll(async () => {
    client = await connect()

    // Deux commerces complets, une ligne par table métier de chaque côté —
    // la même machinerie que le test d'isolation, donc la même couverture.
    seeded = await seedTwoTenants(client)

    authUser = await createAuthUser(email, PASSWORD)
    const created = await client.query<{ id: string }>(
      'insert into public.app_user (auth_user_id, full_name, role, tenant_id)' +
        " values ($1, 'Patron', 'owner', $2) returning id",
      [authUser, seeded.tenants.a],
    )
    appUser = created.rows[0]!.id

    accessToken = (await sessionFor(email, PASSWORD)).accessToken

    /*
     * Le jeton porte-t-il bien le commerce A ? Sans ce contrôle, un jeton sans
     * claim rendrait toutes les assertions négatives vraies — rien n'est
     * lisible, donc rien ne fuit — et le fichier resterait vert en n'ayant
     * mesuré que sa propre erreur. Même piège que `actAs()` un étage plus bas.
     */
    const claims = payloadOf(accessToken).app_metadata
    if (claims?.tenant_id !== seeded.tenants.a) {
      throw new Error(
        `Le jeton porte le commerce ${claims?.tenant_id ?? 'NULL'}, attendu ${seeded.tenants.a}. ` +
          'Tout ce qui suit serait vert sans rien prouver.',
      )
    }
    if (claims.role !== 'owner') {
      throw new Error(`Le jeton porte le rôle ${claims.role ?? 'NULL'}, attendu owner.`)
    }
  })

  afterAll(async () => {
    if (appUser !== undefined) {
      await client?.query('delete from public.app_user where id = $1', [appUser])
    }
    if (authUser !== undefined) await deleteAuthUser(authUser)
    if (seeded !== undefined) {
      await deleteRows(client, seeded.order, seeded.rows.a)
      await deleteRows(client, seeded.order, seeded.rows.b)
    }
    await client?.end()
  })

  describe.each(TABLES)('%s', (table) => {
    const own = (): string => required(seeded.rows.a.get(table), table)
    const foreign = (): string => required(seeded.rows.b.get(table), table)

    it('lit sa ligne', async () => {
      const response = await rest(`${table}?id=eq.${own()}&select=id`, { token: accessToken })

      expect(response.status, response.body).toBe(200)
      expect(response.rows, 'sa propre ligne est invisible à travers PostgREST').toHaveLength(1)
    })

    it('ne lit pas celle du commerce voisin', async () => {
      const response = await rest(`${table}?id=eq.${foreign()}&select=id`, { token: accessToken })

      expect(response.status, response.body).toBe(200)
      expect(response.rows, 'FUITE — la ligne du commerce B est lisible par API').toHaveLength(0)
    })

    it('ne voit jamais la ligne du voisin dans une lecture large', async () => {
      const response = await rest(`${table}?select=id`, { token: accessToken })

      const ids = response.rows.map((row) => row.id)
      expect(ids, 'sa propre ligne est absente').toContain(own())
      expect(ids, 'FUITE — la ligne du commerce B remonte dans la liste').not.toContain(foreign())
    })

    it('ne modifie pas la ligne du voisin', async () => {
      const response = await rest(`${table}?id=eq.${foreign()}`, {
        token: accessToken,
        method: 'PATCH',
        body: { updated_at: new Date().toISOString() },
      })

      expect(response.rows, 'FUITE — la ligne du commerce B est modifiable par API').toHaveLength(0)
    })

    it('ne supprime pas la ligne du voisin', async () => {
      const response = await rest(`${table}?id=eq.${foreign()}`, {
        token: accessToken,
        method: 'DELETE',
      })

      expect(response.rows, 'FUITE — la ligne du commerce B est supprimable par API').toHaveLength(
        0,
      )
    })

    /*
     * Sans jeton, il ne reste que la clé `anon` — celle qui est publiée dans le
     * bundle du front, lisible par n'importe qui avec les outils du navigateur.
     * Elle ne doit rien ouvrir : tout l'applicatif est derrière authentification
     * (SPEC § 2.7), et E0-03 lui retire ses privilèges sur chaque table.
     */
    it("la clé publique seule n'ouvre rien", async () => {
      const response = await rest(`${table}?select=id`)

      expect(response.rows, 'FUITE — la clé anon lit une table métier').toHaveLength(0)
      expect([401, 403]).toContain(response.status)
    })
  })
})

function required(id: string | undefined, table: string): string {
  if (id === undefined) throw new Error(`${table} : aucune ligne peuplée`)
  return id
}
