/*
 * Garde de route par capacité. E1-02.
 *
 * E0-05 laissait un critère invérifiable : « l'interface masque les actions
 * interdites, **en plus** du contrôle serveur ». Il n'y avait rien à masquer —
 * aucun écran n'était interdit à un `worker`. E1-02 en apporte un, et ce
 * composant est ce qui rend le critère vérifiable.
 *
 * `RequireSuperAdmin` (E1-01) ne pouvait pas servir : administrer les commerces
 * n'est pas une case de la matrice § 3.1, qui n'a que les colonnes `owner` et
 * `worker`. Gérer les utilisateurs en est une — la dernière ligne du tableau.
 * Le garde consulte donc `useCan()`, donc la copie de la matrice, elle-même
 * comparée ligne à ligne à `merx.role_capability` par
 * `supabase/tests/permissions.test.ts`. Un droit ajouté d'un seul côté casse le
 * build ; un droit vérifié ici sans passer par la matrice n'existerait nulle
 * part ailleurs.
 *
 * Il ne protège rien, et c'est écrit exprès. Ce qui protège est la policy
 * restrictive sur `app_user` et le garde en tête de `create_worker()` : un
 * `worker` qui forcerait la route verrait une liste vide et se ferait refuser
 * toute écriture. Ce composant existe pour que l'écran ne s'ouvre pas sur du
 * vide — masquer n'est pas interdire.
 */

import { Navigate, Outlet } from 'react-router-dom'

import { useCan } from '@/lib/auth'
import type { Capability } from '@/lib/auth'

export function RequireCapability({ capability }: { capability: Capability }) {
  const allowed = useCan(capability)

  // `replace` : la route interdite ne reste pas dans l'historique, sinon le
  // retour arrière y ramène en boucle.
  if (!allowed) return <Navigate to="/" replace />

  return <Outlet />
}
