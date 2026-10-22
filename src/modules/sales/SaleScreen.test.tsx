/*
 * L'écran de vente — E4-03 et E4-04, côté interface. RÈGLES M1-4, M3-6, point
 * de rupture n° 2.
 *
 * Ce que l'écran doit tenir, et que la base ne voit pas :
 *
 *   — **trois entrées, une seule ligne d'arrivée** : scan, référence tapée,
 *     grille photo. Et pas d'écran scan-only : sans caméra, les deux autres
 *     entrées sont là ;
 *   — la **quantité se tape** (24, 48, 120), le champ est prérempli à 1 et la
 *     frappe le remplace ; les `−` / `+` ajustent d'une pièce ;
 *   — le **prix suit la quantité**, et le total suit les deux ;
 *   — E4-04 : le prix du palier se **force** d'un tap, le forçage survit à la
 *     quantité et part en base avec le prix qu'il remplace ; l'**incitation**
 *     au palier suivant s'affiche ; et un employé ne peut pas enregistrer un
 *     bon sous le `floor_price` — le patron, oui ;
 *   — un **stock à zéro n'empêche rien** (RÈGLE M2-3) ;
 *   — l'écriture : un brouillon, ses lignes en un appel, puis la confirmation —
 *     et une **retente** qui reprend le même brouillon sans le redoubler ;
 *   — un **budget de gestes** pour un bon de dix lignes à quantités réelles.
 *     Le chronomètre de 90 secondes, debout et d'une main, se tient sur un vrai
 *     Android : il est en vérification en attente (`docs/PENDING-CHECKS.md`).
 *
 * Ce qui n'est pas mesuré ici : la recherche elle-même — accents, fautes,
 * référence partielle, classement, isolation — qui appartient à
 * `public.search_products()` et s'éprouve sur la base
 * (`supabase/tests/product-search.test.ts`) ; la résolution par palier, pure et
 * testée en `sale.test.ts` et `pricing.test.ts` ; le dépôt posé par défaut,
 * mesuré sur la base (`supabase/tests/sale-warehouse.test.ts`) ; et la caméra,
 * qui est E2-06 — `ScanButton` est donc remplacé ici par un bouton qui rend un
 * code, parce que jsdom n'a ni `BarcodeDetector` ni `mediaDevices`.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/routes'
import { AuthProvider } from '@/lib/auth'
import { DEVICE_PREFIX_KEY, DEVICE_STORAGE_KEY } from '@/lib/device'
import { createFakeAuthClient, fakeSession } from '@/test/fakeAuth'

/*
 * L'impression (E5-01). Deux fonctions remplacées, et deux seulement :
 * « sommes-nous dans l'enveloppe Android » — faux partout ailleurs dans ce
 * fichier, donc rien ne s'imprime et rien ne change — et l'envoi lui-même. Le
 * ticket, lui, est construit par le vrai code.
 */
const printing = vi.hoisted(() => ({ native: false, printTicket: vi.fn() }))

vi.mock('@/lib/printing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/printing')>()),
  thermalPrinting: () => printing.native,
  printTicket: printing.printTicket,
}))

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

interface Hit {
  variant_id: string
  product_id: string
  name_fr: string
  name_ar: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  photo_url: string | null
}

const SCANNED = '6111234567890'

