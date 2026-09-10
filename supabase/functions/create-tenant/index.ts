/*
 * Création d'un commerce. E1-01.
 *
 * Référence : docs/SPEC.md § 2.4 (dépôt unique), § 3 (rôles), § 9 M8 ;
 *             docs/BACKLOG.md E1-01.
 *
 * ─── Pourquoi une fonction Edge ───
 *
 * Créer le compte d'authentification du patron exige `service_role`, qui ne
 * peut pas vivre dans une PWA : la clé serait lisible par quiconque ouvre
 * l'application. Restaient deux chemins.
 *
 * Écrire le compte en SQL — insérer dans `auth.users` et `auth.identities` avec
 * `crypt()` — aurait tenu dans la migration, sans rien à déployer. C'est le
 * schéma interne de GoTrue : pas une API publique, et il change entre versions.
 * Une mise à jour de Supabase aurait cassé la création de commerce en
 * production, au calendrier de quelqu'un d'autre, et le symptôme aurait
 * ressemblé à une panne d'authentification plutôt qu'à ce qu'il était.
 *
 * Ces quelques lignes s'adressent donc à l'API Admin, qui est publique et
 * versionnée. La règle « pas de backend maison » de CLAUDE.md et de SPEC § 2.7
 * vise un serveur d'API qu'il faudrait auditer — l'isolation entre commerces
 * doit rester à la base. Elle n'est pas contredite ici : cette fonction
 * n'accorde aucun droit et ne filtre aucune donnée. Elle fait la seule chose
 * qui exige `service_role`, et délègue le reste à la RPC, donc à la RLS.
 *
 * ─── L'atomicité ───
 *
 * `create_tenant()` est transactionnelle, mais le compte Auth lui est
 * extérieur : deux systèmes, pas de transaction commune. L'ordre est donc
 * choisi pour que le résidu possible soit le moins nuisible, et il est nettoyé.
 *
 *   1. le compte Auth ;
 *   2. le commerce, par la RPC, avec le jeton de l'appelant ;
 *   3. si (2) échoue, le compte de (1) est supprimé.
 *
 * L'inverse — le commerce d'abord — laisserait en cas d'échec un commerce sans
 * patron : une ligne `tenant` visible dans la liste de l'éditeur, où personne
 * ne peut entrer, et que rien ne distingue d'un commerce valide. Un compte Auth
 * orphelin, lui, n'apparaît nulle part et ne donne accès à rien : sans fiche
 * `app_user`, `merx.custom_access_token()` n'émet aucun claim, donc aucune
 * policy ne passe (E0-03). Si même la suppression échoue, c'est ce résidu-là
 * qui subsiste, et c'est le bon.
 *
 * ─── Où est l'autorité ───
 *
 * Le rôle est vérifié deux fois, et les deux ne servent pas à la même chose.
 * Ici, pour ne pas créer un compte d'authentification que l'étape suivante
 * refusera de rattacher. Dans la RPC, parce que c'est là qu'est l'autorité : la
 * base relit le jeton signé. La RPC est appelée avec le jeton de l'appelant,
 * jamais avec `service_role` — sinon le garde `merx.is_super_admin()` de la
 * migration ne verrait plus jamais qu'un super-admin, et ne dirait plus rien.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

import { CORS_HEADERS, json } from '../_shared/cors.ts'
import { authEmailFor, normalizePhone } from '../_shared/phone.ts'

/** SPEC § 9 M8 : les quatre champs de E1-01, plus le mot de passe du patron. */
interface CreateTenantRequest {
  businessName?: unknown
  ownerName?: unknown
  phone?: unknown
  city?: unknown
  password?: unknown
}

