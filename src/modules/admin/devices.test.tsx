/*
 * Les appareils — E1-03, côté interface.
 *
 * Ce qui se vérifie ici, et rien d'autre : le garde de route, la liste et ses
 * quatre états, et le fait que l'appareil s'annonce dès qu'une session est
 * ouverte, quel que soit l'écran demandé.
 *
 * Ce qui ne s'y vérifie pas — qu'un `worker` ne puisse rien *lire* de `device`,
 * et qu'une lettre ne soit jamais donnée deux fois — ne dépend d'aucun de ces
 * composants : c'est la policy restrictive, le garde de `register_device()` et
 * l'index unique, éprouvés sur la base réelle par
 * `supabase/tests/device-registration.test.ts`. Masquer un écran n'est pas un
 * contrôle d'accès ; c'est ce qui évite d'ouvrir une page vide.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { DEVICE_STORAGE_KEY } from '@/lib/device'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * Le doublon porte sur le client partagé, pas sur `devices.ts` : ce qui a de la
 * valeur est justement de voir la requête se former — et qu'aucun filtre
 * `tenant_id` n'y soit écrit à la main (SPEC § 2.1).
 */
const select = vi.fn()
const rpc = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const builder = {
        select: (columns: string) => {
          select(table, columns)
          return builder
        },
        is: () => builder,
        order: () => select.mock.results.at(-1)?.value,
      }
      return builder
    },
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: vi.fn() },
  },
}))