const calls: Call[] = []
const queries: string[] = []
const respond = vi.fn<(call: Call) => Response | Promise<Response>>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (fn: string, args?: { q?: string }) => ({
      then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
        // Toute route authentifiée enregistre l'appareil au montage (E1-03).
        if (fn === 'register_device') {
          return Promise.resolve({
            data: [{ id: 'dev-1', label: 'Comptoir', prefix: 'A', last_sync_at: null }],
            error: null,
          }).then(resolve, reject)
        }
        if (fn !== 'search_products') return Promise.reject(new Error(`rpc inattendue : ${fn}`))
        const q = args?.q ?? ''
        queries.push(q)
        return Promise.resolve(answerSearch(q)).then(resolve, reject)
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
        is: (column: string, value: unknown) => {
          call.filters.push(['is', column, value])
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

/*
 * La caméra est E2-06 et ne vit pas dans jsdom. Le bouton de remplacement rend
 * un code : ce qui se mesure ici est que le code **aboutisse à une ligne**,
 * sans un geste de plus.
 */
vi.mock('@/lib/barcode', () => ({
  ScanButton: ({ label, onScan }: { label?: string; onScan: (code: string) => void }) => (
    <button type="button" onClick={() => onScan(SCANNED)}>
      {label ?? 'Scanner'}
    </button>
  ),
}))

const hit = (id: string, name: string, extra: Partial<Hit> = {}): Hit => ({
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

/* Un catalogue de grossiste : dix références, dont une au code-barres scanné. */
const CATALOGUE: Hit[] = [
  hit('v1', 'Crème hydratante 200 ml', { code: 'CRM-1', barcode: SCANNED }),
  hit('v2', 'Savon noir 500 g', { code: 'SAV-1' }),
  hit('v3', 'Shampooing 400 ml', { code: 'SHP-1' }),
  hit('v4', 'Dentifrice 75 ml', { code: 'DNT-1' }),
  hit('v5', 'Eau de Javel 1 L', { code: 'JAV-1' }),
  hit('v6', 'Lessive 3 kg', { code: 'LES-1' }),
  hit('v7', 'Huile 5 L', { code: 'HUI-1' }),
  hit('v8', 'Sucre 50 kg', { code: 'SUC-1' }),
  hit('v9', 'Thé 200 g', { code: 'THE-1' }),
  hit('v10', 'Café 1 kg', { code: 'CAF-1' }),
]

/** Les planchers, par variante — aucune variante n'en a par défaut. */
let floors: Map<string, string>

/** La grille par défaut : 12 DH à l'unité, 11 dès 10, 9,50 dès 48. */
const GRID = [
  { min_qty: '1.000', unit_price: '12.00' },
  { min_qty: '10.000', unit_price: '11.00' },
  { min_qty: '48.000', unit_price: '9.50' },
]

/* Les réglages du commerce — vides tant qu'aucun cas n'y met une imprimante. */
let settings: Array<Record<string, unknown>>

/* Ce que la grille rend, par variante — remplacé au cas par cas. */
let grids: Map<string, Array<{ min_qty: string; unit_price: string | null }>>

/* Les quantités en stock, par variante. */
let stock: Map<string, string>

/*
 * Le document d'origine d'une transformation — E4-05. `null` tant qu'aucun cas
 * n'en pose : l'écran de vente ordinaire ne lit aucun document.
 */
let sourceDocument: unknown = null

function answerSearch(q: string): Response {
  const needle = q.trim().toLowerCase()
  if (needle === '') return { data: CATALOGUE, error: null }
  return {
    data: CATALOGUE.filter(
      (row) =>
        row.name_fr.toLowerCase().includes(needle) ||
        (row.code ?? '').toLowerCase().includes(needle) ||
        row.barcode === q.trim(),
    ),
    error: null,
  }
}

const idsOf = (call: Call, column = 'variant_id'): string[] => {
  const filter = call.filters.find(([kind, name]) => kind === 'in' && name === column)
  return (filter?.[2] as string[] | undefined) ?? []
}

/** La réponse ordinaire de la base, écran par écran. */
function defaultResponse(call: Call): Response {
  if (call.table === 'stock_level') {
    return {
      data: idsOf(call).map((id) => ({
        variant_id: id,
        quantity: stock.get(id) ?? '100.000',
        last_movement_at: '2026-10-01T09:00:00Z',
      })),
      error: null,
    }
  }

  if (call.table === 'price_break') {
    const rows = idsOf(call).flatMap((id) =>
      (grids.get(id) ?? GRID).map((row) => ({ variant_id: id, ...row })),
    )
    return { data: rows, error: null }
  }

  // Le plancher, lu avec les paliers (E4-04). `floor_price` est un prix de
  // vente minimum, lisible par tous les rôles (SPEC § 6) — pas un coût.
  if (call.table === 'variant') {
    return {
      data: idsOf(call, 'id').map((id) => ({ id, floor_price: floors.get(id) ?? null })),
      error: null,
    }
  }

  if (call.table === 'tenant_setting') return { data: settings, error: null }

  if (call.table === 'document_sequence') return { data: { last_number: 0 }, error: null }

  // La lecture du document d'origine — E4-05, `loadForTransformation()`.
  if (call.table === 'sale_document' && call.op === 'select') {
    return { data: sourceDocument, error: null }
  }

  if (call.table === 'sale_document' && call.op === 'insert') {
    return { data: { id: 'doc-1' }, error: null }
  }

  if (call.table === 'sale_document' && call.op === 'update') {
    // La confirmation rend la ligne touchée ; la mise à jour des totaux, rien.
    const payload = call.payload as Record<string, unknown>
    return payload['status'] === 'confirmed'
      ? { data: [{ id: 'doc-1' }], error: null }
      : { data: null, error: null }
  }

  if (call.table === 'sale_line') return { data: null, error: null }

  throw new Error(`appel inattendu : ${call.op} ${call.table}`)
}

function renderSale(role = 'worker', path = '/sale') {
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

const searchField = () => screen.getByLabelText('Rechercher ou scanner un produit')
const bon = () => screen.getByRole('region', { name: 'Lignes du bon' })
const total = () => screen.getByRole('status', { name: 'Total' })
const saveButton = () => screen.getByRole('button', { name: 'Enregistrer le bon' })

const lineFor = (name: string): HTMLElement => {
  const items = within(bon()).getAllByRole('listitem')
  const found = items.find((item) => item.textContent?.includes(name))
  if (found === undefined) throw new Error(`aucune ligne pour « ${name} »`)
  return found
}

/** Les appels d'écriture, dans l'ordre — ce qui est parti vers la base. */
const writes = () => calls.filter((call) => call.op !== 'select')

beforeEach(() => {
  calls.length = 0
  queries.length = 0
  respond.mockReset()
  respond.mockImplementation(defaultResponse)
  grids = new Map()
  floors = new Map()
  stock = new Map()
  settings = []
  sourceDocument = null
  printing.native = false
  printing.printTicket.mockReset()
  printing.printTicket.mockResolvedValue(undefined)
  window.localStorage.clear()
  window.localStorage.setItem(DEVICE_STORAGE_KEY, '11111111-1111-4111-8111-111111111111')
  window.localStorage.setItem(DEVICE_PREFIX_KEY, 'A')
})

/* ========================================================================== */
/* RÈGLE M3-6 — trois entrées, une seule ligne d'arrivée                       */
/* ========================================================================== */

describe('les trois entrées', () => {
  it('la référence tapée aboutit à une ligne', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.type(searchField(), 'SAV-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Ajouter au bon — Savon noir 500 g' }))

    expect(lineFor('Savon noir')).toBeInTheDocument()
  })

  it('la grille photo aboutit à la même ligne', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Grille photo' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Savon noir 500 g' }))

    expect(lineFor('Savon noir')).toBeInTheDocument()
  })

  it('le scan aboutit à la même ligne, sans un geste de plus', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Scanner un code-barres' }))

    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())
  })

  /*
   * « Ne pas construire un écran scan-only » : ici la caméra est remplacée,
   * mais ce qui compte est que le champ et la grille soient les deux autres
   * voies, offertes d'emblée et sans rien demander.
   */
  it('n’est pas un écran scan-only', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    expect(searchField()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grille photo' })).toBeInTheDocument()
  })

  it('fusionne le même article au lieu d’ouvrir une seconde ligne', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))

    await waitFor(() => expect(within(bon()).getAllByRole('listitem')).toHaveLength(1))
    expect(within(lineFor('Crème hydratante')).getByLabelText('Quantité')).toHaveValue('2')
  })
})

