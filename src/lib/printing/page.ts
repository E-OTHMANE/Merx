/*
 * La mise en page A4 du PDF. E5-03 — SPEC § 2.7, BRAND-UI § 6 et § 8.
 *
 * Même forme que `ticket.ts`, et pour la même raison : ce fichier ne dessine
 * rien, il rend la **liste des tracés**, page par page. Le dessin demande un
 * `canvas` que jsdom n'a pas ; la mise en page, elle, se vérifie entière —
 * l'ordre des lignes, la pagination, ce qui disparaît quand une donnée manque.
 *
 * **Pourquoi ce PDF est une image, et non du texte.** Dans un PDF, un texte est
 * une suite de codes de glyphes **déjà choisis** : le format n'a pas de moteur
 * de mise en forme. Produire de l'arabe en PDF texte demanderait de réordonner
 * le bidi, de choisir les formes contextuelles, d'appliquer la ligature
 * lam-alef, puis d'incorporer et sous-ensembler la police en CID — c'est-à-dire
 * de réécrire un moteur de façonnage. C'est exactement le piège qu'écarte la
 * RÈGLE de SPEC § 2.7 pour le ticket, et la réponse est la même : le navigateur
 * façonne, le PDF ne transporte que des points. Une seule voie de rendu pour le
 * français et pour l'arabe.
 *
 * **L'échelle, et c'est le critère en gras de la story.** « Lisible sur un
 * écran de téléphone sans zoomer » se dérive : A4 fait 595 points de large, un
 * téléphone montre ~390 px de viewport, donc une page ajustée à la largeur se
 * voit à 595/390 = 1,53. Pour qu'un corps apparaisse au plancher de BRAND-UI
 * § 6 — 16 px, « plancher absolu pour toute donnée » — il doit faire 24 points
 * sur la page. L'échelle de BRAND-UI est donc reprise **× 1,5**, arrondie :
 * 60 / 33 / 27 / 24 / 21 / 20. Aucune valeur inventée ici.
 *
 * **Deux conséquences de cette échelle, assumées.**
 *
 *   1. *La page est paginée.* À 24 points de corps, un A4 tient une vingtaine
 *      de rangs : un bon de quinze lignes fait deux pages. L'en-tête de colonne
 *      est répété, le total ne paraît qu'à la fin, et le pied porte « Page 1/2 ».
 *
 *   2. *Pas de tableau à quatre colonnes.* Désignation, quantité, prix unitaire
 *      et total à 24 points ne tiennent pas dans 523 points de largeur utile :
 *      les colonnes de montants en réclament 330, et il resterait 190 pour un
 *      nom de produit, soit quinze caractères. La page reprend donc la forme du
 *      ticket, qui est aussi celle des lignes de liste de BRAND-UI § 8 : le nom
 *      sur son rang, puis la quantité et le prix d'un côté, le total de l'autre.
 *      L'A4 lisible au téléphone a le budget de colonnes d'un ticket, pas celui
 *      d'une facture de bureau.
 *
 * La **référence** de l'article n'est pas imprimée, bien que `DocumentLine` la
 * porte : elle ajouterait un rang par ligne, donc un tiers de pages en plus sur
 * un fichier qui part par WhatsApp en 3G. Le ticket ne la porte pas non plus,
 * et le critère de la story ne liste aucun contenu.
 *
 * Les montants sont formatés par `moneyText()` depuis le **texte** stocké, et
 * jamais relus en nombre (SPEC § 4, RÈGLE des domaines nommés) — même décision
 * que le ticket, et c'est ici le papier qu'un client d'une autre ville reçoit.
 */

import { MONEY_SCALE, moneyText, parseDecimal, quantityText } from '@/lib/decimal'
import { formatDateTime } from '@/lib/dates'
import {
  TICKET_FONT_FAMILY,
  wrapText,
  type Measure,
  type TicketAlign,
  type TicketOp,
} from '@/lib/printing/ticket'

/** Le vocabulaire des tracés est celui du ticket : du texte et des filets. */
export type PageOp = TicketOp
export type PageAlign = TicketAlign

/** Une ligne du document, avec ses valeurs **telles que la base les rend**. */
export interface PageLine {
  label: string
  /** `numeric(12,3)` en texte, par ex. `"24.000"`. */
  quantity: string
  /** `numeric(12,2)` en texte, par ex. `"9.50"`. */
  unitPrice: string
  /** `numeric(12,2)` en texte. */
  lineTotal: string
}

