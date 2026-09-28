/*
 * Codes-barres et étiquettes — E2-06, côté interface.
 *
 * Ce qui part vers la base, requête par requête, et ce que l'écran dit. Ce que
 * la base refuse pour de bon — l'unicité du code-barres, le SKU figé, l'employé
 * qui écrit — est éprouvé sur la base réelle par
 * `supabase/tests/barcodes.test.ts`. Les deux niveaux ont chacun leur test, et
 * aucun ne peut passer à la place de l'autre (CLAUDE.md).
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { DEVICE_PREFIX_KEY } from '@/lib/device'
import { PRODUCT_MESSAGES } from '@/modules/catalogue/products'
import { VARIANT_MESSAGES } from '@/modules/catalogue/variants'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

interface Call {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  payload?: Record<string, unknown>
  filters: Array<[string, string, unknown]>
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const respond = vi.fn<(call: Call) => Response>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [] }
      const write = (op: Call['op']) => (payload?: Record<string, unknown>) => {
        call.op = op
        if (payload !== undefined) call.payload = payload
        return builder
      }
      const builder = {
        select: () => builder,
        insert: write('insert'),
        update: write('update'),
        delete: write('delete'),
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        is: (column: string, value: unknown) => {
          call.filters.push(['is', column, value])
          return builder
        },
        in: (column: string, value: unknown) => {
          call.filters.push(['in', column, value])
          return builder
        },
        like: (column: string, value: unknown) => {
          call.filters.push(['like', column, value])
          return builder
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => builder,
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

const PRODUCT = {
  id: 'p1',
  name_fr: 'Crème de nuit',
  code: 'CRM-1',
  name_ar: null,
  category_id: null,
  brand: null,
  photo_url: null,
  unit_label: null,
  pieces_per_carton: null,
}

let variants: Array<{
  id: string
  sku: string | null
  barcode: string | null
  sku_printed_at: string | null
  is_default: boolean
}> = []

function defaultRespond(call: Call): Response {
  if (call.op === 'select') {
    if (call.table === 'product') return { data: PRODUCT, error: null }
    if (call.table === 'variant') return { data: variants, error: null }
    return { data: [], error: null }
  }
  if (call.op === 'update') {
    const id = call.filters.find(([, column]) => column === 'id')?.[2]
    return { data: [{ id }], error: null }
  }
  return { data: null, error: null }
}

function renderAt(path: string, role = 'owner') {
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

const writes = () => calls.filter((call) => call.op !== 'select')
const variantWrites = () => writes().filter((call) => call.table === 'variant')

beforeEach(() => {
  calls.length = 0
  window.localStorage.clear()
  window.localStorage.setItem(DEVICE_PREFIX_KEY, 'A')
  variants = [
    { id: 'p1', sku: 'CRM-1', barcode: null, sku_printed_at: null, is_default: true },
  ]
  respond.mockReset()
  respond.mockImplementation(defaultRespond)
  vi.stubGlobal('print', vi.fn())
})

/* ========================================================================== */

