/*
 * Du document au ticket. E5-01 — SPEC § 2.7, BACKLOG E5-01.
 *
 * Ce fichier est la jonction : il lit les réglages du commerce (en-tête,
 * adresse, largeur de tête), construit le ticket et l'envoie. `src/lib/printing`
 * ne connaît ni la vente ni les réglages ; le module Ventes ne connaît ni
 * l'ESC/POS ni le canvas.
 *
 * **Il n'y a pas d'imprimante la plupart du temps, et ce n'est pas une panne.**
 * Au navigateur il n'y a pas de socket (SPEC § 2.7) ; dans un commerce sans
 * imprimante, l'adresse est vide. Dans les deux cas `loadTicketPrinter()` rend
 * `null`, et l'écran n'offre pas le bouton — SPEC § 2.6, une fonctionnalité
 * privée de sa donnée se désactive en silence.
 *
 * **Le client ne figure pas encore sur le ticket** : les clients sont M4
 * (étape 6), et un `sale_document` n'en porte pas en V1 à ce stade. Le champ
 * existe dans le ticket, vide, et la ligne ne s'imprime pas tant qu'il l'est.
 * C'est E6 qui le remplira — pas cette story.
 */

import { MONEY_SCALE, QUANTITY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'
import {
  PRINT_MESSAGES,
  printTicket,
  printerSetup,
  thermalPrinting,
  type PrinterSetup,
  type Ticket,
  type TicketLine,
} from '@/lib/printing'
import { loadSettings } from '@/modules/admin'
import { lineTotalText } from '@/modules/sales/amounts'
import type { DocumentDetail, DocStatus } from '@/modules/sales/documents'
import type { SaleLine } from '@/modules/sales/sale'

export type { Ticket } from '@/lib/printing'

export const TICKET_MESSAGES = {
  printing: PRINT_MESSAGES.printing,
  printed: PRINT_MESSAGES.printed,
  /* L'échec ne défait rien : le bon est écrit, la réimpression est un bouton. */
  failed: PRINT_MESSAGES.failed,
} as const

/** Une imprimante joignable, et l'en-tête à imprimer dessus. */
export interface TicketPrinter {
  setup: PrinterSetup
  header: { businessName: string; phone: string; address: string }
}

/**
 * L'imprimante du commerce, ou `null` — pas d'enveloppe, pas d'adresse, pas de
 * largeur lisible. Les réglages ne sont lus que dans l'enveloppe : au
 * navigateur, la question ne se pose pas, et une requête de moins au chargement
 * d'un écran est une requête de moins.
 */
export async function loadTicketPrinter(): Promise<TicketPrinter | null> {
  if (!thermalPrinting()) return null

  const settings = await loadSettings()
  const setup = printerSetup(settings.printerAddress, settings.printerWidth)
  if (setup === null) return null

  return { setup, header: settings.printHeader }
}

/**
 * Ce qui s'imprime, et ce qui ne s'imprime pas.
 *
 * Un brouillon n'a pas de numéro (RÈGLE M3-2) : il n'y a rien à remettre au
 * client. Un document annulé en a un, et c'est justement pourquoi on ne le
 * réimprime pas — un ticket d'allure valable pour une vente annulée est une
 * preuve fausse entre les mains du client.
 */
export function canPrint(doc: { docNumber: string | null; status: DocStatus }): boolean {
  return doc.docNumber !== null && doc.status !== 'cancelled'
}

/** Du texte de champ (`"2,5"`) au texte de base (`"2.500"`). */
function sqlText(text: string, scale: number): string {
  const value = parseDecimal(text, scale)
  return value === null ? text : toSqlDecimal(value, scale)
}

/** Le ticket d'un document relu depuis la base — la réimpression. */
export function documentTicket(detail: DocumentDetail, printer: TicketPrinter): Ticket {
  const { document, lines } = detail

  return {
    ...printer.header,
    number: document.docNumber ?? '',
    issuedAt: document.issuedAt,
    clientName: '',
    lines: lines.map(
      (line): TicketLine => ({
        label: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      }),
    ),
    total: document.total,
  }
}

/**
 * Le ticket du bon qu'on vient d'enregistrer, depuis l'écran de vente.
 *
 * Les valeurs viennent de l'écran et non d'une relecture : au comptoir, un
 * aller-retour de plus se paie en secondes devant le client (point de rupture
 * n° 2). Elles sont les mêmes que celles de la base — la confirmation a été
 * refusée si les totaux ne disaient pas la vérité sur les lignes
 * (`merx.require_consistent_totals()`), et `line_total` est une colonne
 * engendrée calculée selon la même règle qu'`amounts.ts`, accord mesuré par
 * `supabase/tests/sale-price.test.ts`.
 */
export function saleTicket(
  sale: { docNumber: string; issuedAt: string; lines: readonly SaleLine[]; total: string },
  printer: TicketPrinter,
): Ticket {
  return {
    ...printer.header,
    number: sale.docNumber,
    issuedAt: sale.issuedAt,
    clientName: '',
    lines: sale.lines.map((line): TicketLine => {
      const quantity = sqlText(line.quantity, QUANTITY_SCALE)
      const unitPrice = sqlText(line.unitPrice, MONEY_SCALE)
      return {
        label: line.name,
        quantity,
        unitPrice,
        lineTotal: lineTotalText(line.quantity, line.unitPrice) ?? '0.00',
      }
    }),
    total: sale.total,
  }
}

/** Imprime, ou lève avec une phrase lisible. L'appelant n'annule rien. */
export async function printTicketOn(ticket: Ticket, printer: TicketPrinter): Promise<void> {
  await printTicket(ticket, printer.setup)
}
