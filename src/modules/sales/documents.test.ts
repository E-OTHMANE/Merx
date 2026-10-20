/*
 * La liste et la consultation des documents — E4-07, côté appareil.
 *
 * Ce que le module envoie, et ce qu'il décide seul : les bornes de jour à
 * Casablanca, la page bornée, les trois liens de la chaîne, le motif de
 * l'annulation. Que la base borne au commerce, rende l'auteur à un employé ou
 * emprunte son index n'est mesuré qu'ici par la forme de l'appel —
 * `supabase/tests/sale-document-list.test.ts` l'éprouve sur la base réelle.
 *
 * ÉCRIT SANS STACK, ET SANS ÊTRE LANCÉ (docs/PENDING-CHECKS.md, « E4-07 »).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DOCUMENT_MESSAGES,
  LIST_LIMIT,
  canCancel,
  canReturn,
  canTransform,
  cancelDocument,
  listArguments,
  listSaleDocuments,
  loadDocument,
  type DocStatus,
} from '@/modules/sales'

interface Call {
  table: string
  columns: string
  payload?: unknown
  filters: Array<[string, string, unknown]>
}

interface Response {
  data: unknown
  error: { code?: string; message: string } | null
}

const calls: Call[] = []
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
const respond = vi.fn<(call: Call) => Response>()
const respondRpc = vi.fn<(name: string, args: Record<string, unknown>) => Response>()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, columns: '', filters: [] }
      const builder = {
        select: (columns: string) => {
          call.columns = columns
          return builder
        },
        update: (payload: unknown) => {
          call.payload = payload
          return builder
        },
        eq: (column: string, value: unknown) => {
          call.filters.push(['eq', column, value])
          return builder
        },
        order: () => builder,
        then: (resolve: (value: Response) => unknown, reject: (reason: unknown) => unknown) => {
          calls.push(call)
          return Promise.resolve(respond(call)).then(resolve, reject)
        },
      }
      return builder
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return Promise.resolve(respondRpc(name, args))
    },
  },
}))

beforeEach(() => {
  calls.length = 0
  rpcCalls.length = 0
  respond.mockReset()
  respondRpc.mockReset()
})

const summaryRow = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `d-${n}`,
  doc_type: 'delivery_note',
  doc_number: `BL-A-26-${String(n).padStart(5, '0')}`,
  status: 'confirmed',
  subtotal: '100.00',
  discount_total: '0.00',
  total: '100.00',
  notes: null,
  cancellation_reason: null,
  issued_at: '2026-10-06T08:00:00Z',
  created_at: '2026-10-06T07:59:00Z',
  sort_at: '2026-10-06T08:00:00Z',
  source_document_id: null,
  device_id: 'dev-a',
  device_label: 'Comptoir',
  device_prefix: 'A',
  author_name: 'Patron',
  ...overrides,
})

/* ========================================================================== */
/* Ce que la liste envoie                                                      */
/* ========================================================================== */

describe('listArguments', () => {
  it('ne demande rien là où rien n’est filtré', () => {
    expect(listArguments({}, 101)).toEqual({
      p_from: null,
      p_to: null,
      p_status: null,
      p_doc_type: null,
      p_device_id: null,
      p_search: null,
      p_limit: 101,
    })
  })

  it('traite une chaîne vide comme une absence de filtre', () => {
    const args = listArguments({ status: '', docType: '', deviceId: '', search: '   ', from: '' }, 10)

    expect(args.p_status).toBeNull()
    expect(args.p_doc_type).toBeNull()
    expect(args.p_device_id).toBeNull()
    expect(args.p_search).toBeNull()
    expect(args.p_from).toBeNull()
  })

  /*
   * Une journée de commerce se lit à Casablanca (SPEC § 4). Le 9 octobre 2026
   * est à +01:00 ; la borne haute est le début du 10, exclusive — « au 9 »
   * couvre donc toute la journée du 9.
   */
  it('borne les jours à Casablanca, haute exclusive', () => {
    const args = listArguments({ from: '2026-10-09', to: '2026-10-09' }, 10)

    expect(args.p_from).toBe('2026-10-09T00:00:00+01:00')
    expect(args.p_to).toBe('2026-10-10T00:00:00+01:00')
  })

  it('passe le numéro tapé tel quel, la base le normalise', () => {
    expect(listArguments({ search: ' bl-a-26-00042 ' }, 10).p_search).toBe('bl-a-26-00042')
  })
})