/* ========================================================================== */
/* La quantité se tape                                                         */
/* ========================================================================== */

describe('la quantité', () => {
  async function addCreme(): Promise<void> {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())
  }

  it('ouvre le clavier numérique et vaut 1 d’emblée', async () => {
    await addCreme()

    const field = within(lineFor('Crème hydratante')).getByLabelText('Quantité')
    expect(field).toHaveValue('1')
    expect(field).toHaveAttribute('inputMode', 'decimal')
  })

  /*
   * Le champ est sélectionné au toucher : taper « 120 » remplace le 1, il ne
   * s'y accole pas. Sans cela, le vendeur efface avant de taper — un geste par
   * ligne, mille fois par jour.
   */
  it('se remplace à la frappe, sans effacer d’abord', async () => {
    await addCreme()

    const field = within(lineFor('Crème hydratante')).getByLabelText('Quantité')
    await userEvent.click(field)
    await userEvent.keyboard('120')

    expect(field).toHaveValue('120')
  })

  it('s’ajuste d’une pièce par les deux boutons', async () => {
    await addCreme()

    const line = lineFor('Crème hydratante')
    await userEvent.click(
      within(line).getByRole('button', { name: /Une pièce de plus/ }),
    )
    expect(within(lineFor('Crème hydratante')).getByLabelText('Quantité')).toHaveValue('2')

    await userEvent.click(
      within(lineFor('Crème hydratante')).getByRole('button', { name: /Une pièce de moins/ }),
    )
    expect(within(lineFor('Crème hydratante')).getByLabelText('Quantité')).toHaveValue('1')
  })

  it('se supprime d’un geste', async () => {
    await addCreme()

    await userEvent.click(
      within(lineFor('Crème hydratante')).getByRole('button', { name: /Retirer du bon/ }),
    )

    expect(within(bon()).queryAllByRole('listitem')).toHaveLength(0)
  })
})

/* ========================================================================== */
/* Le prix et le total                                                         */
/* ========================================================================== */

describe('le prix et le total', () => {
  it('résout le prix et le total dès la première ligne', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))

    await waitFor(() => expect(total()).toHaveTextContent('12,00'))
  })

  it('bascule toute la ligne au palier, et le total suit en même temps', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())

    await userEvent.click(within(lineFor('Crème hydratante')).getByLabelText('Quantité'))
    await userEvent.keyboard('48')

    const line = lineFor('Crème hydratante')
    expect(within(line).getByText(/9,50/)).toBeInTheDocument()
    expect(within(line).getByText(/456,00/)).toBeInTheDocument()
    expect(total()).toHaveTextContent('456,00')
  })

  it('laisse saisir le prix là où la grille n’en donne aucun', async () => {
    grids.set('v1', [])
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())

    // Rien ne bloque la vente : le bon attend un prix, pas une grille.
    expect(saveButton()).toBeDisabled()
    await userEvent.type(
      within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)'),
      '13,40',
    )

    expect(total()).toHaveTextContent('13,40')
    expect(saveButton()).toBeEnabled()
  })

  it('n’enregistre pas un bon vide', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    expect(saveButton()).toBeDisabled()
    expect(total()).toHaveTextContent('0,00')
  })
})

/* ========================================================================== */
/* RÈGLE M2-3 — un stock à zéro n'empêche rien                                 */
/* ========================================================================== */

