// @vitest-environment node

/*
 * E0-05 — un appel API brut par un `worker` ne contient jamais `cost_price`.
 * SPEC § 3 (RÈGLE de filtrage serveur, RÈGLE de placement des coûts), § 3.1.
 *
 * C'est le cœur de la story, et il ne se vérifie pas sur un composant : masquer
 * un champ dans l'interface n'est pas un contrôle d'accès. Ce qui est examiné
 * ici est le **texte** du corps rendu par PostgREST à un employé réel, connecté
 * par mot de passe, sur un jeton signé.
 *
 * Le test travaille sur une paire de tables témoin qu'il crée et supprime
 * lui-même (voir `permissions.ts`) : le mécanisme est livré aujourd'hui, les
 * colonnes de coût arrivent en E2, et rien ne justifie d'attendre E2 pour
 * savoir si le mécanisme tient.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CAPABILITIES, type Capability } from '@/lib/auth/permissions'
import { isolationViolations } from './isolation'
import {
  CONFIDENTIAL_COLUMN,
  PROBE_BASE,
  PROBE_COST,
  cleanTenant,
  confidentialColumns,
  createProbe,
  dropProbe,
  rawBody,
  seedTenant,
  type Fixture,
} from './permissions'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

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

let client: Client
let fixture: Fixture
const tokens = {} as Record<'owner' | 'worker', string>

const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
}

beforeAll(async () => {
  client = await connect()
  await createProbe(client)

  const authUsers = {
    owner: await createAuthUser(emails.owner, PASSWORD),
    worker: await createAuthUser(emails.worker, PASSWORD),
  }
  fixture = await seedTenant(client, emails, authUsers)

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  await cleanTenant(client, fixture)
  for (const role of ['owner', 'worker'] as const) {
    const authUser = fixture?.users[role]?.authUser
    if (authUser !== undefined) await deleteAuthUser(authUser)
  }
  await dropProbe(client)
  await client?.end()
}, 60_000)

/* ========================================================================== */
/* Le critère central                                                          */
/* ========================================================================== */

describe("le corps rendu à un employé", () => {
  /*
   * Les quatre façons de demander la colonne. La première est celle que
   * l'application émettra ; les trois autres sont celles qu'on essaie quand on
   * cherche à contourner.
   */
  const attempts = [
    ['la table ordinaire', `${PROBE_BASE}?select=*`],
    ['la relation de coût', `${PROBE_COST}?select=*`],
    ['la colonne, nommément', `${PROBE_COST}?select=${CONFIDENTIAL_COLUMN}`],
    ['la relation de coût, imbriquée', `${PROBE_BASE}?select=*,${PROBE_COST}(*)`],
  ] as const

  it.each(attempts)('%s : le texte ne contient pas cost_price', async (_label, path) => {
    const { body } = await rawBody(path, tokens.worker)

    /*
     * Sur le corps entier, pas sur un objet parsé : `rows[0].cost_price ===
     * undefined` serait vrai aussi pour `{"cost_price": null}`, c'est-à-dire
     * pour un champ masqué — exactement ce que la RÈGLE § 3 refuse.
     */
    expect(body).not.toContain(CONFIDENTIAL_COLUMN)
  })

  it('ne rend aucune ligne de la relation de coût', async () => {
    const result = await rest(`${PROBE_COST}?select=*`, { token: tokens.worker })

    expect(result.status).toBe(200)
    expect(result.rows).toHaveLength(0)
  })

  it("n'écrit pas non plus dans la relation de coût", async () => {
    const inserted = await rest(PROBE_COST, {
      token: tokens.worker,
      method: 'POST',
      body: {
        [`${PROBE_BASE}_id`]: fixture.variant,
        [CONFIDENTIAL_COLUMN]: '1.00',
        tenant_id: fixture.tenant,
      },
    })

    // `with check` autant que `using` : sans lui, l'employé ne lirait pas les
    // coûts mais pourrait en poser.
    expect(inserted.ok).toBe(false)
    expect(inserted.code).toBe('42501')

    const updated = await rest(`${PROBE_COST}?id=eq.${fixture.cost}`, {
      token: tokens.worker,
      method: 'PATCH',
      body: { [CONFIDENTIAL_COLUMN]: '1.00' },
    })
    expect(updated.rows).toHaveLength(0)
  })
})

describe('le corps rendu au patron', () => {
  it('contient la colonne et sa valeur', async () => {
    const { body } = await rawBody(`${PROBE_COST}?select=*`, tokens.owner)

    expect(body).toContain(CONFIDENTIAL_COLUMN)
    expect(body).toContain('42.50')
  })

  it("prouve que l'absence chez l'employé vient du droit, pas d'une base vide", async () => {
    // Sans cette assertion, tout le fichier passerait sur une relation vide :
    // il ne mesurerait que sa propre erreur de préparation.
    const result = await rest(`${PROBE_COST}?select=*`, { token: tokens.owner })
    expect(result.rows).toHaveLength(1)
  })
})

/* ========================================================================== */
/* Le balayage — ce qui vaudra encore quand E2 sera là                         */
/* ========================================================================== */

