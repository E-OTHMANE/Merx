/*
 * Doublon de Supabase Auth pour les tests du front. E0-04.
 *
 * Il n'imite pas `supabase-js` : il implémente `AuthClient`, c'est-à-dire les
 * quatre appels que le fournisseur utilise réellement. Le jour où le
 * fournisseur en demande un cinquième, le compilateur le signale ici.
 *
 * Ce que ce doublon ne prouve pas : qu'un jeton réellement émis porte le
 * commerce. C'est le rôle de `supabase/tests/auth.test.ts`, sur le stack local.
 * Les deux couches sont nécessaires — un doublon fidèle à une hypothèse fausse
 * reste vert pour toujours.
 */

import type { Session } from '@supabase/supabase-js'
import { vi } from 'vitest'

import type { AuthClient } from '@/lib/auth'

/** Fabrique un JWT non signé — seul le corps compte, personne ne le vérifie. */
export function fakeToken(appMetadata: Record<string, unknown> | null): string {
  const body = appMetadata === null ? {} : { app_metadata: appMetadata }
  const encode = (value: object): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'user-1',
    role: 'authenticated',
    ...body,
  })}.signature-sans-valeur`
}

interface SessionOptions {
  tenantId?: string | null
  role?: string | null
  email?: string
  userId?: string
}

/**
 * Une session telle que `supabase-js` la rend. Réduite aux champs que le
 * fournisseur lit — le reste du type est comblé par une assertion, assumée :
 * fabriquer un `User` complet ne rendrait le test ni plus vrai ni plus lisible.
 */
export function fakeSession({
  tenantId = 'tenant-a',
  role = 'owner',
  email = 'patron@merx.test',
  userId = 'user-1',
}: SessionOptions = {}): Session {
  const metadata: Record<string, unknown> = {}
  if (tenantId !== null) metadata['tenant_id'] = tenantId
  if (role !== null) metadata['role'] = role

  return {
    access_token: fakeToken(metadata),
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: userId, email },
  } as unknown as Session
}

export interface FakeAuthClient extends AuthClient {
  /** Pousse une session (ou son absence) comme le ferait Supabase Auth. */
  emit: (session: Session | null) => void
  calls: {
    signInWithPassword: ReturnType<typeof vi.fn>
    signOut: ReturnType<typeof vi.fn>
  }
}

interface FakeOptions {
  /** Session déjà en stockage local au démarrage. */
  initialSession?: Session | null
  /** Ce que la connexion doit produire. Par défaut : une session valide. */
  signInResult?: { session?: Session; error?: { message: string; status?: number; code?: string } }
  /** Erreur rendue par la déconnexion — le cas hors-ligne. */
  signOutError?: { message: string; status?: number } | null
}

export function createFakeAuthClient({
  initialSession = null,
  signInResult = {},
  signOutError = null,
}: FakeOptions = {}): FakeAuthClient {
  type Listener = (event: 'SIGNED_IN' | 'SIGNED_OUT', session: Session | null) => void
  const listeners = new Set<Listener>()

  const emit = (session: Session | null): void => {
    for (const listener of listeners) {
      listener(session === null ? 'SIGNED_OUT' : 'SIGNED_IN', session)
    }
  }

  const signInWithPassword = vi.fn(async () => {
    if (signInResult.error !== undefined) return { error: signInResult.error }

    // Comme Supabase : la session arrive par l'abonnement, pas par le retour.
    emit(signInResult.session ?? fakeSession())
    return { error: null }
  })

  const signOut = vi.fn(async () => {
    if (signOutError !== null) return { error: signOutError }
    emit(null)
    return { error: null }
  })

  return {
    auth: {
      getSession: async () => ({ data: { session: initialSession } }),
      onAuthStateChange: (callback) => {
        listeners.add(callback as Listener)
        return {
          data: { subscription: { unsubscribe: () => listeners.delete(callback as Listener) } },
        }
      },
      signInWithPassword,
      signOut,
    },
    emit,
    calls: { signInWithPassword, signOut },
  }
}
