/*
 * Du document au ticket — E5-01, la part pure.
 *
 * Les écrans sont mesurés ailleurs (`DocumentScreens.test.tsx`,
 * `SaleScreen.test.tsx`). Ici, les deux conversions qu'aucun de ces écrans ne
 * traverse : le texte de champ d'une quantité décimale, et le refus
 * d'imprimer.
 */

import { describe, expect, it } from 'vitest'

import { canPrint, documentTicket, saleTicket, type TicketPrinter } from '@/modules/sales/printing'
import type { SaleLine } from '@/modules/sales/sale'
import type { DocumentDetail } from '@/modules/sales/documents'

const PRINTER: TicketPrinter = {
  setup: { host: '192.168.1.50', port: 9100, width: 576 },
  header: { businessName: 'Parfumerie Nour', phone: '+212612345678', address: 'Derb Omar' },
}

const line = (overrides: Partial<SaleLine> = {}): SaleLine => ({
  variantId: 'v1',
  productId: 'p1',
  name: 'Huile 5 L',
  reference: 'HUI-1',
  photoPath: null,
  quantity: '1',
  unitPrice: '12,00',
  priceSource: 'auto',
  overriddenPrice: null,
  breaks: [],
  floorPrice: null,
  ...overrides,
})

describe('canPrint()', () => {
  it('imprime un document vivant qui porte un numéro', () => {
    expect(canPrint({ docNumber: 'BL-A-26-00042', status: 'confirmed' })).toBe(true)
    expect(canPrint({ docNumber: 'BL-A-26-00042', status: 'delivered' })).toBe(true)
  })

  /* Un brouillon n'a rien à remettre ; un ticket d'annulé est une preuve fausse. */
  it('n’imprime ni un brouillon ni un document annulé', () => {
    expect(canPrint({ docNumber: null, status: 'draft' })).toBe(false)
    expect(canPrint({ docNumber: 'BL-A-26-00042', status: 'cancelled' })).toBe(false)
  })
})

describe('saleTicket()', () => {
  /*
   * L'écran de vente garde ses quantités et ses prix en **texte de champ** —
   * « 2,5 », « 12,00 » avec une virgule. Le ticket, lui, formate depuis la
   * forme de la base. Sans la conversion, la virgule du champ traverserait et
   * le papier porterait une quantité illisible.
   */
  it('convertit le texte de champ en texte de base', () => {
    const ticket = saleTicket(
      {
        docNumber: 'BL-A-26-00042',
        issuedAt: '2026-10-20T13:42:00.000Z',
        lines: [line({ quantity: '2,5', unitPrice: '12,40' })],
        total: '31.00',
      },
      PRINTER,
    )

    expect(ticket.lines).toEqual([
      { label: 'Huile 5 L', quantity: '2.500', unitPrice: '12.40', lineTotal: '31.00' },
    ])
    expect(ticket.number).toBe('BL-A-26-00042')
    expect(ticket.total).toBe('31.00')
    expect(ticket.businessName).toBe('Parfumerie Nour')
  })

  /* RÈGLE M3-7 : demi loin de zéro, au niveau de la ligne. */
  it('arrondit le total de ligne comme la base', () => {
    const ticket = saleTicket(
      {
        docNumber: 'BL-A-26-00042',
        issuedAt: '2026-10-20T13:42:00.000Z',
        // 2,5 × 9,99 = 24,975 → 24,98, demi loin de zéro.
        lines: [line({ quantity: '2,5', unitPrice: '9,99' })],
        total: '24.98',
      },
      PRINTER,
    )

    expect(ticket.lines[0]?.lineTotal).toBe('24.98')
  })
})

describe('documentTicket()', () => {
  it('reprend le document tel que la base le rend', () => {
    const detail: DocumentDetail = {
      document: {
        id: 'd-7',
        docType: 'delivery_note',
        docNumber: 'BL-A-26-00007',
        status: 'confirmed',
        subtotal: '228.00',
        discountTotal: '0.00',
        total: '228.00',
        notes: null,
        cancellationReason: null,
        issuedAt: '2026-10-06T08:00:00Z',
        createdAt: '2026-10-06T07:59:00Z',
        sortAt: '2026-10-06T08:00:00Z',
        sourceDocumentId: null,
        deviceId: 'dev-a',
        deviceLabel: 'Comptoir',
        devicePrefix: 'A',
        authorName: 'Fatima',
      },
      lines: [
        {
          id: 'l-1',
          name: 'Savon 500 g',
          code: 'SAV',
          quantity: '24.000',
          unitPrice: '9.50',
          lineDiscount: '0.00',
          lineTotal: '228.00',
        },
      ],
    }

    expect(documentTicket(detail, PRINTER)).toEqual({
      businessName: 'Parfumerie Nour',
      phone: '+212612345678',
      address: 'Derb Omar',
      number: 'BL-A-26-00007',
      issuedAt: '2026-10-06T08:00:00Z',
      clientName: '',
      lines: [
        { label: 'Savon 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' },
      ],
      total: '228.00',
    })
  })
})
