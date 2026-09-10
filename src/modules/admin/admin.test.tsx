/*
 * Administration — E1-01, côté interface.
 *
 * Trois choses se vérifient ici, et une quatrième ne s'y vérifie pas.
 *
 *   — le garde de rôle : un `owner` qui tape l'URL n'atteint pas l'écran ;
 *   — la liste et ses quatre états (BRAND-UI § 8) ;
 *   — le formulaire, et son refus d'un numéro invalide avant tout appel réseau.
 *
 * Ce qui ne se vérifie pas ici : qu'un `owner` ne puisse rien *lire*. Cela ne
 * dépend d'aucun de ces composants — c'est la policy `super_admin_all` (E0-03)
 * et le garde `merx.is_super_admin()` de `create_tenant()`, éprouvés sur la
 * base réelle par `supabase/tests/tenant-creation.test.ts`. Masquer un écran
 * n'est pas un contrôle d'accès ; c'est ce qui évite d'ouvrir une page vide.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * `api.ts` parle à PostgREST et aux fonctions Edge par le client partagé. Le
 * doublon porte sur ce client, et non sur `api.ts` : ce qui a de la valeur ici
 * est justement que la requête soit formée — et l'on veut voir qu'aucun filtre
 * `tenant_id` n'y est écrit à la main (SPEC § 2.1).
 */
const select = vi.fn()
const invoke = vi.fn()

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
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}))