describe('le code-barres sur la fiche produit', () => {
  it('affiche celui de la variante par défaut', async () => {
    variants = [
      { id: 'p1', sku: 'CRM-1', barcode: '6111234567890', sku_printed_at: null, is_default: true },
    ]
    renderAt('/products/p1')

    expect(await screen.findByLabelText('Code-barres')).toHaveValue('6111234567890')
  })

  it('l’envoie sur `variant`, pas sur `product`', async () => {
    renderAt('/products/p1')
    await userEvent.type(await screen.findByLabelText('Code-barres'), '6111234567890')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }))

    await waitFor(() => expect(variantWrites()).toHaveLength(1))
    expect(variantWrites()[0]?.payload).toStrictEqual({ barcode: '6111234567890' })
    expect(writes().some((call) => call.table === 'product')).toBe(false)
  })

  it('inchangé, rien ne part', async () => {
    variants = [
      { id: 'p1', sku: 'CRM-1', barcode: '6111234567890', sku_printed_at: null, is_default: true },
    ]
    renderAt('/products/p1')
    await screen.findByDisplayValue('6111234567890')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }))

    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(variantWrites()).toHaveLength(0)
  })

  it('vidé, il part à null — « pas de code-barres » est une absence', async () => {
    variants = [
      { id: 'p1', sku: 'CRM-1', barcode: '6111234567890', sku_printed_at: null, is_default: true },
    ]
    renderAt('/products/p1')
    await userEvent.clear(await screen.findByDisplayValue('6111234567890'))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }))

    await waitFor(() => expect(variantWrites()).toHaveLength(1))
    expect(variantWrites()[0]?.payload).toStrictEqual({ barcode: null })
  })

  /*
   * BACKLOG E2-06, critère 5. Le message se branche sur le **nom de la
   * contrainte** : `variant_sku_per_tenant` répondrait le même `23505`.
   */
  it('dit clairement qu’un autre produit porte déjà ce code-barres', async () => {
    respond.mockImplementation((call) =>
      call.op === 'update' && call.table === 'variant'
        ? {
            data: null,
            error: {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "variant_barcode_per_tenant"',
            },
          }
        : defaultRespond(call),
    )
    renderAt('/products/p1')
    await userEvent.type(await screen.findByLabelText('Code-barres'), '6111234567890')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(VARIANT_MESSAGES.duplicateBarcode)
  })

  /*
   * L'arbitrage d'E2-06, vu du patron : la référence est libre sur `product` et
   * pourtant prise, parce qu'une étiquette imprimée la tient. « Déjà utilisée
   * par un autre produit » l'enverrait la chercher là où elle n'est pas.
   */
  it('distingue une référence prise d’un code déjà imprimé', async () => {
    respond.mockImplementation((call) =>
      call.op === 'update' && call.table === 'product'
        ? {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "variant_sku_per_tenant"',
            },
          }
        : defaultRespond(call),
    )
    renderAt('/products/p1')
    await userEvent.type(await screen.findByLabelText('Référence'), '-bis')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le produit' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(PRODUCT_MESSAGES.printedCode)
  })

  /*
   * SPEC § 2.6 : sans caméra, pas de bouton. jsdom n'a ni `BarcodeDetector` ni
   * `mediaDevices` — c'est exactement l'appareil qui ne sait pas scanner.
   */
  it('n’affiche aucun bouton « Scanner » quand la caméra n’est pas une voie possible', async () => {
    renderAt('/products/p1')
    await screen.findByLabelText('Code-barres')

    expect(screen.queryByRole('button', { name: /scanner/i })).toBeNull()
  })
})

/* ========================================================================== */

