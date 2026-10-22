/*
 * L'impression thermique — surface publique. E5-01 — SPEC § 2.7.
 *
 * Trois idées, et c'est tout ce que l'application a à connaître :
 *
 *   `printerSetup()` — y a-t-il une imprimante ? Un réglage vide ou illisible
 *   rend `null`, et l'écran n'offre alors pas le bouton. C'est SPEC § 2.6 : une
 *   fonctionnalité privée de sa donnée se désactive en silence.
 *
 *   `thermalPrinting()` — sommes-nous dans l'enveloppe Android ? Au navigateur,
 *   non, et pour une raison structurelle : pas de socket TCP (SPEC § 2.7). Le
 *   PDF A4 reste la voie de tout le monde (E5-03).
 *
 *   `printTicket()` — dessine, seuille, encode, envoie. Elle lève en cas
 *   d'échec, avec une phrase lisible : **l'échec d'impression ne défait rien**.
 *   Le bon est déjà enregistré, et la réimpression est le même geste.
 */

import { encodeTicket } from '@/lib/printing/escpos'
import { renderTicket } from '@/lib/printing/canvas'
import { nativeTransport, type PrinterTransport } from '@/lib/printing/transport'
import type { Raster } from '@/lib/printing/escpos'
import type { Ticket } from '@/lib/printing/ticket'

export { encodeTicket, feedAndCut, rasterBand, ticketCommands, toBase64 } from '@/lib/printing/escpos'
export { BLACK_THRESHOLD, rasterize } from '@/lib/printing/raster'
export { TICKET_FONT_FAMILY, layoutTicket, wrapText } from '@/lib/printing/ticket'
export { TICKET_FONT_SPECS, loadTicketFonts, paint, renderTicket } from '@/lib/printing/canvas'
export {
  BATCH_PAUSE_MS,
  CONNECT_TIMEOUT_MS,
  FINISH_PAUSE_MS,
  nativeTransport,
  socketTransport,
} from '@/lib/printing/transport'
export type { Raster } from '@/lib/printing/escpos'
export type { Pixels } from '@/lib/printing/raster'
export type {
  Measure,
  Ticket,
  TicketAlign,
  TicketLayout,
  TicketLine,
  TicketOp,
} from '@/lib/printing/ticket'
export type { PrinterTransport, TcpSocketLike } from '@/lib/printing/transport'

/** Le port ESC/POS brut. Universel sur les imprimantes réseau. */
export const DEFAULT_PRINTER_PORT = 9100

/** Où imprimer, et sur quelle largeur de tête. */
export interface PrinterSetup {
  host: string
  port: number
  /** La largeur de la tête en points — `printer_width` (SPEC § 2.7). */
  width: number
}

export const PRINT_MESSAGES = {
  /** Au navigateur. Jamais montré : le bouton n'y est pas. */
  unavailable: 'L’impression thermique demande l’application Android.',
  /** Après un échec, sur l'écran du document. Le bon est intact. */
  failed: 'Impression échouée. Le bon est enregistré, vous pouvez réimprimer.',
  printing: 'Impression…',
  printed: 'Ticket imprimé.',
} as const

/**
 * Lit l'adresse et la largeur des réglages, ou rend `null`.
 *
 * `null` couvre tout ce qui n'est pas une imprimante joignable : réglage vide
 * (le défaut d'un commerce qui n'en a pas), adresse mal formée, port hors
 * bornes, largeur inconnue. Aucun de ces cas n'est une erreur à annoncer : il
 * n'y a pas d'imprimante, donc pas de bouton. Inventer un port ou une largeur
 * ferait échouer l'impression sur un délai réseau plutôt que sur une absence —
 * c'est l'argument écrit dans `20260910090000_tenant_settings.sql`.
 */
export function printerSetup(address: string, width: number | ''): PrinterSetup | null {
  if (typeof width !== 'number' || !Number.isInteger(width) || width <= 0 || width % 8 !== 0) {
    return null
  }

  const trimmed = address.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return null

  const [host = '', portText, ...rest] = trimmed.split(':')
  if (host === '' || rest.length > 0) return null

  const port = portText === undefined ? DEFAULT_PRINTER_PORT : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return { host, port, width }
}

/** Vrai dans l'enveloppe Android, faux au navigateur. */
export function thermalPrinting(): boolean {
  return nativeTransport() !== null
}

/** De quoi remplacer le dessin et le transport dans un test. */
export interface PrintDeps {
  render?: (ticket: Ticket, width: number) => Promise<Raster>
  transport?: PrinterTransport | null
}

/**
 * Imprime, ou lève avec une phrase lisible.
 *
 * L'ordre est celui des responsabilités : le navigateur dessine, `raster.ts`
 * seuille, `escpos.ts` encode, le socket envoie. Aucune étape ne connaît la
 * suivante.
 */
export async function printTicket(
  ticket: Ticket,
  setup: PrinterSetup,
  deps: PrintDeps = {},
): Promise<void> {
  const transport = deps.transport === undefined ? nativeTransport() : deps.transport
  if (transport === null) throw new Error(PRINT_MESSAGES.unavailable)

  const render = deps.render ?? renderTicket
  const raster = await render(ticket, setup.width)

  await transport.send(setup.host, setup.port, encodeTicket(raster))
}
