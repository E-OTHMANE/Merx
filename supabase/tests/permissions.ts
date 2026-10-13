/*
 * Machinerie du test de droits. E0-05 — SPEC § 3, § 3.1.
 *
 * Le critère central de la story ne se vérifie que sur une réponse réelle : un
 * appel API brut par un `worker` ne contient jamais `cost_price`. Or aucune
 * colonne de coût n'existe encore — elles arrivent avec le catalogue (E2). Le
 * mécanisme, lui, est livré aujourd'hui, et un mécanisme livré sans preuve est
 * un mécanisme qu'on croit avoir.
 *
 * D'où le témoin : ce fichier fabrique, le temps du test, une paire de tables
 * qui a la forme de ce que E2 construira — une table ordinaire, et une relation
 * de coût restreinte — en passant par les *vrais* helpers de convention et de
 * restriction. Rien d'E2 n'est livré : les tables sont créées en `beforeAll` et
 * supprimées en `afterAll`, registres compris. Ce qui est prouvé, c'est le
 * mécanisme, sur le chemin que l'application empruntera vraiment :
 *
 *     mot de passe → jeton signé → en-tête HTTP → PostgREST → RLS → corps JSON
 *
 * Les tables portent un préfixe `probe_` et n'existent que pendant ce fichier.
 * Les tests de `supabase/tests` tournent en série (`fileParallelism: false`,
 * vite.config.ts) : ils partagent une seule base, et les balayages de
 * `conventions.test.ts` ne doivent pas croiser un témoin en vol.
 */

import type { Client } from 'pg'

import { API_URL, ANON_KEY } from './rest'

/** Les deux tables témoin, dans l'ordre de création. */
export const PROBE_BASE = 'probe_variant'
export const PROBE_COST = 'probe_variant_cost'

/** Le nom que le worker ne doit jamais voir revenir. */
export const CONFIDENTIAL_COLUMN = 'cost_price'

/* -------------------------------------------------------------------------- */
/* Le cache de schéma de PostgREST                                             */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST est un autre processus, avec sa propre vue du schéma. Une table
 * créée à l'instant lui est invisible jusqu'à ce qu'il la recharge — c'est ce
 * que `notify pgrst, 'reload schema'` demande, et l'attente qui suit vérifie
 * qu'il a obtempéré plutôt que de le supposer.
 *
 * Sans cette attente, le test échouerait en PGRST205 de façon intermittente,
 * c'est-à-dire de la pire façon : un jour sur cinq, sur une machine plus lente.
 */
export async function reloadSchemaCache(client: Client): Promise<void> {
  await client.query("notify pgrst, 'reload schema'")
}

/**
 * Attend que PostgREST voie — ou ne voie plus — une table.
 *
 * La sonde part avec la seule clé anon, sans jeton. Les deux réponses possibles
 * se distinguent alors sans ambiguïté :
 *
 *   42501   — privilège refusé. PostgREST connaît la table ; `anon` n'a aucun
 *             droit dessus (E0-03 les révoque). C'est la preuve de présence.
 *   PGRST205 — table inconnue de son cache de schéma. Preuve d'absence.
 *
 * Toute autre réponse — 503 pendant un redémarrage de conteneur, corps vide,
 * page d'erreur de passerelle — n'est ni l'une ni l'autre, et la sonde attend.
 * Conclure « présente » sur un simple « ce n'est pas PGRST205 » ferait passer
 * un service pas encore prêt pour un service qui a rechargé son schéma : le
 * test échouerait ensuite ailleurs, sur une cause qui n'est pas la sienne.
 */
export async function waitForTable(table: string, present: boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  let last = '(aucune réponse)'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: ANON_KEY },
      })
      last = `${response.status} ${(await response.text()).slice(0, 200)}`

      if (present && last.includes('42501')) return
      if (!present && last.includes('PGRST205')) return
    } catch (error) {
      // Connexion refusée : le conteneur redémarre. C'est une raison d'attendre.
      last = String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    `PostgREST n'a pas rechargé son schéma en 30 s : « ${table} » devrait être ` +
      `${present ? 'visible' : 'absente'}. Dernière réponse : ${last}`,
  )
}

/* -------------------------------------------------------------------------- */
/* Le témoin                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * La forme que E2 devra donner au catalogue, réduite à ce qui est en jeu :
 * `cost_price` ne vit pas sur la table lue par tout le monde, mais sur une
 * relation à part, restreinte par la capacité `view_cost`.
 *
 * Les helpers appelés sont ceux de la migration, sans raccourci : si
 * `merx.apply_capability_restriction()` posait une policy fausse, le témoin la
 * porterait aussi, et le test le dirait.
 */
const CREATE_PROBE = [
  `create table public.${PROBE_BASE} (
     id  uuid primary key default gen_random_uuid(),
     sku text not null
   )`,
  `select merx.apply_reference_conventions('public.${PROBE_BASE}')`,

  `create table public.${PROBE_COST} (
     id                uuid primary key default gen_random_uuid(),
     ${PROBE_BASE}_id  uuid not null references public.${PROBE_BASE} (id),
     ${CONFIDENTIAL_COLUMN} public.money_amount not null
   )`,
  `select merx.apply_reference_conventions('public.${PROBE_COST}')`,
  `select merx.apply_capability_restriction('public.${PROBE_COST}', 'view_cost')`,
]