describe('la planche d’étiquettes', () => {
  /*
   * L'en-tête paraît pendant le chargement : c'est la ligne de la variante qui
   * dit que l'écran a ses données. Attendre l'en-tête seul laisserait passer
   * une assertion sur un écran encore vide.
   */
  const openSheet = async () => {
    renderAt('/products/p1/labels')
    await screen.findByRole('heading', { name: 'Étiquettes' })
    await screen.findByLabelText('Nombre d’étiquettes')
  }

  const printButton = () => screen.getByRole('button', { name: 'Imprimer la planche' })

  it('l’employé ne l’ouvre pas — l’impression peut attribuer un code', async () => {
    renderAt('/products/p1/labels', 'worker')

    expect(await screen.findByRole('button', { name: 'Se déconnecter' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Étiquettes' })).toBeNull()
  })

  it('s’ouvre depuis la fiche produit', async () => {
    renderAt('/products/p1')

    expect(await screen.findByRole('link', { name: 'Étiquettes' })).toHaveAttribute(
      'href',
      '/products/p1/labels',
    )
  })

  it('annonce le nombre d’étiquettes et de feuilles', async () => {
    await openSheet()
    const quantity = screen.getByLabelText('Nombre d’étiquettes')
    await userEvent.clear(quantity)
    await userEvent.type(quantity, '25')

    expect(await screen.findByRole('status')).toHaveTextContent('25 étiquettes, 2 feuilles A4')
  })

  it('dit que le SKU sera figé par l’impression', async () => {
    await openSheet()

    expect(screen.getByText(/CRM-1 — ce code sera figé/)).toBeInTheDocument()
  })

  it('dit que le code-barres du fabricant est celui qui s’imprime', async () => {
    variants = [
      { id: 'p1', sku: 'CRM-1', barcode: '6111234567890', sku_printed_at: null, is_default: true },
    ]
    await openSheet()

    expect(screen.getByText(/6111234567890 — code-barres du fabricant/)).toBeInTheDocument()
  })

  it('imprime, et fige le SKU qu’elle imprime', async () => {
    await openSheet()
    await userEvent.click(printButton())

    await waitFor(() => expect(window.print).toHaveBeenCalled())
    const freeze = variantWrites().find((call) => 'sku_printed_at' in (call.payload ?? {}))
    expect(freeze?.filters).toContainEqual(['in', 'id', ['p1']])
    // La seconde impression ne repousse pas la date : c'est celle de la première.
    expect(freeze?.filters).toContainEqual(['is', 'sku_printed_at', null])
  })

  it('ne fige rien quand c’est l’EAN du fabricant qui s’imprime', async () => {
    variants = [
      { id: 'p1', sku: 'CRM-1', barcode: '6111234567890', sku_printed_at: null, is_default: true },
    ]
    await openSheet()
    await userEvent.click(printButton())

    await waitFor(() => expect(window.print).toHaveBeenCalled())
    expect(variantWrites().some((call) => 'sku_printed_at' in (call.payload ?? {}))).toBe(false)
  })

  it('attribue un SKU au produit qui n’a aucun code, puis le fige', async () => {
    variants = [{ id: 'p1', sku: null, barcode: null, sku_printed_at: null, is_default: true }]
    await openSheet()
    expect(screen.getByText(/Un code sera attribué à l’impression/)).toBeInTheDocument()

    await userEvent.click(printButton())

    await waitFor(() => expect(window.print).toHaveBeenCalled())
    expect(variantWrites()[0]?.payload).toStrictEqual({ sku: 'A-00001' })
    expect(variantWrites()[1]?.payload).toHaveProperty('sku_printed_at')
  })

  /*
   * SPEC § 2.6 : l'appareil sans lettre ne peut pas engendrer de SKU. La ligne
   * le dit une fois, en gris, et rien ne réclame d'enregistrer l'appareil.
   */
  it('sans lettre d’appareil, ne promet aucun code et n’en invente pas', async () => {
    window.localStorage.removeItem(DEVICE_PREFIX_KEY)
    variants = [{ id: 'p1', sku: null, barcode: null, sku_printed_at: null, is_default: true }]
    await openSheet()

    expect(screen.getByText(/Cet appareil n’a pas encore sa lettre/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Aucune étiquette à imprimer')
    expect(printButton()).toBeDisabled()
  })

  it('n’imprime rien à zéro étiquette', async () => {
    await openSheet()
    await userEvent.clear(screen.getByLabelText('Nombre d’étiquettes'))

    expect(printButton()).toBeDisabled()
  })

  it('dit pourquoi quand la base refuse, sans imprimer', async () => {
    variants = [{ id: 'p1', sku: null, barcode: null, sku_printed_at: null, is_default: true }]
    respond.mockImplementation((call) =>
      call.op === 'update'
        ? { data: null, error: { code: '42501', message: 'row-level security' } }
        : defaultRespond(call),
    )
    await openSheet()
    await userEvent.click(printButton())

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(window.print).not.toHaveBeenCalled()
  })
})
