// @vitest-environment node

/*
 * E1-05 — les réglages du commerce, et surtout leurs défauts.
 * SPEC § 9 M8 (`tenant_setting`), § 3.1 (`manage_settings`), § 2.6, § 2.8.
 *
 * Le critère qui porte la story n'est pas la table : c'est que l'application
 * fonctionne sans que personne n'ouvre cet écran. Il se vérifie ici, et
 * aujourd'hui, alors qu'aucun consommateur n'existe encore — l'impression est
 * E5, la bascule de langue E11. Ce qui est éprouvé n'est donc pas « le ticket
 * sort bien », mais la propriété dont le ticket dépendra :
 *
 *     un commerce créé par le chemin réel a, dès sa première seconde, une
 *     valeur utilisable pour chacune de ses clés — et personne n'a rien réglé.
 *
 * Le second sujet du fichier est la forme d'accès, nouvelle dans le projet :
 * tout le commerce lit, le patron seul écrit. Le balayage d'écriture part de
 * `merx.write_capability_registry` et ne nomme aucune table : la grille de prix
 * (E2-03) et les plafonds de crédit (E6) y entreront sans qu'une ligne d'ici
 * change.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SETTING_KEYS } from '@/modules/admin/settingKeys'
import {
  INSUFFICIENT_PRIVILEGE,
  actAs,
  attempt,
  isolationViolations,
  tokenFor,
  writeCapabilityTables,
} from './isolation'
import { createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

/* Le commerce du fichier. Les valeurs comptent : l'en-tête d'impression par
   défaut doit les reprendre, et c'est ce qu'on vérifie. */
const BUSINESS_NAME = 'Parfumerie des Réglages'
const OWNER_NAME = 'Patron Réglages'
const OWNER_PHONE = '+212600000105'
const CITY = 'Casablanca'

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
 * Le registre est lu avant les hooks : `describe.each` a besoin de ses cas au
 * moment de la collecte du fichier, pas quand `beforeAll` tourne. Même geste
 * qu'`isolation.test.ts` avec le registre de conventions.
 */
const WRITE_RESTRICTED = await writeRestrictedUnderTest()

async function writeRestrictedUnderTest(): Promise<Array<[string, string]>> {
  const client = await connect()
  try {
    const registry = await writeCapabilityTables(client)
    if (registry.size === 0) {
      throw new Error(
        'Registre des écritures restreintes vide : le balayage ne vérifierait rien.\n' +
          'Reconstruire la base : npx supabase db reset',
      )
    }
    return [...registry.entries()]
  } finally {
    await client.end()
  }
}

let client: Client
let tenant: string
const authUsers = {} as Record<'owner' | 'worker', string>
const tokens = {} as Record<'owner' | 'worker', string>

const emails = {
  owner: `owner-${crypto.randomUUID()}@merx.test`,
  worker: `worker-${crypto.randomUUID()}@merx.test`,
}

/**
 * Crée le commerce par le chemin réel : la RPC `create_tenant()`, sous un jeton
 * `super_admin`. Insérer les lignes à la main ferait passer le test à côté de
 * ce qu'il mesure — c'est justement l'appel de `merx.seed_tenant_settings()`
 * depuis cette fonction-là qui est en jeu.
 */
async function createTenantAsEditor(): Promise<string> {
  await client.query('begin')
  try {
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ role: 'authenticated', app_metadata: { role: 'super_admin' } }),
    ])
    await client.query('set local role authenticated')

    const { rows } = await client.query<{ id: string }>(
      'select public.create_tenant($1, $2, $3, $4, $5) as id',
      [BUSINESS_NAME, OWNER_NAME, OWNER_PHONE, CITY, authUsers.owner],
    )
    await client.query('commit')
    return rows[0]!.id
  } catch (error) {
    await client.query('rollback')
    throw error
  }
}

beforeAll(async () => {
  client = await connect()

  authUsers.owner = await createAuthUser(emails.owner, PASSWORD)
  authUsers.worker = await createAuthUser(emails.worker, PASSWORD)

  tenant = await createTenantAsEditor()

  await client.query(
    'insert into public.app_user (auth_user_id, full_name, role, tenant_id)' +
      " values ($1, 'Employé Réglages', 'worker', $2)",
    [authUsers.worker, tenant],
  )

  for (const role of ['owner', 'worker'] as const) {
    tokens[role] = (await sessionFor(emails[role], PASSWORD)).accessToken
  }
}, 60_000)

