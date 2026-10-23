/*
 * Le dessin du ticket, et le seul endroit qui touche au DOM. E5-01.
 *
 * C'est ici que le navigateur fait le travail difficile : il lie les lettres
 * arabes, applique le sens droite-à-gauche et place les chiffres latins dans
 * une phrase arabe. L'imprimante ne verra que des points
 * (docs/research/E5-02-arabe-thermique.md § 3).
 *
 * Et c'est le seul fichier du module que jsdom ne peut pas exécuter : il n'a
 * pas de contexte 2D. Tout ce qui se vérifie sans imprimante est donc ailleurs
 * — `ticket.ts` pour la mise en page, `raster.ts` pour le seuillage,
 * `escpos.ts` pour les octets. Ce qui reste ici se juge sur du papier.
 */

import type { Raster } from '@/lib/printing/escpos'
import {
  PAGE_FONT_SPECS,
  layoutDocumentPages,
  type PageDocument,
} from '@/lib/printing/page'
import { grayscale, rasterize, type Gray } from '@/lib/printing/raster'
import {
  TICKET_FONT_FAMILY,
  layoutTicket,
  type Ticket,
  type TicketLayout,
} from '@/lib/printing/ticket'

/**
 * Les polices à charger avant de mesurer quoi que ce soit.
 *
 * `document.fonts.load()` n'est pas une précaution : une police absente au
 * moment du tracé est remplacée en silence par celle du système, qui n'a ni les
 * mêmes largeurs ni, sur une tablette bon marché, les formes contextuelles de
 * l'arabe. Le ticket sortirait décalé, et rien ne le dirait.
 */
export const TICKET_FONT_SPECS = [
  `400 21px ${TICKET_FONT_FAMILY}`,
  `400 24px ${TICKET_FONT_FAMILY}`,
  `500 24px ${TICKET_FONT_FAMILY}`,
  `600 24px ${TICKET_FONT_FAMILY}`,
  `600 34px ${TICKET_FONT_FAMILY}`,
]

/** Charge des polices. Les erreurs ne bloquent pas : on dessine. */
export async function loadFonts(
  specs: readonly string[],
  fonts: FontFaceSet = document.fonts,
): Promise<void> {
  await Promise.all(specs.map((spec) => fonts.load(spec).catch(() => undefined)))
}

/** Charge les polices du ticket. */
export async function loadTicketFonts(fonts: FontFaceSet = document.fonts): Promise<void> {
  await loadFonts(TICKET_FONT_SPECS, fonts)
}

/**
 * Trace la page : papier blanc d'abord, encre noire ensuite.
 *
 * Le fond est rempli explicitement parce qu'un canvas neuf est **transparent**,
 * et qu'un point transparent n'a pas de luminance : sans ce remplissage, tout
 * le ticket basculerait du mauvais côté du seuil. Voir `raster.ts`, qui compose
 * sur blanc pour la même raison — deux gardes pour un rouleau de papier.
 */
export function paint(context: CanvasRenderingContext2D, layout: TicketLayout): void {
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, layout.width, layout.height)

  context.fillStyle = '#000000'
  context.direction = layout.direction
  context.textBaseline = 'alphabetic'

  for (const op of layout.ops) {
    if (op.kind === 'rule') {
      context.fillRect(op.x, op.y, op.width, op.height)
      continue
    }

    context.font = op.font
    context.textAlign = op.align
    context.fillText(op.text, op.x, op.y)
  }
}

/**
 * Le ticket en points, prêt pour `GS v 0`.
 *
 * Deux temps, et le premier est la raison du second : il faut mesurer les
 * textes pour connaître la hauteur du papier, et il faut un contexte pour
 * mesurer. Le canvas est donc créé à la largeur de la tête, haut d'un point, le
 * temps de la mise en page ; lui donner sa hauteur réinitialise le contexte, ce
 * qui est sans conséquence puisque `paint()` repose tout ce dont il a besoin.
 */