describe('listSaleDocuments', () => {
  it('appelle la fonction, pas la table', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })

    await listSaleDocuments({ status: 'cancelled' })

    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]!.name).toBe('list_sale_documents')
    expect(rpcCalls[0]!.args['p_status']).toBe('cancelled')
    expect(calls, 'la liste ne lit pas sale_document directement').toHaveLength(0)
  })

  it('demande une ligne de plus que la page pour savoir qu’elle est tronquée', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })

    await listSaleDocuments()

    expect(rpcCalls[0]!.args['p_limit']).toBe(LIST_LIMIT + 1)
  })

  it('rend la page entière, non tronquée, sous le plafond', async () => {
    respondRpc.mockReturnValue({
      data: Array.from({ length: LIST_LIMIT }, (_, n) => summaryRow(n + 1)),
      error: null,
    })

    const page = await listSaleDocuments()

    expect(page.documents).toHaveLength(LIST_LIMIT)
    expect(page.truncated).toBe(false)
  })

  it('coupe à la page et le dit quand la base avait davantage', async () => {
    respondRpc.mockReturnValue({
      data: Array.from({ length: LIST_LIMIT + 1 }, (_, n) => summaryRow(n + 1)),
      error: null,
    })

    const page = await listSaleDocuments()

    expect(page.documents).toHaveLength(LIST_LIMIT)
    expect(page.truncated).toBe(true)
    // Les plus récents d'abord : l'ordre est celui de la base, intact.
    expect(page.documents[0]!.id).toBe('d-1')
  })

  /*
   * Les montants arrivent en texte et n'en sortent pas : `list_sale_documents()`
   * les rend en `text` (SPEC § 4). Le passage par un nombre JSON, qui était le
   * premier jet de cette story, perdait les centimes de sa représentation —
   * `1250.50` relu en `double` puis remis en chaîne donne « 1250.5 », et c'est
   * le flottant que la RÈGLE interdit. Ce que la base dit est ce qui s'affiche.
   */
  it('porte les montants tels que la base les dit, centimes compris', async () => {
    respondRpc.mockReturnValue({
      data: [summaryRow(1, { subtotal: '1250.50', discount_total: '0.00', total: '1250.50' })],
      error: null,
    })

    const [document] = (await listSaleDocuments()).documents

    expect(document!.total).toBe('1250.50')
    expect(document!.subtotal).toBe('1250.50')
    expect(document!.discountTotal).toBe('0.00')
    expect(document!.authorName).toBe('Patron')
    expect(document!.deviceLabel).toBe('Comptoir')
  })

  it('porte l’erreur de la base telle quelle', async () => {
    respondRpc.mockReturnValue({
      data: null,
      error: { code: '42501', message: 'Ce compte ne peut pas consulter les documents de vente.' },
    })

    await expect(listSaleDocuments()).rejects.toThrow('consulter les documents de vente')
  })
})

/* ========================================================================== */
/* Le détail                                                                   */
/* ========================================================================== */

