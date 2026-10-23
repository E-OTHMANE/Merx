/*
 * La mise en page A4. E5-03 — critères 1, 2 et 5 de la story.
 *
 * Même principe qu'`E5-01` : le test lit la **liste des tracés**, pas des
 * pixels. Ce qu'il vérifie est ce qu'un œil vérifierait sur la feuille — chaque
 * donnée, la pagination, ce qui disparaît quand une donnée manque — et il
 * vérifie en plus une chose que l'œil fait mal : que **rien ne descend sous le
 * plancher de corps**, c'est-à-dire le critère « lisible sur un écran de
 * téléphone sans zoomer », rendu mesurable.
 *
 * La mesure est un doublon à largeur fixe par caractère : la mise en page doit
 * dépendre de ce que la police mesure, pas d'une police précise.
 */

import { describe, expect, it } from 'vitest'

import {
  MIN_PAGE_SIZE,
  PAGE_BODY_SIZE,
  PAGE_FONT_SPECS,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  layoutDocumentPages,
  type PageDocument,
  type PageLine,
  type PageOp,
} from '@/lib/printing/page'
import type { Measure } from '@/lib/printing/ticket'

/** 12 points par caractère, quelle que soit la police. */
const measure: Measure = (text) => text.length * 12

const DOC: PageDocument = {
  businessName: 'Parfumerie Nour',
  phone: '+212612345678',
  address: 'Derb Omar, Casablanca',
  title: 'Bon de livraison',
  number: 'BL-A-26-00042',
  issuedAt: '2026-10-20T13:42:00.000Z',
  clientName: '',
  lines: [
    { label: 'Savon Tide 500 g', quantity: '24.000', unitPrice: '9.50', lineTotal: '228.00' },
    { label: 'Crème Nivea 200 ml', quantity: '6.000', unitPrice: '42.00', lineTotal: '252.00' },
  ],
  subtotal: '480.00',
  discountTotal: '0.00',
  total: '480.00',
  notes: '',
}

type TextOp = Extract<PageOp, { kind: 'text' }>

const isText = (op: PageOp): op is TextOp => op.kind === 'text'

/*
 * Les montants portent des espaces **insécables** (BRAND-UI § 6, `moneyText()`)
 * — aux milliers et devant `DH`. Les écrire ici à la main serait illisible et
 * faux une fois sur deux.
 */
const NBSP = ' '
const dh = (amount: string): string => `${amount.replace(/ /g, NBSP)}${NBSP}DH`

function layout(doc: PageDocument, direction?: 'ltr' | 'rtl') {
  return layoutDocumentPages(doc, {
    measure,
    ...(direction === undefined ? {} : { direction }),
  })
}

/** Les textes d'une page, dans l'ordre du tracé. */
function texts(doc: PageDocument, page = 0): string[] {
  return (layout(doc).pages[page] ?? []).filter(isText).map((op) => op.text)
}

function allTexts(doc: PageDocument): string[] {
  return layout(doc).pages.flatMap((ops) => ops.filter(isText).map((op) => op.text))
}

function sizeOf(op: TextOp): number {
  return Number(/(\d+)px/.exec(op.font)?.[1] ?? 0)
}

/** Une ligne de plus, pour remplir des pages. */
function line(n: number): PageLine {
  return { label: `Article ${n}`, quantity: '2.000', unitPrice: '10.00', lineTotal: '20.00' }
}

function withLines(count: number): PageDocument {
  const lines = Array.from({ length: count }, (_, index) => line(index + 1))
  return { ...DOC, lines, subtotal: '0.00', total: `${count * 20}.00` }
}

