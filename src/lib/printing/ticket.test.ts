/*
 * La mise en page du ticket. E5-01 — critère 3 de la story (« contient : nom et
 * coordonnées du commerce, numéro du bon, date et heure, client, lignes avec
 * quantité et prix, total »).
 *
 * Le test lit la **liste des tracés**, pas des pixels : ce qui s'y vérifie est
 * ce qu'un œil vérifierait sur le papier — la présence de chaque donnée, les
 * colonnes, l'alignement des montants, et ce qui disparaît quand une donnée
 * manque. La liaison des glyphes et la netteté, elles, se jugent sur une vraie
 * imprimante (E5-02, docs/PENDING-CHECKS.md).
 *
 * La mesure est un doublon à largeur fixe par caractère : la mise en page doit
 * dépendre de ce que la police mesure, pas d'une police précise.
 */

import { describe, expect, it } from 'vitest'

import { layoutTicket, wrapText, type Measure, type Ticket, type TicketOp } from '@/lib/printing/ticket'

/** 12 points par caractère, quelle que soit la police. */
const measure: Measure = (text) => text.length * 12

const TICKET: Ticket = {
  businessName: 'Parfumerie Nour',
  phone: '+212612345678',
  address: 'Derb Omar, Casablanca',
  number: 'BL-A-26-00042',
  issuedAt: '2026-10-20T13:42:00.000Z',
  clientName: 'Hassan Alami',
  lines: [
    { label: 'Savon Tide 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' },
    { label: 'Crème Nivea 200 ml', quantity: '6.000', unitPrice: '42.00', lineTotal: '252.00' },
  ],
  total: '480.00',
}

function texts(ticket: Ticket, width = 576): string[] {
  return layoutTicket(ticket, { width, measure })
    .ops.filter((op): op is Extract<TicketOp, { kind: 'text' }> => op.kind === 'text')
    .map((op) => op.text)
}

function textOps(ticket: Ticket, width = 576): Extract<TicketOp, { kind: 'text' }>[] {
  return layoutTicket(ticket, { width, measure }).ops.filter(
    (op): op is Extract<TicketOp, { kind: 'text' }> => op.kind === 'text',
  )
}

describe('ce que le ticket contient', () => {
  it('porte les six données du critère, dans l’ordre du papier', () => {
    expect(texts(TICKET)).toEqual([
      'Parfumerie Nour',
      '+212612345678',
      'Derb Omar, Casablanca',
      'BL-A-26-00042',
      '20/10/2026 14:42',
      'Client : Hassan Alami',
      'Savon Tide 500 g',
      '24 × 9,50 DH',
      '228,00 DH',
      'Crème Nivea 200 ml',
      '6 × 42,00 DH',
      '252,00 DH',
      'Total',
      '480,00 DH',
    ])
  })

  /*
   * Les montants sont formatés depuis le **texte** stocké, par le seul
   * `moneyText()` : virgule décimale, espace insécable des milliers, `DH`
   * après le montant (BRAND-UI § 6). Un passage par `Number` donnerait
   * « 12345678.95 DH » — et sur une autre valeur, des centimes en moins.
   * C'est la RÈGLE des domaines nommés jusque sur le papier (SPEC § 4).
   */
  it('imprime les montants en dirhams groupés, depuis le texte stocké', () => {
    const printed = texts({
      ...TICKET,
      lines: [
        {
          label: 'Lot complet',
          quantity: '1.000',
          unitPrice: '12345678.95',
          lineTotal: '12345678.95',
        },
      ],
      total: '12345678.95',
    })

    expect(printed).toContain('1 × 12 345 678,95 DH')
    expect(printed).toContain('12 345 678,95 DH')
    // L'espace est insécable aux deux places : un montant ne se coupe pas.
    expect(printed.at(-1)).toBe('12 345 678,95 DH')
  })

  it('imprime les quantités sans décimales inutiles', () => {
    const printed = texts({
      ...TICKET,
      lines: [{ label: 'Vrac', quantity: '2.500', unitPrice: '4.00', lineTotal: '10.00' }],
    })

    expect(printed).toContain('2,5 × 4,00 DH')
  })
})

