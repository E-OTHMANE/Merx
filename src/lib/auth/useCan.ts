/*
 * La question « ai-je le droit ? », posée pour l'utilisateur connecté. E0-05.
 *
 * Séparé de `permissions.ts`, qui ne doit dépendre ni de React ni du navigateur
 * : le test de conformité de la matrice l'importe depuis `supabase/tests`, en
 * environnement node.
 *
 * Ce hook sert à *afficher*. Il ne protège rien — c'est `merx.can()` qui
 * protège, côté base, à chaque requête (SPEC § 3). Cacher un bouton en
 * l'appelant ici est un confort ; croire que cela remplace la policy est une
 * fuite.
 */

import { useAuth } from '@/lib/auth/context'
import { can, type Capability } from '@/lib/auth/permissions'

export function useCan(capability: Capability): boolean {
  const { user } = useAuth()
  return can(user?.role, capability)
}
