/*
 * Garde de route. E0-04 — « les routes protégées redirigent vers la connexion ».
 *
 * Trois états, pas deux. Tant que la session n'est pas relue du stockage local,
 * on n'affiche ni le contenu ni la connexion : rediriger pendant `loading`
 * renverrait au formulaire un utilisateur déjà connecté, à chaque démarrage.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { useAuth } from '@/lib/auth'
import { useDeviceRegistration } from '@/lib/device'

/*
 * BRAND-UI § 8 : « Un écran de chargement montre la forme de ce qui arrive, pas
 * un rond qui tourne au centre. » Des blocs neutres, aux dimensions de l'écran
 * qui suit, sans animation (BRAND-UI § 10 : presque rien).
 */
function LoadingScreen() {
  return (
    <main aria-busy="true" aria-label="Chargement" className="min-h-dvh px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <div className="h-7 w-32 rounded-field bg-paper-100" />
        <div className="h-field rounded-field bg-paper-100" />
        <div className="h-field rounded-field bg-paper-100" />
      </div>
    </main>
  )
}

export function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()

  /*
   * E1-03 : « Un appareil s'enregistre à la première connexion. » Ici, parce que
   * c'est le seul endroit que toute session traverse, quel que soit l'écran
   * demandé — un vendeur n'ouvrira jamais l'écran des appareils, et sa tablette
   * doit pourtant avoir sa lettre de numérotation (SPEC § 2.5).
   *
   * Le hook est appelé avant les retours conditionnels : il décide lui-même de
   * ne rien faire tant que la session n'est pas ouverte.
   */
  useDeviceRegistration()

  if (status === 'loading') return <LoadingScreen />

  if (status === 'signed-out') {
    // `replace` : la route protégée ne doit pas rester dans l'historique,
    // sinon le retour arrière après connexion ramène à la redirection.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}