describe('ce qui manque ne laisse pas de trou', () => {
  /* SPEC § 2.6 : une donnée absente désactive sa ligne, elle ne la vide pas. */
  it('imprime un ticket sans en-tête quand le commerce n’a rien renseigné', () => {
    const printed = texts({ ...TICKET, businessName: '', phone: '', address: '' })

    expect(printed[0]).toBe('BL-A-26-00042')
    expect(printed).not.toContain('')
  })

  it('n’écrit pas « Client » pour une vente au comptoir', () => {
    const printed = texts({ ...TICKET, clientName: '' })

    expect(printed.some((text) => text.startsWith('Client'))).toBe(false)
  })

  it('n’écrit pas de date quand l’horodatage est inconnu', () => {
    const printed = texts({ ...TICKET, issuedAt: null })

    expect(printed).not.toContain('20/10/2026 14:42')
    expect(printed).toContain('BL-A-26-00042')
  })

  it('imprime un bon sans ligne — numéro, date et total', () => {
    const printed = texts({ ...TICKET, lines: [], total: '0.00' })

    expect(printed).toEqual([
      'Parfumerie Nour',
      '+212612345678',
      'Derb Omar, Casablanca',
      'BL-A-26-00042',
      '20/10/2026 14:42',
      'Client : Hassan Alami',
      'Total',
      '0,00 DH',
    ])
  })
})

describe('les colonnes', () => {
  /*
   * Le montant est à droite, le détail à gauche, **sur la même ligne de base**.
   * Deux lignes de base, et la colonne des montants glisse d'un rang : le
   * ticket devient illisible à mesure qu'il s'allonge.
   */
  it('aligne le total de ligne à droite, sur la ligne du détail', () => {
    const ops = textOps(TICKET)
    const detail = ops.find((op) => op.text === '24 × 9,50 DH')
    const amount = ops.find((op) => op.text === '228,00 DH')

    expect(detail?.align).toBe('start')
    expect(amount?.align).toBe('end')
    expect(amount?.y).toBe(detail?.y)
    expect(detail?.x).toBe(8)
    expect(amount?.x).toBe(576 - 8)
  })

  it('centre l’en-tête du commerce', () => {
    const ops = textOps(TICKET)
    const name = ops.find((op) => op.text === 'Parfumerie Nour')

    expect(name?.align).toBe('center')
    expect(name?.x).toBe(288)
  })

  it('suit la largeur de la tête', () => {
    const ops = textOps(TICKET, 384)
    const amount = ops.find((op) => op.text === '228,00 DH')

    expect(amount?.x).toBe(384 - 8)
    expect(layoutTicket(TICKET, { width: 384, measure }).width).toBe(384)
  })

  it('sépare les blocs par des filets, et rien d’autre', () => {
    const { ops } = layoutTicket(TICKET, { width: 576, measure })
    const rules = ops.filter((op) => op.kind === 'rule')

    expect(rules.length).toBe(3)
    for (const rule of rules) {
      expect(rule.kind === 'rule' && rule.width).toBe(560)
    }
  })

  it('descend sans jamais remonter', () => {
    const { ops, height } = layoutTicket(TICKET, { width: 576, measure })
    let last = 0
    for (const op of ops) {
      expect(op.y).toBeGreaterThanOrEqual(last)
      last = op.y
    }
    expect(height).toBeGreaterThan(last)
  })

  /* Une bande `GS v 0` compte des lignes entières. */
  it('rend une hauteur multiple de 8, qui croît avec les lignes', () => {
    const short = layoutTicket({ ...TICKET, lines: [] }, { width: 576, measure })
    const long = layoutTicket(TICKET, { width: 576, measure })

    expect(short.height % 8).toBe(0)
    expect(long.height % 8).toBe(0)
    expect(long.height).toBeGreaterThan(short.height)
  })
})

describe('le nom qui dépasse', () => {
  /*
   * Un nom de produit est ce que le client vérifie : il se replie sur
   * plusieurs rangs, il ne se tronque pas.
   */
  it('replie un nom trop long sur plusieurs rangs', () => {
    const label = 'Savon de Marseille extra pur 72 % huile d’olive 500 grammes'
    const printed = texts({
      ...TICKET,
      lines: [{ label, quantity: '1.000', unitPrice: '9.50', lineTotal: '9.50' }],
    })

    const rows = printed.filter((text) => label.includes(text))
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.join(' ')).toBe(label)
    for (const row of rows) {
      expect(measure(row, ''), row).toBeLessThanOrEqual(560)
    }
  })

  it('coupe au caractère un mot plus large que la colonne', () => {
    const rows = wrapText('X'.repeat(100), '', 120, measure)

    expect(rows.length).toBe(10)
    expect(rows.join('')).toBe('X'.repeat(100))
  })

  it('ne rend aucun rang pour un libellé vide', () => {
    expect(wrapText('   ', '', 120, measure)).toEqual([])
  })
})
