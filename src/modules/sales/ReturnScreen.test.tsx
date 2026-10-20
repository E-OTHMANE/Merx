/*
 * L'écran de retour — E4-06, côté interface. RÈGLES M3-9, M3-2 ; BRAND-UI § 13.
 *
 * Ce que l'écran doit tenir, et que la base ne voit pas :
 *
 *   — il **part du bon** : les lignes arrivent à la quantité encore
 *     retournable, et rien ne s'ajoute qui n'ait été livré. Il n'y a donc ni
 *     recherche, ni scan, ni grille photo — un retour n'est pas une vente ;
 *   — la quantité **se baisse** : un retour partiel est le cas normal. Une
 *     quantité au-delà du bon reste affichée, la ligne le dit, et
 *     « Enregistrer » se refuse — on ne réécrit pas sous les doigts de
 *     quelqu'un (même parti pris que le champ vidé d'E4-03) ;
 *   — le **motif est facultatif** : un retour sans motif s'enregistre, et un
 *     motif saisi part dans `notes` ;
 *   — l'écriture : un brouillon qui porte son bon d'origine, ses lignes **en un
 *     appel**, puis la confirmation qui pose `RT-A-26-00001` ;
 *   — c'est un écran de **détail** : un retour vers Vente, aucune barre
 *     d'onglets (BRAND-UI § 13, et `navigation.test.tsx` le range).
 *
 * Ce qui n'est pas mesuré ici : le calcul du reste à rendre, pur et mesuré dans
 * `returns.test.ts` ; et le registre en base — ni la quantité, ni l'avoir, ni
 * le verrou —, qui est `supabase/tests/returns.test.ts`.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { DEVICE_PREFIX_KEY, DEVICE_STORAGE_KEY } from '@/lib/device'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

interface Call {
  table: string
  op: 'select' | 'insert' | 'update'
  payload?: unknown
  filters: Array<[string, string, unknown]>
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const respond = vi.fn<(call: Call) => Response | Promise<Response>>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string) => ({
      then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
        // Toute route authentifiée enregistre l'appareil au montage (E1-03).
        if (fn === 'register_device') {
          return Promise.resolve({
            data: [{ id: 'dev-1', label: 'Comptoir', prefix: 'A', last_sync_at: null }],
            error: null,
          }).then(resolve, reject)
        }
        return Promise.reject(new Error(`rpc inattendue : ${fn}`))
      },
    }),
    from: (table: string) => {
      const call: Call = { table, op: 'select', filters: [] }
      const write = (op: Call['op']) => (payload?: unknown) => {
        call.op = op
        call.payload = payload
        return builder
      }
      const builder = {
        select: () => builder,
        insert: write('insert'),
        update: write('update'),
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        in: (column: string, value: unknown) => {
          call.filters.push(['in', column, value])
          return builder
        },
        single: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
    storage: {
      from: () => ({ createSignedUrls: vi.fn(async () => ({ data: [], error: null })) }),
    },
    functions: { invoke: vi.fn() },
  },
}))

function originLine(
  variantId: string,
  quantity: string,
  unitPrice: string,
): Record<string, unknown> {
  return {
    variant_id: variantId,
    quantity,
    unit_price: unitPrice,
    line_total: (Number(quantity) * Number(unitPrice)).toFixed(2),
    variant: {
      sku: `SKU-${variantId}`,
      product: {
        id: `p-${variantId}`,
        name_fr: variantId === 'v1' ? 'Crème hydratante 200 ml' : 'Savon noir 500 g',
        code: variantId === 'v1' ? 'CRM-1' : 'SAV-1',
        photo_url: null,
      },
    },
  }
}

/** Le bon d'origine, remplacé au cas par cas. */
let origin: unknown

/** Les retours déjà enregistrés sur lui. */
let previous: unknown[]

const isPrevious = (call: Call): boolean =>
  call.filters.some(([, column]) => column === 'source_document_id')

function defaultResponse(call: Call): Response {
  if (call.table === 'sale_document' && call.op === 'select') {
    return isPrevious(call) ? { data: previous, error: null } : { data: origin, error: null }
  }
  if (call.table === 'document_sequence') return { data: { last_number: 0 }, error: null }
  if (call.table === 'sale_document' && call.op === 'insert') {
    return { data: { id: 'rt-1' }, error: null }
  }
  if (call.table === 'sale_document' && call.op === 'update') {
    const payload = call.payload as Record<string, unknown>
    return payload['status'] === 'confirmed'
      ? { data: [{ id: 'rt-1' }], error: null }
      : { data: null, error: null }
  }
  if (call.table === 'sale_line') return { data: null, error: null }
  throw new Error(`appel inattendu : ${call.op} ${call.table}`)
}