describe('le stock', () => {
  it('se lit à côté de l’article, et un zéro n’empêche pas la vente', async () => {
    stock.set('v1', '0.000')
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())

    expect(saveButton()).toBeEnabled()
    await userEvent.click(saveButton())

    expect(await screen.findByText(/BL-A-\d\d-00001/)).toBeInTheDocument()
  })

  it('un stock négatif non plus', async () => {
    stock.set('v1', '-7.000')
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(saveButton()).toBeEnabled())
  })
})

/* ========================================================================== */
/* L'écriture                                                                  */
/* ========================================================================== */

describe('l’enregistrement', () => {
  async function sellTwo(): Promise<void> {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }))
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())
    await userEvent.click(within(lineFor('Crème hydratante')).getByLabelText('Quantité'))
    await userEvent.keyboard('24')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Savon noir 500 g' }))
    await waitFor(() => expect(lineFor('Savon noir')).toBeInTheDocument())
  }

  /*
   * Rien ne part pendant la saisie : deux lignes et une quantité tapée ne
   * produisent aucune écriture. C'est ce qui fait qu'un bon abandonné ne laisse
   * aucun brouillon, donc aucun trou dans la séquence (SPEC § 4).
   */
  it('n’écrit rien avant l’appui', async () => {
    await sellTwo()

    expect(writes()).toEqual([])
  })

  it('écrit le brouillon, ses lignes en un seul appel, puis la confirmation', async () => {
    await sellTwo()

    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    const written = writes()
    expect(written.map((call) => `${call.op} ${call.table}`)).toEqual([
      'insert sale_document',
      'update sale_document',
      'insert sale_line',
      'update sale_document',
    ])

    // Le brouillon : le type du document, l'appareil, les totaux. Aucun dépôt —
    // la base le pose (`merx.default_warehouse_id()`, E4-03).
    const draft = written[0]!.payload as Record<string, unknown>
    expect(draft['doc_type']).toBe('delivery_note')
    expect(draft['total']).toBe('276.00')
    expect(draft).not.toHaveProperty('warehouse_id')
    expect(draft).not.toHaveProperty('status')

    // Les deux lignes, en un appel, montants et quantités en texte.
    const lines = written[2]!.payload as Array<Record<string, unknown>>
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      variant_id: 'v1',
      quantity: '24.000',
      unit_price: '11.00',
      price_source: 'auto',
      overridden_price: null,
    })
    expect(lines[1]).toMatchObject({ variant_id: 'v2', quantity: '1.000', unit_price: '12.00' })

    // `line_total` n'est pas envoyé : la base l'engendre (RÈGLE M3-7, E4-04).
    // Une valeur fournie serait refusée, et la règle d'arrondi n'a qu'un seul
    // endroit où elle est écrite.
    expect(lines[0]).not.toHaveProperty('line_total')
    expect(lines[1]).not.toHaveProperty('line_total')

    // La confirmation : le statut, le numéro, la date — et rien d'autre.
    const confirmation = written[3]!.payload as Record<string, unknown>
    expect(confirmation['status']).toBe('confirmed')
    expect(confirmation['doc_number']).toMatch(/^BL-A-\d\d-00001$/)
    expect(confirmation['issued_at']).toEqual(expect.any(String))
  })

  it('vide le bon et propose le suivant', async () => {
    await sellTwo()

    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    expect(within(bon()).queryAllByRole('listitem')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Nouveau bon' }))
    expect(screen.queryByText(/BL-A-\d\d-00001/)).toBeNull()
  })

  /*
   * Les trois appels ne sont pas atomiques. Si le réseau coupe **entre** les
   * lignes et la confirmation, le brouillon reste : un second appui le confirme
   * tel quel — il n'en crée pas un second et ne redouble pas ses lignes. C'est
   * la seule façon dont ce chemin peut échouer à moitié, et elle est mesurée.
   */
  it('une confirmation perdue se retente sur le même brouillon', async () => {
    let confirmations = 0
    respond.mockImplementation((call) => {
      if (
        call.table === 'sale_document' &&
        call.op === 'update' &&
        (call.payload as Record<string, unknown>)['status'] === 'confirmed'
      ) {
        confirmations += 1
        if (confirmations === 1) {
          return { data: null, error: { message: 'Réseau indisponible' } }
        }
      }
      return defaultResponse(call)
    })

    await sellTwo()
    await userEvent.click(saveButton())
    expect(await screen.findByText('Réseau indisponible')).toBeInTheDocument()

    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    const written = writes()
    expect(written.filter((c) => c.table === 'sale_document' && c.op === 'insert')).toHaveLength(1)
    expect(written.filter((c) => c.table === 'sale_line')).toHaveLength(1)
    expect(confirmations).toBe(2)

    // La seconde tentative confirme le document déjà écrit.
    const confirmed = written.filter(
      (c) => c.table === 'sale_document' && c.op === 'update',
    )
    expect(confirmed.at(-1)!.filters).toContainEqual(['eq', 'id', 'doc-1'])
  })

  it('dit l’échec du brouillon sans rien perdre de la saisie', async () => {
    respond.mockImplementation((call) =>
      call.table === 'sale_document' && call.op === 'insert'
        ? { data: null, error: { message: 'Réseau indisponible' } }
        : defaultResponse(call),
    )

    await sellTwo()
    await userEvent.click(saveButton())

    expect(await screen.findByText('Réseau indisponible')).toBeInTheDocument()
    expect(within(bon()).getAllByRole('listitem')).toHaveLength(2)
  })
})