afterAll(async () => {
  if (client !== undefined && tenant !== undefined) {
    await client.query('reset role')
    await client.query('delete from public.tenant_setting where tenant_id = $1', [tenant])
    await client.query('delete from public.device where tenant_id = $1', [tenant])
    await client.query('delete from public.warehouse where tenant_id = $1', [tenant])
    await client.query('delete from public.app_user where tenant_id = $1', [tenant])
    await client.query('delete from public.tenant where id = $1', [tenant])
  }

  for (const role of ['owner', 'worker'] as const) {
    if (authUsers[role] !== undefined) await deleteAuthUser(authUsers[role])
  }
  await client?.end()
}, 60_000)

/** Les réglages du commerce du test, lus en tant que `postgres`. */
async function settingsOfTenant(): Promise<Map<string, unknown>> {
  await client.query('reset role')
  const { rows } = await client.query<{ key: string; value: unknown }>(
    'select key, value from public.tenant_setting where tenant_id = $1',
    [tenant],
  )
  return new Map(rows.map((r) => [r.key, r.value]))
}

/* ========================================================================== */
/* Les défauts — une seule source, et elle couvre tout                         */
/* ========================================================================== */

describe('merx.setting_default', () => {
  /*
   * La règle qui rend l'invariant tenable : une clé sans défaut est une clé que
   * `seed_tenant_settings()` ne pose pas, donc une absence que l'application
   * rencontrera un jour — c'est-à-dire le cas qu'aucun écran ne sait traiter.
   * Le contrôle est bidirectionnel : un défaut orphelin signale une clé retirée
   * du type sans que le registre suive.
   */
  it('couvre exactement les clés de public.setting_key', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ key: string; defaulted: boolean }>(`
      select label as key, (d.key is not null) as defaulted
      from unnest(enum_range(null::public.setting_key)) as label
      left join merx.setting_default d on d.key = label
      order by 1
    `)
    expect(rows.filter((r) => !r.defaulted)).toEqual([])

    const { rows: orphans } = await client.query<{ key: string }>(`
      select d.key from merx.setting_default d
      where d.key::text <> all (
        select label::text from unnest(enum_range(null::public.setting_key)) as label
      )
    `)
    expect(orphans).toEqual([])
  })

  /*
   * La contrepartie de « le code ne porte aucun défaut » : ce que le code
   * connaît, ce sont les *clés*, et cette liste-là doit être la même des deux
   * côtés. Une clé ajoutée en base et pas au front laisserait un réglage
   * inaccessible ; l'inverse afficherait un champ qui n'existe pas.
   *
   * Même raisonnement, même remède qu'`src/lib/auth/permissions.ts` pour la
   * matrice § 3.1.
   */
  it('est déclarée avec les mêmes clés dans src/modules/admin/settingKeys.ts', async () => {
    await client.query('reset role')
    const { rows } = await client.query<{ key: string }>(
      'select label::text as key from unnest(enum_range(null::public.setting_key)) as label order by 1',
    )
    expect(rows.map((r) => r.key)).toEqual([...SETTING_KEYS].sort())
  })
})

describe('un commerce créé par create_tenant()', () => {
  /*
   * Le critère de la story, dit en une assertion : personne n'a ouvert l'écran,
   * et pourtant tout est réglé.
   */
  it('a une ligne pour chaque clé, sans que personne ait rien réglé', async () => {
    const settings = await settingsOfTenant()
    expect([...settings.keys()].sort()).toEqual([...SETTING_KEYS].sort())
  })

  it('reprend le nom, le téléphone et la ville du commerce dans l’en-tête imprimé', async () => {
    const header = (await settingsOfTenant()).get('print_header') as Record<string, string>

    // Ce qui part chez le client sur le papier (E5-01). Un ticket anonyme est
    // le symptôme d'un défaut qui n'a pas été posé.
    expect(header).toEqual({
      business_name: BUSINESS_NAME,
      phone: OWNER_PHONE,
      address: CITY,
    })
  })

  it('parle français par défaut', async () => {
    expect((await settingsOfTenant()).get('default_language')).toBe('fr')
  })

  /*
   * L'absence d'imprimante est un réglage à part entière, pas une clé
   * manquante : l'écran montre un champ vide, et E5-01 lit une chaîne vide
   * plutôt que de buter sur une clé absente.
   */
  it('n’a pas d’imprimante, et le dit par une valeur plutôt que par une absence', async () => {
    const settings = await settingsOfTenant()
    expect(settings.has('printer_address')).toBe(true)
    expect(settings.get('printer_address')).toBe('')
  })

  /* Un défaut vide partout passerait les assertions de présence ci-dessus. */
  it('n’a aucune valeur nulle', async () => {
    for (const [key, value] of await settingsOfTenant()) {
      expect(value, `${key} est nul`).not.toBeNull()
    }
  })
})

