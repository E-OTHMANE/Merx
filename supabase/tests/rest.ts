/*
 * Machinerie du test d'authentification de bout en bout. E0-04.
 *
 * `isolation.test.ts` (E0-03) pose les claims lui-même et interroge Postgres
 * directement : il prouve que les policies sont justes. `access-token.test.ts`
 * prouve qu'un jeton émis porte le commerce. Il restait un maillon non tenu —
 * celui que l'application emprunte réellement :
 *
 *     connexion → jeton signé → en-tête HTTP → PostgREST → RLS → lignes
 *
 * Rien ici ne nomme une table. Les cas de test se construisent à partir de
 * `merx.convention_registry`, comme le test d'isolation : les tables du
 * catalogue (E2) et tout ce qui suivra seront couvertes sans qu'une ligne de ce
 * fichier change.
 */

import type { Client } from 'pg'

import { appendOnlyTables, auditedTables, derivedTables, withoutTriggers } from './isolation'

// Réexporté ici : les fichiers de test qui rangent par PostgREST l'importent
// avec le reste de leur outillage.
export { withoutTriggers }

export const API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54521'

/* Clés du stack local : publiques, sans valeur ailleurs. */
export const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

/* -------------------------------------------------------------------------- */
/* Authentification                                                            */
/* -------------------------------------------------------------------------- */

export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
}

export async function createAuthUser(email: string, password: string): Promise<string> {
  const response = await adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const body = (await response.json()) as { id?: string }

  if (body.id === undefined) {
    throw new Error(
      `Service d'authentification injoignable sur ${API_URL} : ${JSON.stringify(body)}\n` +
        'Démarrer le stack : npx supabase start',
    )
  }
  return body.id
}

export async function deleteAuthUser(id: string): Promise<void> {
  await adminFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' })
}

export interface TokenOutcome {
  accessToken: string | null
  refreshToken: string | null
  status: number
  /** Code d'erreur rendu par Supabase Auth, quand il refuse. */
  errorCode: string | null
}

