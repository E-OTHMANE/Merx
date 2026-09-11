/*
 * La recherche produit — E2-04, côté écran.
 *
 * Ce que l'écran doit tenir, et que la base ne voit pas : une seule requête
 * après la frappe, pas une par touche ; jamais les résultats d'une saisie
 * dépassée ; la liste et la grille photo, au choix, gardé sur l'appareil ; les
 * quatre états, dont celui d'une recherche sans résultat.
 *
 * Ce qui ne se vérifie pas ici — les accents, les fautes, la référence
 * partielle, le classement, l'isolation, l'absence de coût, la vitesse —
 * appartient à `public.search_products()` et s'éprouve sur la base réelle :
 * `supabase/tests/product-search.test.ts`.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { VIEW_STORAGE_KEY } from '@/modules/catalogue/ProductListScreen'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

interface Row {
  variant_id: string
  product_id: string
  name_fr: string
  name_ar: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  photo_url: string | null
}

interface Response {
  data: unknown
  error: { message: string } | null
}

const DEVICE = { id: 'd1', label: 'Appareil A', prefix: 'A', last_sync_at: null }

/* Chaque recherche envoyée, dans l'ordre, et ce qu'elle rend. */
const queries: string[] = []
const answer = vi.fn<(q: string) => Response | Promise<Response>>()
const createSignedUrls = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args: { q: string }) => ({
      then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
        // Toute route authentifiée enregistre l'appareil au montage (E1-03).
        if (fn === 'register_device') {
          return Promise.resolve({ data: [DEVICE], error: null }).then(resolve, reject)
        }
        if (fn !== 'search_products') return Promise.reject(new Error(`rpc inattendue : ${fn}`))
        queries.push(args.q)
        return Promise.resolve(answer(args.q)).then(resolve, reject)
      },
    }),
    from: () => {
      throw new Error('la liste ne lit aucune table : elle passe par search_products()')
    },
    storage: {
      from: () => ({ createSignedUrls: (...args: unknown[]) => createSignedUrls(...args) }),
    },
    functions: { invoke: vi.fn() },
  },
}))

const row = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  variant_id: id,
  product_id: id,
  name_fr: name,
  name_ar: null,
  code: null,
  sku: null,
  barcode: null,
  photo_url: null,
  ...extra,
})

const CATALOGUE = [
  row('p1', 'Crème hydratante', { code: '4512', photo_url: 'p1/a.jpg' }),
  row('p2', 'Savon noir', { code: 'SAV-1' }),
]

