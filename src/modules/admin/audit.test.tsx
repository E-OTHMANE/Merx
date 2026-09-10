/*
 * Le journal — E1-04, côté interface.
 *
 * Ce qui se vérifie ici : le garde de route, les quatre états de l'écran, et la
 * forme des requêtes — aucun filtre `tenant_id` écrit à la main (SPEC § 2.1),
 * et des bornes de date qui couvrent une journée *marocaine*.
 *
 * Ce qui ne s'y vérifie pas — qu'un `worker` ne lise rien du journal, qu'une
 * ligne ne se rature pas, que le helper soit le seul écrivain — ne dépend
 * d'aucun de ces composants. C'est la policy restrictive, les deux triggers
 * d'ajout seul et les privilèges retirés, éprouvés sur la base réelle par
 * `supabase/tests/audit.test.ts`. Masquer un écran n'est pas un contrôle
 * d'accès ; c'est ce qui évite d'ouvrir une page vide.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * Le doublon porte sur le client partagé : ce qui a de la valeur est de voir la
 * requête se former, filtre par filtre.
 */
const select = vi.fn()
const filters = vi.fn()
const result = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const builder = {
        select: (columns: string) => {
          select(table, columns)
          return builder
        },
        is: () => builder,
        eq: (column: string, value: unknown) => {
          filters(table, 'eq', column, value)
          return builder
        },
        gte: (column: string, value: unknown) => {
          filters(table, 'gte', column, value)
          return builder
        },
        lt: (column: string, value: unknown) => {
          filters(table, 'lt', column, value)
          return builder
        },
        limit: () => builder,
        order: () => builder,
        /*
         * Le constructeur de requête de `supabase-js` est un *thenable* : la
         * requête part quand on l'attend, pas à un appel particulier. Le
         * doublon l'imite, sans quoi il imposerait un ordre d'appels que le
         * vrai client n'impose pas — et un filtre déplacé casserait un test
         * sans que rien ne soit cassé. La réponse dépend de la table : l'écran
         * lit le journal *et* la liste des auteurs, pour nommer les lignes.
         */
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result(table)).then(resolve),
      }
      return builder
    },
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
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
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    action: 'price_override',
    entity_type: 'sale_line',
    entity_id: 'line-1',
    user_id: 'user-1',
    created_at: '2026-09-08T14:30:00Z',
    before: { unit_price: '10.00' },
    after: { unit_price: '8.00' },
    ...overrides,
  }
}

const author = { id: 'user-1', full_name: 'Rachid', role: 'worker', is_active: true }

const homeScreen = () => screen.queryByRole('button', { name: 'Se déconnecter' })

/** Les lectures et les filtres posés sur `audit_log` — l'écran lit aussi
 * `app_user`, pour nommer les auteurs. */
const auditSelect = () => select.mock.calls.filter(([table]) => table === 'audit_log')
const auditFilters = () => filters.mock.calls.filter(([table]) => table === 'audit_log')

beforeEach(() => {
  select.mockReset()
  filters.mockReset()
  result.mockReset()
  result.mockImplementation((table: string) =>
    table === 'app_user' ? { data: [author], error: null } : { data: [], error: null },
  )
})

/* ========================================================================== */
/* Le garde de capacité                                                        */
/* ========================================================================== */

describe('le garde de capacité', () => {
  it('renvoie un `worker` à l’accueil', async () => {
    renderAt('/audit', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Journal' })).not.toBeInTheDocument()
    // Le garde n'est pas une politesse : il ne demande pas les lignes non plus.
    expect(select).not.toHaveBeenCalled()
  })

  it('laisse passer le patron', async () => {
    renderAt('/audit', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Journal' })).toBeInTheDocument(),
    )
  })

  it("n'offre le lien qu'à qui a la capacité", async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument()
  })

  it('offre le lien au patron', async () => {
    renderAt('/', 'owner')

    await waitFor(() => expect(screen.getByRole('link', { name: 'Journal' })).toBeInTheDocument())
  })
})

/* ========================================================================== */
/* La lecture                                                                  */
/* ========================================================================== */