describe('merx.seed_tenant_settings()', () => {
  it('n’écrase pas une valeur choisie par le patron', async () => {
    await client.query('reset role')
    await client.query(
      `update public.tenant_setting set value = '"192.168.1.50:9100"'::jsonb
       where tenant_id = $1 and key = 'printer_address'`,
      [tenant],
    )

    await client.query('select merx.seed_tenant_settings($1)', [tenant])

    expect((await settingsOfTenant()).get('printer_address')).toBe('192.168.1.50:9100')

    await client.query(
      `update public.tenant_setting set value = '""'::jsonb
       where tenant_id = $1 and key = 'printer_address'`,
      [tenant],
    )
  })

  /*
   * Le geste du rattrapage, celui que toute migration ajoutant une clé devra
   * répéter : une ligne absente est rétablie à son défaut, et elle seule.
   */
  it('rétablit une ligne manquante à son défaut', async () => {
    await client.query('reset role')
    await client.query(
      "delete from public.tenant_setting where tenant_id = $1 and key = 'default_language'",
      [tenant],
    )
    expect((await settingsOfTenant()).has('default_language')).toBe(false)

    await client.query('select merx.seed_tenant_settings($1)', [tenant])

    expect((await settingsOfTenant()).get('default_language')).toBe('fr')
  })

  it('refuse un commerce inconnu plutôt que d’écrire dans le vide', async () => {
    await client.query('reset role')
    await client.query('begin')
    try {
      const attempted = await attempt(
        client,
        "select merx.seed_tenant_settings('00000000-0000-0000-0000-000000000000'::uuid)",
      )
      expect(attempted.ok).toBe(false)
      if (!attempted.ok) expect(attempted.code).toBe('P0002')
    } finally {
      await client.query('rollback')
    }
  })

  /*
   * `authenticated` ne l'exécute pas : ce n'est pas une action d'utilisateur.
   * Sans ce refus, un employé pourrait repeupler les réglages d'un commerce —
   * inoffensif aujourd'hui, mais c'est une écriture sur une table dont on vient
   * de lui retirer l'écriture, par une porte que personne ne regarde.
   */
  it('n’est pas exécutable par authenticated', async () => {
    await client.query('begin')
    try {
      await actAs(client, tokenFor(tenant, 'owner'))
      const attempted = await attempt(client, `select merx.seed_tenant_settings('${tenant}'::uuid)`)

      expect(attempted.ok).toBe(false)
      if (!attempted.ok) expect(attempted.code).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await client.query('rollback')
    }
  })
})

/* ========================================================================== */
/* La lecture reste ouverte à l'employé — décision, pas oubli                   */
/* ========================================================================== */

describe('l’employé, sur le chemin réel de l’application', () => {
  /*
   * C'est la décision inhabituelle de la story, et elle mérite un test qui
   * tombe si quelqu'un « corrige » l'absence de `capability_restriction` :
   * l'employé imprime le bon (E5-01) et travaille dans la langue du commerce
   * (E11-01). Lui fermer la lecture bloquerait la vente — SPEC § 2.6.
   */
  it('lit tous les réglages du commerce', async () => {
    const result = await rest('tenant_setting?select=key,value', { token: tokens.worker })
    const keys = (result.rows as Array<{ key: string }>).map((r) => r.key).sort()

    expect(result.status).toBe(200)
    expect(keys).toEqual([...SETTING_KEYS].sort())
  })

  it('lit l’en-tête et l’adresse d’imprimante dont dépend le ticket', async () => {
    const result = await rest('tenant_setting?select=key,value&key=in.(print_header,printer_address)', {
      token: tokens.worker,
    })
    expect(result.rows).toHaveLength(2)
  })

  it('ne peut pas changer l’adresse de l’imprimante', async () => {
    const before = (await settingsOfTenant()).get('printer_address')

    const patched = await rest('tenant_setting?key=eq.printer_address', {
      token: tokens.worker,
      method: 'PATCH',
      body: { value: '10.0.0.9:9100' },
    })

    /*
     * La RLS ne lève pas sur un UPDATE : elle ne trouve simplement aucune ligne
     * à modifier. « Aucune erreur » ne prouverait donc rien — c'est la valeur
     * relue qui distingue une policy qui refuse d'une policy retirée.
     *
     * La valeur est assertée **en premier**, et c'est voulu : policy retirée,
     * ce test doit tomber sur « la valeur a changé », pas sur un compte de
     * lignes. Le compte vient après, en second témoin.
     */
    expect(
      (await settingsOfTenant()).get('printer_address'),
      "FUITE — l'employé a changé l'adresse de l'imprimante",
    ).toBe(before)
    expect(patched.rows).toHaveLength(0)
  })
})