/** Ce qui s'imprime sur la page. Tout est facultatif sauf le numéro (§ 2.6). */
export interface PageDocument {
  businessName: string
  phone: string
  address: string
  /** « Bon de livraison », « Devis » — le module Ventes le nomme. */
  title: string
  /** `BL-A-26-00042`. */
  number: string
  /** Horodatage ISO ; `null` si inconnu — la ligne disparaît alors. */
  issuedAt: string | null
  /** Vide quand la vente est au comptoir, sans client nommé. */
  clientName: string
  lines: PageLine[]
  /** `numeric(12,2)` en texte. */
  subtotal: string
  /** `numeric(12,2)` en texte. Une remise nulle ne s'imprime pas. */
  discountTotal: string
  /** `numeric(12,2)` en texte. */
  total: string
  /** La note libre du document. Vide : rien ne s'imprime. */
  notes: string
}

export interface PageOptions {
  measure: Measure
  /** `rtl` retourne les colonnes. Par défaut `ltr`. */
  direction?: 'ltr' | 'rtl'
}

/** Les pages, chacune une liste de tracés sur la même géométrie. */
export interface PdfPages {
  width: number
  height: number
  direction: 'ltr' | 'rtl'
  pages: PageOp[][]
}

/** A4 en points PDF (1/72 de pouce) : 210 × 297 mm. */
export const PAGE_WIDTH = 595
export const PAGE_HEIGHT = 842

/*
 * L'échelle de BRAND-UI § 6 × 1,5 — la dérivation est en tête de fichier.
 * `SIZE_NOTE` est le plancher de la page, et il ne porte que ce que BRAND-UI
 * met en « Mention » : l'adresse, l'horodatage, le pied de page.
 */
const SIZE_FIGURE = 60
const SIZE_TITLE = 33
const SIZE_SUBTITLE = 27
const SIZE_BODY = 24
const SIZE_LABEL = 21
const SIZE_NOTE = 20

/** Le plancher de corps de la page : rien ne s'imprime en dessous. */
export const MIN_PAGE_SIZE = SIZE_NOTE
/** Le corps des données — montants, quantités, désignations (BRAND-UI § 6). */
export const PAGE_BODY_SIZE = SIZE_BODY

/*
 * Base d'espacement de BRAND-UI § 7 (4 px) à la même échelle : 6 points. Toutes
 * les valeurs ci-dessous en sont des multiples.
 *
 * **La marge est à 24 et non à 36, et c'est la mesure qui l'a décidé.** À 36,
 * une page ne tenait que **quatre** lignes — un bon de cinq sortait sur deux
 * pages dont la seconde ne portait que le total, et pesait le double sur une
 * liaison 3G. À 24 (8,5 mm) il en tient cinq. Le support premier est un écran
 * de téléphone, pas une imprimante de bureau ; ce qu'une marge étroite risque
 * sur une vraie feuille est de rogner le pied de page, jamais une donnée.
 *
 * `LINE_GAP` sépare deux articles. Le ticket n'en met aucun — ses deux rangs
 * suffisent à grouper —, mais sur 523 points de large les rangs se confondent :
 * un cran d'espacement, pas deux.
 */
const MARGIN = 24
const GAP = 12
const LINE_GAP = 6
const RULE_HEIGHT = 2

export function pageFont(size: number, weight: 400 | 500 | 600): string {
  return `${weight} ${size}px ${TICKET_FONT_FAMILY}`
}

function lineHeight(size: number): number {
  return Math.round(size * 1.35)
}

interface Cursor {
  y: number
}

/** Ce qui ouvre une page : un en-tête ne se mesure pas, il commence. */
type Opening = (ops: PageOp[], cursor: Cursor) => void

/**
 * Un bloc insécable, qui connaît sa hauteur avant d'être tracé.
 *
 * C'est ce que la pagination manipule : elle doit savoir si le bloc tient
 * encore avant de le dessiner. Les en-têtes n'en sont pas — ils ne s'insèrent
 * jamais au milieu d'une page.
 */
interface Block {
  height: number
  draw: (ops: PageOp[], cursor: Cursor) => void
}

