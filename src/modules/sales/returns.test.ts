/*
 * Le retour d'un bon — E4-06, côté appareil. RÈGLES M3-9, M3-2.
 *
 * Ce que ce fichier mesure, et que la base ne voit pas :
 *
 *   — **le reste à rendre**, par variante, retours précédents déduits. L'écran
 *     n'offre jamais plus que ce que le bon a livré, et une quantité tapée
 *     au-delà est refusée **tôt**, avec la phrase de l'écran — celle de
 *     `merx.require_returnable_quantity()` ne se lit que lorsqu'on a parlé à
 *     PostgREST sans passer par là (CLAUDE.md, deux gardes sur le même chemin),
 *     et elle est mesurée dans `supabase/tests/returns.test.ts` ;
 *
 *   — **le prix du papier, et la grille muette.** Une ligne de retour porte le
 *     prix du bon, sans palier et sans plancher : un changement de quantité ne
 *     rejoue aucune résolution, et rien ne la force à remonter au tarif du
 *     jour. C'est ce que le client a payé qu'on lui rend ;
 *
 *   — **les quatre refus de lecture** : un document introuvable, un document
 *     qui n'est pas un bon, un bon encore brouillon, un bon annulé — plus le
 *     bon dont tout a déjà été rendu.
 *
 * Ce qui part en base est mesuré par `ReturnScreen.test.tsx` ; ce que la base
 * en fait, par `returns.test.ts` et `returns-api.test.ts` de `supabase/tests`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RETURN_DOC_TYPE,
  RETURN_MESSAGES,
  lineOverReturnable,
  loadForReturn,
  returnIsComplete,
} from '@/modules/sales'
import { setQuantity, stepQuantity } from '@/modules/sales/sale'

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

function line(
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
        name_fr: variantId === 'v1' ? 'Crème hydratante' : 'Savon noir',
        code: variantId === 'v1' ? 'CRM-1' : null,
        photo_url: 'p/1.jpg',
      },
    },
  }
}

/** Le bon d'origine, tel que PostgREST le rend avec ses lignes. */
function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bl-1',
    doc_type: 'delivery_note',
    doc_number: 'BL-A-26-00007',
    status: 'confirmed',
    sale_line: [line('v1', '10.000', '9.00')],
    ...overrides,
  }
}

/** Les retours déjà enregistrés sur ce bon, tels que PostgREST les rend. */
let previous: Array<{ id: string; status: string; sale_line: Array<Record<string, string>> }>

/** Le bon courant. */
let origin: unknown

/* La seconde lecture se reconnaît à son filtre : les retours du bon. */
const isPrevious = (call: Call): boolean =>
  call.filters.some(([, column]) => column === 'source_document_id')

beforeEach(() => {
  calls.length = 0
  respond.mockReset()
  previous = []
  origin = note()
  respond.mockImplementation((call) => {
    if (call.table !== 'sale_document') throw new Error(`appel inattendu : ${call.table}`)
    return isPrevious(call) ? { data: previous, error: null } : { data: origin, error: null }
  })
})

describe('le reste à rendre', () => {
  it('part des quantités du bon', async () => {
    const source = await loadForReturn('bl-1')

    expect(source.docNumber).toBe('BL-A-26-00007')
    expect(source.returnable.get('v1')).toBe('10')
    expect(source.lines).toHaveLength(1)
    expect(source.lines[0]).toMatchObject({
      variantId: 'v1',
      productId: 'p-v1',
      name: 'Crème hydratante',
      reference: 'CRM-1',
      quantity: '10',
      unitPrice: '9,00',
      priceSource: 'manual',
      overriddenPrice: null,
    })
  })

  it('déduit les retours déjà confirmés', async () => {
    previous = [{ id: 'rt-1', status: 'confirmed', sale_line: [{ variant_id: 'v1', quantity: '4.000' }] }]
    const source = await loadForReturn('bl-1')

    expect(source.returnable.get('v1')).toBe('6')
    expect(source.lines[0]!.quantity).toBe('6')
  })

  /*
   * Les brouillons et les annulés ne comptent pas, et c'est la **requête** qui
   * le dit : un retour abandonné bloquerait le bon pour toujours, et un retour
   * annulé a déjà rendu son stock. La base tient le même arbitrage.
   */
  it('ne demande que les retours qui ont vécu', async () => {
    await loadForReturn('bl-1')

    const query = calls.find(isPrevious)
    expect(query?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'source_document_id', 'bl-1'],
        ['eq', 'doc_type', 'return'],
        ['in', 'status', ['confirmed', 'delivered']],
      ]),
    )
  })

  it('laisse de côté une variante entièrement rendue', async () => {
    origin = note({
      sale_line: [line('v1', '10.000', '9.00'), line('v2', '2.000', '4.00')],
    })
    previous = [
      { id: 'rt-1', status: 'confirmed', sale_line: [{ variant_id: 'v1', quantity: '10.000' }] },
    ]

    const source = await loadForReturn('bl-1')
    expect(source.lines.map((l) => l.variantId)).toEqual(['v2'])
  })

  it('refuse un bon dont tout a déjà été rendu', async () => {
    previous = [
      { id: 'rt-1', status: 'confirmed', sale_line: [{ variant_id: 'v1', quantity: '10.000' }] },
    ]

    await expect(loadForReturn('bl-1')).rejects.toThrow(RETURN_MESSAGES.nothingLeft)
  })

  /*
   * Deux lignes de la même variante n'arrivent que par l'API — l'écran de vente
   * fusionne (E4-03). La ligne de retour prend alors le **plus bas** prix :
   * l'avoir ne dépasse jamais ce qui a été facturé, donc la branche « avoir »
   * du garde ne refuse aucun retour total légitime.
   */
  it('prend le plus bas prix quand le bon porte deux fois la variante', async () => {
    origin = note({
      sale_line: [line('v1', '10.000', '12.00'), line('v1', '10.000', '9.00')],
    })

    const source = await loadForReturn('bl-1')
    expect(source.lines).toHaveLength(1)
    expect(source.returnable.get('v1')).toBe('20')
    expect(source.lines[0]!.unitPrice).toBe('9,00')
  })
})