function renderList(role = 'worker') {
  render(
    <AuthProvider
      client={createFakeAuthClient({
        initialSession: fakeSession({ role, email: 'vendeur@merx.ma', userId: 'auth-vendeur' }),
      })}
    >
      <MemoryRouter initialEntries={['/products']}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

const searchField = () => screen.getByLabelText('Rechercher un produit')

beforeEach(() => {
  queries.length = 0
  answer.mockReset()
  answer.mockImplementation(() => ({ data: CATALOGUE, error: null }))
  createSignedUrls.mockReset()
  createSignedUrls.mockResolvedValue({
    data: [{ path: 'p1/a.jpg', signedUrl: 'https://photos/p1', error: null }],
    error: null,
  })
  window.localStorage.clear()
})

describe('la saisie', () => {
  it('le champ a son libellé au-dessus, et suit l’écriture tapée', async () => {
    renderList()
    await screen.findByText('Crème hydratante')

    expect(searchField()).toHaveAttribute('type', 'search')
    expect(searchField()).toHaveAttribute('dir', 'auto')
  })

  it('une seule recherche après la frappe, pas une par touche', async () => {
    renderList()
    await screen.findByText('Crème hydratante')

    await userEvent.type(searchField(), 'creme')

    await waitFor(() => expect(queries).toEqual(['', 'creme']))
  })

  it('ne montre jamais les résultats d’une saisie dépassée', async () => {
    let release: (value: Response) => void = () => undefined
    answer.mockImplementation((q) => {
      if (q === 'sa') return new Promise<Response>((resolve) => (release = resolve))
      if (q === 'savon') return { data: [CATALOGUE[1]], error: null }
      return { data: CATALOGUE, error: null }
    })
    renderList()
    await screen.findByText('Crème hydratante')

    await userEvent.type(searchField(), 'sa')
    await waitFor(() => expect(queries).toContain('sa'))
    await userEvent.type(searchField(), 'von')
    await waitFor(() => expect(screen.queryByText('Crème hydratante')).toBeNull())
    expect(screen.getByText('Savon noir')).toBeInTheDocument()

    // La réponse à « sa » arrive enfin, en retard : elle ne remplace rien.
    release({ data: [row('p9', 'Sachet tardif')], error: null })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('Sachet tardif')).toBeNull()
    expect(screen.getByText('Savon noir')).toBeInTheDocument()
  })
})

describe('les quatre états', () => {
  it('une recherche sans résultat le dit, avec ce qui a été cherché', async () => {
    answer.mockImplementation((q) => (q === 'zzqx' ? { data: [], error: null } : { data: CATALOGUE, error: null }))
    renderList()
    await screen.findByText('Crème hydratante')

    await userEvent.type(searchField(), 'zzqx')

    expect(await screen.findByText('Aucun produit ne correspond à « zzqx ».')).toBeInTheDocument()
  })

  it('un catalogue vide ne parle pas de recherche', async () => {
    answer.mockImplementation(() => ({ data: [], error: null }))
    renderList('worker')

    expect(await screen.findByText('Aucun produit pour l’instant.')).toBeInTheDocument()
  })

  it('50 résultats : l’écran dit qu’il y en a peut-être d’autres', async () => {
    const fifty = Array.from({ length: 50 }, (_, n) => row(`p${n}`, `Produit ${String(n).padStart(2, '0')}`))
    answer.mockImplementation(() => ({ data: fifty, error: null }))
    renderList()

    expect(
      await screen.findByText('Les 50 premiers produits, par ordre alphabétique. Tapez pour chercher.'),
    ).toBeInTheDocument()
  })

  it('moins de 50 : pas de note', async () => {
    renderList()
    await screen.findByText('Crème hydratante')
    expect(screen.queryByText(/Les 50 /)).toBeNull()
  })
})

describe('liste ou grille photo', () => {
  it('la liste par défaut ; la grille au choix, avec les photos', async () => {
    renderList()
    await screen.findByText('Crème hydratante')

    const list = screen.getByRole('button', { name: 'Liste' })
    const grid = screen.getByRole('button', { name: 'Grille photo' })
    expect(list).toHaveAttribute('aria-pressed', 'true')
    expect(grid).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(grid)

    expect(grid).toHaveAttribute('aria-pressed', 'true')
    // Dans l'écran : la barre d'onglets (E11-04) porte sa propre liste.
    expect(within(screen.getByRole('main')).getByRole('list')).toHaveClass('grid')
    const card = screen.getByText('Crème hydratante').closest('li')!
    expect(within(card).getByRole('presentation')).toHaveAttribute('src', 'https://photos/p1')
    expect(within(card).getByText('4512')).toBeInTheDocument()
  })

  it('le choix reste sur l’appareil', async () => {
    renderList()
    await screen.findByText('Crème hydratante')
    await userEvent.click(screen.getByRole('button', { name: 'Grille photo' }))
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe('grid')
  })

  it('rouvert, l’écran reprend la grille', async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, 'grid')
    renderList()
    await screen.findByText('Crème hydratante')

    expect(screen.getByRole('button', { name: 'Grille photo' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('BRAND-UI § 11', () => {
  it('aucun bouton sans texte', async () => {
    renderList('owner')
    await screen.findByText('Crème hydratante')

    const silent = screen
      .getAllByRole('button')
      .filter((button) => (button.textContent ?? '').trim() === '')
    expect(silent).toEqual([])
  })
})
