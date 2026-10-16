/*
 * L'enregistrement d'un bon — E4-03.
 *
 * **Rien n'est écrit pendant la saisie.** Dix lignes ne coûtent aucun
 * aller-retour : le bon vit dans l'écran, et trois appels partent au moment où
 * le vendeur appuie sur « Enregistrer le bon » (SPEC § 10, point de rupture
 * n° 2). Un bon abandonné ne laisse donc aucun brouillon derrière lui — c'est
 * aussi ce qui tient la séquence sans trou : un brouillon ne consomme aucun
 * numéro (SPEC § 4, RÈGLE M3-2).
 *
 *   1. le document, au statut `draft` — il naît brouillon, la base l'exige
 *      (`merx.reject_frozen_birth()`, E4-01) ;
 *   2. ses lignes, **en un seul appel** — une ligne ne s'écrit plus sous un
 *      document confirmé (`merx.reject_frozen_child_write()`) ;
 *   3. la confirmation, qui pose le numéro et la date — `confirmDocument()`,
 *      E4-02, qui enjambe un numéro déjà pris et retente.
 *
 * `warehouse_id` n'est pas envoyé : la base le pose depuis le commerce de la
 * session (`merx.default_warehouse_id()`, E4-03) — SPEC § 2.4, le dépôt n'est
 * « jamais exposé ». `tenant_id` et `created_by` viennent déjà du jeton.
 *
 * **Les trois appels ne sont pas atomiques, et c'est traité plutôt que caché.**
 * Un réseau qui coupe entre deux étapes laisse un brouillon : ce qui a réussi
 * est retenu dans `SaleProgress`, et un second appui reprend là où le premier
 * s'est arrêté — il ne crée pas un second brouillon et ne redouble pas ses
 * lignes. Les totaux sont réécrits avant les lignes : un brouillon est
 * librement modifiable (RÈGLE M3-3), donc une retente part des lignes
 * d'aujourd'hui, pas de celles de la tentative perdue.
 *
 * Le mouvement de stock n'est **pas** écrit ici, et ne le sera jamais : depuis
 * E4-05, la confirmation d'un bon de livraison le fait écrire par la base
 * (`merx.write_sale_movements()`, RÈGLE M3-5), et l'insertion directe d'un
 * mouvement `sale` est refusée — il naît de la confirmation, pas d'un geste de
 * l'appareil. L'appareil n'a donc rien à envoyer de plus qu'en E4-03 : le
 * troisième appel suffit, et le stock suit tout seul.
 *
 * **Le type du document et sa filiation** arrivent aussi en E4-05 : un devis,
 * une commande ou un bon s'écrivent par le même chemin, et une transformation
 * n'est qu'un document neuf qui porte `source_document_id` (RÈGLE M3-4 —
 * l'original n'est jamais muté, et la base le tient de toute façon).
 */

