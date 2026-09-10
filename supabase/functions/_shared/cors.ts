/*
 * En-têtes CORS des fonctions Edge. E1-01.
 *
 * L'application est une SPA servie depuis une autre origine que l'API (SPEC
 * § 2.7) : sans ces en-têtes, le navigateur refuse la réponse avant que le code
 * ne la voie, et l'erreur ne ressemble à rien de ce qui s'est réellement passé.
 *
 * `*` sur l'origine : la fonction n'accorde rien par elle-même. Elle exige un
 * jeton dans `Authorization`, et l'autorité reste à la base, qui le relit signé
 * (SPEC § 2.1). Une liste d'origines ici protégerait d'un CSRF qui n'existe pas
 * — rien n'est porté par un cookie.
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/** Une réponse JSON, en-têtes CORS compris. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}
