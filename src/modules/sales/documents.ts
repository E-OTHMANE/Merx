/*
 * La liste et la consultation des documents de vente — E4-07. SPEC § 8.
 *
 * « Retrouver un bon, afin de régler un litige. » Ce fichier lit ; la seule
 * écriture est l'annulation, et elle n'invente rien : elle emprunte ce qu'E4-01
 * a posé en base (`merx.require_cancel_capability()`, le motif obligatoire,
 * l'inversion des mouvements, l'entrée `document_cancellation`).
 *
 * ----------------------------------------------------------------------------
 * **La liste et l'en-tête du détail passent par `list_sale_documents()`**, pas
 * par un `select` sur `sale_document`. Deux raisons, mesurables, que la
 * migration `20261021090000` écrit : l'auteur et l'appareil sont fermés à
 * l'employé (`app_user`, `device`), et la policy `OR merx.is_super_admin()`
 * mettrait une lecture directe en Seq Scan sur tous les commerces (BACKLOG
 * E0-03). Les **lignes** et la **filiation** restent des lectures ordinaires,
 * sous RLS : elles n'ont besoin d'aucun nom que la RLS refuse.
 *
 * **Les dates sont des jours de commerce, à Casablanca** (`@/lib/day`) : « du 9 »
 * couvre le 9 marocain, borne haute exclusive. Le tri et le filtre de date
 * portent sur la date d'émission, ou de création pour un brouillon — sans quoi
 * un brouillon, qui n'a pas d'`issued_at`, serait injoignable.
 *
 * **Les montants arrivent par PostgREST en nombres JSON** (c'est son rendu d'un
 * `numeric`) ; ils sont remis en texte tels quels pour l'affichage
 * (`moneyText()`), jamais additionnés ni comparés ici. `numeric(12,2)` tient
 * exactement dans la représentation décimale la plus courte d'un nombre JSON.
 *
 * **Pas de filtre par client** : `sale_document.client_id` naît en E6-01.
 */

import { startOfDay, endOfDay } from '@/lib/day'
import { supabase } from '@/lib/supabase'
import type { SaleDocType } from '@/modules/sales/documentNumber'
import { TRANSFORM_TARGET } from '@/modules/sales/transform'

export type DocStatus = 'draft' | 'confirmed' | 'delivered' | 'cancelled'

/** Ce que chaque type se dit à l'écran. Exhaustif : un cinquième type casse la compilation. */
export const DOC_TYPE_LABELS: Readonly<Record<SaleDocType, string>> = {
  quote: 'Devis',
  order: 'Commande',
  delivery_note: 'Bon de livraison',
  return: 'Retour',
}

/** Idem pour le statut. « Annulé » est le mot qui marque un document annulé. */
export const STATUS_LABELS: Readonly<Record<DocStatus, string>> = {
  draft: 'Brouillon',
  confirmed: 'Confirmé',
  delivered: 'Livré',
  cancelled: 'Annulé',
}

export const DOCUMENT_MESSAGES = {
  notFound: 'Ce document n’existe plus, ou ce compte n’a pas le droit de le lire.',
  /*
   * Les phrases de l'écran d'annulation. Aucune n'est celle de la base : le
   * garde de capacité (`merx.require_cancel_capability()`) et le `check` du
   * motif parlent en leurs propres mots, que l'écran affiche tels quels quand
   * c'est la base qui refuse (CLAUDE.md, deux gardes sur le même chemin).
   */
  reasonRequired: 'Dites pourquoi vous annulez ce document : le motif est obligatoire.',
  cancelNotSaved: 'L’annulation n’a pas pu être enregistrée.',
} as const

/** Ce qu'une page de la liste contient au plus avant « affinez les filtres ». */
export const LIST_LIMIT = 100

export interface DocumentFilter {
  /** Jours locaux `AAAA-MM-JJ`, bornes incluses. */
  from?: string
  to?: string
  status?: DocStatus | ''
  docType?: SaleDocType | ''
  deviceId?: string
  /** Un numéro entier, des chiffres, ou un fragment — la base distingue. */
  search?: string
}