describe('toute relation déclarée confidentielle', () => {
  /*
   * Le témoin prouve le mécanisme aujourd'hui ; ce balayage protège demain. Il
   * part de `merx.confidential_registry` : la relation de coût du catalogue
   * (E2) y entrera d'elle-même, et sera vérifiée ici sans qu'une ligne de ce
   * fichier change. Une liste de tables écrite à la main aurait cessé de
   * protéger quoi que ce soit à la première table oubliée.
   */
  it('ne laisse fuir aucune de ses colonnes dans le corps rendu à un employé', async () => {
    const byTable = await confidentialColumns(client)
    expect(byTable.size).toBeGreaterThan(0)

    for (const [table, columns] of byTable) {
      const { body } = await rawBody(`${table}?select=*`, tokens.worker)
      for (const column of columns) {
        expect(body, `${table}.${column} apparaît dans la réponse`).not.toContain(column)
      }
    }
  })
})

describe('le contrôle de policies de E0-03, étendu', () => {
  /*
   * `isolation.test.ts` exige deux policies exactement, ni plus. E0-05 en
   * ajoute une troisième, restrictive, sur les seules relations confidentielles
   * — et la branche correspondante ne peut être exercée que là où une telle
   * relation existe, c'est-à-dire ici. Sans ces deux cas, le contrôle étendu ne
   * serait vérifié par personne jusqu'à E2.
   */
  it('accepte la policy restrictive du témoin', async () => {
    const found = await isolationViolations(client, 'les policies attendues, exactement')
    expect(found.filter((v) => v.table_name === PROBE_COST)).toEqual([])
  })

  it('signale une relation déclarée confidentielle sans policy restrictive', async () => {
    // La table de base n'en a pas : la déclarer confidentielle le temps d'une
    // assertion doit suffire à la faire signaler.
    await client.query('insert into merx.confidential_registry values ($1, $2)', [
      PROBE_BASE,
      'view_cost',
    ])
    try {
      const found = await isolationViolations(client, 'les policies attendues, exactement')
      const onBase = found.filter((v) => v.table_name === PROBE_BASE)

      expect(onBase).toHaveLength(1)
      expect(onBase[0]!.detail).toContain('capability_restriction')
    } finally {
      await client.query('delete from merx.confidential_registry where table_name = $1', [
        PROBE_BASE,
      ])
    }
  })
})

/* ========================================================================== */
/* Le helper unique, et la matrice                                             */
/* ========================================================================== */

describe('merx.can()', () => {
  it("n'est pas une surface d'API", async () => {
    // Le helper vit dans `merx`, que `config.toml` n'expose pas. S'il devenait
    // appelable, un client choisirait la capacité qu'on lui évalue.
    const result = await rest('rpc/can', { method: 'POST', body: { wanted: 'view_cost' } })
    expect(result.ok).toBe(false)
  })

  it('refuse une capacité inconnue plutôt que de l’accorder', async () => {
    const { rows } = await client.query<{ allowed: boolean }>(
      "select merx.can('capacite_inexistante') as allowed",
    )
    expect(rows[0]!.allowed).toBe(false)
  })

  it('rend le rôle métier, jamais le rôle Postgres du premier niveau', async () => {
    /*
     * Le piège de E0-03, reposé un étage plus haut : un jeton qui porte
     * `super_admin` au premier niveau porte un rôle Postgres, pas un rôle
     * métier. Le confondre donnerait toutes les capacités à toute session.
     */
    await client.query('begin')
    try {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ role: 'super_admin', app_metadata: { role: 'worker' } }),
      ])
      await client.query('set local role authenticated')

      const { rows } = await client.query<{ allowed: boolean }>(
        "select merx.can('view_cost') as allowed",
      )
      expect(rows[0]!.allowed).toBe(false)
    } finally {
      await client.query('rollback')
    }
  })
})

describe('la matrice SPEC § 3.1', () => {
  /*
   * La base et le front en tiennent chacun une copie. Sans cette comparaison,
   * elles divergeraient — et la divergence s'afficherait comme un droit : un
   * bouton visible pour une action que le serveur refuse, ou pire, une action
   * cachée que le serveur accepte.
   */
  it('est la même en base et dans src/lib/auth/permissions.ts', async () => {
    const { rows } = await client.query<{ capability: string; role: string }>(
      'select capability, role from merx.role_capability order by capability, role',
    )
    const inDatabase = rows.map((r) => `${r.capability}:${r.role}`)

    const inFront = Object.entries(CAPABILITIES)
      .flatMap(([capability, roles]) => roles.map((role) => `${capability}:${role}`))
      .sort()

    expect(inDatabase).toEqual(inFront)
  })

  it('ne connaît que les capacités déclarées côté front', async () => {
    const { rows } = await client.query<{ capability: string }>(
      'select distinct capability from merx.role_capability',
    )
    const known = new Set(Object.keys(CAPABILITIES) as Capability[])

    for (const { capability } of rows) {
      expect(known).toContain(capability)
    }
  })
})
