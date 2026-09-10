/*
 * Accès aux données de l'administration. M8 — E1-01.
 *
 * Deux appels, et ils ne passent pas par le même chemin, pour une raison qui
 * n'est pas d'organisation :
 *
 *   — la lecture va droit à PostgREST. Aucun filtre n'est écrit ici : la policy
 *     `super_admin_all` (E0-03) décide de ce qui revient. Un `where` sur le
 *     tenant serait un filtre applicatif, exactement ce que SPEC § 2.1 refuse ;
 *
 *   — la création passe par la fonction Edge `create-tenant`, parce qu'elle
 *     seule peut créer un compte d'authentification (`service_role`). Elle
 *     rappelle ensuite la base avec le jeton de l'appelant, donc l'autorité
 *     reste où elle doit être.
 */

import { supabase } from '@/lib/supabase'

/** Un commerce, tel que la liste de l'éditeur le montre. E1-01. */
export interface TenantSummary {
  id: string
  businessName: string
  ownerName: string | null
  phone: string | null
  city: string | null
  createdAt: string
  /** Dernière émission de jeton d'un utilisateur du commerce. Nul si jamais. */
  lastActivityAt: string | null
}

interface TenantRow {
  id: string
  business_name: string
  owner_name: string | null
  phone: string | null
  city: string | null
  created_at: string
  app_user: Array<{ last_seen_at: string | null }>
}

/**
 * Les commerces, du plus récemment créé au plus ancien.
 *
 * La dernière activité est agrégée ici plutôt qu'en base : elle est le maximum
 * des `last_seen_at` des utilisateurs du commerce, estampillés par le hook
 * d'émission de jeton (migration E1-01). Une vue l'aurait calculée côté
 * serveur, mais une vue est une relation de plus à isoler, à enregistrer et à
 * tester — pour un maximum sur quelques lignes, lu par une seule personne.
 */
export async function listTenants(): Promise<TenantSummary[]> {
  const { data, error } = await supabase
    .from('tenant')
    .select('id, business_name, owner_name, phone, city, created_at, app_user(last_seen_at)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error !== null) throw new Error(error.message)

  return (data as TenantRow[]).map((row) => {
    const seen = row.app_user
      .map((u) => u.last_seen_at)
      .filter((at): at is string => at !== null)
      .sort()

    return {
      id: row.id,
      businessName: row.business_name,
      ownerName: row.owner_name,
      phone: row.phone,
      city: row.city,
      createdAt: row.created_at,
      lastActivityAt: seen.at(-1) ?? null,
    }
  })
}

export interface NewTenant {
  businessName: string
  ownerName: string
  phone: string
  city: string
  password: string
}

/**
 * Crée un commerce et son patron. Rend le numéro sous sa forme canonique —
 * c'est celui que le patron devra saisir pour se connecter, et il peut différer
 * de ce qui a été tapé (`06 12 34 56 78` devient `0612345678`).
 *
 * Les refus de la fonction Edge sont rendus tels quels : ils sont déjà écrits
 * pour être lus (« Ce numéro est déjà rattaché à un compte »). Les traduire une
 * seconde fois ici, c'est deux formulations à tenir d'accord.
 */
export async function createTenant(input: NewTenant): Promise<{ tenantId: string; phone: string }> {
  const { data, error } = await supabase.functions.invoke<{
    tenantId?: string
    phone?: string
    error?: string
  }>('create-tenant', { body: input })

  if (error !== null) {
    /*
     * `FunctionsHttpError` porte la réponse, dont le corps contient le message
     * écrit par la fonction. Sans cette lecture, toute erreur métier — numéro
     * déjà pris, mot de passe trop court — s'afficherait « Edge Function
     * returned a non-2xx status code », qui ne dit rien à personne.
     */
    const response = (error as { context?: Response }).context
    if (response !== undefined) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null
      if (typeof body?.error === 'string') throw new Error(body.error)
    }
    throw new Error(error.message)
  }

  if (data?.tenantId === undefined || data.phone === undefined) {
    throw new Error('Réponse inattendue du serveur.')
  }

  return { tenantId: data.tenantId, phone: data.phone }
}