function renderReturn(role = 'worker', path = '/sale/return/bl-1') {
  render(
    <AuthProvider
      client={createFakeAuthClient({
        initialSession: fakeSession({ role, email: 'vendeur@merx.ma', userId: 'auth-vendeur' }),
      })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  )
}

/* L'identifiant que l'appareil s'est donné (E1-03) : un UUID, pas une étiquette. */
const DEVICE_ID = '11111111-1111-4111-8111-111111111111'

const lines = () => screen.getByRole('region', { name: 'Lignes du retour' })
const credit = () => screen.getByRole('status', { name: 'Avoir' })
const saveButton = () => screen.getByRole('button', { name: 'Enregistrer le retour' })

const lineFor = (name: string): HTMLElement => {
  const items = within(lines()).getAllByRole('listitem')
  const found = items.find((item) => item.textContent?.includes(name))
  if (found === undefined) throw new Error(`aucune ligne pour « ${name} »`)
  return found
}

/** Les appels d'écriture, dans l'ordre — ce qui est parti vers la base. */
const writes = () => calls.filter((call) => call.op !== 'select')

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
  respond.mockImplementation(defaultResponse)
  previous = []
  origin = {
    id: 'bl-1',
    doc_type: 'delivery_note',
    doc_number: 'BL-A-26-00007',
    status: 'confirmed',
    sale_line: [originLine('v1', '10.000', '9.00'), originLine('v2', '4.000', '4.00')],
  }
  window.localStorage.setItem(DEVICE_STORAGE_KEY, DEVICE_ID)
  window.localStorage.setItem(DEVICE_PREFIX_KEY, 'A')
})

describe('l’écran de retour', () => {
  it('reprend les lignes du bon, à la quantité livrée', async () => {
    renderReturn()

    expect(await screen.findByText('Retour du bon BL-A-26-00007')).toBeInTheDocument()
    const line = lineFor('Crème hydratante 200 ml')
    expect(within(line).getByLabelText('Quantité rendue — Crème hydratante 200 ml')).toHaveValue(
      '10',
    )
    expect(within(line).getByText('Livré, encore retournable : 10')).toBeInTheDocument()
    // 10 × 9,00 + 4 × 4,00
    expect(credit()).toHaveTextContent('106,00')
  })

  /* Un retour n'est pas une vente : rien ne s'ajoute qui ne vienne du bon. */
  it('n’offre ni recherche, ni scan, ni grille', async () => {
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    expect(screen.queryByLabelText('Rechercher ou scanner un produit')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Type de document' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Présentation des produits' })).not.toBeInTheDocument()
  })

  it('est un écran de détail : un retour vers Vente, aucune barre d’onglets', async () => {
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    expect(screen.getByRole('link', { name: 'Retour : Vente' })).toHaveAttribute('href', '/sale')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('laisse baisser la quantité, et l’avoir suit', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    const field = within(lineFor('Crème hydratante 200 ml')).getByLabelText(
      'Quantité rendue — Crème hydratante 200 ml',
    )
    await user.clear(field)
    await user.type(field, '3')

    expect(field).toHaveValue('3')
    // 3 × 9,00 + 4 × 4,00
    expect(credit()).toHaveTextContent('43,00')
  })

  it('laisse retirer une ligne qui ne revient pas', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    await user.click(screen.getByRole('button', { name: 'Retirer du retour — Savon noir 500 g' }))

    expect(within(lines()).getAllByRole('listitem')).toHaveLength(1)
    expect(credit()).toHaveTextContent('90,00')
  })

  /*
   * Le refus tôt, sous les doigts du vendeur. La phrase n'est pas celle de la
   * base : `merx.require_returnable_quantity()` a la sienne, et elle ne se lit
   * que lorsqu'on a écrit sans passer par cet écran.
   */
  it('refuse une quantité au-delà du bon, sans réécrire le champ', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    const field = within(lineFor('Crème hydratante 200 ml')).getByLabelText(
      'Quantité rendue — Crème hydratante 200 ml',
    )
    await user.clear(field)
    await user.type(field, '12')

    // Le champ garde ce qui a été tapé : rien ne bouge en silence.
    expect(field).toHaveValue('12')
    expect(within(lineFor('Crème hydratante 200 ml')).getByRole('alert')).toHaveTextContent(
      'Ce bon n’a livré que 10',
    )
    expect(saveButton()).toBeDisabled()
  })

  it('déduit les retours déjà enregistrés', async () => {
    previous = [{ id: 'rt-0', status: 'confirmed', sale_line: [{ variant_id: 'v1', quantity: '7.000' }] }]
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    expect(
      within(lineFor('Crème hydratante 200 ml')).getByLabelText(
        'Quantité rendue — Crème hydratante 200 ml',
      ),
    ).toHaveValue('3')
  })

  it('dit pourquoi il n’y a rien à retourner', async () => {
    origin = {
      id: 'bl-1',
      doc_type: 'delivery_note',
      doc_number: 'BL-A-26-00007',
      status: 'cancelled',
      sale_line: [originLine('v1', '10.000', '9.00')],
    }
    renderReturn()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ce bon est annulé : il n’y a rien à retourner.',
    )
  })
})