describe('le patron, sur le chemin réel de l’application', () => {
  /*
   * Le contrôle positif, sans lequel tout ce qui précède serait satisfait par
   * une table verrouillée pour tout le monde. Et il porte sur la valeur, pas
   * sur un compte de lignes.
   */
  it('change une valeur, et elle change vraiment', async () => {
    const patched = await rest('tenant_setting?key=eq.printer_address', {
      token: tokens.owner,
      method: 'PATCH',
      body: { value: '192.168.1.77:9100' },
    })

    expect(patched.rows).toHaveLength(1)
    expect((await settingsOfTenant()).get('printer_address')).toBe('192.168.1.77:9100')

    await client.query(
      `update public.tenant_setting set value = '""'::jsonb
       where tenant_id = $1 and key = 'printer_address'`,
      [tenant],
    )
  })
})

/* ========================================================================== */
/* Le balayage — toute table à écriture restreinte, présente et à venir        */
/* ========================================================================== */

describe.each(WRITE_RESTRICTED)('%s, écriture réservée à %s', (table, capability) => {
  /*
   * Rien ici ne connaît `tenant_setting`. Le registre fournit la table et la
   * capacité ; les rôles qui l'ont et ceux qui ne l'ont pas sont lus dans la
   * matrice § 3.1. La grille de prix (E2-03) et les plafonds de crédit (E6)
   * seront éprouvés de la même façon en s'inscrivant.
   */
  let allowed: string[] = []
  let denied: string[] = []
  let row: string

  beforeAll(async () => {
    await client.query('reset role')

    const { rows: matrix } = await client.query<{ role: string }>(
      'select role::text as role from merx.role_capability where capability = $1',
      [capability],
    )
    allowed = matrix.map((r) => r.role)
    denied = ['owner', 'worker'].filter((role) => !allowed.includes(role))

    const { rows } = await client.query<{ id: string }>(
      `select id from public."${table}" where tenant_id = $1 order by id limit 1`,
      [tenant],
    )
    if (rows[0] === undefined) {
      // Jamais de table sautée en silence : un balayage qui s'esquive laisse la
      // suite au vert sans avoir rien vérifié.
      throw new Error(
        `${table} est au registre des écritures restreintes mais le commerce du ` +
          'test n’en a aucune ligne. Ajouter sa préparation dans le `beforeAll` ' +
          'de supabase/tests/settings.test.ts.',
      )
    }
    row = rows[0].id
  })

  it('la matrice donne bien la capacité à l’un et pas à l’autre', () => {
    // Sans les deux populations, le balayage ne compare rien : un refus opposé
    // à tout le monde ressemble à un droit bien posé.
    expect(allowed.length, `${capability} n’est accordée à personne`).toBeGreaterThan(0)
    expect(denied.length, `${capability} est accordée à tout le monde`).toBeGreaterThan(0)
  })

  /** L'état complet de la ligne : ce qui a bougé se voit, quelle que soit la table. */
  const snapshot = async (): Promise<string> => {
    await client.query('reset role')
    const { rows } = await client.query<{ state: string }>(
      `select to_jsonb(t.*)::text as state from public."${table}" t where id = $1`,
      [row],
    )
    return rows[0]?.state ?? '(ligne disparue)'
  }

  it.each(['owner', 'worker'])('%s — écrit si et seulement si la matrice le permet', async (role) => {
    const permitted = allowed.includes(role)
    const before = await snapshot()

    await client.query('begin')
    try {
      await actAs(client, tokenFor(tenant, role))

      const touched = await attempt(
        client,
        `update public."${table}" set updated_at = updated_at where id = '${row}'::uuid`,
      )
      expect(touched.ok, `refus inattendu : ${touched.ok ? '' : touched.message}`).toBe(true)
      if (touched.ok) {
        expect(
          touched.rowCount,
          permitted
            ? 'la policy refuse une écriture légitime'
            : 'FUITE — une écriture est passée sans la capacité',
        ).toBe(permitted ? 1 : 0)
      }

      const removed = await attempt(
        client,
        `delete from public."${table}" where id = '${row}'::uuid`,
      )
      expect(removed.ok).toBe(true)
      if (removed.ok) {
        expect(removed.rowCount, 'FUITE — une suppression est passée sans la capacité').toBe(
          permitted ? 1 : 0,
        )
      }
    } finally {
      // La suppression légitime du rôle autorisé est le contrôle positif ; on
      // ne la conserve pas.
      await client.query('rollback')
    }

    expect(await snapshot(), 'la ligne a bougé hors de la transaction').toBe(before)
  })

  it.each(['owner', 'worker'])('%s — insère si et seulement si la matrice le permet', async (role) => {
    await client.query('begin')
    try {
      await actAs(client, tokenFor(tenant, role))

      /*
       * L'INSERT, lui, lève : `with check` refuse la ligne au lieu de n'en
       * trouver aucune. Le code est asserté — un refus par contrainte
       * d'unicité (23505) ou par clé étrangère (23503) prendrait sinon le
       * crédit du refus par capacité (E1-01, même piège).
       */
      const written = await attempt(
        client,
        `insert into public."${table}" (tenant_id) values ('${tenant}'::uuid)`,
      )

      if (allowed.includes(role)) {
        // Le rôle autorisé bute au pire sur une colonne obligatoire, jamais sur
        // un privilège : c'est ce qui distingue « pas le droit » de « pas de
        // valeur ».
        if (!written.ok) {
          expect(written.code, `refus par la capacité alors qu’elle est accordée`).not.toBe(
            INSUFFICIENT_PRIVILEGE,
          )
        }
        return
      }

      expect(written.ok, 'FUITE — une ligne a été insérée sans la capacité').toBe(false)
      if (!written.ok) expect(written.code).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await client.query('rollback')
    }
  })
})

