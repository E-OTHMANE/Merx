/*
 * Création d'un employé. E1-02.
 *
 * Référence : docs/SPEC.md § 3 (rôles), § 3.1 (capacité `manage_users`),
 *             § 9 M8 (`app_user`) ; docs/BACKLOG.md E1-02.
 *
 * ─── Pourquoi une fonction Edge, encore ───
 *
 * La même raison qu'en E1-01, et c'est la seule : créer un compte
 * d'authentification exige `service_role`, qui ne peut pas vivre dans une PWA —
 * la clé serait lisible par quiconque ouvre l'application. Écrire le compte en
 * SQL demanderait d'insérer à la main dans `auth.users` et `auth.identities`,
 * c'est-à-dire dans le schéma interne de GoTrue : pas une API publique, et il
 * change entre versions. Une mise à jour de Supabase casserait la création
 * d'employé en production, et le symptôme ressemblerait à une panne
 * d'authentification.
 *
 * Cette fonction n'accorde aucun droit et ne filtre aucune donnée. Elle fait la
 * seule chose qui exige `service_role`, et délègue le reste à la RPC, donc à la
 * base.
 *
 * ─── L'atomicité ───
 *
 * Comme en E1-01 : le compte Auth est extérieur à la transaction de la RPC.
 * L'ordre est choisi pour que le résidu possible soit le moins nuisible.
 *
 *   1. le compte Auth ;
 *   2. la fiche `app_user`, par la RPC, avec le jeton de l'appelant ;
 *   3. si (2) échoue, le compte de (1) est supprimé.
 *
 * L'inverse laisserait une fiche d'employé sans compte : une ligne dans la
 * liste du patron, avec un numéro et un état « actif », derrière laquelle
 * personne ne peut se connecter — et rien ne la distinguerait d'un employé
 * valide. Un compte Auth orphelin, lui, n'apparaît nulle part et n'ouvre rien :
 * sans fiche `app_user`, le hook n'émet aucun claim, donc aucune policy ne
 * passe (E0-03).
 *
 * ─── Où est l'autorité ───
 *
 * Pas ici. Le pré-contrôle `can_manage_users` évite de créer un compte que
 * l'étape 2 refusera de rattacher ; le garde qui décide est celui de
 * `public.create_worker()`, que la base relit sur un jeton signé. La RPC est
 * appelée avec le jeton de l'appelant, jamais avec `service_role` — sinon le
 * garde ne verrait plus jamais qu'un tout-puissant et ne dirait plus rien.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

import { CORS_HEADERS, json } from '../_shared/cors.ts'
import { authEmailFor, normalizePhone } from '../_shared/phone.ts'

/** E1-02 : « nom, téléphone, mot de passe ». Rien d'autre — pas de rôle. */
interface CreateUserRequest {
  fullName?: unknown
  phone?: unknown
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
    return json({ error: 'Connectez-vous pour créer un employé.' }, 401)
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (url === '' || anonKey === '' || serviceKey === '') {
    // Une fonction déployée sans son environnement échouerait plus loin, sur un
    // message qui parlerait d'autre chose.
    return json({ error: "Fonction mal configurée : variables d'environnement absentes." }, 500)
  }

  /*
   * Le client de l'appelant : sa clé publique, son jeton. C'est lui qui portera
   * la RPC, pour que le garde `merx.can('manage_users')` s'exerce sur le vrai
   * demandeur, et que le commerce de l'employé soit celui du jeton.
   */
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  /*
   * Le droit n'est pas lu ici, il est demandé à la base — même raison qu'en
   * E1-01 : le rôle métier vit dans les claims déposés par le hook, et ni
   * `getUser()` ni `getClaims()` ne les rendent de façon fiable. Un pré-contrôle
   * écrit ici refuserait tout le monde, patron compris.
   */
  const { data: allowed, error: guardError } = await caller.rpc('can_manage_users')

  if (guardError !== null) {
    // Un jeton expiré ou illisible ne franchit pas PostgREST : c'est une session
    // à rouvrir, pas un droit à réclamer.
    return json({ error: 'Session expirée. Reconnectez-vous.' }, 401)
  }

  /*
   * Le libellé de ce refus n'est pas celui de `create_worker()`, et ce n'est pas
   * une négligence : les deux gardes rendent un 403, et sans deux phrases
   * distinctes rien ne dirait lequel a répondu — le test de ce pré-contrôle
   * resterait vert le pré-contrôle retiré, la RPC prenant le refus à son compte.
   * Constaté par sabotage : 0 test sur 180 tombait. C'est celui-ci que
   * l'utilisateur lit ; celui de la base n'apparaît que si l'on est arrivé
   * jusqu'à elle sans passer par ici.
   */
  if (allowed !== true) {
    return json({ error: 'Seul le patron crée un employé.' }, 403)
  }

  let body: CreateUserRequest
  try {
    body = (await request.json()) as CreateUserRequest
  } catch {
    return json({ error: 'Requête illisible.' }, 400)
  }

  const fullName = text(body.fullName)
  const password = typeof body.password === 'string' ? body.password : ''

  if (fullName === '') return json({ error: "Le nom de l'employé est obligatoire." }, 400)

  /*
   * Le numéro est l'identifiant de connexion (E1-01) : il est normalisé par la
   * fonction même qui servira à dériver l'adresse, et par celle que le front
   * appelle à la connexion. Une seconde écriture de cette règle serait une
   * divergence en attente, et sa conséquence un employé qui ne peut pas entrer.
   */
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
      createError?.status === 422 ||
      (createError?.message ?? '').includes('already been registered')

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

  /* 2 — la fiche, sous l'autorité de la base. */
  const { data: userId, error: rpcError } = await caller.rpc('create_worker', {
    full_name: fullName,
    phone,
    auth_user_id: authUserId,
  })

  /* 3 — le ménage, si l'étape 2 a échoué. */
  if (rpcError !== null) {
    await admin.auth.admin.deleteUser(authUserId).catch(() => undefined)
    return json({ error: rpcError.message }, rpcError.code === '42501' ? 403 : 400)
  }

  return json({ userId, phone }, 201)
})