/** Une ligne de la liste, et l'en-tête du détail. */
export interface SaleDocumentSummary {
  id: string
  docType: SaleDocType
  /** Nul tant que le document est un brouillon (RÈGLE M3-2). */
  docNumber: string | null
  status: DocStatus
  subtotal: string
  discountTotal: string
  total: string
  notes: string | null
  cancellationReason: string | null
  issuedAt: string | null
  createdAt: string
  /** La date que la liste trie : émission, ou création pour un brouillon. */
  sortAt: string
  sourceDocumentId: string | null
  deviceLabel: string | null
  devicePrefix: string | null
  /** `null` si l'auteur n'est plus dans la fiche du commerce. */
  authorName: string | null
}

interface SummaryRow {
  id: string
  doc_type: SaleDocType
  doc_number: string | null
  status: DocStatus
  subtotal: number | string
  discount_total: number | string
  total: number | string
  notes: string | null
  cancellation_reason: string | null
  issued_at: string | null
  created_at: string
  sort_at: string
  source_document_id: string | null
  device_label: string | null
  device_prefix: string | null
  author_name: string | null
}

const summary = (row: SummaryRow): SaleDocumentSummary => ({
  id: row.id,
  docType: row.doc_type,
  docNumber: row.doc_number,
  status: row.status,
  subtotal: String(row.subtotal),
  discountTotal: String(row.discount_total),
  total: String(row.total),
  notes: row.notes,
  cancellationReason: row.cancellation_reason,
  issuedAt: row.issued_at,
  createdAt: row.created_at,
  sortAt: row.sort_at,
  sourceDocumentId: row.source_document_id,
  deviceLabel: row.device_label,
  devicePrefix: row.device_prefix,
  authorName: row.author_name,
})

const orNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim()

/** Les paramètres de la fonction pour un filtre — des `null` là où rien n'est demandé. */
export function listArguments(filter: DocumentFilter, limit: number) {
  const from = orNull(filter.from)
  const to = orNull(filter.to)
  return {
    p_from: from === null ? null : startOfDay(from),
    p_to: to === null ? null : endOfDay(to),
    p_status: orNull(filter.status),
    p_doc_type: orNull(filter.docType),
    p_device_id: orNull(filter.deviceId),
    p_search: orNull(filter.search),
    p_limit: limit,
  }
}

export interface DocumentPage {
  documents: SaleDocumentSummary[]
  /**
   * Vrai quand la base avait plus que la page : l'écran écrit « les 100 plus
   * récents, affinez les filtres ». On demande une ligne de plus pour le savoir
   * sans second appel.
   */
  truncated: boolean
}

/** Les documents du commerce, du plus récent au plus ancien, sous les filtres donnés. */
export async function listSaleDocuments(filter: DocumentFilter = {}): Promise<DocumentPage> {
  const { data, error } = await supabase.rpc(
    'list_sale_documents',
    listArguments(filter, LIST_LIMIT + 1),
  )
  if (error !== null) throw new Error(error.message)

  const rows = ((data ?? []) as SummaryRow[]).map(summary)
  return { documents: rows.slice(0, LIST_LIMIT), truncated: rows.length > LIST_LIMIT }
}

/** Une ligne du détail. */
export interface DocumentLine {
  id: string
  name: string
  code: string | null
  quantity: string
  unitPrice: string
  lineDiscount: string
  lineTotal: string
}

interface LineRow {
  id: string
  quantity: string
  unit_price: string
  line_discount: string
  line_total: string
  variant: {
    sku: string | null
    product: { name_fr: string; code: string | null } | null
  } | null
}

export interface DocumentDetail {
  document: SaleDocumentSummary
  lines: DocumentLine[]
}

