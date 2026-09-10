/* Surface publique de l'authentification. E0-04. */

export { AuthProvider, type AuthClient } from '@/lib/auth/AuthProvider'
export { useAuth, type AuthContextValue, type AuthStatus, type AuthUser } from '@/lib/auth/context'
export { AUTH_MESSAGES } from '@/lib/auth/messages'
export { claimsOf, type TokenClaims, type UserRole } from '@/lib/auth/claims'
export { CAPABILITIES, can, type Capability } from '@/lib/auth/permissions'
export { useCan } from '@/lib/auth/useCan'
