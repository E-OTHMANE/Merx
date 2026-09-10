/*
 * Les employés — E1-02, côté interface.
 *
 * C'est ici que le critère laissé en suspens par E0-05 devient vérifiable :
 * « l'interface masque les actions interdites, **en plus** du contrôle
 * serveur ». Il n'y avait rien à masquer tant qu'aucun écran n'était interdit à
 * un `worker` ; il y en a un.
 *
 * Ce qui se vérifie ici, et rien d'autre : le garde de route, la liste et ses
 * quatre états, le formulaire. Ce qui ne s'y vérifie pas — qu'un `worker` ne
 * puisse rien *lire* ni *écrire* — ne dépend d'aucun de ces composants : c'est
 * la policy restrictive sur `app_user` et les gardes des deux RPC, éprouvés sur
 * la base réelle par `supabase/tests/user-management.test.ts`. Masquer un écran
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
 * Le doublon porte sur le client partagé, pas sur `users.ts` : ce qui a de la
 * valeur est justement de voir la requête se former — et qu'aucun filtre
 * `tenant_id` n'y soit écrit à la main (SPEC § 2.1).
 */
const select = vi.fn()
const rpc = vi.fn()
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
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
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
    id: 'user-2',
    auth_user_id: 'auth-employe',
    full_name: 'Yassine Alaoui',
    phone: '0612345678',
    role: 'worker',
    is_active: true,
    last_seen_at: '2026-09-05T14:30:00Z',
    ...overrides,
  }
}

/** La ligne du patron lui-même : `auth_user_id` est celui de sa session. */
function ownRow(overrides: Record<string, unknown> = {}) {
  return row({
    id: 'user-1',
    auth_user_id: 'auth-patron',
    full_name: 'Rachid Benali',
    role: 'owner',
    ...overrides,
  })
}

const homeScreen = () => screen.queryByRole('button', { name: 'Se déconnecter' })

beforeEach(() => {
  select.mockReset()
  rpc.mockReset()
  invoke.mockReset()
  select.mockReturnValue({ data: [], error: null })
  rpc.mockResolvedValue({ error: null })
})

/* ========================================================================== */
/* Le garde de capacité                                                        */
/* ========================================================================== */

describe('le garde de capacité', () => {
  it.each([['/users'], ['/users/new']])('renvoie un `worker` à l’accueil depuis %s', async (path) => {
    renderAt(path, 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: 'Employés' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Nouvel employé' })).not.toBeInTheDocument()
    // Le garde n'est pas une politesse : il ne demande rien au serveur non plus.
    expect(select).not.toHaveBeenCalled()
  })

  it('laisse passer le patron', async () => {
    renderAt('/users', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Employés' })).toBeInTheDocument(),
    )
  })

  it("n'offre le lien qu'à qui a la capacité", async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Employés' })).not.toBeInTheDocument()
  })

  it('offre le lien au patron', async () => {
    renderAt('/', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Employés' })).toBeInTheDocument(),
    )
  })
})

/* ========================================================================== */
/* La liste                                                                    */
/* ========================================================================== */