describe('l’enregistrement', () => {
  /*
   * Trois appels, comme la vente (E4-03) : le brouillon — qui porte son bon
   * d'origine —, ses lignes **en un seul appel**, puis la confirmation qui pose
   * le numéro. Dix lignes ne coûtent donc aucun aller-retour de plus.
   */
  it('écrit le brouillon, ses lignes en un appel, puis la confirmation', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    await user.click(saveButton())

    await waitFor(() =>
      expect(screen.getByText(/Retour RT-A-\d{2}-00001 enregistré/)).toBeInTheDocument(),
    )

    const written = writes()
    expect(written.map((call) => `${call.op} ${call.table}`)).toEqual([
      'insert sale_document',
      'update sale_document',
      'insert sale_line',
      'update sale_document',
    ])

    // Le brouillon : son type, son bon d'origine, et aucun dépôt — la base le
    // pose depuis le commerce de la session (E4-03).
    expect(written[0]!.payload).toMatchObject({
      doc_type: 'return',
      source_document_id: 'bl-1',
      device_id: DEVICE_ID,
    })
    expect(written[0]!.payload).not.toHaveProperty('warehouse_id')

    // Les lignes, en un seul appel, au prix du bon.
    const rows = written[2]!.payload as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sale_document_id: 'rt-1',
      variant_id: 'v1',
      quantity: '10.000',
      unit_price: '9.00',
      price_source: 'manual',
      overridden_price: null,
    })
    // `line_total` est engendrée par la base depuis E4-04 : elle n'est pas envoyée.
    expect(rows[0]).not.toHaveProperty('line_total')

    // La confirmation pose le numéro du retour, pas celui d'un bon.
    const confirmation = written[3]!.payload as Record<string, unknown>
    expect(confirmation['status']).toBe('confirmed')
    expect(String(confirmation['doc_number'])).toMatch(/^RT-A-\d{2}-00001$/)
  })

  it('n’envoie aucun motif quand le champ est vide', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    await user.click(saveButton())
    await waitFor(() => expect(writes()).not.toHaveLength(0))

    expect(writes()[0]!.payload).not.toHaveProperty('notes')
  })

  it('porte le motif saisi dans les notes du document', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    await user.type(screen.getByLabelText('Motif du retour (facultatif)'), 'emballage abîmé')
    await user.click(saveButton())
    await waitFor(() => expect(writes()).not.toHaveLength(0))

    expect(writes()[0]!.payload).toMatchObject({ notes: 'emballage abîmé' })
  })

  it('dit le refus de la base sans perdre la saisie', async () => {
    const user = userEvent.setup()
    renderReturn()
    await screen.findByText('Retour du bon BL-A-26-00007')

    respond.mockImplementation((call) => {
      if (call.table === 'sale_document' && call.op === 'insert') {
        return {
          data: null,
          error: { code: 'PT400', message: 'Ce retour rend plus que le bon n’a livré' },
        }
      }
      return defaultResponse(call)
    })

    await user.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('rend plus que le bon')
    // Les lignes sont toujours là : rien n'est perdu d'une tentative refusée.
    expect(within(lines()).getAllByRole('listitem')).toHaveLength(2)
  })
})
