/*
 * Accès aux données des employés. M8 — E1-02.
 *
 * Trois appels, trois chemins, et la différence n'est pas d'organisation :
 *
 *   — la lecture va droit à PostgREST. Aucun filtre n'est écrit ici : la policy
 *     `tenant_isolation` borne au commerce, la policy restrictive
 *     `capability_restriction` exige `manage_users` (E1-02). Un `where` sur le
 *     tenant serait un filtre applicatif, ce que SPEC § 2.1 refuse ;
 *
 *   — la création passe par la fonction Edge `create-user`, seule à pouvoir
 *     créer un compte d'authentification (`service_role`). Elle rappelle
 *     ensuite la base avec le jeton de l'appelant ;
 *
 *   — l'activation passe par une RPC, parce qu'un `PATCH` direct sur
 *     `app_user` laisserait l'appelant choisir les colonnes qu'il modifie —
 *     `role` compris. La RPC n'expose qu'une question : actif ou non.
 */

import { supabase } from '@/lib/supabase'

/** Un utilisateur du commerce, tel que l'écran du patron le montre. E1-02. */
export interface Employee {
  id: string
  /**
   * Compte d'authentification. Sert à reconnaître l'appelant dans sa propre
   * liste — `AuthUser.id` est cet identifiant-là, pas celui de la fiche.
   */
  authUserId: string | null
  fullName: string
  phone: string | null
  role: 'super_admin' | 'owner' | 'worker'
  isActive: boolean
  /** Dernière émission de jeton. Nul si le compte n'a jamais servi. */
  lastSeenAt: string | null
}

interface EmployeeRow {
  id: string
  auth_user_id: string | null
  full_name: string
  phone: string | null
  role: 'super_admin' | 'owner' | 'worker'
  is_active: boolean
  last_seen_at: string | null
}

/**
 * Les utilisateurs du commerce, par ordre alphabétique.
 *
 * L'ordre est celui du nom, pas de la création : le patron cherche quelqu'un
 * qu'il connaît, il ne parcourt pas un journal. Les comptes désactivés restent
 * dans la liste — c'est le sens de « désactiver sans supprimer ».
 */
export async function listUsers(): Promise<Employee[]> {
  const { data, error } = await supabase
    .from('app_user')
    .select('id, auth_user_id, full_name, phone, role, is_active, last_seen_at')
    .is('deleted_at', null)
    .order('full_name', { ascending: true })

  if (error !== null) throw new Error(error.message)

  return (data as EmployeeRow[]).map((row) => ({
    id: row.id,
    authUserId: row.auth_user_id,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    isActive: row.is_active,
    lastSeenAt: row.last_seen_at,
  }))
}

export interface NewWorker {
  fullName: string
  phone: string
  password: string
}

/**
 * Crée un employé. Rend le numéro sous sa forme canonique — c'est celui que
 * l'employé devra saisir pour se connecter, et il peut différer de ce qui a été
 * tapé (`06 12 34 56 78` devient `0612345678`).
 *
 * Aucun rôle n'est transmis : `create_worker()` l'écrit elle-même (E1-02). Ce
 * qui n'est pas un paramètre n'est pas une surface d'escalade.
 */
export async function createWorker(input: NewWorker): Promise<{ userId: string; phone: string }> {
  const { data, error } = await supabase.functions.invoke<{
    userId?: string
    phone?: string
    error?: string
  }>('create-user', { body: input })

  if (error !== null) {
    /*
     * `FunctionsHttpError` porte la réponse, dont le corps contient le message
     * écrit par la fonction. Sans cette lecture, tout refus métier — numéro déjà
     * pris, mot de passe trop court — s'afficherait « Edge Function returned a
     * non-2xx status code », qui ne dit rien à personne.
     */
    const response = (error as { context?: Response }).context
    if (response !== undefined) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      if (typeof body?.error === 'string') throw new Error(body.error)
    }
    throw new Error(error.message)
  }

  if (data?.userId === undefined || data.phone === undefined) {
    throw new Error('Réponse inattendue du serveur.')
  }

  return { userId: data.userId, phone: data.phone }
}

/**
 * Active ou désactive un compte. La fiche reste : les documents et les
 * mouvements portent `created_by`, et un employé supprimé emporterait la
 * réponse à « qui a fait ce bon ? ».
 */
export async function setUserActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_user_active', {
    target_user: id,
    active,
  })

  // Les refus de la base sont déjà écrits pour être lus (« Seul le patron
  // modifie un employé. »). Les reformuler ici, c'est deux formulations à tenir
  // d'accord.
  if (error !== null) throw new Error(error.message)
}
