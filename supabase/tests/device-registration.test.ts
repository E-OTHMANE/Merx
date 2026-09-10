// @vitest-environment node

/*
 * E1-03 — l'appareil s'enregistre, et sa lettre ne se donne qu'une fois.
 *
 * Le critère qui compte n'est pas « un appareil obtient une lettre » : c'est
 * qu'aucun commerce ne puisse en donner deux fois la même, y compris quand deux
 * appareils s'enregistrent au même instant. Sans cela, la numérotation locale
 * de E4-02 fabrique deux `BL-B-0001` distincts sur deux tablettes, et personne
 * ne s'en aperçoit avant la synchronisation — sur des bons déjà remis.
 *
 * L'unicité est tenue à deux niveaux, et ce fichier les éprouve séparément :
 *
 *   index unique  — `INSERT` direct d'une lettre déjà prise, sous `postgres`,
 *                   sans passer par aucune fonction. Seul l'index répond.
 *   verrou        — 26 connexions distinctes qui s'enregistrent en même temps
 *                   dans le même commerce. L'index seul les ferait échouer ;
 *                   c'est le verrou qui leur donne 26 lettres différentes.
 *
 * Retirer l'index laisse le second test vert et fait tomber le premier ;
 * retirer le verrou fait l'inverse. C'est la condition posée par CLAUDE.md :
 * une règle gardée à plusieurs niveaux a un test par niveau, chacun
 * contournant les autres.
 *
 * Les autres niveaux, dans le même esprit :
 *
 *   RPC       — appel direct à `/rest/v1/rpc/register_device`, sans écran. La
 *               fonction est `security definer` : la policy ne s'applique pas à
 *               elle, seul son garde répond.
 *   policy    — `GET`/`PATCH` direct sur `/rest/v1/device`, sans aucune
 *               fonction. Seule la policy restrictive répond.
 *   isolation — un appareil du commerce d'en face, adressé par son identifiant.
 *
 * Chaque refus asserte le **code d'erreur** attendu, et là où un code ne suffit
 * pas, l'absence d'effet : aucune ligne créée, aucune lettre consommée.
 *
 * Il écrit hors transaction, comme ses voisins : PostgREST et GoTrue sont deux
 * autres processus. Le ménage est donc explicite, et fait même en cas d'échec.
 */

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { ANON_KEY, API_URL, createAuthUser, deleteAuthUser, rest, sessionFor } from './rest'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const PASSWORD = 'mot-de-passe-de-test-0000'

let db: Client

const createdTenants: string[] = []
const createdAuthUsers: string[] = []

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
 * Un commerce et sa population. Tout est posé sous `postgres`, jamais par
 * l'application : ce fichier vérifie ce que l'application a le droit de faire,
 * il ne peut pas se servir de ce droit pour préparer ses propres cas.
 *
 * Aucun appareil n'est créé ici — `create_tenant()` en pose un en E1-01, mais
 * le commerce est monté à la main pour que chaque cas parte d'un alphabet
 * intact et sache exactement quelles lettres sont prises.
 */
async function seedTenant(): Promise<{ tenant: string; owner: Person; worker: Person }> {
  const { rows } = await db.query<{ id: string }>(
    "insert into public.tenant (business_name, tenant_id) values ('Appareils', gen_random_uuid())" +
      ' returning id',
  )
  const tenant = rows[0]!.id
  createdTenants.push(tenant)

  const person = async (role: 'owner' | 'worker'): Promise<Person> => {
    const email = `${role}-${crypto.randomUUID()}@merx.test`
    const authUser = await createAuthUser(email, PASSWORD)
    createdAuthUsers.push(authUser)

    const created = await db.query<{ id: string }>(
      'insert into public.app_user (tenant_id, auth_user_id, full_name, phone, role)' +
        ' values ($1, $2, $3, $4, $5) returning id',
      [tenant, authUser, role === 'owner' ? 'Patron' : 'Employé', freshPhone(), role],
    )

    const { accessToken } = await sessionFor(email, PASSWORD)
    return { authUser, appUser: created.rows[0]!.id, email, token: accessToken }
  }

  return { tenant, owner: await person('owner'), worker: await person('worker') }
}

/** Un appel direct à une RPC, sans passer par aucun écran. */
async function rpc(
  name: string,
  token: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; code: string | null; message: string; rows: unknown[] }> {
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
    code: response.ok ? null : (asError?.code ?? null),
    message: response.ok ? '' : (asError?.message ?? text),
    rows: Array.isArray(parsed) ? parsed : [],
  }
}

