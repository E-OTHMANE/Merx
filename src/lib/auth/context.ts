/*
 * L'état d'authentification, tel que le reste de l'application le voit. E0-04.
 *
 * Séparé du composant qui le fournit : un fichier `.tsx` qui exporte à la fois
 * un composant et un hook casse le rafraîchissement à chaud (règle
 * `react-refresh/only-export-components`).
 */

import { createContext, useContext } from 'react'

import type { UserRole } from '@/lib/auth/claims'

/** La session d'un utilisateur, réduite à ce dont l'interface a besoin. */
export interface AuthUser {
  id: string
  email: string | null
  /** Commerce de l'utilisateur, lu dans le jeton. Jamais nul quand connecté. */
  tenantId: string
  /** Rôle métier. E0-05 en fera des droits ; ici il est seulement porté. */
  role: UserRole | null
}

/**
 * Trois états, pas deux. `loading` existe parce qu'au premier rendu la session
 * n'est pas encore relue du stockage local : la confondre avec `signed-out`
 * renverrait vers la connexion un utilisateur déjà connecté, à chaque
 * démarrage de l'application.
 */
export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

export interface AuthContextValue {
  status: AuthStatus
  user: AuthUser | null
  /** Dernier refus, prêt à afficher. `null` quand il n'y a rien à dire. */
  message: string | null
  /**
   * Numéro de téléphone du patron, ou adresse de l'éditeur. La dérivation vers
   * l'identifiant Supabase Auth est faite par le fournisseur (E1-01) : aucun
   * écran n'a à savoir qu'une adresse existe derrière un numéro.
   */
  signIn: (identifier: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error("useAuth() hors d'un <AuthProvider>.")
  }
  return value
}