export async function renderTicket(ticket: Ticket, width: number): Promise<Raster> {
  await loadTicketFonts()

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = 1

  const measuring = canvas.getContext('2d')
  if (measuring === null) throw new Error("Ce navigateur ne sait pas dessiner le ticket.")

  const layout = layoutTicket(ticket, {
    width,
    measure: (text, font) => {
      measuring.font = font
      return measuring.measureText(text).width
    },
  })

  canvas.height = layout.height

  const context = canvas.getContext('2d')
  if (context === null) throw new Error("Ce navigateur ne sait pas dessiner le ticket.")

  paint(context, layout)

  return rasterize(context.getImageData(0, 0, layout.width, layout.height))
}

/*
 * ---- Le PDF A4 (E5-03) ----
 *
 * Même voie que le ticket, et c'est tout l'intérêt : le navigateur façonne
 * l'arabe, le PDF ne transporte que des points (`page.ts`, en tête).
 */

/**
 * Le facteur entre le point PDF et le point de l'image.
 *
 * **2, et c'est la densité de l'écran qui le dit, pas une habitude.** Un
 * téléphone ordinaire montre 390 px de viewport à une densité de 3, soit
 * ~1 170 points physiques en travers ; une tablette d'entrée de gamme en a
 * 1 200. A4 rendu à 2 fait 1 190 points de large : l'image arrive donc à
 * l'écran à peu près point pour point, et pas une goutte d'encre de plus. À
 * 1,5 (893 points) elle est agrandie d'un tiers, et un corps de 24 points perd
 * son anticrénelage là où il sert ; à 3 le fichier double sans que rien ne se
 * voie, puisque l'écran redescend l'image.
 *
 * **Mesuré** le 2026-10-23 par `npm run pdf:measure` — un bon de 5 lignes
 * (une page) et de 10 lignes (deux pages), en français et en arabe :
 *
 * | facteur | une page | deux pages |
 * |---|---|---|
 * | 1   | 27,6 Ko | 48,7 Ko |
 * | 1,5 | 47,8 Ko | 83,7 Ko |
 * | **2** | **70,7 Ko** | **125,0 Ko** |
 * | 3   | 118,0 Ko | 207,9 Ko |
 *
 * Le PDF part par WhatsApp, souvent en 3G : 71 Ko pour un bon d'une page est
 * le prix de la netteté, et il reste loin du plafond de 300 Ko que la story
 * s'est donné. L'arabe ne coûte rien de plus (66,4 Ko) — les glyphes liés
 * portent moins d'encre que le français, pas davantage.
 */
export const PAGE_SCALE = 2

export interface RenderPagesOptions {
  direction?: 'ltr' | 'rtl'
  /** Pour mesurer : le facteur d'échelle. Par défaut `PAGE_SCALE`. */
  scale?: number
}

/**
 * Les pages du document en niveaux de gris, prêtes pour `buildPdf()`.
 *
 * Deux contextes, et la raison est la même que pour le ticket : il faut mesurer
 * les textes **en points** pour paginer, et peindre **en points d'image** pour
 * que les glyphes sortent nets. Le premier canvas mesure à l'échelle 1, le
 * second peint à l'échelle du rendu — les mêmes chaînes de police servent aux
 * deux, c'est `context.scale()` qui fait le reste.
 */
export async function renderDocumentPages(
  doc: PageDocument,
  options: RenderPagesOptions = {},
): Promise<Gray[]> {
  await loadFonts(PAGE_FONT_SPECS)

  const scale = options.scale ?? PAGE_SCALE

  const ruler = document.createElement('canvas')
  ruler.width = 1
  ruler.height = 1
  const measuring = ruler.getContext('2d')
  if (measuring === null) throw new Error("Ce navigateur ne sait pas dessiner la page.")

  const layout = layoutDocumentPages(doc, {
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    measure: (text, font) => {
      measuring.font = font
      return measuring.measureText(text).width
    },
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(layout.width * scale)
  canvas.height = Math.round(layout.height * scale)

  const context = canvas.getContext('2d')
  if (context === null) throw new Error("Ce navigateur ne sait pas dessiner la page.")

  const pages: Gray[] = []
  for (const ops of layout.pages) {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.scale(scale, scale)

    paint(context, { width: layout.width, height: layout.height, direction: layout.direction, ops })

    context.setTransform(1, 0, 0, 1, 0, 0)
    pages.push(grayscale(context.getImageData(0, 0, canvas.width, canvas.height)))
  }

  return pages
}
