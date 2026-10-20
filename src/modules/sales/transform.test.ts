/*
 * La transformation d'un document — E4-05, côté appareil. RÈGLES M3-4, M3-5.
 *
 * Ce que ce fichier mesure, et que la base ne voit pas :
 *
 *   — une ligne reprise porte **le prix du papier**, et les paliers et le
 *     plancher **d'aujourd'hui** : le document raconte la vente telle qu'elle a
 *     été promise, la grille, elle, bouge ;
 *   — **aucun forçage n'est attribué à celui qui transforme.**
 *     `overriddenPrice` est nul sur toute ligne reprise, quoi qu'en dise la
 *     grille du jour : sinon l'entrée `price_override` du journal porterait le
 *     nom de l'employé qui transforme un devis fait par le patron il y a un
 *     mois. C'est l'erreur de « qui » qu'E4-04 a refusée pour la confirmation
 *     (E1-04, l'auteur est celui qui écrit) ;
 *   — `priceSource` se **mesure** contre la grille du jour au lieu d'être
 *     copié : `auto` quand le prix repris est celui du palier, `manual` sinon —
 *     ce qui est la vérité, le prix ne venant pas de la grille ;
 *   — un original brouillon, annulé, ou qui ne donne rien, est refusé **ici**,
 *     avec la phrase de l'écran. Celle de la base
 *     (`merx.require_transformation_shape()`) ne se lit que lorsqu'on a parlé à
 *     PostgREST sans passer par là (CLAUDE.md, deux gardes sur le même chemin),
 *     et elle est mesurée dans `supabase/tests/sale-lifecycle.test.ts`.
 *
 * Ce qui part en base est mesuré par `SaleScreen.test.tsx` (le document neuf,
 * sa filiation, ses lignes) ; ce que la base en fait, par
 * `sale-lifecycle.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TRANSFORM_MESSAGES, TRANSFORM_TARGET, loadForTransformation } from '@/modules/sales'

interface Call {
  table: string
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
      const call: Call = { table, filters: [] }
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        in: (column: string, value: unknown) => {
          call.filters.push(['in', column, value])
          return builder
        },
        is: (column: string, value: unknown) => {
          call.filters.push(['is', column, value])
          return builder
        },
        maybeSingle: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
  },
}))

/** La grille du jour : 12 DH à l'unité, 11 dès 10 pièces. */
const GRID = [
  { variant_id: 'v1', min_qty: '1.000', unit_price: '12.00' },
  { variant_id: 'v1', min_qty: '10.000', unit_price: '11.00' },
]

/** Les planchers du jour, par variante — aucun par défaut. */
let floors: Map<string, string>

/** Les paliers du jour — remplacés au cas par cas. */
let grid: Array<{ variant_id: string; min_qty: string; unit_price: string | null }>

function line(
  variantId: string,
  quantity: string,
  unitPrice: string,
): Record<string, unknown> {
  return {
    variant_id: variantId,
    quantity,
    unit_price: unitPrice,
    variant: {
      sku: `SKU-${variantId}`,
      product: {
        id: `p-${variantId}`,
        name_fr: 'Crème hydratante',
        code: 'CRM-1',
        photo_url: 'p/1.jpg',
      },
    },
  }
}

/** Le document d'origine, tel que PostgREST le rend avec ses lignes. */
function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q-1',
    doc_type: 'quote',
    doc_number: 'DV-A-26-00007',
    status: 'confirmed',
    sale_line: [line('v1', '24.000', '11.00')],
    ...overrides,
  }
}

function answer(document: unknown): void {
  respond.mockImplementation((call) => {
    if (call.table === 'sale_document') return { data: document, error: null }
    if (call.table === 'price_break') return { data: grid, error: null }
    if (call.table === 'variant') {
      return {
        data: [...new Set(grid.map((row) => row.variant_id))].map((id) => ({
          id,
          floor_price: floors.get(id) ?? null,
        })),
        error: null,
      }
    }
    throw new Error(`appel inattendu : ${call.table}`)
  })
}

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
  floors = new Map()
  grid = [...GRID]
  answer(source())
})

describe('la chaîne proposée', () => {
  /*
   * L'écran propose **le pas suivant**. Le saut « devis → bon » existe en base
   * — un client accepte un devis et on le livre — et le vendeur l'obtient en
   * changeant le type avant d'enregistrer ; il n'a pas à être le défaut.
   */
  it('va du devis à la commande, de la commande au bon, et s’arrête là', () => {
    expect(TRANSFORM_TARGET).toEqual({
      quote: 'order',
      order: 'delivery_note',
      delivery_note: null,
      /*
       * Un bon ne se transforme pas : il se **retourne**, et le retour a sa
       * propre porte (E4-06). La chaîne admise en base le connaît — c'est la
       * même table —, cet écran-ci ne le propose pas.
       */
      return: null,
    })
  })
})