function renderAt(path: string, role: string | null) {
  const client = createFakeAuthClient({
    initialSession: fakeSession({ role, email: 'editeur@merx.ma' }),
  })

  render(
    <AuthProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/** Ce que PostgREST rend, tel quel — colonnes en `snake_case`. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tenant-1',
    business_name: 'Droguerie Atlas',
    owner_name: 'Rachid Benali',
    phone: '0612345678',
    city: 'Casablanca',
    created_at: '2026-09-01T09:00:00Z',
    app_user: [{ last_seen_at: '2026-09-05T14:30:00Z' }],
    ...overrides,
  }
}

beforeEach(() => {
  select.mockReset()
  invoke.mockReset()
  select.mockReturnValue({ data: [], error: null })
})

describe('le garde de rôle', () => {
  it.each([['owner'], ['worker']])('renvoie un %s à l’accueil', async (role) => {
    renderAt('/admin/tenants', role)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('heading', { name: 'Commerces' })).not.toBeInTheDocument()
  })

  it('laisse passer l’éditeur', async () => {
    renderAt('/admin/tenants', 'super_admin')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Commerces' })).toBeInTheDocument(),
    )
  })

  it("n'offre le lien qu'à l'éditeur", async () => {
    renderAt('/', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('link', { name: 'Commerces' })).not.toBeInTheDocument()
  })
})

describe('la liste des commerces', () => {
  it('ne filtre aucun tenant à la main — la RLS décide (SPEC § 2.1)', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/admin/tenants', 'super_admin')

    await waitFor(() => expect(select).toHaveBeenCalled())
    const [table, columns] = select.mock.calls[0] as [string, string]
    expect(table).toBe('tenant')
    expect(columns).not.toMatch(/tenant_id/)
  })

  it('montre la date de création et la dernière activité', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/admin/tenants', 'super_admin')

    expect(await screen.findByText('Droguerie Atlas')).toBeInTheDocument()
    expect(screen.getByText(/Créé le 01\/09\/2026/)).toBeInTheDocument()
    expect(screen.getByText(/Vu le 05\/09\/2026/)).toBeInTheDocument()
  })

  /*
   * L'information que l'éditeur cherche vraiment : l'installation a-t-elle été
   * prise en main ? Un tiret ne répondrait pas à la question.
   */
  it('dit qu’un commerce n’a jamais servi', async () => {
    select.mockReturnValue({ data: [row({ app_user: [] })], error: null })
    renderAt('/admin/tenants', 'super_admin')

    expect(await screen.findByText('Jamais connecté')).toBeInTheDocument()
  })

  it('retient la connexion la plus récente parmi les utilisateurs', async () => {
    select.mockReturnValue({
      data: [
        row({
          app_user: [
            { last_seen_at: '2026-09-02T08:00:00Z' },
            { last_seen_at: null },
            { last_seen_at: '2026-09-06T17:45:00Z' },
          ],
        }),
      ],
      error: null,
    })
    renderAt('/admin/tenants', 'super_admin')

    expect(await screen.findByText(/Vu le 06\/09\/2026/)).toBeInTheDocument()
  })

  /* BRAND-UI § 6 : « Un écran vide invite à agir. » */
  it('invite à agir quand aucun commerce n’est installé', async () => {
    renderAt('/admin/tenants', 'super_admin')

    expect(
      await screen.findByText('Aucun commerce. Créez le premier pour installer un client.'),
    ).toBeInTheDocument()
  })

  it('annonce l’échec de lecture et propose de réessayer', async () => {
    select.mockReturnValue({ data: null, error: { message: 'Réseau injoignable.' } })
    renderAt('/admin/tenants', 'super_admin')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau injoignable.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

describe('le formulaire de création', () => {
  /*
   * La session est relue du stockage local avant que le garde ne laisse passer
   * : au premier rendu, l'écran affiché est celui de chargement (E0-04). Saisir
   * sans l'attendre chercherait des champs qui n'existent pas encore.
   */
  async function openForm() {
    renderAt('/admin/tenants/new', 'super_admin')
    await screen.findByRole('heading', { name: 'Nouveau commerce' })
  }

  async function fill(phone: string) {
    await openForm()

    await userEvent.type(screen.getByLabelText('Nom du commerce'), 'Droguerie Atlas')
    await userEvent.type(screen.getByLabelText('Nom du patron'), 'Rachid Benali')
    await userEvent.type(screen.getByLabelText('Téléphone du patron'), phone)
    await userEvent.type(screen.getByLabelText('Mot de passe du patron'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Créer le commerce' }))
  }

  it('porte les quatre champs de la story, la ville étant facultative', async () => {
    await openForm()

    expect(screen.getByLabelText('Nom du commerce')).toBeInTheDocument()
    expect(screen.getByLabelText('Nom du patron')).toBeInTheDocument()
    expect(screen.getByLabelText('Téléphone du patron')).toBeInTheDocument()
    // SPEC § 2.6 : ce qui est facultatif se dit.
    expect(screen.getByLabelText('Ville (facultatif)')).toBeInTheDocument()
    // Aucun champ email : l'identifiant est dérivé du numéro (E1-01).
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
  })

  it('transmet la saisie à la fonction Edge', async () => {
    invoke.mockResolvedValue({ data: { tenantId: 'tenant-1', phone: '0612345678' }, error: null })
    await fill('06 12 34 56 78')

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    const [name, options] = invoke.mock.calls[0] as [string, { body: Record<string, string> }]
    expect(name).toBe('create-tenant')
    expect(options.body).toMatchObject({
      businessName: 'Droguerie Atlas',
      ownerName: 'Rachid Benali',
      phone: '06 12 34 56 78',
      password: 'motdepasse',
    })
  })

  /*
   * Le contrôle local évite un compte d'authentification créé puis supprimé —
   * et, surtout, il nomme la vraie cause. Le serveur revérifie : c'est lui qui
   * décide.
   */
  it('refuse un numéro invalide sans appeler le serveur', async () => {
    await fill('0612')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Numéro de téléphone invalide. Exemple : 06 12 34 56 78.',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('affiche le refus du serveur tel qu’il est écrit', async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: new Response(JSON.stringify({ error: 'Ce numéro est déjà rattaché à un compte.' })),
      }),
    })
    await fill('0612345678')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ce numéro est déjà rattaché à un compte.',
    )
  })
})