/** Un appel au point d'émission de jetons — le seul chemin vers une session. */
async function token(grant: 'password' | 'refresh_token', payload: object): Promise<TokenOutcome> {
  const response = await fetch(`${API_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    error_code?: string
  }

  return {
    accessToken: body.access_token ?? null,
    refreshToken: body.refresh_token ?? null,
    status: response.status,
    errorCode: body.error_code ?? null,
  }
}

/** Une connexion par mot de passe, exactement comme le front la fait. */
export async function signInWithPassword(email: string, password: string): Promise<TokenOutcome> {
  return token('password', { email, password })
}

/** Rejoue un `refresh_token` — ce que fait l'application au redémarrage. */
export async function refreshSession(refreshToken: string): Promise<TokenOutcome> {
  return token('refresh_token', { refresh_token: refreshToken })
}

/** Comme `signInWithPassword`, mais exige la réussite : pour les préparatifs. */
export async function sessionFor(
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const outcome = await signInWithPassword(email, password)

  if (outcome.accessToken === null || outcome.refreshToken === null) {
    throw new Error(`Connexion refusée (${outcome.status}) : ${outcome.errorCode ?? 'sans code'}`)
  }
  return { accessToken: outcome.accessToken, refreshToken: outcome.refreshToken }
}

/** Le corps d'un JWT, sans vérifier la signature — c'est Supabase qui signe. */
export function payloadOf(token: string): {
  role?: string
  app_metadata?: { tenant_id?: string; role?: string }
} {
  const [, payload] = token.split('.')
  if (payload === undefined) throw new Error('jeton illisible')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

/* -------------------------------------------------------------------------- */
/* PostgREST                                                                   */
/* -------------------------------------------------------------------------- */

export interface RestResult {
  status: number
  ok: boolean
  /** Lignes rendues. Tableau vide si la réponse n'en contient pas. */
  rows: Array<{ id?: string }>
  /** Code d'erreur PostgREST (`42501` pour un refus de privilège). */
  code: string | null
  body: string
}

interface RestOptions {
  /** Jeton de l'utilisateur. Absent : la requête part avec la seule clé anon. */
  token?: string | undefined
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

/**
 * Une requête PostgREST, telle que `supabase-js` l'émet : `apikey` porte la clé
 * publique, `Authorization` porte le jeton de l'utilisateur. C'est ce second
 * en-tête que la RLS lit.
 *
 * `Prefer: return=representation` sur les écritures : sans lui, PostgREST rend
 * `204` sans corps, et l'on ne pourrait pas distinguer « aucune ligne touchée »
 * de « une ligne modifiée chez le voisin ».
 */
export async function rest(path: string, options: RestOptions = {}): Promise<RestResult> {
  const { token, method = 'GET', body } = options

  const response = await fetch(`${API_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  const code =
    parsed !== null && typeof parsed === 'object' && 'code' in parsed
      ? String((parsed as { code: unknown }).code)
      : null

  /*
   * PGRST205 : PostgREST ne connaît pas la table. Ce n'est pas une fuite, c'est
   * un cache de schéma en retard — le dire ici évite de chercher une policy
   * absente pendant une heure.
   */
  if (code === 'PGRST205') {
    throw new Error(
      `PostgREST ne connaît pas « ${path.split('?')[0]} » : son cache de schéma est en ` +
        'retard sur les migrations. Recharger : npx supabase db reset',
    )
  }

  return {
    status: response.status,
    ok: response.ok,
    rows: Array.isArray(parsed) ? (parsed as Array<{ id?: string }>) : [],
    code,
    body: text,
  }
}

/* -------------------------------------------------------------------------- */
/* Données de test, écrites pour de bon                                        */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST est un autre processus : il ne verrait rien d'une transaction
 * ouverte ici. Les lignes sont donc validées, et le ménage est explicite —
 * dans l'ordre inverse des dépendances, sinon une clé étrangère refuse.
 */
export async function deleteRows(
  client: Client,
  order: readonly string[],
  rows: ReadonlyMap<string, string>,
): Promise<void> {
  const appendOnly = await appendOnlyTables(client)
  const audited = await auditedTables(client)
  const derived = await derivedTables(client)

  for (const table of [...order].reverse()) {
    const id = rows.get(table)
    if (id === undefined) continue

    /*
     * Une table en ajout seul refuse la suppression à tout le monde, `postgres`
     * compris (E1-04) — c'est la propriété, pas un obstacle à contourner. Le
     * ménage lève donc le garde explicitement, le temps d'une requête.
     *
     * `session_replication_role` plutôt qu'un `alter table ... disable trigger`
     * nommé : le nettoyage ne doit pas savoir comment le garde est posé. Nommer
     * le trigger accrocherait la routine de ménage à son existence, et le jour
     * où quelqu'un le retire, c'est ce fichier-ci qui exploserait — un test
     * d'authentification rouge pour un garde d'audit manquant, personne ne
     * remonterait la piste.
     *
     * `set` et non `set local` : ce ménage-ci ne tourne dans aucune
     * transaction, et hors transaction `set local` ne fait rien — silencieuse-
     * ment. Le réglage est donc posé sur la session, et remis juste après.
     *
     * Sans cela, ces lignes-ci survivent, et avec elles les clés étrangères
     * qu'elles tiennent : le commerce et ses utilisateurs deviennent
     * indestructibles, et le prochain test hérite d'une base qu'il n'a pas
     * peuplée. La propriété est éprouvée là où elle doit l'être — sur les
     * chemins de l'application et de la base, dans `audit.test.ts` et le
     * balayage d'isolation — pas dans une routine de nettoyage.
     */
    /*
     * Une table journalisée (RÈGLE M8-1) refuse, elle, toute écriture sans
     * commerce ni auteur dans le jeton — et ce ménage n'en a pas. Même geste.
     */
    /*
     * Une table dérivée (RÈGLE M2-1), elle, refuse toute écriture qui ne vient
     * pas de son trigger d'agrégat — y compris une suppression de ménage.
     * Même geste, et pour la même raison : la propriété est éprouvée sur son
     * chemin réel, dans `stock-movements.test.ts`, pas ici.
     */
    if (appendOnly.has(table) || audited.has(table) || derived.has(table)) {
      await withoutTriggers(client, () =>
        client.query(`delete from public."${table}" where id = $1`, [id]),
      )
      continue
    }

    await client.query(`delete from public."${table}" where id = $1`, [id])
  }
}
