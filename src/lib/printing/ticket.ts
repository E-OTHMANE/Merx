/*
 * La mise en page du ticket 80 mm. E5-01 — SPEC § 8, BRAND-UI § 6.
 *
 * Le ticket n'est pas du texte qui coule : c'est une page de points dessinée à
 * la main, colonne par colonne. Ce fichier ne dessine pourtant rien — il rend
 * la **liste des tracés** et la hauteur qu'il faut au papier.
 *
 * Pourquoi cette séparation : le dessin demande un `canvas`, que jsdom n'a pas,
 * et la mise en page est tout ce qui peut se vérifier sans imprimante — l'ordre
 * des lignes, les colonnes, l'alignement des montants, ce qui s'affiche quand
 * une donnée manque. Ce que la liste des tracés ne prouve pas, c'est la liaison
 * des glyphes : elle appartient au moteur de texte, et elle se juge sur du
 * papier (E5-02).
 *
 * Les montants sont formatés par `moneyText()` depuis le **texte** stocké, et
 * jamais relus en nombre : un `numeric` passé par un `double` perd ses centimes
 * là où la RÈGLE des domaines nommés (SPEC § 4) interdit le flottant. C'est la
 * même décision qu'E4-07, un cran plus loin — ici, c'est le papier que le
 * client emporte.
 */

import { moneyText, quantityText } from '@/lib/decimal'
import { formatDateTime } from '@/lib/dates'

/** Une ligne du bon, avec ses valeurs **telles que la base les rend** (texte). */
export interface TicketLine {
  label: string
  /** `numeric(12,3)` en texte, par ex. `"24.000"`. */
  quantity: string
  /** `numeric(12,2)` en texte, par ex. `"9.50"`. */
  unitPrice: string
  /** `numeric(12,2)` en texte. */
  lineTotal: string
}

/** Ce qui s'imprime. Tout est facultatif sauf le numéro : SPEC § 2.6. */
export interface Ticket {
  businessName: string
  phone: string
  address: string
  /** `BL-A-26-00042`. */
  number: string
  /** Horodatage ISO ; `null` si inconnu — la ligne disparaît alors. */
  issuedAt: string | null
  /** Vide quand la vente est au comptoir, sans client nommé. */
  clientName: string
  lines: TicketLine[]
  /** Le total du document, en texte. */
  total: string
}

export type TicketAlign = 'start' | 'center' | 'end'

export type TicketOp =
  | { kind: 'text'; text: string; x: number; y: number; font: string; align: TicketAlign }
  /** Un filet horizontal : la seule « décoration », et elle sépare des colonnes. */
  | { kind: 'rule'; x: number; y: number; width: number; height: number }

export interface TicketLayout {
  width: number
  height: number
  direction: 'ltr' | 'rtl'
  ops: TicketOp[]
}

/** Mesure la largeur d'un texte dans une police donnée, en points. */
export type Measure = (text: string, font: string) => number

export interface LayoutOptions {
  /** La largeur de la tête, en points — `printer_width` (SPEC § 2.7). */
  width: number
  measure: Measure
  /** `rtl` retourne les colonnes. Le ticket arabe est E5-02 ; ici, par défaut. */
  direction?: 'ltr' | 'rtl'
}

/*
 * La famille est celle de BRAND-UI § 6, dans l'ordre qui compte : l'arabe
 * d'abord, parce que c'est elle qui porte les deux écritures. Elle doit être
 * **chargée** avant le premier tracé, sinon le navigateur dessine avec une
 * police de repli et le ticket change de largeur sans rien dire
 * (`renderTicket()` s'en charge).
 */
export const TICKET_FONT_FAMILY = '"IBM Plex Sans Arabic", "IBM Plex Sans", sans-serif'

/*
 * Les corps, en points d'imprimante — 203 points par pouce, donc 24 points
 * valent environ 3 mm de haut. En dessous de 21, un glyphe arabe perd ses
 * traits fins à cette résolution (recherche § 3) ; le corps courant est à 24,
 * ce qui est le plancher de BRAND-UI § 6 transposé au papier.
 */
const SIZE_TITLE = 34
const SIZE_BODY = 24
const SIZE_NOTE = 21
const SIZE_TOTAL = 34

const MARGIN = 8
const GAP = 10
const RULE_HEIGHT = 2

function font(size: number, weight: 400 | 500 | 600): string {
  return `${weight} ${size}px ${TICKET_FONT_FAMILY}`
}

function lineHeight(size: number): number {
  return Math.round(size * 1.35)
}

/**
 * Coupe un texte aux limites de la colonne, par mots, puis par caractères pour
 * un mot plus long que la colonne — un nom de produit sans espace ne doit pas
 * sortir du papier.
 */
