/*
 * Les réglages — E1-05, côté interface.
 *
 * Ce qui se vérifie ici : le garde de route, l'écran et ses états, et le fait
 * que l'interface n'invente ni défaut ni tenant. Ce qui ne s'y vérifie pas —
 * que tout commerce naisse réglé, qu'un employé lise sans écrire — ne dépend
 * d'aucun de ces composants : c'est `create_tenant()`, `merx.setting_default` et
 * les policies d'écriture, éprouvés sur la base réelle par
 * `supabase/tests/settings.test.ts`.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * Le doublon porte sur le client partagé : ce qui a de la valeur est de voir
 * la requête se former — et qu'aucun `tenant_id` n'y soit écrit (SPEC § 2.1).
 */
const select = vi.fn()
const update = vi.fn()
const rpc = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => select(table, columns),
      update: (value: unknown) => ({
        eq: (column: string, key: string) => ({
          select: () => update(table, value, column, key),
        }),
      }),
    }),
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

/** Ce que PostgREST rend pour un commerce qui vient d'être créé. */
const SEEDED = [
  {
    key: 'print_header',
    value: { business_name: 'Parfumerie Nour', phone: '+212612345678', address: 'Casablanca' },
  },
  { key: 'default_language', value: 'fr' },
  { key: 'printer_address', value: '' },
]

const homeScreen = () => screen.queryByRole('button', { name: 'Se déconnecter' })
const heading = () => screen.queryByRole('heading', { name: 'Paramètres' })

beforeEach(() => {
  select.mockReset()
  update.mockReset()
  rpc.mockReset()
  select.mockReturnValue({ data: SEEDED, error: null })
  update.mockReturnValue({ data: [{ id: 'setting-1' }], error: null })
  rpc.mockResolvedValue({ data: [], error: null })
})

/* ========================================================================== */
/* Le garde de capacité                                                        */
/* ========================================================================== */

describe('le garde de capacité', () => {
  it('renvoie un `worker` à l’accueil, sans rien demander', async () => {
    renderAt('/settings', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(heading()).not.toBeInTheDocument()
    expect(select).not.toHaveBeenCalled()
  })

  it('laisse passer le patron', async () => {
    renderAt('/settings', 'owner')

    await waitFor(() => expect(heading()).toBeInTheDocument())
  })

  it("n'offre le lien qu'à qui a la capacité", async () => {
    renderAt('/', 'worker')

    await waitFor(() => expect(homeScreen()).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Paramètres' })).not.toBeInTheDocument()
  })

  it('offre le lien au patron', async () => {
    renderAt('/', 'owner')

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Paramètres' })).toBeInTheDocument(),
    )
  })
})

/* ========================================================================== */
/* L'écran                                                                     */
/* ========================================================================== */

describe('l’écran des réglages', () => {
  it('ne filtre aucun tenant à la main — la RLS décide (SPEC § 2.1)', async () => {
    renderAt('/settings', 'owner')

    await waitFor(() => expect(select).toHaveBeenCalled())
    const [table, columns] = select.mock.calls[0] as [string, string]
    expect(table).toBe('tenant_setting')
    expect(columns).not.toMatch(/tenant_id/)
  })

  /*
   * Le critère de la story, vu de l'écran : il s'ouvre sur des valeurs déjà
   * posées. Il sert à corriger, pas à renseigner.
   */
  it('arrive rempli avec ce que le commerce a déjà', async () => {
    renderAt('/settings', 'owner')

    expect(await screen.findByLabelText('Nom du commerce')).toHaveValue('Parfumerie Nour')
    expect(screen.getByLabelText('Téléphone')).toHaveValue('+212612345678')
    expect(screen.getByLabelText('Adresse')).toHaveValue('Casablanca')
    expect(screen.getByRole('radio', { name: 'Français' })).toBeChecked()
    expect(screen.getByLabelText('Imprimante réseau')).toHaveValue('')
  })

  /* SPEC § 2.6, E11-03 : aucun champ ne réclame sa donnée. */
  it('ne marque aucun champ comme obligatoire', async () => {
    renderAt('/settings', 'owner')

    await screen.findByLabelText('Nom du commerce')
    for (const input of screen.getAllByRole('textbox')) {
      expect(input).not.toBeRequired()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
    }
  })

  /*
   * Une valeur illisible s'affiche vide ; elle n'est pas remplacée par une
   * valeur que le code aurait choisie. Le seul défaut est celui de la base.
   */
  it('n’invente aucun défaut quand une valeur est illisible', async () => {
    select.mockReturnValue({
      data: [
        { key: 'print_header', value: {} },
        { key: 'default_language', value: 'klingon' },
      ],
      error: null,
    })
    renderAt('/settings', 'owner')

    expect(await screen.findByLabelText('Nom du commerce')).toHaveValue('')
    expect(screen.getByRole('radio', { name: 'Français' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'العربية' })).not.toBeChecked()
    expect(screen.getByLabelText('Imprimante réseau')).toHaveValue('')
  })

  it('annonce l’échec de lecture et propose de réessayer', async () => {
    select.mockReturnValue({ data: null, error: { message: 'Réseau injoignable.' } })
    renderAt('/settings', 'owner')

    expect(await screen.findByRole('alert')).toHaveTextContent('Réseau injoignable.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* L'enregistrement                                                            */
/* ========================================================================== */

describe('l’enregistrement', () => {
  it('n’écrit que ce qui a changé, clé par clé, sans tenant', async () => {
    const user = userEvent.setup()
    renderAt('/settings', 'owner')

    const printer = await screen.findByLabelText('Imprimante réseau')
    await user.type(printer, '192.168.1.50:9100')
    await user.click(screen.getByRole('button', { name: 'Enregistrer les réglages' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Réglages enregistrés.')
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(
      'tenant_setting',
      { value: '192.168.1.50:9100' },
      'key',
      'printer_address',
    )
  })

  it('écrit l’en-tête en un seul objet', async () => {
    const user = userEvent.setup()
    renderAt('/settings', 'owner')

    const address = await screen.findByLabelText('Adresse')
    await user.clear(address)
    await user.type(address, 'Derb Omar, Casablanca')
    await user.click(screen.getByRole('button', { name: 'Enregistrer les réglages' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(
      'tenant_setting',
      {
        value: {
          business_name: 'Parfumerie Nour',
          phone: '+212612345678',
          address: 'Derb Omar, Casablanca',
        },
      },
      'key',
      'print_header',
    )
  })

  it('change la langue du commerce', async () => {
    const user = userEvent.setup()
    renderAt('/settings', 'owner')

    await user.click(await screen.findByRole('radio', { name: 'العربية' }))
    await user.click(screen.getByRole('button', { name: 'Enregistrer les réglages' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith('tenant_setting', { value: 'ar' }, 'key', 'default_language')
  })

  /*
   * Un UPDATE refusé par la RLS ne lève pas : il ne touche aucune ligne. Dire
   * « Enregistré » à ce moment-là serait mentir — c'est la situation d'un
   * compte à qui l'on a retiré le droit pendant qu'il avait l'écran ouvert.
   */
  it('ne dit pas « enregistré » quand aucune ligne n’a été touchée', async () => {
    update.mockReturnValue({ data: [], error: null })
    const user = userEvent.setup()
    renderAt('/settings', 'owner')

    await user.type(await screen.findByLabelText('Imprimante réseau'), '10.0.0.9:9100')
    await user.click(screen.getByRole('button', { name: 'Enregistrer les réglages' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/non enregistré/)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