/*
 * Le ménage. Les registres ne se vident pas tout seuls quand une table
 * disparaît : une entrée laissée derrière ferait échouer la règle « registre
 * périmé » de `conventions.test.ts`, sur un fichier qui n'a rien à voir.
 */
const DROP_PROBE = [
  `drop table if exists public.${PROBE_COST}`,
  `drop table if exists public.${PROBE_BASE}`,
  `delete from merx.confidential_registry where table_name in ('${PROBE_COST}', '${PROBE_BASE}')`,
  `delete from merx.convention_registry  where table_name in ('${PROBE_COST}', '${PROBE_BASE}')`,
]

/**
 * Crée le témoin, après avoir nettoyé ce qu'une exécution interrompue aurait pu
 * laisser. Un test qui suppose la base propre échoue une fois sur deux, et pour
 * une raison qui n'est pas la sienne.
 */
export async function createProbe(client: Client): Promise<void> {
  await dropProbe(client)
  for (const statement of CREATE_PROBE) await client.query(statement)
  await reloadSchemaCache(client)
  await waitForTable(PROBE_COST, true)
}

export async function dropProbe(client: Client): Promise<void> {
  for (const statement of DROP_PROBE) await client.query(statement)
  await reloadSchemaCache(client)

  // On attend la disparition autant que l'apparition : rendre la main pendant
  // que PostgREST tient encore la table pour vivante laisserait le fichier
  // suivant s'exécuter dans un monde à moitié rangé.
  await waitForTable(PROBE_COST, false)
}

/* -------------------------------------------------------------------------- */
/* Un commerce, un patron, un employé                                          */
/* -------------------------------------------------------------------------- */

export interface Fixture {
  tenant: string
  /** Ligne de `probe_variant`, et sa ligne de coût. */
  variant: string
  cost: string
  users: Record<'owner' | 'worker', { authUser: string; appUser: string; email: string }>
}

export async function seedTenant(
  client: Client,
  emails: Record<'owner' | 'worker', string>,
  authUsers: Record<'owner' | 'worker', string>,
): Promise<Fixture> {
  const { rows: tenants } = await client.query<{ id: string }>(
    "insert into public.tenant (business_name, tenant_id) values ('Droits', gen_random_uuid()) returning id",
  )
  const tenant = tenants[0]!.id

  const users = {} as Fixture['users']
  for (const role of ['owner', 'worker'] as const) {
    const { rows } = await client.query<{ id: string }>(
      'insert into public.app_user (auth_user_id, full_name, role, tenant_id)' +
        ' values ($1, $2, $3, $4) returning id',
      [authUsers[role], role === 'owner' ? 'Patron' : 'Employé', role, tenant],
    )
    users[role] = { authUser: authUsers[role], appUser: rows[0]!.id, email: emails[role] }
  }

  const { rows: variants } = await client.query<{ id: string }>(
    `insert into public.${PROBE_BASE} (sku, tenant_id) values ('SKU-1', $1) returning id`,
    [tenant],
  )
  const variant = variants[0]!.id

  const { rows: costs } = await client.query<{ id: string }>(
    `insert into public.${PROBE_COST} (${PROBE_BASE}_id, ${CONFIDENTIAL_COLUMN}, tenant_id)` +
      " values ($1, '42.50', $2) returning id",
    [variant, tenant],
  )

  return { tenant, variant, cost: costs[0]!.id, users }
}

export async function cleanTenant(client: Client, fixture: Fixture | undefined): Promise<void> {
  if (fixture === undefined) return

  await client.query(`delete from public.${PROBE_COST} where tenant_id = $1`, [fixture.tenant])
  await client.query(`delete from public.${PROBE_BASE} where tenant_id = $1`, [fixture.tenant])
  await client.query('delete from public.app_user where tenant_id = $1', [fixture.tenant])
  // Le dépôt avant le commerce : `warehouse_tenant_id_fkey` ne cascade pas.
  await client.query('delete from public.warehouse where tenant_id = $1', [fixture.tenant])
  await client.query('delete from public.tenant where id = $1', [fixture.tenant])
}

/* -------------------------------------------------------------------------- */
/* Lecture brute                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Une requête PostgREST dont on garde le **corps tel quel**, sans le parser.
 *
 * C'est délibéré, et c'est tout le test. `rows[0].cost_price === undefined`
 * passerait aussi bien sur `{"cost_price": null}` que sur une réponse où la clé
 * est absente — or la RÈGLE § 3 distingue précisément ces deux cas. Chercher la
 * sous-chaîne dans le texte ne laisse pas cette porte ouverte.
 */
export async function rawBody(
  path: string,
  token: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${API_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: await response.text() }
}

/** Les colonnes confidentielles réellement présentes en base, par relation. */
export async function confidentialColumns(client: Client): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(`
    select r.table_name, a.attname as column_name
    from merx.confidential_registry r
    join pg_class c on c.relname = r.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where r.capability = 'view_cost'
      and a.attname not in ('id', 'tenant_id', 'created_at', 'updated_at',
                            'created_by', 'device_id', 'deleted_at')
      and a.attname not like '%\\_id'
    order by 1, 2
  `)

  const byTable = new Map<string, string[]>()
  for (const { table_name, column_name } of rows) {
    byTable.set(table_name, [...(byTable.get(table_name) ?? []), column_name])
  }
  return byTable
}