describe('les lignes reprises', () => {
  it('portent la quantité et le prix du document d’origine', async () => {
    const loaded = await loadForTransformation('q-1')

    expect(loaded.docNumber).toBe('DV-A-26-00007')
    expect(loaded.target).toBe('order')
    expect(loaded.lines).toHaveLength(1)
    expect(loaded.lines[0]).toMatchObject({
      variantId: 'v1',
      productId: 'p-v1',
      name: 'Crème hydratante',
      reference: 'CRM-1',
      photoPath: 'p/1.jpg',
      quantity: '24',
      unitPrice: '11,00',
    })
  })

  it('lisent les paliers et le plancher du jour, pas ceux du devis', async () => {
    floors.set('v1', '10.50')
    const loaded = await loadForTransformation('q-1')

    expect(loaded.lines[0]!.floorPrice).toBe('10.50')
    expect(loaded.lines[0]!.breaks).toEqual([
      { minQty: '1.000', unitPrice: '12.00' },
      { minQty: '10.000', unitPrice: '11.00' },
    ])
    // Un seul appel pour toutes les variantes, comme au comptoir.
    expect(calls.filter((call) => call.table === 'price_break')).toHaveLength(1)
  })

  it('sont `auto` quand le prix repris est celui du palier du jour', async () => {
    const loaded = await loadForTransformation('q-1')

    expect(loaded.lines[0]!.priceSource).toBe('auto')
    expect(loaded.lines[0]!.overriddenPrice).toBeNull()
  })

  /*
   * L'arbitrage du fichier. Le devis promettait 9,00 ; la grille du jour dit
   * 11,00 pour cette quantité. La ligne garde le prix promis, se dit `manual`
   * — le prix ne vient pas de la grille —, et **n'est pas un forçage** : rien
   * n'entrera au journal au nom de celui qui transforme.
   */
  it('n’attribue aucun forçage à celui qui transforme', async () => {
    answer(source({ sale_line: [line('v1', '24.000', '9.00')] }))

    const loaded = await loadForTransformation('q-1')

    expect(loaded.lines[0]!.unitPrice).toBe('9,00')
    expect(loaded.lines[0]!.priceSource).toBe('manual')
    expect(loaded.lines[0]!.overriddenPrice).toBeNull()
  })

  it('reste sans forçage même quand la grille ne répond plus', async () => {
    grid = []
    answer(source({ sale_line: [line('v1', '24.000', '9.00')] }))

    const loaded = await loadForTransformation('q-1')

    expect(loaded.lines[0]!.unitPrice).toBe('9,00')
    expect(loaded.lines[0]!.priceSource).toBe('manual')
    expect(loaded.lines[0]!.overriddenPrice).toBeNull()
    expect(loaded.lines[0]!.breaks).toEqual([])
  })
})

describe('ce qui ne se transforme pas', () => {
  it('un document introuvable, ou interdit', async () => {
    answer(null)
    await expect(loadForTransformation('q-1')).rejects.toThrow(TRANSFORM_MESSAGES.notFound)
  })

  it('un brouillon', async () => {
    answer(source({ status: 'draft', doc_number: null }))
    await expect(loadForTransformation('q-1')).rejects.toThrow(TRANSFORM_MESSAGES.draft)
  })

  it('un document annulé', async () => {
    answer(source({ status: 'cancelled' }))
    await expect(loadForTransformation('q-1')).rejects.toThrow(TRANSFORM_MESSAGES.cancelled)
  })

  it('un bon de livraison, qui est la fin du cycle', async () => {
    answer(source({ doc_type: 'delivery_note', doc_number: 'BL-A-26-00007' }))
    await expect(loadForTransformation('q-1')).rejects.toThrow(TRANSFORM_MESSAGES.terminal)
  })

  it('un document sans ligne', async () => {
    answer(source({ sale_line: [] }))
    await expect(loadForTransformation('q-1')).rejects.toThrow(TRANSFORM_MESSAGES.empty)
  })

  /*
   * Aucune lecture de paliers dans ces cas-là : un refus se prononce avant de
   * payer un aller-retour au comptoir.
   */
  it('refuse avant de lire la grille', async () => {
    answer(source({ status: 'cancelled' }))
    await expect(loadForTransformation('q-1')).rejects.toThrow()

    expect(calls.map((call) => call.table)).toEqual(['sale_document'])
  })
})
