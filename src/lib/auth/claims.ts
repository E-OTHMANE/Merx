/*
 * Lecture du jeton d'accès. E0-04.
 *
 * `tenant_id` et `role` sont déposés dans `app_metadata` par le hook
 * `merx.custom_access_token()` (E0-03, migration `tenancy.sql`). Ce fichier ne
 * fait que les relire : il ne les calcule pas, ne les complète pas, et ne les
 * remplace jamais par une valeur locale.
 *
 * La signature n'est pas vérifiée ici, et ce n'est pas un oubli. Le front n'a
 * pas le secret, et l'aurait-il que cela ne servirait à rien : ce qui protège
 * les données est la RLS, côté base, qui relit le jeton signé à chaque requête
 * (SPEC § 2.1). Ce que le front lit ici ne sert qu'à afficher — décider quoi
 * montrer, et détecter un compte sans commerce. Un utilisateur qui trafiquerait
 * son stockage local se donnerait un écran, pas une ligne de données.
 *
 * Le `role` de premier niveau du JWT est le rôle Postgres (`authenticated`) ;
 * le rôle métier est celui d'`app_metadata`. Les confondre donnerait le
 * super-admin à toute session authentifiée — c'est exactement ce que la
 * migration E0-03 prend soin de séparer.
 */

/** Les trois rôles de SPEC § 3. E0-05 leur donnera des droits ; ici, on lit. */
export type UserRole = 'super_admin' | 'owner' | 'worker'

const ROLES: readonly string[] = ['super_admin', 'owner', 'worker']

export interface TokenClaims {
  /** Commerce de l'appelant. `null` si le hook n'a rien déposé. */
  tenantId: string | null
  /** Rôle métier. `null` si absent ou inconnu. */
  role: UserRole | null
}

const EMPTY: TokenClaims = { tenantId: null, role: null }

/** Décode le corps d'un JWT sans en vérifier la signature. */
function payloadOf(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64)) as Record<string, unknown>
  } catch {
    // Un jeton illisible est traité comme un jeton sans claim : pas de tenant,
    // donc pas d'accès. L'échec se lit comme une absence de droit, jamais comme
    // une exception qu'un appelant pourrait oublier d'attraper.
    return null
  }
}

export function claimsOf(accessToken: string | null | undefined): TokenClaims {
  if (!accessToken) return EMPTY

  const payload = payloadOf(accessToken)
  const metadata = payload?.['app_metadata']
  if (typeof metadata !== 'object' || metadata === null) return EMPTY

  const { tenant_id: tenant, role } = metadata as Record<string, unknown>

  return {
    tenantId: typeof tenant === 'string' && tenant !== '' ? tenant : null,
    role: typeof role === 'string' && ROLES.includes(role) ? (role as UserRole) : null,
  }
}