/* ========================================================================== */
/* Le mécanisme lui-même                                                       */
/* ========================================================================== */

describe('merx.apply_write_capability_restriction()', () => {
  /*
   * Une policy qui interroge une capacité inexistante est toujours fausse :
   * elle verrouille la table en silence, et le symptôme apparaît chez un
   * client, pas ici. Mieux vaut refuser la migration.
   *
   * La table témoin naît et meurt dans une transaction annulée : le DDL est
   * transactionnel en Postgres, registres compris — `conventions.test.ts` ne
   * croisera rien.
   */
  it('refuse une capacité qui n’est pas dans la matrice', async () => {
    await client.query('reset role')
    await client.query('begin')
    try {
      await client.query(
        'create table public.probe_write_restriction (id uuid primary key default gen_random_uuid())',
      )
      await client.query("select merx.apply_business_conventions('public.probe_write_restriction')")

      const attempted = await attempt(
        client,
        "select merx.apply_write_capability_restriction('public.probe_write_restriction', 'capacite_inexistante')",
      )

      expect(attempted.ok).toBe(false)
      if (!attempted.ok) expect(attempted.message).toContain('Capacité inconnue')
    } finally {
      await client.query('rollback')
    }
  })

  /*
   * Le pendant du contrôle de E0-05 sur les relations confidentielles : une
   * table inscrite au registre sans ses policies doit être signalée par le
   * balayage du catalogue. Sans cette assertion, la branche ajoutée à
   * `isolation.ts` pourrait ne rien exiger du tout et personne ne le saurait.
   */
  it('est exigée par le balayage de policies dès qu’une table est au registre', async () => {
    await client.query('reset role')
    await client.query('begin')
    try {
      await client.query('insert into merx.write_capability_registry values ($1, $2)', [
        'app_user',
        'manage_settings',
      ])

      const found = await isolationViolations(client, 'les policies attendues, exactement')
      const onAppUser = found.filter((v) => v.table_name === 'app_user')

      expect(onAppUser.map((v) => v.detail).join(' | ')).toContain('write_capability_insert')
      expect(onAppUser).toHaveLength(3)
    } finally {
      await client.query('rollback')
    }
  })

  it('laisse le balayage vert sur les tables réellement restreintes', async () => {
    await client.query('reset role')
    const found = await isolationViolations(client, 'les policies attendues, exactement')
    const names = WRITE_RESTRICTED.map(([table]) => table)

    expect(found.filter((v) => names.includes(v.table_name))).toEqual([])
  })
})