describe('loadDocument', () => {
  const lineRow = {
    id: 'l-1',
    quantity: '24.000',
    unit_price: '9.50',
    line_discount: '0.00',
    line_total: '228.00',
    variant: { sku: 'SAV-1', product: { name_fr: 'Savon 500 g', code: 'SAV' } },
  }

  it('lit l’en-tête par la fonction et les lignes sous RLS', async () => {
    respondRpc.mockReturnValue({ data: [summaryRow(7)], error: null })
    respond.mockReturnValue({ data: [lineRow], error: null })

    const detail = await loadDocument('d-7')

    expect(rpcCalls[0]).toEqual({
      name: 'list_sale_documents',
      args: { p_document_id: 'd-7', p_limit: 1 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.table).toBe('sale_line')
    expect(calls[0]!.filters).toContainEqual(['eq', 'sale_document_id', 'd-7'])
    // Les quantités et les montants des lignes voyagent en texte.
    expect(calls[0]!.columns).toContain('quantity::text')
    expect(calls[0]!.columns).toContain('line_total::text')

    expect(detail?.document.docNumber).toBe('BL-A-26-00007')
    expect(detail?.lines).toEqual([
      {
        id: 'l-1',
        name: 'Savon 500 g',
        code: 'SAV',
        quantity: '24.000',
        unitPrice: '9.50',
        lineDiscount: '0.00',
        lineTotal: '228.00',
      },
    ])
  })

  it('rend null quand la fonction ne rend rien : absent ou interdit se répondent pareil', async () => {
    respondRpc.mockReturnValue({ data: [], error: null })
    respond.mockReturnValue({ data: [], error: null })

    await expect(loadDocument('d-inconnu')).resolves.toBeNull()
  })
})

/* ========================================================================== */
/* Ce que le détail propose — la chaîne d'E4-05 et d'E4-06                     */
/* ========================================================================== */

describe('les actions du détail', () => {
  const STATUSES: DocStatus[] = ['draft', 'confirmed', 'delivered', 'cancelled']

  it.each([
    ['quote', 'confirmed', true],
    ['quote', 'delivered', true],
    ['order', 'confirmed', true],
    ['quote', 'draft', false],
    ['quote', 'cancelled', false],
    ['order', 'cancelled', false],
    // Un bon est la fin du cycle, et un retour n'est le début de rien.
    ['delivery_note', 'confirmed', false],
    ['return', 'confirmed', false],
  ] as const)('Transformer — %s %s : %s', (docType, status, expected) => {
    expect(canTransform({ docType, status })).toBe(expected)
  })

  it.each([
    ['delivery_note', 'confirmed', true],
    ['delivery_note', 'delivered', true],
    ['delivery_note', 'draft', false],
    ['delivery_note', 'cancelled', false],
    // Seul un bon se retourne : un devis ou une commande n'ont rien livré.
    ['quote', 'confirmed', false],
    ['order', 'confirmed', false],
    ['return', 'confirmed', false],
  ] as const)('Retour — %s %s : %s', (docType, status, expected) => {
    expect(canReturn({ docType, status })).toBe(expected)
  })

  it('l’annulation n’est offerte qu’à un document qui a vécu', () => {
    expect(STATUSES.filter((status) => canCancel({ status }))).toEqual(['confirmed', 'delivered'])
  })
})

/* ========================================================================== */
/* L'annulation                                                                */
/* ========================================================================== */

describe('cancelDocument', () => {
  it('refuse un motif vide avec la phrase de l’écran, sans appeler la base', async () => {
    await expect(cancelDocument('d-1', '   ')).rejects.toThrow(DOCUMENT_MESSAGES.reasonRequired)

    expect(calls).toHaveLength(0)
  })

  it('écrit le statut et le motif, rien d’autre', async () => {
    respond.mockReturnValue({ data: [{ id: 'd-1' }], error: null })

    await cancelDocument('d-1', '  Erreur de client  ')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.table).toBe('sale_document')
    expect(calls[0]!.payload).toEqual({
      status: 'cancelled',
      cancellation_reason: 'Erreur de client',
    })
    expect(calls[0]!.filters).toContainEqual(['eq', 'id', 'd-1'])
  })

  it('rend la phrase de la base quand c’est elle qui refuse', async () => {
    respond.mockReturnValue({
      data: null,
      error: {
        code: '42501',
        message: 'Annuler un document exige la capacité cancel_document.',
      },
    })

    // Exactement la phrase de la base : ce n'est pas celle de l'écran.
    await expect(cancelDocument('d-1', 'Erreur')).rejects.toThrow(
      /^Annuler un document exige la capacité cancel_document/,
    )
  })

  it('dit l’absence quand la RLS écarte la ligne sans rien lever', async () => {
    respond.mockReturnValue({ data: [], error: null })

    await expect(cancelDocument('d-voisin', 'Erreur')).rejects.toThrow(DOCUMENT_MESSAGES.notFound)
  })
})