function renderAt(path: string, role: string | null) {
  render(
    <AuthProvider
      client={createFakeAuthClient({
        initialSession: fakeSession({ role, email: 'patron@merx.ma', userId: 'auth-patron' }),
      })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/** Ce que PostgREST rend, tel quel — colonnes en `snake_case`. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    label: 'Comptoir',
    prefix: 'A',
    last_sync_at: '2026-09-05T14:30:00Z',
    is_active: true,
    ...overrides,
  }
}

const homeScreen = () => screen.queryByRole('button', { name: 'Se déconnecter' })

/** Les appels à `register_device()`, séparés du reste. */
const registrations = () => rpc.mock.calls.filter(([name]) => name === 'register_device')

beforeEach(() => {
  select.mockReset()
  rpc.mockReset()
  select.mockReturnValue({ data: [], error: null })
  rpc.mockResolvedValue({ data: [row()], error: null })
  window.localStorage.clear()
})

/* ========================================================================== */
/* Le garde de capacité                                                        */
/* ========================================================================== */

describe('le garde de capacité', () => {
  it('renvoie un `worker` à l’accueil', async () => {
    renderAt('/devices', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Appareils' })).not.toBeInTheDocument()
    // Le garde n'est pas une politesse : il ne demande pas la liste non plus.
    expect(select).not.toHaveBeenCalled()
  })

  it('laisse passer le patron', async () => {
    renderAt('/devices', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Appareils' })).toBeInTheDocument(),
    )
  })

  it("n'offre le lien qu'à qui a la capacité", async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Appareils' })).not.toBeInTheDocument()
  })

  it('offre le lien au patron', async () => {
    renderAt('/', 'owner')

    await waitFor(() => expect(screen.getByRole('link', { name: 'Appareils' })).toBeInTheDocument())
  })
})

/* ========================================================================== */
/* La liste                                                                    */
/* ========================================================================== */

describe('la liste des appareils', () => {
  it('ne filtre aucun tenant à la main — la RLS décide (SPEC § 2.1)', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/devices', 'owner')

    await waitFor(() => expect(select).toHaveBeenCalled())
    const [table, columns] = select.mock.calls[0] as [string, string]
    expect(table).toBe('device')
    expect(columns).not.toMatch(/tenant_id/)
  })

  it('montre le nom, la lettre et la dernière synchronisation', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/devices', 'owner')

    expect(await screen.findByText('Comptoir')).toBeInTheDocument()
    expect(screen.getByLabelText('Préfixe A')).toBeInTheDocument()
    expect(screen.getByText(/Synchronisé le 05\/09\/2026/)).toBeInTheDocument()
  })

  /*
   * E1-03 : « leur dernière synchronisation ». Un appareil enregistré mais
   * jamais revenu doit se lire comme tel, pas comme un tiret — c'est justement
   * celui que le patron cherche quand un bon manque.
   */
  it('dit qu’un appareil n’a jamais synchronisé', async () => {
    select.mockReturnValue({ data: [row({ last_sync_at: null })], error: null })
    renderAt('/devices', 'owner')

    expect(await screen.findByText('Jamais synchronisé')).toBeInTheDocument()
  })

  it('signale un appareil retiré sans le faire disparaître', async () => {
    select.mockReturnValue({ data: [row({ is_active: false })], error: null })
    renderAt('/devices', 'owner')

    expect(await screen.findByText(/Retiré/)).toBeInTheDocument()
    expect(screen.getByText('Comptoir')).toBeInTheDocument()
  })

  /* BRAND-UI § 6 : « Un écran vide invite à agir. » */
  it('explique l’écran vide', async () => {
    renderAt('/devices', 'owner')

    expect(
      await screen.findByText(/Un appareil s’enregistre tout seul à sa première connexion/),
    ).toBeInTheDocument()
  })

  it('annonce l’échec de lecture et propose de réessayer', async () => {
    select.mockReturnValue({ data: null, error: { message: 'Réseau injoignable.' } })
    renderAt('/devices', 'owner')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau injoignable.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* L'enregistrement à la connexion                                             */
/* ========================================================================== */

describe("l'appareil s'annonce", () => {
  /*
   * E1-03 : « Un appareil s'enregistre à la première connexion. » Le
   * déclencheur est la session, pas l'écran des appareils — que le vendeur
   * n'ouvrira jamais, puisqu'il ne peut pas y entrer.
   */
  it('dès qu’une session est ouverte, même sur l’accueil', async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(registrations()).toHaveLength(1))
  })

  it('avec l’identifiant du stockage local, jamais un autre', async () => {
    renderAt('/', 'owner')

    await waitFor(() => expect(registrations()).toHaveLength(1))
    const [, args] = registrations()[0] as [string, Record<string, unknown>]
    expect(args['device_key']).toBe(window.localStorage.getItem(DEVICE_STORAGE_KEY))
  })

  /*
   * Le commerce n'est jamais transmis : il vient du jeton signé (SPEC § 2.1).
   * La lettre non plus — elle est attribuée par la base, sous verrou.
   */
  it('sans transmettre ni commerce ni lettre', async () => {
    renderAt('/', 'owner')

    await waitFor(() => expect(registrations()).toHaveLength(1))
    const [, args] = registrations()[0] as [string, Record<string, unknown>]
    expect(Object.keys(args)).toEqual(['device_key'])
  })

  it('une seule fois, même en traversant plusieurs écrans', async () => {
    renderAt('/devices', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Appareils' })).toBeInTheDocument(),
    )
    expect(registrations()).toHaveLength(1)
  })

  /*
   * Réseau absent : c'est la situation ordinaire derrière un comptoir (SPEC
   * § 2.5). Il n'y a rien à proposer à l'utilisateur, donc rien à afficher — et
   * surtout, l'écran doit rester utilisable.
   */
  it('sans rien casser quand le réseau manque', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Réseau injoignable.' } })
    select.mockReturnValue({ data: [row()], error: null })

    renderAt('/devices', 'owner')

    expect(await screen.findByText('Comptoir')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('jamais sans session', async () => {
    render(
      <AuthProvider client={createFakeAuthClient({ initialSession: null })}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </AuthProvider>,
    )

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Merx' })).toBeInTheDocument(),
    )
    expect(registrations()).toHaveLength(0)
  })
})
