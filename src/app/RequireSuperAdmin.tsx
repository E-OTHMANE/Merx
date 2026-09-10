/*
 * Garde des écrans de l'éditeur. E1-01.
 *
 * Il ne protège rien, et c'est délibéré : ce qui protège est le garde
 * `merx.is_super_admin()` en tête de `public.create_tenant()`, et la policy
 * `super_admin_all` pour la lecture (E0-03). Un `owner` qui forcerait la route
 * verrait une liste vide et se ferait refuser la création — la RLS ne lui rend
 * rien.
 *
 * Ce composant existe pour que l'écran ne s'ouvre pas sur du vide. E0-05 :
 * « l'interface masque les actions interdites, **en plus** du contrôle
 * serveur. »
 *
 * `merx.can()` n'est pas consulté ici : administrer les commerces n'est pas une
 * case de la matrice § 3.1, qui n'a que les colonnes `owner` et `worker`.
 * L'éditeur est traité en amont, comme il l'est côté base.
 */

import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '@/lib/auth'

export function RequireSuperAdmin() {
  const { user } = useAuth()

  // `replace` : la route interdite ne reste pas dans l'historique, sinon le
  // retour arrière y ramène en boucle.
  if (user?.role !== 'super_admin') return <Navigate to="/" replace />

  return <Outlet />
}