describe('la lecture du journal', () => {
  it('ne filtre aucun tenant à la main — la RLS décide (SPEC § 2.1)', async () => {
    renderAt('/audit', 'owner')

    await waitFor(() => expect(auditSelect()).toHaveLength(1))
    const [, columns] = auditSelect()[0] as [string, string]
    expect(columns).not.toMatch(/tenant_id/)
    expect(auditFilters()).toHaveLength(0)
  })

  it('montre l’action en français, l’auteur et la date', async () => {
    result.mockImplementation((table: string) =>
      table === 'app_user'
        ? { data: [author], error: null }
        : { data: [entry()], error: null },
    )
    renderAt('/audit', 'owner')

    /*
     * La ligne, pas la page : « Rachid » figure aussi dans le filtre par
     * utilisateur, et une recherche à l'échelle de l'écran confondrait les deux
     * — un journal qui n'afficherait plus l'auteur passerait pour juste.
     */
    const line = await screen.findByRole('listitem')
    expect(line).toHaveTextContent('Prix forcé')
    expect(line).toHaveTextContent('Rachid')
    expect(line).toHaveTextContent('sale_line')
    expect(line).toHaveTextContent('08/09/2026')
  })

  /*
   * Le nom vient d'une seconde lecture, qui peut échouer seule. L'écran ne doit
   * pas tomber pour autant : l'identifiant brut reste lisible faute de mieux,
   * et le journal garde sa raison d'être.
   */
  it('retombe sur l’identifiant quand les auteurs manquent', async () => {
    result.mockImplementation((table: string) =>
      table === 'app_user'
        ? { data: null, error: { message: 'Réseau injoignable.' } }
        : { data: [entry()], error: null },
    )
    renderAt('/audit', 'owner')

    expect(await screen.findByRole('listitem')).toHaveTextContent('user-1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  /* BRAND-UI § 6 : un écran vide dit ce qui va s'y écrire. */
  it('explique l’écran vide', async () => {
    renderAt('/audit', 'owner')

    expect(await screen.findByText(/Le journal se remplit tout seul/)).toBeInTheDocument()
  })

  it('annonce l’échec de lecture et propose de réessayer', async () => {
    result.mockImplementation((table: string) =>
      table === 'app_user'
        ? { data: [author], error: null }
        : { data: null, error: { message: 'Réseau injoignable.' } },
    )
    renderAt('/audit', 'owner')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau injoignable.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* Les deux filtres de E1-04                                                   */
/* ========================================================================== */

describe('les filtres', () => {
  it('filtrent par utilisateur', async () => {
    renderAt('/audit', 'owner')
    await screen.findByRole('heading', { name: 'Journal' })
    await waitFor(() => expect(screen.getByRole('option', { name: 'Rachid' })).toBeInTheDocument())

    await userEvent.selectOptions(screen.getByLabelText('Utilisateur'), 'user-1')

    await waitFor(() =>
      expect(auditFilters()).toContainEqual(['audit_log', 'eq', 'user_id', 'user-1']),
    )
  })

  /*
   * La borne haute est exclusive et porte sur le *lendemain* : « au 9 » doit
   * contenir le 9 en entier. Écrite `lte` sur `2026-09-09T00:00:00`, elle
   * n'aurait retenu que les actions de minuit pile.
   *
   * Et le décalage est celui de Casablanca, pas celui du navigateur : une
   * tablette dont le fuseau a dérivé — cela arrive, et plus souvent qu'on ne
   * croit — sortirait sinon les ventes du matin de la journée qu'on lit
   * (SPEC § 4).
   */
  it('filtrent par date, sur la journée marocaine entière', async () => {
    renderAt('/audit', 'owner')
    await screen.findByRole('heading', { name: 'Journal' })

    await userEvent.type(screen.getByLabelText('Du'), '2026-09-08')
    await userEvent.type(screen.getByLabelText('Au'), '2026-09-09')

    await waitFor(() => {
      const posted = auditFilters()
      expect(posted).toContainEqual(['audit_log', 'gte', 'created_at', '2026-09-08T00:00:00+01:00'])
      expect(posted).toContainEqual(['audit_log', 'lt', 'created_at', '2026-09-10T00:00:00+01:00'])
    })
  })
})