/** `register_device()`, tel que `src/lib/device/register.ts` l'émet. */
async function register(
  token: string | null,
  deviceKey: string,
  label?: string,
): ReturnType<typeof rpc> {
  return rpc('register_device', token, {
    device_key: deviceKey,
    ...(label === undefined ? {} : { device_label: label }),
  })
}

async function devicesOf(
  tenant: string,
): Promise<Array<{ id: string; label: string; prefix: string; is_active: boolean }>> {
  const { rows } = await db.query(
    'select id, label, prefix, is_active from public.device where tenant_id = $1 order by prefix',
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
    await db.query('delete from public.device where tenant_id = $1', [tenant])
    await db.query('delete from public.app_user where tenant_id = $1', [tenant])
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
/* Le critère : un appareil s'enregistre à la première connexion               */
/* ========================================================================== */

describe("l'enregistrement d'un appareil", () => {
  it('attribue A, puis B, puis C — dans l’ordre', async () => {
    const { tenant, owner } = await seedTenant()

    const letters: string[] = []
    for (let n = 0; n < 3; n += 1) {
      const outcome = await register(owner.token, crypto.randomUUID())
      expect(outcome.status).toBe(200)
      letters.push((outcome.rows[0] as { prefix: string }).prefix)
    }

    expect(letters).toEqual(['A', 'B', 'C'])
    expect((await devicesOf(tenant)).map((d) => d.prefix)).toEqual(['A', 'B', 'C'])
  })

  it('rend l’identifiant que le client a engendré, jamais un autre', async () => {
    const { owner } = await seedTenant()
    const key = crypto.randomUUID()

    const outcome = await register(owner.token, key)

    // C'est ce qui rend l'appel idempotent : le client sait déjà qui il est
    // avant de parler au serveur (SPEC § 2.5, local-first).
    expect((outcome.rows[0] as { id: string }).id).toBe(key)
  })

  it('nomme l’appareil par sa lettre à défaut d’un nom donné', async () => {
    const { owner } = await seedTenant()

    const auto = await register(owner.token, crypto.randomUUID())
    const named = await register(owner.token, crypto.randomUUID(), 'Comptoir 2')

    expect((auto.rows[0] as { label: string }).label).toBe('Appareil A')
    expect((named.rows[0] as { label: string }).label).toBe('Comptoir 2')
  })

  it('estampille la dernière synchronisation', async () => {
    const { owner } = await seedTenant()

    const outcome = await register(owner.token, crypto.randomUUID())

    expect((outcome.rows[0] as { last_sync_at: string | null }).last_sync_at).not.toBeNull()
  })

  /*
   * E1-03 : « Un appareil s'enregistre à la première connexion. » Donc à
   * *chaque* connexion l'appel repart, et il ne doit rien créer de plus — sinon
   * les 26 lettres du commerce sont brûlées en une semaine de redémarrages.
   */
  it('est idempotent : le même appareil ne consomme qu’une lettre', async () => {
    const { tenant, owner } = await seedTenant()
    const key = crypto.randomUUID()

    const first = await register(owner.token, key, 'Comptoir')
    const second = await register(owner.token, key)
    const third = await register(owner.token, key)

    for (const outcome of [first, second, third]) {
      expect((outcome.rows[0] as { prefix: string }).prefix).toBe('A')
      expect((outcome.rows[0] as { id: string }).id).toBe(key)
    }

    // Le nom donné la première fois n'est pas écrasé par les suivants : ce
    // serait perdre le nom que le patron a donné à sa tablette.
    expect((third.rows[0] as { label: string }).label).toBe('Comptoir')

    const devices = await devicesOf(tenant)
    expect(devices).toHaveLength(1)
  })

  /*
   * Le vendeur tient la tablette. S'il ne pouvait pas l'enregistrer, la caisse
   * serait sans lettre de numérotation jusqu'à ce que le patron passe.
   */
  it('est ouvert à l’employé, qui n’a pourtant pas le droit de lire la liste', async () => {
    const { tenant, worker } = await seedTenant()

    const outcome = await register(worker.token, crypto.randomUUID())
    expect(outcome.status).toBe(200)
    expect((outcome.rows[0] as { prefix: string }).prefix).toBe('A')

    // Le même employé, sur la table : la policy restrictive répond, elle.
    const read = await rest('device?select=*', { token: worker.token })
    expect(read.rows).toHaveLength(0)

    expect(await devicesOf(tenant)).toHaveLength(1)
  })
})

/* ========================================================================== */
/* Le cœur : une lettre n'est jamais donnée deux fois                          */
/* ========================================================================== */

describe("l'unicité du préfixe", () => {
  /*
   * Niveau « verrou consultatif ».
   *
   * 26 connexions distinctes — donc 26 transactions concurrentes, comme 26
   * requêtes PostgREST simultanées — s'enregistrent dans le même commerce. Sous
   * `READ COMMITTED` et sans verrou, elles lisent toutes le même ensemble de
   * lettres prises et choisissent toutes « A » : l'index en laisse passer une
   * et fait échouer les vingt-cinq autres.
   *
   * Ce que le test exige est donc double : aucune erreur, **et** 26 lettres
   * distinctes. Le premier point tombe si le verrou disparaît ; le second
   * tomberait si l'index disparaissait *et* que le verrou était mal posé.
   */
  it('donne 26 lettres différentes à 26 enregistrements simultanés', async () => {
    const { tenant, owner } = await seedTenant()

    const keys = Array.from({ length: 26 }, () => crypto.randomUUID())
    const outcomes = await Promise.all(keys.map((key) => register(owner.token, key)))

    const refused = outcomes.filter((o) => !o.ok)
    expect(
      refused.map((o) => `${o.code}: ${o.message}`),
      'un enregistrement simultané a été refusé — le verrou de ' +
        'merx.next_device_prefix() ne sérialise plus l’attribution',
    ).toEqual([])

    const letters = outcomes.map((o) => (o.rows[0] as { prefix: string }).prefix)
    expect(new Set(letters).size).toBe(26)
    expect([...letters].sort()).toEqual((await devicesOf(tenant)).map((d) => d.prefix))
  }, 60_000)

  /*
   * Niveau « index unique ».
   *
   * L'écriture est faite sous `postgres`, en SQL direct : ni la fonction, ni son
   * verrou, ni la RLS ne sont sur le chemin. Seul l'index peut répondre — et
   * c'est bien lui qu'on veut éprouver, parce que c'est lui qui tiendra le jour
   * où une ligne arrivera par la synchronisation de E10 plutôt que par la RPC.
   */
  it('refuse en 23505 un préfixe déjà pris, même écrit en SQL direct', async () => {
    const { tenant, owner } = await seedTenant()
    await register(owner.token, crypto.randomUUID())

    await expect(
      db.query(
        "insert into public.device (tenant_id, label, prefix) values ($1, 'Doublon', 'A')",
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    expect(await devicesOf(tenant)).toHaveLength(1)
  })

  /*
   * L'index est **total**, et c'est la décision de cette story.
   *
   * Un appareil supprimé emporte sa ligne, pas ses numéros : les `BL-B-0001`
   * qu'il a produits restent en base et sur le papier du client. Rendre « B »
   * au stock ferait recommencer une tablette neuve à `BL-B-0001`, contre un
   * historique que plus personne ne regarde. Ce test tomberait si l'index
   * redevenait partiel (`where deleted_at is null`).
   */
  it('ne redonne pas la lettre d’un appareil supprimé', async () => {
    const { tenant, owner } = await seedTenant()

    const first = await register(owner.token, crypto.randomUUID())
    expect((first.rows[0] as { prefix: string }).prefix).toBe('A')

    await db.query('update public.device set deleted_at = now(), is_active = false where id = $1', [
      (first.rows[0] as { id: string }).id,
    ])

    const second = await register(owner.token, crypto.randomUUID())
    expect((second.rows[0] as { prefix: string }).prefix).toBe('B')

    expect((await devicesOf(tenant)).map((d) => d.prefix)).toEqual(['A', 'B'])
  })

  /*
   * Le même refus, un étage plus bas.
   *
   * Le test précédent passe par la RPC : ce qu'il éprouve est le `select` de
   * `merx.next_device_prefix()`, qui ne filtre pas `deleted_at`. L'index, lui,
   * n'y est pour rien — il resterait vert s'il redevenait partiel. Constaté par
   * sabotage : `where deleted_at is null` remis, 0 test sur 22 tombait.
   *
   * Celui-ci écrit en SQL direct, sous `postgres` : aucune fonction sur le
   * chemin, seul l'index peut répondre. C'est le niveau qui comptera quand une
   * ligne arrivera par la synchronisation de E10 plutôt que par la RPC.
   */
  it('refuse en 23505 la lettre d’un appareil supprimé, écrite en SQL direct', async () => {
    const { tenant, owner } = await seedTenant()
    const first = await register(owner.token, crypto.randomUUID())
    await db.query('update public.device set deleted_at = now() where id = $1', [
      (first.rows[0] as { id: string }).id,
    ])

    await expect(
      db.query(
        "insert into public.device (tenant_id, label, prefix) values ($1, 'Ressuscité', 'A')",
        [tenant],
      ),
      "l'index device_prefix_per_tenant ne couvre plus les lignes supprimées : " +
        'une lettre libérée peut être redonnée, et E4-02 produira deux BL-A-0001',
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('ne redonne pas la lettre d’un appareil désactivé', async () => {
    const { owner } = await seedTenant()

    const first = await register(owner.token, crypto.randomUUID())
    await db.query('update public.device set is_active = false where id = $1', [
      (first.rows[0] as { id: string }).id,
    ])

    const second = await register(owner.token, crypto.randomUUID())
    expect((second.rows[0] as { prefix: string }).prefix).toBe('B')
  })

  /*
   * Le verrou porte sur le commerce, pas sur la table : deux commerces
   * s'enregistrent en parallèle sans s'attendre, et chacun repart de « A ».
   */
  it('recommence à A dans chaque commerce', async () => {
    const one = await seedTenant()
    const two = await seedTenant()

    const [a, b] = await Promise.all([
      register(one.owner.token, crypto.randomUUID()),
      register(two.owner.token, crypto.randomUUID()),
    ])

    expect((a.rows[0] as { prefix: string }).prefix).toBe('A')
    expect((b.rows[0] as { prefix: string }).prefix).toBe('A')
  })

  /* Vingt-six appareils n'arrivera pas. Si cela arrive, un refus lisible vaut
   * mieux qu'une lettre recyclée — et le code est distinct de tous les autres. */
  it('refuse le 27ᵉ appareil en 54000, sans rien créer', async () => {
    const { tenant, owner } = await seedTenant()

    await db.query(
      "insert into public.device (tenant_id, label, prefix)" +
        " select $1, 'Saturé', letter" +
        ' from unnest(enum_range(null::public.device_prefix)) as letter',
      [tenant],
    )

    const outcome = await register(owner.token, crypto.randomUUID())

    expect(outcome.code).toBe('54000')
    expect(outcome.message).toContain('26 appareils')
    expect(await devicesOf(tenant)).toHaveLength(26)
  })
})

/* ========================================================================== */
/* Les gardes de la RPC — un par refus, chacun son code et sa phrase           */
/* ========================================================================== */

describe('register_device() refuse', () => {
  /*
   * Les trois refus de la fonction rendent des messages distincts. C'est la
   * règle de CLAUDE.md vérifiée par sabotage en E1-02 : deux gardes qui
   * répondent la même phrase sont indiscernables, et retirer l'un ne fait
   * tomber aucun test.
   */
  it('un compte sans commerce, en 42501', async () => {
    const email = `orphelin-${crypto.randomUUID()}@merx.test`
    const authUser = await createAuthUser(email, PASSWORD)
    createdAuthUsers.push(authUser)
    const { accessToken } = await sessionFor(email, PASSWORD)

    const outcome = await register(accessToken, crypto.randomUUID())

    expect(outcome.code).toBe('42501')
    expect(outcome.message).toContain('Aucun commerce rattaché')
  })

  it('un appareil sans identifiant, en 23514', async () => {
    const { owner } = await seedTenant()

    const outcome = await rpc('register_device', owner.token, { device_key: null })

    expect(outcome.code).toBe('23514')
    expect(outcome.message).toContain('Aucun appareil désigné')
  })

  /*
   * L'identifiant est engendré par le client : rien n'empêche quelqu'un
   * d'envoyer celui du voisin. La réponse dit « introuvable » plutôt que « pas
   * à vous » — confirmer l'existence d'une ligne qu'on n'a pas le droit de voir
   * est déjà une fuite (même formulation qu'en E1-02).
   */
  it('l’appareil d’un autre commerce, en P0002 et sans l’adopter', async () => {
    const one = await seedTenant()
    const two = await seedTenant()

    const key = crypto.randomUUID()
    await register(one.owner.token, key)

    const outcome = await register(two.owner.token, key)

    expect(outcome.code).toBe('P0002')
    expect(outcome.message).toContain('introuvable')

    // L'appareil n'a pas changé de commerce, et le second n'en a aucun.
    expect(await devicesOf(one.tenant)).toHaveLength(1)
    expect(await devicesOf(two.tenant)).toHaveLength(0)
  })

  it('un appareil retiré par le patron, en 42501', async () => {
    const { owner } = await seedTenant()
    const key = crypto.randomUUID()
    await register(owner.token, key)
    await db.query('update public.device set is_active = false where id = $1', [key])

    const outcome = await register(owner.token, key)

    expect(outcome.code).toBe('42501')
    expect(outcome.message).toContain('retiré')
  })

  /*
   * Deux gardes sur ce chemin, et ils rendent le **même code** : le privilège
   * refusé à `anon` et le garde « aucun commerce » répondent tous deux `42501`.
   * Un test qui n'asserte que le code ne peut donc pas dire lequel a refusé, et
   * reste vert quand le premier disparaît — constaté par sabotage : le `grant`
   * rendu à `anon`, 0 test sur 23 tombait.
   *
   * L'assertion porte donc sur le message, seul élément qui les sépare. Postgres
   * écrit le sien (« permission denied for function ») ; la fonction écrirait le
   * sien, en français, si l'appel l'atteignait.
   */
  it('un appelant anonyme, sur le privilège et non sur son garde', async () => {
    const outcome = await register(null, crypto.randomUUID())

    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('42501')
    expect(
      outcome.message,
      'l’appel anonyme a atteint le corps de la fonction : le privilège rendu ' +
        'à `anon` ne le tient plus, et seul le garde interne a répondu',
    ).toContain('permission denied for function')
  })
})

/* ========================================================================== */
/* La policy — « le patron voit ses appareils »                                */
/* ========================================================================== */

describe('la table device', () => {
  it('se lit par le patron, avec la dernière synchronisation', async () => {
    const { owner } = await seedTenant()
    await register(owner.token, crypto.randomUUID(), 'Comptoir')

    const read = await rest('device?select=id,label,prefix,last_sync_at,is_active', {
      token: owner.token,
    })

    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]).toMatchObject({ label: 'Comptoir', prefix: 'A', is_active: true })
    expect((read.rows[0] as { last_sync_at: string | null }).last_sync_at).not.toBeNull()
  })

  /*
   * Niveau « policy ». Aucune fonction sur le chemin : c'est
   * `capability_restriction` qui répond, et elle seule. Un `worker` obtient une
   * liste vide plutôt qu'un refus — c'est le comportement d'une policy, et
   * c'est pourquoi l'assertion porte sur l'absence de ligne, pas sur un code.
   */
  it('ne rend aucune ligne à un employé', async () => {
    const { worker, owner } = await seedTenant()
    await register(owner.token, crypto.randomUUID())

    const read = await rest('device?select=*', { token: worker.token })

    expect(read.rows).toHaveLength(0)
  })

  it('refuse l’écriture directe d’un employé', async () => {
    const { tenant, worker } = await seedTenant()

    const written = await rest('device', {
      token: worker.token,
      method: 'POST',
      body: { tenant_id: tenant, label: 'Pirate', prefix: 'Z' },
    })

    expect(written.ok).toBe(false)
    expect(written.code).toBe('42501')
    expect(await devicesOf(tenant)).toHaveLength(0)
  })

  /*
   * Le patron non plus n'écrit pas la lettre à la main. La policy le laisse
   * passer — il a la capacité — mais l'index tient : c'est le dernier rempart,
   * celui qui vaudra encore quand la ligne viendra de PowerSync (E10).
   */
  it('refuse un doublon de préfixe écrit par le patron lui-même', async () => {
    const { tenant, owner } = await seedTenant()
    await register(owner.token, crypto.randomUUID())

    const written = await rest('device', {
      token: owner.token,
      method: 'POST',
      body: { tenant_id: tenant, label: 'Doublon', prefix: 'A' },
    })

    expect(written.ok).toBe(false)
    expect(written.code).toBe('23505')
    expect(await devicesOf(tenant)).toHaveLength(1)
  })

  it('ne rend pas les appareils du commerce d’en face', async () => {
    const one = await seedTenant()
    const two = await seedTenant()
    await register(one.owner.token, crypto.randomUUID())

    const read = await rest('device?select=*', { token: two.owner.token })

    expect(read.rows).toHaveLength(0)
  })
})