export function wrapText(
  text: string,
  fontSpec: string,
  maxWidth: number,
  measure: Measure,
): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (measure(trimmed, fontSpec) <= maxWidth) return [trimmed]

  const lines: string[] = []
  let current = ''

  const push = (): void => {
    if (current !== '') lines.push(current)
    current = ''
  }

  for (const word of trimmed.split(/\s+/)) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (measure(candidate, fontSpec) <= maxWidth) {
      current = candidate
      continue
    }

    push()

    if (measure(word, fontSpec) <= maxWidth) {
      current = word
      continue
    }

    // Un mot plus large que la colonne : on le coupe au caractère.
    for (const letter of word) {
      if (current !== '' && measure(current + letter, fontSpec) > maxWidth) push()
      current += letter
    }
  }

  push()
  return lines
}

/**
 * La page du ticket : sa hauteur, et tout ce qu'il y a à tracer.
 *
 * Une donnée absente ne laisse pas de trou : sa ligne n'existe pas. C'est
 * SPEC § 2.6 appliqué au papier — un commerce qui n'a pas renseigné son
 * téléphone imprime un ticket sans téléphone, pas un ticket avec une étiquette
 * vide.
 */
export function layoutTicket(ticket: Ticket, options: LayoutOptions): TicketLayout {
  const { width, measure } = options
  const direction = options.direction ?? 'ltr'
  const inner = width - 2 * MARGIN
  const start = MARGIN
  const end = width - MARGIN
  const center = Math.round(width / 2)

  const ops: TicketOp[] = []
  let y = MARGIN

  const write = (text: string, fontSpec: string, align: TicketAlign, size: number): void => {
    const x = align === 'center' ? center : align === 'end' ? end : start
    y += size
    ops.push({ kind: 'text', text, x, y, font: fontSpec, align })
    y += lineHeight(size) - size
  }

  const rule = (): void => {
    y += GAP
    ops.push({ kind: 'rule', x: MARGIN, y, width: inner, height: RULE_HEIGHT })
    y += RULE_HEIGHT + GAP
  }

  /* L'en-tête du commerce — ce que le client lit en premier. */
  if (ticket.businessName.trim() !== '') {
    write(ticket.businessName.trim(), font(SIZE_TITLE, 600), 'center', SIZE_TITLE)
  }
  for (const detail of [ticket.phone, ticket.address]) {
    if (detail.trim() !== '') write(detail.trim(), font(SIZE_NOTE, 400), 'center', SIZE_NOTE)
  }

  rule()

  /* Le numéro et l'horodatage : la preuve que le client emporte. */
  write(ticket.number, font(SIZE_BODY, 600), 'start', SIZE_BODY)

  const issued = formatDateTime(ticket.issuedAt)
  if (issued !== null) write(issued, font(SIZE_NOTE, 400), 'start', SIZE_NOTE)

  if (ticket.clientName.trim() !== '') {
    write(`Client : ${ticket.clientName.trim()}`, font(SIZE_BODY, 400), 'start', SIZE_BODY)
  }

  rule()

  /*
   * Les lignes. Deux rangs par article : le nom sur toute la largeur, puis la
   * quantité et le prix à gauche, le total de la ligne à droite. Un seul rang
   * obligerait à tronquer le nom, qui est ce que le client vérifie.
   */
  const labelFont = font(SIZE_BODY, 400)
  const detailFont = font(SIZE_NOTE, 400)
  const amountFont = font(SIZE_BODY, 500)

  for (const line of ticket.lines) {
    for (const row of wrapText(line.label, labelFont, inner, measure)) {
      write(row, labelFont, 'start', SIZE_BODY)
    }

    const detail = `${quantityText(line.quantity)} × ${moneyText(line.unitPrice)}`

    /*
     * Les deux colonnes partagent une ligne de base : le détail avance `y`, le
     * total s'y raccroche sans l'avancer une seconde fois.
     */
    y += SIZE_BODY
    ops.push({ kind: 'text', text: detail, x: start, y, font: detailFont, align: 'start' })
    ops.push({
      kind: 'text',
      text: moneyText(line.lineTotal),
      x: end,
      y,
      font: amountFont,
      align: 'end',
    })
    y += lineHeight(SIZE_BODY) - SIZE_BODY
  }

  rule()

  /* Le total. C'est le chiffre qui est le sujet (BRAND-UI § 6). */
  const totalFont = font(SIZE_TOTAL, 600)
  y += SIZE_TOTAL
  ops.push({ kind: 'text', text: 'Total', x: start, y, font: totalFont, align: 'start' })
  ops.push({
    kind: 'text',
    text: moneyText(ticket.total),
    x: end,
    y,
    font: totalFont,
    align: 'end',
  })
  y += lineHeight(SIZE_TOTAL) - SIZE_TOTAL

  /*
   * La hauteur est arrondie au multiple de 8 supérieur : le papier avance de
   * toute façon avant la coupe, et un compte rond simplifie le découpage en
   * bandes.
   */
  const height = Math.ceil((y + MARGIN) / 8) * 8

  return { width, height, direction, ops }
}