/* ========================================================================== */
/* Le budget de gestes                                                         */
/* ========================================================================== */

/*
 * « Bon de 10 lignes en moins de 90 secondes. » Le chronomètre se tient debout,
 * au comptoir, sur un vrai Android — il est en vérification en attente. Ce qui
 * se mesure ici est ce dont il dépend et qui ne dépend d'aucun matériel : le
 * **nombre de gestes**. Chaque tap superflu est payé mille fois par jour.
 *
 * Le parcours compté est celui d'un grossiste, avec des quantités réelles —
 * 24, 48, 120 — et non dix fois « 1 » : pour chaque ligne, toucher le champ de
 * recherche, taper la référence, toucher le résultat, toucher la quantité, la
 * taper. Soit **trois taps et deux saisies par ligne**, et un tap pour
 * enregistrer : le budget est de 31 taps pour dix lignes, et le test échoue si
 * un geste s'ajoute.
 */
describe('le budget de gestes', () => {
  const QUANTITIES = ['24', '48', '120', '6', '12', '2', '36', '10', '4', '60']

  it('dix lignes à quantités réelles, en 31 taps', async () => {
    let taps = 0
    const tap = async (element: Element): Promise<void> => {
      taps += 1
      await userEvent.click(element)
    }

    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    for (const [index, article] of CATALOGUE.entries()) {
      await tap(searchField())
      await userEvent.keyboard(article.code!)
      await tap(await screen.findByRole('button', { name: `Ajouter au bon — ${article.name_fr}` }))
      await waitFor(() => expect(lineFor(article.name_fr)).toBeInTheDocument())

      await tap(within(lineFor(article.name_fr)).getByLabelText('Quantité'))
      await userEvent.keyboard(QUANTITIES[index]!)
    }

    expect(within(bon()).getAllByRole('listitem')).toHaveLength(10)

    await tap(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    expect(taps).toBe(31)

    // Et le bon est juste : dix lignes, chacune au prix de son palier.
    const lines = writes().find((call) => call.table === 'sale_line')!.payload as Array<
      Record<string, unknown>
    >
    expect(lines).toHaveLength(10)
    expect(lines[0]).toMatchObject({ quantity: '24.000', unit_price: '11.00' })
    expect(lines[2]).toMatchObject({ quantity: '120.000', unit_price: '9.50' })
    expect(lines[5]).toMatchObject({ quantity: '2.000', unit_price: '12.00' })
  }, 60_000)
})

/* ========================================================================== */
/* E4-04 — le forçage, l'incitation, le plancher                               */
/* ========================================================================== */

const priceButton = (name: string) =>
  within(lineFor(name)).getByRole('button', { name: `Forcer le prix — ${name}` })

async function addCreme(role = 'worker'): Promise<void> {
  renderSale(role)
  await screen.findByText('Crème hydratante 200 ml')
  await userEvent.click(
    screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }),
  )
  await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())
}

describe('le forçage du prix', () => {
  /*
   * Un tap sur le prix ouvre le champ : forcer un prix coûte un geste, sur la
   * ligne qu'on force, et aucun sur les autres (budget de gestes, ci-dessus).
   */
  it('s’ouvre d’un tap sur le prix du palier', async () => {
    await addCreme()

    expect(priceButton('Crème hydratante 200 ml')).toHaveTextContent('12,00')
    await userEvent.click(priceButton('Crème hydratante 200 ml'))

    const field = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    expect(field).toHaveValue('12,00')
  })

  it('part en base avec le prix qu’il remplace, et le total le suit', async () => {
    await addCreme()
    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const field = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(field)
    await userEvent.keyboard('10,50')

    expect(total()).toHaveTextContent('10,50')

    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    const lines = writes().find((call) => call.table === 'sale_line')!.payload as Array<
      Record<string, unknown>
    >
    expect(lines[0]).toMatchObject({
      unit_price: '10.50',
      price_source: 'manual',
      overridden_price: '12.00',
    })
  })

  /*
   * L'inverse de la règle d'E4-03 : le forçage survit au changement de
   * quantité. Sans cela, il ne serait qu'une suggestion.
   */
  it('survit au changement de quantité', async () => {
    await addCreme()
    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const price = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(price)
    await userEvent.keyboard('10,50')

    await userEvent.click(within(lineFor('Crème hydratante')).getByLabelText('Quantité'))
    await userEvent.keyboard('48')

    expect(within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')).toHaveValue(
      '10,50',
    )
    expect(total()).toHaveTextContent('504,00')
  })

  it('se rend d’un geste, et le palier revient', async () => {
    await addCreme()
    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const price = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(price)
    await userEvent.keyboard('10,50')

    await userEvent.click(
      within(lineFor('Crème hydratante')).getByRole('button', {
        name: 'Rétablir le prix du palier — Crème hydratante 200 ml',
      }),
    )

    expect(priceButton('Crème hydratante 200 ml')).toHaveTextContent('12,00')
    expect(total()).toHaveTextContent('12,00')
  })

  /* Une ligne dont la grille ne dit rien se saisit toujours (E4-03, § 2.6). */
  it('reste une saisie, et non un forçage, là où aucun prix n’existe', async () => {
    grids.set('v1', [{ min_qty: '1.000', unit_price: null }])
    await addCreme()

    const field = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.click(field)
    await userEvent.keyboard('13')

    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)

    const lines = writes().find((call) => call.table === 'sale_line')!.payload as Array<
      Record<string, unknown>
    >
    expect(lines[0]).toMatchObject({ price_source: 'manual', overridden_price: null })
  })
})

