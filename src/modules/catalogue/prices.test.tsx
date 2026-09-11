/*
 * La grille de prix — E2-03, côté interface.
 *
 * Ce qui part vers la base, requête par requête, et ce que l'écran dit. Que la
 * base garde la ligne à l'unité, refuse l'employé ou cache le coût ne dépend
 * d'aucun de ces composants : `supabase/tests/price-grid.test.ts` l'éprouve sur
 * la base réelle.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { PRICE_GRID_MESSAGES } from '@/modules/catalogue/priceGrid'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

interface Call {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert'
  payload?: unknown
  filters: Array<[string, string, unknown]>
  single: boolean
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const respond = vi.fn<(call: Call) => Response | Promise<Response>>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [], single: false }
      const write = (op: Call['op']) => (payload?: unknown) => {
        call.op = op
        if (payload !== undefined) call.payload = payload
        return builder
      }
      const builder = {
        select: () => builder,
        insert: write('insert'),
        update: write('update'),
        upsert: write('upsert'),
        delete: write('delete'),
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        is: (column: string, value: unknown) => {
          call.filters.push(['is', column, value])
          return builder
        },
        order: () => builder,
        maybeSingle: () => {
          call.single = true
          return builder
        },
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
    storage: { from: () => ({ createSignedUrls: vi.fn(async () => ({ data: [], error: null })) }) },
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}))

function renderAt(path: string, role: string) {
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

const PRODUCT = {
  id: 'p1',
  name_fr: 'Eau de toilette',
  code: 'EDT-50',
  name_ar: null,
  category_id: null,
  brand: null,
  photo_url: null,
  unit_label: null,
  pieces_per_carton: null,
}

/* La grille telle que PostgREST la rend, montants en texte. */
let breaks: Array<{ id: string; min_qty: string; unit_price: string | null }> = []
let cost: { cost_price: string } | null = null

function defaultRespond(call: Call): Response {
  if (call.op === 'select') {
    if (call.table === 'product') return { data: PRODUCT, error: null }
    if (call.table === 'variant') return { data: { id: 'p1', floor_price: '9.00' }, error: null }
    if (call.table === 'price_break') return { data: breaks, error: null }
    if (call.table === 'variant_cost') return { data: cost, error: null }
    return { data: [], error: null }
  }
  if (call.op === 'update') {
    const id = call.filters.find(([, column]) => column === 'id')?.[2]
    return { data: [{ id }], error: null }
  }
  return { data: null, error: null }
}

const writes = () => calls.filter((call) => call.op !== 'select')
const saveButton = () => screen.getByRole('button', { name: 'Enregistrer la grille' })
const basePrice = () => screen.getByLabelText('Prix unitaire (DH), dès 1')
const tier = (n: number) => screen.getByRole('group', { name: `Palier ${n}` })

async function openGrid(role = 'owner') {
  renderAt('/products/p1/prices', role)
  await screen.findByRole('heading', { name: 'Grille de prix' })
  await screen.findByText('Eau de toilette')
}

beforeEach(() => {
  calls.length = 0
  breaks = [
    { id: 'b10', min_qty: '10.000', unit_price: '11.00' },
    { id: 'p1', min_qty: '1.000', unit_price: '12.50' },
  ]
  cost = { cost_price: '7.25' }
  respond.mockReset()
  respond.mockImplementation(defaultRespond)
})

/* ========================================================================== */