describe('la liste des employés', () => {
  it('ne filtre aucun tenant à la main — la RLS décide (SPEC § 2.1)', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/users', 'owner')

    await waitFor(() => expect(select).toHaveBeenCalled())
    const [table, columns] = select.mock.calls[0] as [string, string]
    expect(table).toBe('app_user')
    expect(columns).not.toMatch(/tenant_id/)
  })

  it('montre le nom, le rôle, le numéro et la dernière connexion', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/users', 'owner')

    expect(await screen.findByText('Yassine Alaoui')).toBeInTheDocument()
    expect(screen.getByText('Employé')).toBeInTheDocument()
    expect(screen.getByText('0612345678')).toBeInTheDocument()
    expect(screen.getByText(/Vu le 05\/09\/2026/)).toBeInTheDocument()
  })

  it('dit qu’un compte n’a jamais servi', async () => {
    select.mockReturnValue({ data: [row({ last_seen_at: null })], error: null })
    renderAt('/users', 'owner')

    expect(await screen.findByText('Jamais connecté')).toBeInTheDocument()
  })

  it('signale un compte désactivé sans le faire disparaître', async () => {
    select.mockReturnValue({ data: [row({ is_active: false })], error: null })
    renderAt('/users', 'owner')

    expect(await screen.findByText(/Désactivé/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réactiver' })).toBeInTheDocument()
  })

  /* BRAND-UI § 6 : « Un écran vide invite à agir. » */
  it('invite à agir quand le patron est seul', async () => {
    renderAt('/users', 'owner')

    expect(
      await screen.findByText('Aucun employé. Créez un compte pour celui qui tient le comptoir.'),
    ).toBeInTheDocument()
  })

  it('annonce l’échec de lecture et propose de réessayer', async () => {
    select.mockReturnValue({ data: null, error: { message: 'Réseau injoignable.' } })
    renderAt('/users', 'owner')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau injoignable.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* Désactiver, réactiver                                                       */
/* ========================================================================== */

describe('la désactivation', () => {
  it('passe par la RPC, jamais par un PATCH sur la table', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/users', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Désactiver' }))

    /*
     * L'appel est cherché par son nom, pas pris au premier rang : depuis E1-03,
     * toute route authentifiée émet `register_device()` au montage
     * (`RequireAuth`), et il arrive avant celui-ci.
     */
    await waitFor(() =>
      expect(rpc.mock.calls.some(([name]) => name === 'set_user_active')).toBe(true),
    )
    const call = rpc.mock.calls.find(([name]) => name === 'set_user_active') as [
      string,
      Record<string, unknown>,
    ]
    expect(call[1]).toEqual({ target_user: 'user-2', active: false })
  })

  /* BRAND-UI § 6 : « Le même mot du début à la fin d'un parcours. » */
  it('dit ce qui vient de se passer, dans les mots du bouton', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    renderAt('/users', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Désactiver' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Yassine Alaoui est désactivé. Il ne peut plus se connecter.',
    )
  })

  it('affiche le refus du serveur tel qu’il est écrit', async () => {
    select.mockReturnValue({ data: [row()], error: null })
    rpc.mockResolvedValue({ error: { message: 'Seul le patron modifie un employé.' } })
    renderAt('/users', 'owner')

    await userEvent.click(await screen.findByRole('button', { name: 'Désactiver' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Seul le patron modifie un employé.',
    )
  })

  /*
   * E1-02 : « Le patron ne peut pas se retirer son propre rôle `owner`. » Sa
   * propre ligne ne porte aucune action — ni bouton grisé, qui inviterait à
   * chercher comment l'activer. La base refuse de toute façon (trigger
   * `app_user_protect_own_role`) ; ceci évite de proposer ce qui sera refusé.
   */
  it('n’offre aucune action sur la ligne du patron lui-même', async () => {
    select.mockReturnValue({ data: [ownRow(), row()], error: null })
    renderAt('/users', 'owner')

    expect(await screen.findByText('Rachid Benali')).toBeInTheDocument()
    expect(screen.getByText('Vous')).toBeInTheDocument()
    // Une seule action dans la liste : celle de l'employé.
    expect(screen.getAllByRole('button', { name: 'Désactiver' })).toHaveLength(1)
  })
})

/* ========================================================================== */
/* Le formulaire                                                               */
/* ========================================================================== */

describe('le formulaire de création', () => {
  /*
   * La session est relue du stockage local avant que le garde ne laisse passer :
   * au premier rendu, l'écran affiché est celui de chargement (E0-04).
   */
  async function openForm() {
    renderAt('/users/new', 'owner')
    await screen.findByRole('heading', { name: 'Nouvel employé' })
  }

  async function fill(phone: string) {
    await openForm()

    await userEvent.type(screen.getByLabelText('Nom de l’employé'), 'Yassine Alaoui')
    await userEvent.type(screen.getByLabelText('Téléphone de l’employé'), phone)
    await userEvent.type(screen.getByLabelText('Mot de passe de l’employé'), 'motdepasse')
    await userEvent.click(screen.getByRole('button', { name: 'Créer l’employé' }))
  }

  it('porte les trois champs de la story, et aucun choix de rôle', async () => {
    await openForm()

    expect(screen.getByLabelText('Nom de l’employé')).toBeInTheDocument()
    expect(screen.getByLabelText('Téléphone de l’employé')).toBeInTheDocument()
    expect(screen.getByLabelText('Mot de passe de l’employé')).toBeInTheDocument()

    // Aucun champ email : l'identifiant est dérivé du numéro (E1-01).
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
    /*
     * Aucun sélecteur de rôle, et ce n'est pas cosmétique : `create_worker()`
     * n'accepte pas de rôle en paramètre. Un sélecteur ici supposerait une
     * valeur transmise au serveur, donc une surface d'escalade à garder fermée
     * à chaque évolution.
     */
    expect(screen.queryByLabelText(/rôle/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('transmet la saisie à la fonction Edge, sans rôle', async () => {
    invoke.mockResolvedValue({ data: { userId: 'user-2', phone: '0612345678' }, error: null })
    await fill('06 12 34 56 78')

    await waitFor(() => expect(invoke).toHaveBeenCalled())
    const [name, options] = invoke.mock.calls[0] as [string, { body: Record<string, string> }]
    expect(name).toBe('create-user')
    expect(options.body).toEqual({
      fullName: 'Yassine Alaoui',
      phone: '06 12 34 56 78',
      password: 'motdepasse',
    })
  })

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
