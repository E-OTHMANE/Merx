/*
 * Un commerce de démonstration sur le stack local, et de quoi s'y connecter.
 *
 * `npx supabase db reset` rebâtit une base **vide** : aucun commerce, aucun
 * compte. Ce script fabrique le minimum pour ouvrir l'application — surtout
 * depuis un téléphone, où l'on ne peut pas bricoler en SQL.
 *
 * Il ne court-circuite rien : il crée un compte éditeur (le seul geste qui se
 * fait en SQL, comme à l'installation de l'éditeur), puis appelle la **vraie**
 * fonction `create-tenant` avec son jeton. Le commerce, son dépôt, son
 * appareil, ses réglages et son patron naissent donc par le chemin de
 * production (E1-01).
 *
 * Développement seulement — les clés ci-dessous sont celles du stack local,
 * publiques par construction. Ne jamais pointer `SUPABASE_API_URL` ailleurs.
 *
 *     npm run dev:account
 *     npm run dev:account -- 0612345678
 */

import { Client } from 'pg'

const API_URL = process.env.SUPABASE_API_URL ?? 'http://127.0.0.1:54521'
const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

/* Dix chiffres, forme marocaine. Repris tel quel par l'écran de connexion. */
const PHONE = process.argv[2] ?? '0612345678'
const OWNER_PASSWORD = 'patron-merx-0000'
const EDITOR_PASSWORD = 'editeur-merx-0000'
const EDITOR_EMAIL = `editeur-${Date.now()}@merx.test`

async function admin(path, init = {}) {
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

async function createAuthUser(email, password) {
  const response = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const body = await response.json()
  if (body.id === undefined) {
    throw new Error(
      `Service d'authentification injoignable sur ${API_URL} : ${JSON.stringify(body)}\n` +
        'Le stack est-il démarré ? npx supabase start',
    )
  }
  return body.id
}

async function signIn(email, password) {
  const response = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await response.json()
  if (body.access_token === undefined) {
    throw new Error(`Connexion refusée (${response.status}) : ${JSON.stringify(body)}`)
  }
  return body.access_token
}

const db = new Client({ connectionString: DB_URL })
await db.connect()

try {
  /*
   * L'éditeur. Sa fiche est posée en SQL parce que c'est le seul compte que
   * personne ne crée depuis l'application : il est là avant tout le monde.
   */
  const editorId = await createAuthUser(EDITOR_EMAIL, EDITOR_PASSWORD)
  const { rows } = await db.query(
    "insert into public.tenant (business_name) values ('Éditeur Merx') returning id",
  )
  await db.query(
    'insert into public.app_user (tenant_id, auth_user_id, full_name, role) values ($1, $2, $3, $4)',
    [rows[0].id, editorId, 'Éditeur', 'super_admin'],
  )

  const editorToken = await signIn(EDITOR_EMAIL, EDITOR_PASSWORD)

  /* Le commerce, par la vraie fonction — dépôt, appareil, réglages, patron. */
  const response = await fetch(`${API_URL}/functions/v1/create-tenant`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${editorToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      businessName: 'Droguerie Atlas',
      ownerName: 'Rachid Benali',
      phone: PHONE,
      city: 'Casablanca',
      password: OWNER_PASSWORD,
    }),
  })

  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(
      `Réponse illisible de create-tenant (${response.status}) : ${text}\n` +
        'Le runtime Edge est-il démarré ? docker restart supabase_edge_runtime_Merx',
    )
  }

  if (response.status !== 201) {
    throw new Error(`create-tenant a refusé (${response.status}) : ${body.error ?? text}`)
  }

  console.log('')
  console.log('Commerce créé : Droguerie Atlas (Casablanca)')
  console.log('')
  console.log('  Connexion patron')
  console.log(`    Téléphone     ${body.phone}`)
  console.log(`    Mot de passe  ${OWNER_PASSWORD}`)
  console.log('')
  console.log('  Connexion éditeur (super_admin, par email)')
  console.log(`    Identifiant   ${EDITOR_EMAIL}`)
  console.log(`    Mot de passe  ${EDITOR_PASSWORD}`)
  console.log('')
  console.log('Le catalogue est vide : créez un produit avant de vendre.')
  console.log('')
} finally {
  await db.end()
}
