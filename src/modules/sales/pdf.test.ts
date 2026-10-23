/*
 * Du document au PDF — E5-03, la part pure.
 *
 * L'écran est mesuré dans `DocumentScreens.test.tsx`, les octets dans
 * `src/lib/printing/pdf.test.ts`, la mise en page dans `page.test.ts`. Ici, la
 * jonction : ce que la page reçoit du document et des réglages, et ce que le
 * partage reçoit d'elle.
 *
 * Le critère « généré localement, sans appel serveur » tient en partie ici :
 * `exportDocumentPdf()` ne lit que les réglages du commerce — la même lecture
 * que l'écran des paramètres — et n'envoie rien. Les octets sortent du canvas.
 */

import { describe, expect, it, vi } from 'vitest'

import type { PageDocument, PdfFile } from '@/lib/printing'
import type { DocumentDetail } from '@/modules/sales/documents'
import { canExportPdf, documentPage, exportDocumentPdf } from '@/modules/sales/pdf'

const header = { businessName: 'Parfumerie Nour', phone: '+212612345678', address: 'Derb Omar' }
const settings = vi.hoisted(() => ({ fails: false }))

vi.mock('@/modules/admin', () => ({
  loadSettings: () =>
    settings.fails
      ? Promise.reject(new Error('réglages illisibles'))
      : Promise.resolve({
          printHeader: {
            businessName: 'Parfumerie Nour',
            phone: '+212612345678',
            address: 'Derb Omar',
          },
          printerAddress: '',
          printerWidth: 576,
        }),
}))

function detail(overrides: Partial<DocumentDetail['document']> = {}): DocumentDetail {
  return {
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
      ...overrides,
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
}

describe('canExportPdf()', () => {
  it('exporte un document vivant qui porte un numéro', () => {
    expect(canExportPdf({ docNumber: 'BL-A-26-00042', status: 'confirmed' })).toBe(true)
    expect(canExportPdf({ docNumber: 'BL-A-26-00042', status: 'delivered' })).toBe(true)
  })

  /*
   * Même porte que le ticket, et la raison est plus forte ici : un papier se
   * perd, un fichier se transmet encore des mois après. Un PDF d'allure valable
   * pour une vente annulée est une preuve fausse qui circule.
   */
  it('n’exporte ni un brouillon ni un document annulé', () => {
    expect(canExportPdf({ docNumber: null, status: 'draft' })).toBe(false)
    expect(canExportPdf({ docNumber: 'BL-A-26-00042', status: 'cancelled' })).toBe(false)
  })
})

describe('documentPage()', () => {
  it('reprend le document tel que la base le rend, et l’en-tête des réglages', async () => {
    settings.fails = false

    expect(await documentPage(detail())).toEqual<PageDocument>({
      ...header,
      title: 'Bon de livraison',
      number: 'BL-A-26-00007',
      issuedAt: '2026-10-06T08:00:00Z',
      clientName: '',
      lines: [
        { label: 'Savon 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' },
      ],
      subtotal: '228.00',
      discountTotal: '0.00',
      total: '228.00',
      notes: '',
    })
  })

  it('titre la page du type du document : un devis n’est pas un bon', async () => {
    settings.fails = false
    const page = await documentPage(detail({ docType: 'quote', docNumber: 'DV-A-26-00007' }))

    expect([page.title, page.number]).toEqual(['Devis', 'DV-A-26-00007'])
  })

  /*
   * § 2.6 : un en-tête illisible n'empêche pas le partage. Il manquera le nom
   * du commerce en haut de la feuille, pas le bon — et `page.ts` n'imprime pas
   * la ligne d'une donnée vide.
   */
  it('part sans en-tête plutôt que de ne pas partir', async () => {
    settings.fails = true
    const page = await documentPage(detail())

    expect([page.businessName, page.phone, page.address]).toEqual(['', '', ''])
    expect(page.number).toBe('BL-A-26-00007')
  })
})

describe('exportDocumentPdf()', () => {
  it('nomme le fichier du numéro et de la date, et le remet au partage', async () => {
    settings.fails = false
    const shared: PdfFile[] = []

    const outcome = await exportDocumentPdf(detail(), {
      build: async () => new Uint8Array([37, 80, 68, 70]),
      sharing: {
        share: async (file) => {
          shared.push(file)
          return 'shared'
        },
      },
    })

    expect(outcome).toBe('shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]!.name).toBe('BL-A-26-00007-2026-10-06.pdf')
    expect([...shared[0]!.bytes]).toEqual([37, 80, 68, 70])
  })

  it('rend ce que le partage a fait, sans le réinterpréter', async () => {
    settings.fails = false

    for (const outcome of ['shared', 'downloaded', 'cancelled'] as const) {
      expect(
        await exportDocumentPdf(detail(), {
          build: async () => new Uint8Array(1),
          sharing: { share: async () => outcome },
        }),
      ).toBe(outcome)
    }
  })

  it('porte la page au générateur, pas le document', async () => {
    settings.fails = false
    let seen: PageDocument | null = null

    await exportDocumentPdf(detail({ notes: 'Livrer avant midi' }), {
      build: async (page) => {
        seen = page
        return new Uint8Array(1)
      },
      sharing: { share: async () => 'shared' },
    })

    expect(seen).not.toBeNull()
    expect(seen!.notes).toBe('Livrer avant midi')
  })
})