describe('ce que la page contient', () => {
  it('porte l’en-tête, le document, ses lignes et son total, dans l’ordre de la feuille', () => {
    expect(texts(DOC)).toEqual([
      'Parfumerie Nour',
      '+212612345678',
      'Derb Omar, Casablanca',
      'Bon de livraison',
      'BL-A-26-00042',
      '20/10/2026 14:42',
      'Désignation',
      'Montant',
      'Savon Tide 500 g',
      `24 × ${dh('9,50')}`,
      dh('228,00'),
      'Crème Nivea 200 ml',
      `6 × ${dh('42,00')}`,
      dh('252,00'),
      'Total',
      dh('480,00'),
      'BL-A-26-00042',
      'Page 1/1',
    ])
  })

  /*
   * La règle des domaines nommés, SPEC § 4, prise sur le papier qu'un client
   * d'une autre ville reçoit : les montants viennent du **texte** stocké, par
   * `moneyText()`, et jamais d'un `Number`. `0.1 + 0.2` ne doit pas pouvoir
   * entrer dans un document commercial.
   */
  it('imprime les montants en dirhams groupés, depuis le texte stocké', () => {
    const big = {
      ...DOC,
      lines: [
        { label: 'Sac de ciment', quantity: '150.000', unitPrice: '78.35', lineTotal: '11752.50' },
      ],
      subtotal: '11752.50',
      total: '11752.50',
    }

    expect(allTexts(big)).toContain(`150 × ${dh('78,35')}`)
    expect(allTexts(big)).toContain(dh('11 752,50'))
  })

  it('n’imprime pas la ligne d’une donnée absente', () => {
    const bare: PageDocument = {
      ...DOC,
      businessName: '',
      phone: '',
      address: '',
      issuedAt: null,
      notes: '',
    }

    expect(texts(bare)).toEqual([
      'Bon de livraison',
      'BL-A-26-00042',
      'Désignation',
      'Montant',
      'Savon Tide 500 g',
      `24 × ${dh('9,50')}`,
      dh('228,00'),
      'Crème Nivea 200 ml',
      `6 × ${dh('42,00')}`,
      dh('252,00'),
      'Total',
      dh('480,00'),
      'BL-A-26-00042',
      'Page 1/1',
    ])
  })

  it('imprime le client quand il y en a un', () => {
    expect(texts({ ...DOC, clientName: 'Hassan Alami' })).toContain('Client : Hassan Alami')
  })

  it('imprime la note du document quand elle est remplie', () => {
    expect(texts({ ...DOC, notes: 'Livraison au dépôt de Derb Ghallef' })).toEqual(
      expect.arrayContaining(['Note', 'Livraison au dépôt de Derb Ghallef']),
    )
  })

  /*
   * Sans remise, le sous-total répète le total : deux lignes qui disent la même
   * chose sur un papier qu'on lit debout (§ 2.6).
   */
  it('ne montre le sous-total et la remise que s’il y a une remise', () => {
    expect(texts(DOC)).not.toContain('Sous-total')

    const discounted = { ...DOC, subtotal: '480.00', discountTotal: '30.00', total: '450.00' }
    expect(texts(discounted)).toEqual(
      expect.arrayContaining(['Sous-total', dh('480,00'), 'Remise', dh('30,00'), dh('450,00')]),
    )
  })

  it('titre le document de son type : un devis n’est pas un bon', () => {
    expect(texts({ ...DOC, title: 'Devis', number: 'DV-A-26-00007' })).toEqual(
      expect.arrayContaining(['Devis', 'DV-A-26-00007']),
    )
  })
})

describe('lisible sur un écran de téléphone sans zoomer', () => {
  /*
   * La forme mesurable du critère en gras. A4 ajusté à la largeur d'un
   * téléphone se voit à 595/390 ≈ 1,5 : un corps de 24 points y paraît au
   * plancher de 16 px de BRAND-UI § 6. Un corps de 12 points — la taille
   * ordinaire d'un document de bureau — y paraîtrait à 8 px.
   */
  it('ne descend jamais sous le plancher de corps', () => {
    const ops = layout(withLines(40)).pages.flatMap((page) => page.filter(isText))
    expect(ops.length).toBeGreaterThan(40)

    for (const op of ops) {
      expect(sizeOf(op), `« ${op.text} » est trop petit`).toBeGreaterThanOrEqual(MIN_PAGE_SIZE)
    }
  })

  it('porte les données au corps courant, et le total au-dessus', () => {
    const ops = layout(DOC).pages[0]!.filter(isText)
    const amounts = ops.filter((op) => op.text.endsWith('DH'))

    for (const amount of amounts) {
      expect(sizeOf(amount), amount.text).toBeGreaterThanOrEqual(PAGE_BODY_SIZE)
    }

    const total = ops.find((op) => op.text === dh('480,00'))!
    const lineTotal = ops.find((op) => op.text === dh('228,00'))!
    expect(sizeOf(total)).toBeGreaterThan(sizeOf(lineTotal))
  })

  /*
   * Une police absente au moment du tracé est remplacée en silence par celle du
   * système : la page sort décalée sans que rien ne le dise. La liste de
   * préchargement doit donc couvrir ce que la mise en page emploie.
   */
  it('n’emploie aucune police que le rendu ne précharge', () => {
    const used = new Set(
      layout({ ...withLines(30), discountTotal: '30.00', notes: 'Une note' })
        .pages.flatMap((page) => page.filter(isText))
        .map((op) => op.font),
    )

    expect([...used].sort()).toEqual(
      [...used].filter((font) => PAGE_FONT_SPECS.includes(font)).sort(),
    )
  })
})

