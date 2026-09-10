/*
 * Le fournisseur de session. E0-04.
 *
 * Il ne fait que trois choses, et rien d'autre :
 *   — relire la session au démarrage, puis suivre ses changements ;
 *   — refuser une session sans commerce, en le disant ;
 *   — connecter et déconnecter.
 *
 * Les droits — qui voit quoi, qui peut quoi — sont E0-05. Ici, le rôle est
 * transporté, jamais interprété.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { AuthChangeEvent, Session, Subscription } from '@supabase/supabase-js'

import { claimsOf } from '@/lib/auth/claims'
import { AuthContext, type AuthContextValue, type AuthUser } from '@/lib/auth/context'
import { AUTH_MESSAGES } from '@/lib/auth/messages'
import { accountIdentifier } from '@/lib/phone'
import { supabase } from '@/lib/supabase'

interface AuthErrorLike {
  message: string
  status?: number | undefined
  code?: string | undefined
}

/**
 * Ce que le fournisseur attend d'un client — pas une ligne de plus. Le vrai
 * client Supabase le satisfait ; un doublon d'essai aussi, sans avoir à imiter
 * toute la surface de `supabase-js`.
 */
export interface AuthClient {
  auth: {
    getSession(): Promise<{ data: { session: Session | null } }>
    onAuthStateChange(
      callback: (event: AuthChangeEvent, session: Session | null) => void,
    ): { data: { subscription: Pick<Subscription, 'unsubscribe'> } }
    signInWithPassword(credentials: { email: string; password: string }): Promise<{
      error: AuthErrorLike | null
    }>
    signOut(options?: { scope: 'global' | 'local' | 'others' }): Promise<{
      error: AuthErrorLike | null
    }>
  }
}

/** Traduit un refus de Supabase Auth en une phrase qui dit quoi faire. */
function messageFor(error: AuthErrorLike): string {
  if (error.status === 429 || error.code === 'over_request_rate_limit') {
    return AUTH_MESSAGES.tooManyRequests
  }
  /*
   * E1-02 : le hook d'émission de jeton refuse un compte désactivé, et Supabase
   * Auth relaie son refus en 403. C'est le seul 403 que la connexion produit —
   * un mot de passe faux est un 400, une limite de débit un 429.
   */
  if (error.status === 403) {
    return AUTH_MESSAGES.deactivated
  }
  // Pas de statut : la requête n'est jamais arrivée. Sur une tablette derrière
  // un comptoir, c'est le cas le plus fréquent — il mérite son propre message.
  if (error.status === undefined || error.status >= 500) {
    return AUTH_MESSAGES.offline
  }
  return AUTH_MESSAGES.badCredentials
}

export function AuthProvider({
  children,
  client = supabase,
}: {
  children: ReactNode
  client?: AuthClient
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void client.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session)
      setReady(true)
    })

    /*
     * Le rappel ne fait que poser l'état. Appeler `signOut()` depuis l'intérieur
     * d'un rappel de `onAuthStateChange` bloque le verrou interne de
     * `supabase-js` : la déconnexion d'un compte orphelin est donc décidée par
     * l'effet suivant, hors du rappel.
     */
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      if (cancelled) return
      setSession(next)
      setReady(true)
    })

    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [client])

  // Le jeton ne change qu'à la connexion et au rafraîchissement : inutile de
  // le décoder à chaque rendu sur une tablette d'entrée de gamme.
  const claims = useMemo(() => claimsOf(session?.access_token), [session?.access_token])

  /*
   * Authentifié, mais sans commerce. Le compte existe côté Auth et le hook n'a
   * déposé aucun `tenant_id` : fiche `app_user` absente, désactivée ou
   * supprimée (E0-03). Laisser entrer produirait une application vide — la RLS
   * ne rendrait jamais une ligne — et l'utilisateur croirait à une panne.
   */
  const orphan = session !== null && claims.tenantId === null

  useEffect(() => {
    if (!orphan) return

    // La déconnexion d'abord, l'explication ensuite : dans cet ordre, le
    // message ne peut pas s'afficher sur un écran encore protégé. L'échec de
    // `signOut()` — réseau absent — ne doit pas priver l'utilisateur de la
    // raison : elle est posée dans tous les cas.
    void (async () => {
      await client.auth.signOut().catch(() => undefined)
      setMessage(AUTH_MESSAGES.noTenant)
    })()
  }, [orphan, client])

  const signIn = useCallback(
    async (identifier: string, password: string): Promise<void> => {
      setMessage(null)

      if (identifier.trim() === '' || password === '') {
        setMessage(AUTH_MESSAGES.missingFields)
        return
      }

      /*
       * E1-01 : le patron se connecte avec son numéro de téléphone, jamais avec
       * un email — il n'en a pas saisi un, et l'adresse Supabase Auth de son
       * compte est dérivée du numéro. La dérivation est faite ici, au seul
       * point d'entrée de la connexion, par la fonction même qui a servi à
       * créer le compte (`supabase/functions/_shared/phone.ts`).
       *
       * L'éditeur, lui, se connecte par une vraie adresse : son compte n'est
       * créé par aucun écran de l'application. `accountIdentifier` laisse donc
       * passer ce qui contient un « @ ».
       */
      const account = accountIdentifier(identifier)
      if (account === null) {
        // Dit avant l'appel réseau. Sans cela, un numéro mal ponctué partirait
        // vers une adresse inexistante et reviendrait en « mot de passe
        // incorrect » — le seul message qui n'aide pas à corriger.
        setMessage(AUTH_MESSAGES.badIdentifier)
        return
      }

      const { error } = await client.auth.signInWithPassword({ email: account, password })
      if (error !== null) setMessage(messageFor(error))

      // En cas de succès, rien à faire : `onAuthStateChange` pose la session.
      // Et si le jeton revient sans commerce, l'effet ci-dessus s'en charge —
      // un seul endroit décide, quel que soit le chemin d'arrivée.
    },
    [client],
  )

  const signOut = useCallback(async (): Promise<void> => {
    setMessage(null)

    const { error } = await client.auth.signOut()

    /*
     * La révocation côté serveur a échoué — réseau absent, le cas normal ici.
     * La session locale part quand même : un utilisateur qui appuie sur « Se
     * déconnecter » derrière un comptoir partagé doit être déconnecté de cette
     * tablette, réseau ou pas. Le jeton reste valide côté serveur jusqu'à son
     * expiration ; c'est le prix, et il est plus petit que celui d'une session
     * ouverte que personne n'a pu fermer.
     */
    if (error !== null) await client.auth.signOut({ scope: 'local' })

    setSession(null)
  }, [client])

  const user: AuthUser | null = useMemo(() => {
    if (session === null || claims.tenantId === null) return null
    return {
      id: session.user.id,
      email: session.user.email ?? null,
      tenantId: claims.tenantId,
      role: claims.role,
    }
  }, [session, claims.tenantId, claims.role])

  const value: AuthContextValue = useMemo(
    () => ({
      status: !ready ? 'loading' : user !== null ? 'signed-in' : 'signed-out',
      user,
      message,
      signIn,
      signOut,
    }),
    [ready, user, message, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
