/*
 * Du document au PDF A4. E5-03 — SPEC § 2.7, BACKLOG E5-03.
 *
 * Jumeau de `printing.ts`, et la même frontière : ce fichier lit les réglages
 * du commerce et nomme le document, `src/lib/printing` ne connaît ni la vente
 * ni les réglages.
 *
 * **Deux différences avec le ticket, et elles viennent toutes deux de § 2.7.**
 *
 *   1. *Le bouton est là partout.* L'impression thermique se tait au
 *      navigateur, faute de socket ; le PDF, lui, « est engendré localement et
 *      marche partout, enveloppe comprise : c'est le repli quand l'imprimante
 *      est absente, en panne, ou quand l'utilisateur est au navigateur ». Il
 *      n'y a donc **rien à charger** pour savoir si l'action s'offre, et pas de
 *      `null` à rendre.
 *
 *   2. *Un en-tête manquant n'empêche rien.* Le ticket ne s'imprime pas sans
 *      imprimante ; un PDF se partage sans en-tête de commerce — il manquera le
 *      nom du vendeur en haut de la page, pas le bon. Une lecture de réglages
 *      qui échoue rend donc un en-tête vide, dont les lignes ne s'impriment pas
 *      (§ 2.6), au lieu d'annuler le partage.
 *
 * **Le client ne figure pas encore sur la page**, pour la raison d'E5-01 : les
 * clients sont M4 (étape 6). Le champ existe, vide, et sa ligne ne s'imprime
 * pas. Le **relevé de compte** du troisième critère est dans le même cas, mais
 * plus profondément : un relevé demande `client_ledger_entry` (E6-02), donc il
 * n'y a à l'étape 5 aucun solde à relever. E6-04, qui dépend déjà d'E5-03,
 * posera un `layoutStatement()` à côté de `layoutDocumentPages()`.
 */

import {
  SHARE_MESSAGES,
  buildDocumentPdf,
  pdfFileName,
  pdfSharing,
  type PageDocument,
  type PageLine,
  type PdfSharing,
  type ShareOutcome,
} from '@/lib/printing'
import { loadSettings } from '@/modules/admin'
import { DOC_TYPE_LABELS, type DocumentDetail } from '@/modules/sales/documents'
import { canPrint } from '@/modules/sales/printing'

export const PDF_MESSAGES = {
  working: SHARE_MESSAGES.working,
  shared: SHARE_MESSAGES.shared,
  downloaded: SHARE_MESSAGES.downloaded,
  /* L'échec ne défait rien : le document est écrit, le bouton se rappuie. */
  failed: SHARE_MESSAGES.failed,
} as const

/**
 * Ce qui s'exporte, et ce qui ne s'exporte pas — la même porte que le ticket.
 *
 * Un brouillon n'a pas de numéro (RÈGLE M3-2) : il n'y a rien à envoyer à un
 * client d'une autre ville. Un document annulé en a un, et c'est pour cela
 * qu'on ne le renvoie pas : un PDF d'allure valable pour une vente annulée est
 * une preuve fausse, et un fichier, contrairement à un papier, se transmet
 * encore des mois après.
 */
export const canExportPdf = canPrint

const EMPTY_HEADER = { businessName: '', phone: '', address: '' }

/**
 * La page, à partir du document relu et des réglages du commerce.
 *
 * Les montants et les quantités restent les **chaînes** que la base a rendues ;
 * `page.ts` les met en forme. Rien n'est relu en nombre (SPEC § 4).
 */
export async function documentPage(detail: DocumentDetail): Promise<PageDocument> {
  const { document, lines } = detail
  const header = await loadSettings().then(
    (settings) => settings.printHeader,
    () => EMPTY_HEADER,
  )

  return {
    ...header,
    title: DOC_TYPE_LABELS[document.docType],
    number: document.docNumber ?? '',
    issuedAt: document.issuedAt,
    clientName: '',
    lines: lines.map(
      (line): PageLine => ({
        label: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      }),
    ),
    subtotal: document.subtotal,
    discountTotal: document.discountTotal,
    total: document.total,
    notes: document.notes ?? '',
  }
}

/** De quoi remplacer le rendu et le partage dans un test. */
export interface ExportDeps {
  build?: (page: PageDocument) => Promise<Uint8Array<ArrayBuffer>>
  sharing?: PdfSharing
}

/**
 * Engendre le PDF et le remet au système de partage.
 *
 * Lève avec une phrase lisible, et l'appelant n'annule rien : à ce point le
 * document est enregistré depuis longtemps.
 */
export async function exportDocumentPdf(
  detail: DocumentDetail,
  deps: ExportDeps = {},
): Promise<ShareOutcome> {
  const page = await documentPage(detail)
  const bytes = await (deps.build ?? buildDocumentPdf)(page)
  const sharing = deps.sharing ?? pdfSharing()

  return sharing.share({ name: pdfFileName(page.number, page.issuedAt), bytes })
}