describe('la grille', () => {
  /*
   * Aucune lecture de `price_break` ni de `variant` : le prix d'un retour ne se
   * résout pas, il se lit sur le papier. Une ligne sans palier ne peut pas être
   * remontée au tarif du jour par un changement de quantité.
   */
  it('n’est pas lue du tout', async () => {
    const source = await loadForReturn('bl-1')

    expect(calls.map((call) => call.table)).toEqual(['sale_document', 'sale_document'])
    expect(source.lines[0]!.breaks).toEqual([])
    expect(source.lines[0]!.floorPrice).toBeNull()
  })

  it('ne reprend pas la parole quand la quantité change', async () => {
    const source = await loadForReturn('bl-1')

    const lowered = setQuantity(source.lines, 'v1', '4')
    expect(lowered[0]!.unitPrice).toBe('9,00')
    expect(lowered[0]!.priceSource).toBe('manual')

    const stepped = stepQuantity(lowered, 'v1', -1)
    expect(stepped[0]!.quantity).toBe('3')
    expect(stepped[0]!.unitPrice).toBe('9,00')
  })
})

describe('les refus de lecture', () => {
  it('nomme un document introuvable', async () => {
    origin = null
    await expect(loadForReturn('bl-1')).rejects.toThrow(RETURN_MESSAGES.notFound)
  })

  for (const docType of ['quote', 'order'] as const) {
    it(`refuse ${docType === 'quote' ? 'un devis' : 'une commande'} : rien n’y a été livré`, async () => {
      origin = note({ doc_type: docType })
      await expect(loadForReturn('bl-1')).rejects.toThrow(RETURN_MESSAGES.notDeliveryNote)
    })
  }

  it('refuse un bon encore brouillon', async () => {
    origin = note({ status: 'draft', doc_number: null })
    await expect(loadForReturn('bl-1')).rejects.toThrow(RETURN_MESSAGES.draft)
  })

  it('refuse un bon annulé', async () => {
    origin = note({ status: 'cancelled' })
    await expect(loadForReturn('bl-1')).rejects.toThrow(RETURN_MESSAGES.cancelled)
  })
})

describe('le registre, sous les doigts du vendeur', () => {
  it('signale la ligne qui rend plus que le bon n’a livré', async () => {
    const source = await loadForReturn('bl-1')

    const asked = setQuantity(source.lines, 'v1', '12')
    expect(lineOverReturnable(asked[0]!, source.returnable)).toBe(true)
    expect(returnIsComplete(asked, source.returnable)).toBe(false)

    // Et la phrase dit le chiffre qu'on peut encore rendre.
    expect(RETURN_MESSAGES.overReturnable('10')).toContain('10')
  })

  it('laisse passer un retour partiel comme un retour total', async () => {
    const source = await loadForReturn('bl-1')

    expect(returnIsComplete(source.lines, source.returnable)).toBe(true)
    expect(returnIsComplete(setQuantity(source.lines, 'v1', '3'), source.returnable)).toBe(true)
  })

  it('refuse un retour vide, et une quantité vide ou nulle', async () => {
    const source = await loadForReturn('bl-1')

    expect(returnIsComplete([], source.returnable)).toBe(false)
    expect(returnIsComplete(setQuantity(source.lines, 'v1', ''), source.returnable)).toBe(false)
    expect(returnIsComplete(setQuantity(source.lines, 'v1', '0'), source.returnable)).toBe(false)
  })

  it('écrit un document de type return', () => {
    expect(RETURN_DOC_TYPE).toBe('return')
  })
})