describe('le garde de route', () => {
  it('l’employé ne l’ouvre pas — renvoyé à l’accueil', async () => {
    renderAt('/products/p1/prices', 'worker')

    expect(await screen.findByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Grille de prix' })).toBeNull()
  })

  it('le patron l’ouvre depuis la fiche', async () => {
    renderAt('/products/p1', 'owner')

    expect(await screen.findByRole('link', { name: 'Grille de prix' })).toHaveAttribute(
      'href',
      '/products/p1/prices',
    )
  })
})

describe('la grille arrive', () => {
  it('la ligne à l’unité d’abord, puis les paliers ; plancher et prix d’achat pour le patron', async () => {
    await openGrid()

    expect(basePrice()).toHaveValue('12,50')
    expect(within(tier(2)).getByLabelText('À partir de (quantité)')).toHaveValue('10')
    expect(within(tier(2)).getByLabelText('Prix unitaire (DH)')).toHaveValue('11,00')
    expect(screen.getByLabelText('Prix plancher (DH)')).toHaveValue('9,00')
    expect(screen.getByLabelText('Prix d’achat (DH)')).toHaveValue('7,25')
  })

  it('la ligne à l’unité n’a ni quantité à saisir, ni bouton pour la retirer', async () => {
    await openGrid()

    const base = screen.getByRole('group', { name: 'Prix à l’unité' })
    expect(within(base).queryByLabelText('À partir de (quantité)')).toBeNull()
    expect(within(base).queryByRole('button')).toBeNull()
  })

  it('le prix d’achat est lu, filtré sur sa variante', async () => {
    await openGrid()

    const read = calls.find((call) => call.table === 'variant_cost')
    expect(read?.filters).toContainEqual(['eq', 'variant_id', 'p1'])
  })
})

describe('prix non renseigné — SPEC § 2.6', () => {
  it('une ligne à l’unité sans prix donne un champ vide, et rien ne le reproche', async () => {
    breaks = [{ id: 'p1', min_qty: '1.000', unit_price: null }]
    cost = null
    await openGrid()

    expect(basePrice()).toHaveValue('')
    expect(screen.getByLabelText('Prix d’achat (DH)')).toHaveValue('')
    const main = screen.getByRole('main')
    expect(within(main).queryAllByRole('alert')).toEqual([])
    expect(main.querySelector('[aria-invalid="true"], [required]')).toBeNull()
    expect(within(main).queryByText(/obligatoire|requis|manquant|renseignez/i)).toBeNull()
  })

  it('effacer le prix à l’unité l’envoie à null — jamais à 0', async () => {
    await openGrid()
    await userEvent.clear(basePrice())
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    expect(writes()).toEqual([
      expect.objectContaining({
        table: 'price_break',
        op: 'update',
        payload: { unit_price: null },
        filters: [['eq', 'id', 'p1']],
      }),
    ])
  })
})

describe('enregistrer', () => {
  it('sans changement, le bouton reste inactif — sans un mot', async () => {
    await openGrid()
    expect(saveButton()).toBeDisabled()
  })

  it('les champs ne laissent entrer qu’un décimal, en virgule', async () => {
    await openGrid()
    await userEvent.clear(basePrice())
    await userEvent.type(basePrice(), '1a2.505')

    expect(basePrice()).toHaveValue('12,50')
  })

  it('un prix changé : une seule écriture, en texte décimal', async () => {
    await openGrid()
    await userEvent.clear(basePrice())
    await userEvent.type(basePrice(), '13')
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    expect(writes()).toEqual([
      expect.objectContaining({ table: 'price_break', op: 'update', payload: { unit_price: '13.00' } }),
    ])
  })

  it('un palier ajouté part complet, sous la variante, sans tenant_id', async () => {
    await openGrid()
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un palier' }))
    const added = tier(3)
    await userEvent.type(within(added).getByLabelText('À partir de (quantité)'), '100')

    // À moitié rempli : le bouton attend, sans un mot.
    expect(saveButton()).toBeDisabled()
    expect(within(screen.getByRole('main')).queryAllByRole('alert')).toEqual([])

    await userEvent.type(within(added).getByLabelText('Prix unitaire (DH)'), '10')
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    const [insert] = writes()
    expect(insert).toMatchObject({ table: 'price_break', op: 'insert' })
    expect(insert!.payload).toEqual([
      { id: expect.any(String), variant_id: 'p1', min_qty: '100.000', unit_price: '10.00' },
    ])
  })

  it('deux paliers à la même quantité retiennent le bouton', async () => {
    await openGrid()
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un palier' }))
    await userEvent.type(within(tier(3)).getByLabelText('À partir de (quantité)'), '10')
    await userEvent.type(within(tier(3)).getByLabelText('Prix unitaire (DH)'), '9')

    expect(saveButton()).toBeDisabled()
  })

  it('un palier retiré part en suppression douce', async () => {
    await openGrid()
    await userEvent.click(screen.getByRole('button', { name: 'Retirer le palier 2' }))
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    const [retire] = writes()
    expect(retire).toMatchObject({ table: 'price_break', op: 'update', filters: [['eq', 'id', 'b10']] })
    expect(retire!.payload).toEqual({ deleted_at: expect.any(String) })
  })

  it('le prix d’achat effacé supprime sa ligne — pas de coût connu, pas de ligne', async () => {
    await openGrid()
    await userEvent.clear(screen.getByLabelText('Prix d’achat (DH)'))
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    expect(writes()).toEqual([
      expect.objectContaining({
        table: 'variant_cost',
        op: 'delete',
        filters: [['eq', 'variant_id', 'p1']],
      }),
    ])
  })

  it('le prix d’achat saisi part sur variant_cost, jamais sur variant', async () => {
    cost = null
    await openGrid()
    await userEvent.type(screen.getByLabelText('Prix d’achat (DH)'), '7,5')
    await userEvent.click(saveButton())

    await screen.findByText('Grille enregistrée.')
    expect(writes()).toEqual([
      expect.objectContaining({
        table: 'variant_cost',
        op: 'upsert',
        payload: { variant_id: 'p1', cost_price: '7.50' },
      }),
    ])
  })
})

describe('les refus de la base, chacun sous ses mots', () => {
  it('policy de price_break — 42501', async () => {
    respond.mockImplementation((call) =>
      call.op === 'insert'
        ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }
        : defaultRespond(call),
    )
    await openGrid()
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un palier' }))
    await userEvent.type(within(tier(3)).getByLabelText('À partir de (quantité)'), '100')
    await userEvent.type(within(tier(3)).getByLabelText('Prix unitaire (DH)'), '10')
    await userEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(PRICE_GRID_MESSAGES.refused)
  })

  it('modification qui ne touche aucune ligne — ni succès, ni le message de la policy', async () => {
    respond.mockImplementation((call) =>
      call.op === 'update' ? { data: [], error: null } : defaultRespond(call),
    )
    await openGrid()
    await userEvent.clear(basePrice())
    await userEvent.type(basePrice(), '13')
    await userEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(PRICE_GRID_MESSAGES.notSaved)
    await waitFor(() => expect(screen.queryByText('Grille enregistrée.')).toBeNull())
  })
})