describe('l’incitation au palier suivant', () => {
  /* RÈGLE M1-4, et la phrase est celle du spec : « +2 → 12,00 DH ». */
  it('s’affiche à moins de 20 % du palier suivant', async () => {
    grids.set('v1', [
      { min_qty: '1.000', unit_price: '13.00' },
      { min_qty: '12.000', unit_price: '12.00' },
    ])
    await addCreme()

    await userEvent.click(within(lineFor('Crème hydratante')).getByLabelText('Quantité'))
    await userEvent.keyboard('10')

    expect(lineFor('Crème hydratante')).toHaveTextContent('+2 → 12,00 DH')
  })

  it('se tait trop loin du palier', async () => {
    grids.set('v1', [
      { min_qty: '1.000', unit_price: '13.00' },
      { min_qty: '12.000', unit_price: '12.00' },
    ])
    await addCreme()

    await userEvent.click(within(lineFor('Crème hydratante')).getByLabelText('Quantité'))
    await userEvent.keyboard('8')

    expect(lineFor('Crème hydratante')).not.toHaveTextContent('→')
  })
})

describe('le plancher', () => {
  /*
   * L'écran refuse tôt, sous les doigts. Ce qui protège est
   * `merx.require_floor_price()` en base, mesuré sur la vraie base
   * (`supabase/tests/sale-price.test.ts`) : un écran se contourne d'une requête
   * (E1-02), et les deux niveaux ne rendent pas la même phrase.
   */
  it('retient le bon de l’employé, en disant pourquoi', async () => {
    floors.set('v1', '11.50')
    await addCreme('worker')

    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const price = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(price)
    await userEvent.keyboard('10')

    expect(
      within(lineFor('Crème hydratante')).getByText(
        'Prix trop bas pour cet article. Le patron seul peut descendre plus bas.',
      ),
    ).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(writes()).toEqual([])
  })

  it('laisse passer le patron, sans un mot', async () => {
    floors.set('v1', '11.50')
    await addCreme('owner')

    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const price = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(price)
    await userEvent.keyboard('10')

    expect(within(lineFor('Crème hydratante')).queryByText(/Prix trop bas/)).toBeNull()
    await waitFor(() => expect(saveButton()).toBeEnabled())
  })

  it('laisse passer l’employé au plancher exactement', async () => {
    floors.set('v1', '11.50')
    await addCreme('worker')

    await userEvent.click(priceButton('Crème hydratante 200 ml'))
    const price = within(lineFor('Crème hydratante')).getByLabelText('Prix unitaire (DH)')
    await userEvent.clear(price)
    await userEvent.keyboard('11,50')

    await waitFor(() => expect(saveButton()).toBeEnabled())
  })
})
/* ========================================================================== */
/* E4-05 — le type de document, et la transformation                           */
/* ========================================================================== */

/*
 * Le choix du type est ce qui fait qu'un devis existe : sans lui la chaîne de
 * la RÈGLE M3-4 n'a pas de premier maillon, et l'écran ne saurait produire que
 * des bons. Ce qui se mesure ici est que le choix **descende en base** — c'est
 * le type qui décide si le stock bouge (RÈGLE M3-5), et c'est la base qui
 * s'en charge.
 */