describe('la pagination', () => {
  it('tient un petit bon sur une seule page', () => {
    expect(layout(DOC).pages).toHaveLength(1)
  })

  it('passe à la page suivante et répète le type, le numéro et les colonnes', () => {
    const many = layout(withLines(40))
    expect(many.pages.length).toBeGreaterThan(1)

    for (const [index, ops] of many.pages.entries()) {
      const page = ops.filter(isText).map((op) => op.text)
      expect(page, `page ${index + 1}`).toEqual(
        expect.arrayContaining(['Bon de livraison', 'BL-A-26-00042', 'Désignation', 'Montant']),
      )
    }
  })

  it('ne répète l’en-tête du commerce que sur la première page', () => {
    const many = layout(withLines(40))
    const others = many.pages.slice(1).flatMap((ops) => ops.filter(isText).map((op) => op.text))

    expect(texts(withLines(40))).toContain('Parfumerie Nour')
    expect(others).not.toContain('Parfumerie Nour')
  })

  it('ne porte le total que sur la dernière page', () => {
    const many = layout(withLines(40))
    const pages = many.pages.map((ops) => ops.filter(isText).map((op) => op.text))

    expect(pages.filter((page) => page.includes('Total'))).toHaveLength(1)
    expect(pages.at(-1)).toContain('Total')
  })

  it('numérote les pages, et dit combien il y en a', () => {
    const many = layout(withLines(40))
    const count = many.pages.length

    many.pages.forEach((ops, index) => {
      expect(ops.filter(isText).map((op) => op.text)).toContain(`Page ${index + 1}/${count}`)
    })
  })

  /* Un tracé hors de la feuille ne se voit pas : il disparaît, simplement. */
  it('ne trace rien au-delà de la feuille', () => {
    for (const ops of layout(withLines(40)).pages) {
      for (const op of ops) {
        expect(op.y).toBeGreaterThan(0)
        expect(op.y).toBeLessThanOrEqual(PAGE_HEIGHT)
        expect(op.x).toBeGreaterThanOrEqual(0)
        expect(op.x).toBeLessThanOrEqual(PAGE_WIDTH)
      }
    }
  })

  /*
   * La largeur utile est lue sur les filets, qui la portent : l'assertion ne
   * répète donc pas la marge du fichier mesuré — elle la lui demande.
   */
  it('coupe un nom plus long que la feuille au lieu d’en sortir', () => {
    const long = {
      ...DOC,
      lines: [
        { ...line(1), label: 'Lessive en poudre parfum lavande grand format économique 5 kg' },
      ],
    }

    const ops = layout(long).pages[0]!
    const inner = ops.find((op): op is Extract<PageOp, { kind: 'rule' }> => op.kind === 'rule')!.width

    /* Le nom ne tient pas sur un rang : il en occupe plusieurs. */
    expect(ops.filter(isText).length).toBeGreaterThan(texts(DOC).length - 3)

    for (const op of ops.filter(isText)) {
      expect(measure(op.text, op.font), `« ${op.text} » dépasse la colonne`).toBeLessThanOrEqual(
        inner,
      )
    }
  })
})

describe('le sens de lecture', () => {
  it('garde la géométrie de la feuille, quel que soit le sens', () => {
    const page = layout(DOC)
    expect([page.width, page.height]).toEqual([PAGE_WIDTH, PAGE_HEIGHT])
    expect(page.direction).toBe('ltr')
    expect(layout(DOC, 'rtl').direction).toBe('rtl')
  })

  /*
   * En RTL, le canvas résout `textAlign: 'start'` vers la droite, mais la
   * coordonnée reste absolue : c'est la mise en page qui doit la retourner.
   * Sans cela le numéro et les montants se superposeraient au milieu.
   */
  it('retourne les colonnes en arabe', () => {
    const ltr = layout(DOC).pages[0]!.filter(isText)
    const rtl = layout(DOC, 'rtl').pages[0]!.filter(isText)

    const amountLtr = ltr.find((op) => op.text === dh('228,00'))!
    const amountRtl = rtl.find((op) => op.text === dh('228,00'))!
    const labelLtr = ltr.find((op) => op.text === 'Savon Tide 500 g')!
    const labelRtl = rtl.find((op) => op.text === 'Savon Tide 500 g')!

    expect(amountLtr.x).toBeGreaterThan(labelLtr.x)
    expect(amountRtl.x).toBeLessThan(labelRtl.x)
  })
})