export function layoutDocumentPages(doc: PageDocument, options: PageOptions): PdfPages {
  const { measure } = options
  const direction = options.direction ?? 'ltr'
  const rtl = direction === 'rtl'

  const inner = PAGE_WIDTH - 2 * MARGIN
  /*
   * Les deux bords, retournés en RTL. Le canvas résout `textAlign: 'start'`
   * vers la droite quand sa direction est `rtl`, mais la coordonnée reste
   * absolue : c'est ici qu'elle se retourne, pas dans le moteur de texte.
   */
  const startX = rtl ? PAGE_WIDTH - MARGIN : MARGIN
  const endX = rtl ? MARGIN : PAGE_WIDTH - MARGIN
  const centerX = Math.round(PAGE_WIDTH / 2)

  const x = (align: PageAlign): number =>
    align === 'center' ? centerX : align === 'end' ? endX : startX

  const write = (
    ops: PageOp[],
    cursor: Cursor,
    text: string,
    size: number,
    weight: 400 | 500 | 600,
    align: PageAlign,
  ): void => {
    cursor.y += size
    ops.push({ kind: 'text', text, x: x(align), y: cursor.y, font: pageFont(size, weight), align })
    cursor.y += lineHeight(size) - size
  }

  /** Deux colonnes sur une même ligne de base : le rang n'avance qu'une fois. */
  const writePair = (
    ops: PageOp[],
    cursor: Cursor,
    left: { text: string; size: number; weight: 400 | 500 | 600 },
    right: { text: string; size: number; weight: 400 | 500 | 600 },
  ): void => {
    const size = Math.max(left.size, right.size)
    cursor.y += size
    ops.push({
      kind: 'text',
      text: left.text,
      x: startX,
      y: cursor.y,
      font: pageFont(left.size, left.weight),
      align: 'start',
    })
    ops.push({
      kind: 'text',
      text: right.text,
      x: endX,
      y: cursor.y,
      font: pageFont(right.size, right.weight),
      align: 'end',
    })
    cursor.y += lineHeight(size) - size
  }

  const rule = (ops: PageOp[], cursor: Cursor): void => {
    cursor.y += GAP
    ops.push({ kind: 'rule', x: MARGIN, y: cursor.y, width: inner, height: RULE_HEIGHT })
    cursor.y += RULE_HEIGHT + GAP
  }

  const ruleHeight = GAP + RULE_HEIGHT + GAP

  /* ---- L'en-tête de la première page ---- */

  const headerRows: Array<{ text: string; size: number; weight: 400 | 500 | 600 }> = []
  if (doc.businessName.trim() !== '') {
    headerRows.push({ text: doc.businessName.trim(), size: SIZE_TITLE, weight: 600 })
  }
  for (const detail of [doc.phone, doc.address]) {
    if (detail.trim() !== '') headerRows.push({ text: detail.trim(), size: SIZE_NOTE, weight: 400 })
  }

  const issued = formatDateTime(doc.issuedAt)
  const client = doc.clientName.trim()

  const firstHeader: Opening = (ops, cursor) => {
    for (const row of headerRows) write(ops, cursor, row.text, row.size, row.weight, 'center')
    rule(ops, cursor)

    /* Le type du document et son numéro : ce que le client cite au téléphone. */
    writePair(
      ops,
      cursor,
      { text: doc.title, size: SIZE_SUBTITLE, weight: 500 },
      { text: doc.number, size: SIZE_SUBTITLE, weight: 600 },
    )
    if (issued !== null) write(ops, cursor, issued, SIZE_NOTE, 400, 'start')
    if (client !== '') write(ops, cursor, `Client : ${client}`, SIZE_BODY, 400, 'start')

    rule(ops, cursor)
    columnHead(ops, cursor)
  }

  /* ---- L'en-tête d'une page de suite ---- */

  const nextHeader: Opening = (ops, cursor) => {
    writePair(
      ops,
      cursor,
      { text: doc.title, size: SIZE_SUBTITLE, weight: 500 },
      { text: doc.number, size: SIZE_SUBTITLE, weight: 600 },
    )
    rule(ops, cursor)
    columnHead(ops, cursor)
  }

  function columnHead(ops: PageOp[], cursor: Cursor): void {
    writePair(
      ops,
      cursor,
      { text: 'Désignation', size: SIZE_LABEL, weight: 500 },
      { text: 'Montant', size: SIZE_LABEL, weight: 500 },
    )
    ops.push({ kind: 'rule', x: MARGIN, y: cursor.y, width: inner, height: RULE_HEIGHT })
    cursor.y += RULE_HEIGHT + GAP
  }

  /* ---- Les lignes ---- */

  const labelFont = pageFont(SIZE_BODY, 400)

  const lineBlocks: Block[] = doc.lines.map((line): Block => {
    const rows = wrapText(line.label, labelFont, inner, measure)
    const detail = `${quantityText(line.quantity)} × ${moneyText(line.unitPrice)}`

    return {
      height: rows.length * lineHeight(SIZE_BODY) + lineHeight(SIZE_BODY) + LINE_GAP,
      draw: (ops, cursor) => {
        for (const row of rows) write(ops, cursor, row, SIZE_BODY, 400, 'start')
        /*
         * La quantité et le prix unitaire sont **des données**, donc au corps
         * courant : BRAND-UI § 6 en fait le « plancher absolu pour toute
         * donnée », et c'est le prix que le client vérifie en premier. Seules
         * les mentions — adresse, horodatage, pied de page — descendent à 20.
         */
        writePair(
          ops,
          cursor,
          { text: detail, size: SIZE_BODY, weight: 400 },
          { text: moneyText(line.lineTotal), size: SIZE_BODY, weight: 500 },
        )
        cursor.y += LINE_GAP
      },
    }
  })

  /* ---- La clôture : remise, total, note ---- */

  const discount = parseDecimal(doc.discountTotal, MONEY_SCALE)
  const discounted = discount !== null && discount !== 0n
  const noteText = doc.notes.trim()
  const noteRows = noteText === '' ? [] : wrapText(noteText, pageFont(SIZE_BODY, 400), inner, measure)

  const closing: Block = {
    height:
      ruleHeight +
      (discounted ? 2 * lineHeight(SIZE_SUBTITLE) : 0) +
      lineHeight(SIZE_FIGURE) +
      (noteRows.length === 0 ? 0 : GAP + lineHeight(SIZE_LABEL) + noteRows.length * lineHeight(SIZE_BODY)),
    draw: (ops, cursor) => {
      rule(ops, cursor)

      /*
       * Le sous-total et la remise ne paraissent que s'il y a une remise : sans
       * elle, ils répètent le total (§ 2.6, une donnée absente ne laisse pas de
       * trou).
       */
      if (discounted) {
        writePair(
          ops,
          cursor,
          { text: 'Sous-total', size: SIZE_BODY, weight: 400 },
          { text: moneyText(doc.subtotal), size: SIZE_SUBTITLE, weight: 500 },
        )
        writePair(
          ops,
          cursor,
          { text: 'Remise', size: SIZE_BODY, weight: 400 },
          { text: moneyText(doc.discountTotal), size: SIZE_SUBTITLE, weight: 500 },
        )
      }

      /* Le total. C'est le chiffre qui est le sujet (BRAND-UI § 6). */
      writePair(
        ops,
        cursor,
        { text: 'Total', size: SIZE_TITLE, weight: 600 },
        { text: moneyText(doc.total), size: SIZE_FIGURE, weight: 600 },
      )

      if (noteRows.length > 0) {
        cursor.y += GAP
        write(ops, cursor, 'Note', SIZE_LABEL, 500, 'start')
        for (const row of noteRows) write(ops, cursor, row, SIZE_BODY, 400, 'start')
      }
    },
  }

  /* ---- La pagination ---- */

  const footerHeight = lineHeight(SIZE_NOTE) + GAP
  const bottom = PAGE_HEIGHT - MARGIN - footerHeight

  const pages: PageOp[][] = []
  let ops: PageOp[] = []
  let cursor: Cursor = { y: MARGIN }

  const open = (header: Opening): void => {
    ops = []
    cursor = { y: MARGIN }
    header(ops, cursor)
  }

  open(firstHeader)

  for (const block of lineBlocks) {
    if (cursor.y + block.height > bottom) {
      pages.push(ops)
      open(nextHeader)
    }
    block.draw(ops, cursor)
  }

  /* Le total ne se sépare pas de son filet : il passe entier à la page suivante. */
  if (cursor.y + closing.height > bottom) {
    pages.push(ops)
    open(nextHeader)
  }
  closing.draw(ops, cursor)
  pages.push(ops)

  /*
   * Le pied se pose après coup : « Page 1/3 » demande de connaître 3, donc
   * d'avoir fini de paginer.
   */
  const footerY = PAGE_HEIGHT - MARGIN
  const footerFont = pageFont(SIZE_NOTE, 400)
  pages.forEach((pageOps, index) => {
    pageOps.push({
      kind: 'text',
      text: doc.number,
      x: startX,
      y: footerY,
      font: footerFont,
      align: 'start',
    })
    pageOps.push({
      kind: 'text',
      text: `Page ${index + 1}/${pages.length}`,
      x: endX,
      y: footerY,
      font: footerFont,
      align: 'end',
    })
  })

  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, direction, pages }
}

/**
 * Les polices que la page emploie, à charger avant de mesurer.
 *
 * Même raison que pour le ticket : une police absente au moment du tracé est
 * remplacée en silence par celle du système, qui n'a ni les mêmes largeurs ni,
 * sur une tablette bon marché, les formes contextuelles de l'arabe. La page
 * sortirait décalée sans que rien ne le dise. `page.test.ts` vérifie que tout
 * ce qu'une mise en page emploie figure bien dans cette liste.
 */
export const PAGE_FONT_SPECS = [
  pageFont(SIZE_NOTE, 400),
  pageFont(SIZE_LABEL, 500),
  pageFont(SIZE_BODY, 400),
  pageFont(SIZE_BODY, 500),
  pageFont(SIZE_SUBTITLE, 500),
  pageFont(SIZE_SUBTITLE, 600),
  pageFont(SIZE_TITLE, 600),
  pageFont(SIZE_FIGURE, 600),
]