/**
 * Le document et ses lignes. `null` quand il n'existe pas **ou** n'est pas du
 * commerce : les deux se répondent par l'absence (E1-02, E1-03).
 *
 * L'en-tête passe par la fonction (l'auteur, l'appareil) ; les lignes par une
 * lecture ordinaire, sous RLS. Les quantités et les montants des lignes sont
 * casts en texte côté base, comme partout ailleurs dans ce module.
 */
export async function loadDocument(documentId: string): Promise<DocumentDetail | null> {
  const [header, lines] = await Promise.all([
    supabase.rpc('list_sale_documents', {
      p_document_id: documentId,
      p_limit: 1,
    }),
    supabase
      .from('sale_line')
      .select(
        'id, quantity::text, unit_price::text, line_discount::text, line_total::text,' +
          ' variant!inner(sku, product!inner(name_fr, code))',
      )
      .eq('sale_document_id', documentId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ])

  if (header.error !== null) throw new Error(header.error.message)
  if (lines.error !== null) throw new Error(lines.error.message)

  const row = ((header.data ?? []) as SummaryRow[])[0]
  if (row === undefined) return null

  return {
    document: summary(row),
    lines: ((lines.data ?? []) as unknown as LineRow[]).map((line) => ({
      id: line.id,
      name: line.variant?.product?.name_fr ?? '—',
      code: line.variant?.product?.code ?? line.variant?.sku ?? null,
      quantity: line.quantity,
      unitPrice: line.unit_price,
      lineDiscount: line.line_discount,
      lineTotal: line.line_total,
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* Ce que le détail propose                                                    */
/* -------------------------------------------------------------------------- */

const LIVING: readonly DocStatus[] = ['confirmed', 'delivered']

/**
 * « Transformer » — la chaîne d'E4-05, côté écran (`TRANSFORM_TARGET`) : un
 * document qui a quelque chose pour suite, ni brouillon ni annulé. Le même
 * critère que `loadForTransformation()`, sans lire le document une seconde fois.
 */
export function canTransform(doc: Pick<SaleDocumentSummary, 'docType' | 'status'>): boolean {
  return TRANSFORM_TARGET[doc.docType] !== null && LIVING.includes(doc.status)
}

/**
 * « Retour » — la chaîne d'E4-06 : un bon de livraison vivant, et lui seul.
 * Ce que le bon a déjà rendu ne se sait pas d'ici : c'est l'écran de retour qui
 * le dit (`RETURN_MESSAGES.nothingLeft`), et la base qui le tient (RÈGLE M3-9).
 */
export function canReturn(doc: Pick<SaleDocumentSummary, 'docType' | 'status'>): boolean {
  return doc.docType === 'delivery_note' && LIVING.includes(doc.status)
}

/** Seul un document qui a vécu s'annule : un brouillon se supprime (RÈGLE M3-3). */
export function canCancel(doc: Pick<SaleDocumentSummary, 'status'>): boolean {
  return LIVING.includes(doc.status)
}

/**
 * Annule un document, avec son motif.
 *
 * Le motif vide est refusé **ici**, avec la phrase de l'écran ; la base le
 * refuse aussi (`sale_document_cancellation_reason`, `23514`) avec la sienne.
 * Tout le reste — le droit (`cancel_document`, le patron seul), le bon qui porte
 * un retour vivant, l'inversion du stock, l'entrée du journal — est écrit par la
 * base dans la même transaction : rien n'est ajouté ici.
 *
 * Une mise à jour que la RLS écarte ne lève rien et ne touche aucune ligne :
 * c'est pourquoi la ligne touchée est relue, et l'absence est dite.
 */
export async function cancelDocument(documentId: string, reason: string): Promise<void> {
  const trimmed = reason.trim()
  if (trimmed === '') throw new Error(DOCUMENT_MESSAGES.reasonRequired)

  const { data, error } = await supabase
    .from('sale_document')
    .update({ status: 'cancelled', cancellation_reason: trimmed })
    .eq('id', documentId)
    .select('id')

  if (error !== null) throw new Error(error.message)
  if (((data ?? []) as unknown[]).length === 0) throw new Error(DOCUMENT_MESSAGES.notFound)
}