import { MONEY_SCALE, QUANTITY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'
import { supabase } from '@/lib/supabase'
import { documentTotals, lineTotalOf } from '@/modules/sales/amounts'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import { confirmDocument, type ConfirmedDocument } from '@/modules/sales/numbering'
import type { SaleLine } from '@/modules/sales/sale'

/** Le type de document que l'écran de vente produit par défaut — RÈGLE M3-1. */
export const SALE_DOC_TYPE = 'delivery_note' as const

/* L'identifiant que la mise en forme à blanc emploie : elle n'écrit rien. */
const DRY_RUN = '00000000-0000-0000-0000-000000000000'

export const SALE_MESSAGES = {
  incomplete:
    'Ce bon n’est pas prêt : chaque ligne demande une quantité et un prix.',
  notSaved: 'Le bon n’a pas pu être enregistré.',
} as const

/** Ce qui a déjà abouti, pour qu'une retente ne le refasse pas. */
export interface SaleProgress {
  /** Le brouillon écrit, à réutiliser tel quel. */
  documentId?: string
  /** Ses lignes sont en base : une retente ne les réécrit pas. */
  linesWritten?: boolean
}

export interface RecordSaleRequest {
  lines: readonly SaleLine[]
  /** Devis, commande ou bon. Le bon par défaut — RÈGLE M3-1. */
  docType?: SaleDocType
  /**
   * Le document d'origine, quand ce bon-ci naît d'une transformation (E4-05).
   * Posé à la naissance du brouillon : il gèle avec lui à la confirmation.
   */
  sourceDocumentId?: string
  /** `installationId()` — la clé de cet appareil en base. */
  deviceId: string
  /** `cachedDevicePrefix()` — sa lettre. */
  prefix: string | null
  /** Ce qu'une tentative précédente a déjà écrit. */
  progress: SaleProgress
  /** Appelé après chaque étape réussie, pour que l'appelant le retienne. */
  onProgress: (progress: SaleProgress) => void
  /** Fournie pour que le test ne dépende pas de l'horloge. */
  issuedAt?: Date
}

/**
 * La ligne, dans la forme que la base reçoit : des décimales en texte.
 *
 * **`line_total` n'y est pas.** C'est une colonne engendrée depuis E4-04
 * (RÈGLE M3-7) : la base la calcule, et une valeur fournie serait refusée en
 * `428C9`. L'accord sur le centime n'est donc plus une règle que l'appareil
 * applique de son côté — il n'a plus la parole. Le total affiché pendant la
 * saisie, lui, reste calculé ici (`amounts.ts`), et la suite mesure que les
 * deux tombent sur le même centime.
 *
 * `overridden_price` est le prix que la grille donnait et que le vendeur a
 * remplacé : nul quand la ligne n'est pas un forçage, y compris quand aucun
 * prix n'existait (E4-03). C'est lui qui déclenche l'entrée `price_override` au
 * journal, par la condition du trigger d'audit.
 */
function rowOf(documentId: string, line: SaleLine): Record<string, unknown> {
  const quantity = parseDecimal(line.quantity, QUANTITY_SCALE)
  const unitPrice = parseDecimal(line.unitPrice, MONEY_SCALE)
  if (quantity === null || unitPrice === null || lineTotalOf(line.quantity, line.unitPrice) === null) {
    throw new Error(SALE_MESSAGES.incomplete)
  }

  return {
    sale_document_id: documentId,
    variant_id: line.variantId,
    quantity: toSqlDecimal(quantity, QUANTITY_SCALE),
    unit_price: toSqlDecimal(unitPrice, MONEY_SCALE),
    price_source: line.priceSource,
    overridden_price: line.overriddenPrice,
  }
}

/**
 * Écrit le bon et le confirme. Rend le document confirmé — son numéro est ce
 * que le vendeur annonce au client.
 */
export async function recordSale(request: RecordSaleRequest): Promise<ConfirmedDocument> {
  const { lines, progress, onProgress } = request
  const docType = request.docType ?? SALE_DOC_TYPE
  if (lines.length === 0) throw new Error(SALE_MESSAGES.incomplete)

  const totals = documentTotals(lines)
  // Les lignes sont mises en forme avant la première écriture — `rowOf` refuse
  // une quantité ou un prix illisible : un bon incomplet ne laisse pas un
  // brouillon derrière lui.
  lines.forEach((line) => rowOf(DRY_RUN, line))

  let documentId = progress.documentId

  if (documentId === undefined) {
    const { data, error } = await supabase
      .from('sale_document')
      .insert({
        doc_type: docType,
        device_id: request.deviceId,
        subtotal: totals.subtotal,
        discount_total: totals.discountTotal,
        total: totals.total,
        ...(request.sourceDocumentId === undefined
          ? {}
          : { source_document_id: request.sourceDocumentId }),
      })
      .select('id')
      .single()
    if (error !== null) throw new Error(error.message)

    documentId = (data as { id: string }).id
    onProgress({ documentId })
  }

  if (progress.linesWritten !== true) {
    // Le brouillon d'une tentative perdue porte les totaux de cette
    // tentative-là ; ceux d'aujourd'hui sont ceux qui s'impriment.
    const { error: totalsError } = await supabase
      .from('sale_document')
      .update({
        subtotal: totals.subtotal,
        discount_total: totals.discountTotal,
        total: totals.total,
      })
      .eq('id', documentId)
      .eq('status', 'draft')
    if (totalsError !== null) throw new Error(totalsError.message)

    const { error } = await supabase
      .from('sale_line')
      .insert(lines.map((line) => rowOf(documentId, line)))
    if (error !== null) throw new Error(error.message)

    onProgress({ documentId, linesWritten: true })
  }

  return await confirmDocument({
    documentId,
    docType,
    deviceId: request.deviceId,
    prefix: request.prefix,
    ...(request.issuedAt === undefined ? {} : { issuedAt: request.issuedAt }),
  })
}