/** `config.toml` : `auth.minimum_password_length`. Refusé plus loin sinon. */
const MINIMUM_PASSWORD_LENGTH = 6

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== 'POST') {
    return json({ error: 'Méthode non autorisée.' }, 405)
  }

  const authorization = request.headers.get('Authorization')
  if (authorization === null) {
    return json({ error: 'Connectez-vous pour créer un commerce.' }, 401)
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (url === '' || anonKey === '' || serviceKey === '') {
    // Une fonction déployée sans son environnement échouerait plus loin, sur
    // un message qui parlerait d'autre chose.
    return json({ error: "Fonction mal configurée : variables d'environnement absentes." }, 500)
  }

  /*
   * Le client de l'appelant : sa clé publique, son jeton. C'est lui qui portera
   * la RPC, pour que le garde `merx.is_super_admin()` s'exerce sur le vrai
   * demandeur.
   */
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  /*
   * Le rôle n'est pas lu ici, il est demandé à la base.
   *
   * Le rôle métier vit dans les claims du jeton, déposés par
   * `merx.custom_access_token()` (E0-03). Ni `getUser()` ni `getClaims()` ne
   * les rendent de façon fiable : le premier rend l'`app_metadata` *stocké* sur
   * `auth.users`, où le rôle métier ne figure pas ; le second, sur un jeton
   * HS256, retombe sur le serveur d'auth et aboutit au même endroit. Le
   * pré-contrôle refusait alors tout le monde, éditeur compris — et le mode de
   * défaillance aurait pu être l'inverse.
   *
   * `can_create_tenant()` rend `merx.is_super_admin()`, c'est-à-dire la même
   * expression, au caractère près, que le garde en tête de `create_tenant()`.
   * Les deux ne peuvent pas diverger, et la question est tranchée par qui la
   * relit sur un jeton signé.
   *
   * Ce que ce contrôle apporte reste modeste : il évite de créer un compte
   * d'authentification que l'étape 2 refuserait de rattacher. L'autorité, elle,
   * est à l'étape 2.
   */
  const { data: allowed, error: guardError } = await caller.rpc('can_create_tenant')

  if (guardError !== null) {
    // Un jeton expiré ou illisible ne franchit pas PostgREST : c'est une
    // session à rouvrir, pas un droit à réclamer.
    return json({ error: 'Session expirée. Reconnectez-vous.' }, 401)
  }

  /*
   * Le libellé de ce refus n'est pas celui de `create_tenant()`, et ce n'est pas
   * une négligence : les deux gardes rendent un 403, et sans deux phrases
   * distinctes rien ne dirait lequel a répondu — le test de ce pré-contrôle
   * resterait vert le pré-contrôle retiré, la RPC prenant le refus à son compte.
   * C'est celui-ci que l'utilisateur lit ; celui de la base n'apparaît que si
   * l'on est arrivé jusqu'à elle sans passer par ici.
   */
  if (allowed !== true) {
    return json({ error: "Seul l'éditeur crée un commerce." }, 403)
  }

  let body: CreateTenantRequest
  try {
    body = (await request.json()) as CreateTenantRequest
  } catch {
    return json({ error: 'Requête illisible.' }, 400)
  }

  const businessName = text(body.businessName)
  const ownerName = text(body.ownerName)
  const city = text(body.city)
  const password = typeof body.password === 'string' ? body.password : ''

  if (businessName === '') return json({ error: 'Le nom du commerce est obligatoire.' }, 400)
  if (ownerName === '') return json({ error: 'Le nom du patron est obligatoire.' }, 400)

  const phone = normalizePhone(text(body.phone))
  if (phone === null) {
    return json({ error: 'Numéro de téléphone invalide. Exemple : 06 12 34 56 78.' }, 400)
  }

  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return json(
      { error: `Le mot de passe fait au moins ${MINIMUM_PASSWORD_LENGTH} caractères.` },
      400,
    )
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  /* 1 — le compte. */
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: authEmailFor(phone),
    password,
    // Aucun courrier ne peut atteindre une adresse en `.invalid` : demander une
    // confirmation reviendrait à interdire la première connexion.
    email_confirm: true,
  })

  if (createError !== null || created.user === null) {
    const duplicate =
      createError?.status === 422 || (createError?.message ?? '').includes('already been registered')

    return json(
      {
        error: duplicate
          ? 'Ce numéro est déjà rattaché à un compte.'
          : `Compte impossible à créer : ${createError?.message ?? 'raison inconnue'}`,
      },
      duplicate ? 409 : 500,
    )
  }

  const authUserId = created.user.id

  /* 2 — le commerce, sous l'autorité de la base. */
  const { data: tenantId, error: rpcError } = await caller.rpc('create_tenant', {
    business_name: businessName,
    owner_name: ownerName,
    phone,
    city: city === '' ? null : city,
    auth_user_id: authUserId,
  })

  /* 3 — le ménage, si l'étape 2 a échoué. */
  if (rpcError !== null) {
    await admin.auth.admin.deleteUser(authUserId).catch(() => undefined)
    return json({ error: rpcError.message }, rpcError.code === '42501' ? 403 : 400)
  }

  return json({ tenantId, phone }, 201)
})
