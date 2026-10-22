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
import { rasterize } from '@/lib/printing/raster'
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

/** Charge les polices du ticket. Les erreurs ne bloquent pas : on dessine. */
export async function loadTicketFonts(fonts: FontFaceSet = document.fonts): Promise<void> {
  await Promise.all(TICKET_FONT_SPECS.map((spec) => fonts.load(spec).catch(() => undefined)))
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