describe('le type de document', () => {
  const chooseType = async (label: string): Promise<void> => {
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Type de document' })).getByRole('button', {
        name: label,
      }),
    )
  }

  it('est le bon de livraison par défaut — RÈGLE M3-1', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')

    const group = screen.getByRole('group', { name: 'Type de document' })
    expect(within(group).getByRole('button', { name: 'Bon' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(saveButton()).toBeInTheDocument()
  })

  it('un devis part avec son type, son numéro et sa phrase', async () => {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')
    await chooseType('Devis')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter au bon — Savon noir 500 g' }))
    await waitFor(() => expect(lineFor('Savon noir')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le devis' }))
    await screen.findByText(/DV-A-\d\d-00001/)

    const written = writes()
    expect((written[0]!.payload as Record<string, unknown>)['doc_type']).toBe('quote')
    const confirmation = written[3]!.payload as Record<string, unknown>
    expect(confirmation['doc_number']).toMatch(/^DV-A-\d\d-00001$/)
    /*
     * Le genre suit le type : « devis enregistré », « commande enregistrée ».
     * La phrase est écrite en entier dans l'écran plutôt que recomposée — une
     * phrase fausse se lit, et personne ne relit un gabarit.
     */
    expect(screen.getByText(/Devis DV-A-\d\d-00001 enregistré\./)).toBeInTheDocument()
  })
})

describe('la transformation d’un document', () => {
  /*
   * Un devis de deux lignes : l'une au prix du palier d'aujourd'hui, l'autre à
   * un prix qui n'est plus celui de la grille. C'est la seconde qui porte
   * l'arbitrage — elle ne doit pas arriver ici en forçage.
   */
  const QUOTE = {
    id: 'q-1',
    doc_type: 'quote',
    doc_number: 'DV-A-26-00007',
    status: 'confirmed',
    sale_line: [
      {
        variant_id: 'v1',
        quantity: '24.000',
        unit_price: '11.00',
        variant: {
          sku: 'CRM-1',
          product: {
            id: 'v1',
            name_fr: 'Crème hydratante 200 ml',
            code: 'CRM-1',
            photo_url: null,
          },
        },
      },
      {
        variant_id: 'v2',
        quantity: '2.000',
        unit_price: '10.00',
        variant: {
          sku: 'SAV-1',
          product: { id: 'v2', name_fr: 'Savon noir 500 g', code: 'SAV-1', photo_url: null },
        },
      },
    ],
  }

  const openTransformation = async (): Promise<void> => {
    sourceDocument = QUOTE
    renderSale('worker', '/sale/from/q-1')
    await screen.findByRole('heading', { level: 1, name: 'Transformer DV-A-26-00007' })
    await waitFor(() => expect(lineFor('Crème hydratante')).toBeInTheDocument())
  }

  it('reprend les lignes du document et propose le pas suivant', async () => {
    await openTransformation()

    expect(within(bon()).getAllByRole('listitem')).toHaveLength(2)
    expect(within(lineFor('Crème hydratante')).getByLabelText('Quantité')).toHaveValue('24')
    // 24 × 11,00 + 2 × 10,00 — les prix du papier, pas ceux de la grille.
    expect(total()).toHaveTextContent('284,00')

    const group = screen.getByRole('group', { name: 'Type de document' })
    expect(within(group).getByRole('button', { name: 'Commande' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('porte un retour vers Vente, et aucune barre d’onglets', async () => {
    await openTransformation()

    expect(screen.getByRole('link', { name: 'Retour : Vente' })).toHaveAttribute('href', '/sale')
    expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).toBeNull()
  })

  /*
   * « Modification des lignes possible pendant la transformation » : une ligne
   * reprise se modifie comme une ligne tapée, et la grille d'aujourd'hui
   * reprend la parole dès que la quantité change — une nouvelle quantité est
   * une nouvelle vente, pas la reprise d'un prix promis.
   */
  it('laisse modifier une ligne reprise', async () => {
    await openTransformation()

    await userEvent.click(
      screen.getByRole('button', { name: 'Retirer du bon — Savon noir 500 g' }),
    )
    expect(within(bon()).getAllByRole('listitem')).toHaveLength(1)

    const quantity = within(lineFor('Crème hydratante')).getByLabelText('Quantité')
    await userEvent.clear(quantity)
    await userEvent.type(quantity, '48')
    // La grille reprend la parole : 9,50 dès 48 pièces.
    expect(total()).toHaveTextContent('456,00')
  })

  it('écrit un document neuf qui désigne l’original, sans le toucher', async () => {
    await openTransformation()

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la commande' }))
    await screen.findByText(/CM-A-\d\d-00001/)

    const written = writes()
    const draft = written[0]!.payload as Record<string, unknown>
    expect(draft['doc_type']).toBe('order')
    expect(draft['source_document_id']).toBe('q-1')

    // Rien n'a été écrit sur l'original : aucune écriture ne le nomme.
    expect(written.filter((call) => call.filters.some(([, , value]) => value === 'q-1'))).toEqual(
      [],
    )
  })

  /*
   * L'arbitrage de `transform.ts`, mesuré : la seconde ligne s'écarte de la
   * grille d'aujourd'hui (10,00 contre 12,00 au palier) et part pourtant
   * **sans** `overridden_price`. Sinon l'entrée `price_override` du journal
   * porterait le nom de l'employé qui transforme, pour un prix décidé par
   * quelqu'un d'autre il y a un mois (E4-04, E1-04).
   */
  it('n’attribue aucun forçage à celui qui transforme', async () => {
    await openTransformation()

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer la commande' }))
    await screen.findByText(/CM-A-\d\d-00001/)

    const lines = writes().find((call) => call.table === 'sale_line')!.payload as Array<
      Record<string, unknown>
    >
    expect(lines).toHaveLength(2)
    // La ligne au palier : `auto`, comme une ligne tapée aujourd'hui.
    expect(lines[0]).toMatchObject({
      variant_id: 'v1',
      unit_price: '11.00',
      price_source: 'auto',
      overridden_price: null,
    })
    // Celle qui s'en écarte : `manual` — le prix vient d'un papier, pas de la
    // grille — et **aucun** prix remplacé.
    expect(lines[1]).toMatchObject({
      variant_id: 'v2',
      unit_price: '10.00',
      price_source: 'manual',
      overridden_price: null,
    })
  })

  /*
   * Une lecture en échec ne laisse pas une impasse : l'écran dit ce qui s'est
   * passé et reste utilisable — le vendeur saisit à la main (SPEC § 2.6).
   */
  it('dit l’échec de la lecture et laisse l’écran utilisable', async () => {
    sourceDocument = null
    renderSale('worker', '/sale/from/q-9')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /n’existe plus, ou ce compte n’a pas le droit de le lire/,
    )
    expect(searchField()).toBeInTheDocument()
  })
})

/* ========================================================================== */
/* E5-01 — le ticket part à l'imprimante                                       */
/* ========================================================================== */

describe('l’impression du ticket, au comptoir', () => {
  /** Un commerce réglé avec une imprimante réseau sur le Wi-Fi du magasin. */
  const WITH_PRINTER = [
    {
      key: 'print_header',
      value: { business_name: 'Parfumerie Nour', phone: '+212612345678', address: 'Derb Omar' },
    },
    { key: 'default_language', value: 'fr' },
    { key: 'printer_address', value: '192.168.1.50:9100' },
    { key: 'printer_width', value: 576 },
  ]

  async function sellOne(): Promise<void> {
    renderSale()
    await screen.findByText('Crème hydratante 200 ml')
    await userEvent.click(
      screen.getByRole('button', { name: 'Ajouter au bon — Crème hydratante 200 ml' }),
    )
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await userEvent.click(saveButton())
    await screen.findByText(/BL-A-\d\d-00001/)
  }

  /*
   * **Sans un tap de plus.** Le ticket part à l'enregistrement : au comptoir,
   * chaque geste superflu est payé mille fois par jour (point de rupture n° 2).
   * Ce que le test lit est le ticket lui-même — l'en-tête du commerce, le
   * numéro que l'appareil vient d'attribuer, la ligne et son prix, le total.
   */
  it('imprime le bon dès qu’il est enregistré, sans un geste de plus', async () => {
    printing.native = true
    settings = WITH_PRINTER
    await sellOne()

    await waitFor(() => expect(printing.printTicket).toHaveBeenCalledTimes(1))
    const [ticket, setup] = printing.printTicket.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]

    expect(ticket).toMatchObject({
      businessName: 'Parfumerie Nour',
      phone: '+212612345678',
      address: 'Derb Omar',
      total: '12.00',
      lines: [
        { label: 'Crème hydratante 200 ml', quantity: '1.000', unitPrice: '12.00', lineTotal: '12.00' },
      ],
    })
    expect(ticket['number']).toMatch(/^BL-A-\d\d-00001$/)
    expect(setup).toEqual({ host: '192.168.1.50', port: 9100, width: 576 })
  })

  /*
   * Critère 4 : « échec d'impression non bloquant — le bon reste enregistré,
   * réimpression possible ». La vente est faite, le numéro est attribué, et
   * l'écran propose de réessayer sans rien ressaisir.
   */
  it('garde le bon et propose de réimprimer quand l’impression échoue', async () => {
    printing.native = true
    settings = WITH_PRINTER
    printing.printTicket.mockRejectedValue(new Error('L’imprimante ne répond pas.'))
    await sellOne()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impression échouée. Le bon est enregistré, vous pouvez réimprimer.',
    )
    expect(screen.getByText(/Bon BL-A-\d\d-00001 enregistré\./)).toBeInTheDocument()

    printing.printTicket.mockResolvedValue(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Imprimer de nouveau' }))

    await waitFor(() => expect(printing.printTicket).toHaveBeenCalledTimes(2))
  })

  /*
   * SPEC § 2.7 : hors de l'enveloppe Android il n'y a pas de socket. La vente
   * se fait exactement pareil, et rien ne s'imprime — pas de bouton, pas de
   * message, et pas même une lecture des réglages.
   */
  it('vend sans rien imprimer hors de l’enveloppe Android', async () => {
    settings = WITH_PRINTER
    await sellOne()

    expect(printing.printTicket).not.toHaveBeenCalled()
    expect(calls.some((call) => call.table === 'tenant_setting')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Imprimer de nouveau' })).not.toBeInTheDocument()
  })

  /* Un commerce sans imprimante : l'adresse est vide, et rien ne s'offre. */
  it('vend sans rien imprimer quand aucune imprimante n’est réglée', async () => {
    printing.native = true
    settings = WITH_PRINTER.map((row) =>
      row.key === 'printer_address' ? { ...row, value: '' } : row,
    )
    await sellOne()

    expect(printing.printTicket).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Imprimer de nouveau' })).not.toBeInTheDocument()
  })
})
