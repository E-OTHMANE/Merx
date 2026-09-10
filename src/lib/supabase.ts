/*
 * Le client Supabase — un seul, pour toute l'application. E0-04.
 *
 * SPEC § 2.7 : pas de backend maison. Le front parle à PostgREST et à Supabase
 * Auth, et c'est la RLS qui décide ce qu'il obtient (SPEC § 2.1). La clé `anon`
 * est publique par construction : elle n'ouvre rien, elle identifie le projet.
 *
 * La session est conservée dans le stockage local et rafraîchie toute seule :
 * l'utilisateur d'un commerce ne se reconnecte pas chaque matin, et surtout pas
 * quand le réseau est absent (SPEC § 2.5). Une seule instance dans tout le
 * projet — deux clients, ce sont deux minuteries de rafraîchissement sur le
 * même jeton, donc des révocations mutuelles.
 */

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY sont absentes. ' +
      'Copier .env.example en .env.local.',
  )
}

/** Clé du stockage local. Nommée : une clé par défaut se confond entre projets. */
export const SESSION_STORAGE_KEY = 'merx.auth'

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: SESSION_STORAGE_KEY,
    // Aucun fournisseur externe en V1 : rien à lire dans l'URL de retour.
    detectSessionInUrl: false,
  },
})
