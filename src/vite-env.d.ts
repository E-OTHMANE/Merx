/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/*
 * Les deux seules variables d'environnement du front (E0-04). Déclarées ici
 * pour que leur absence soit une erreur de compilation et non une chaîne
 * `undefined` envoyée à Supabase, qui échouerait au premier appel réseau.
 */
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
