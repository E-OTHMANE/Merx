/*
 * La numérotation locale des documents — E4-02.
 *
 * SPEC § 2.5 et § 8, RÈGLE M3-2 : le numéro est attribué **par l'appareil**, à
 * la confirmation, sans rien demander au serveur. `BL-A-26-00001` — code du
 * type, lettre de l'appareil (E1-03, unique par commerce et jamais recyclée),
 * année sur deux chiffres, cinq chiffres de séquence.
 *
 * L'appareil a tout ce qu'il faut hors réseau : son identifiant est celui qu'il
 * s'est donné (`installationId()`, E1-03 — c'est aussi la clé primaire de
 * `device`), et sa lettre est en cache (`cachedDevicePrefix()`). Rien ici ne
 * demande au serveur *quel numéro prendre*.
 *
 * **Le compteur n'est pas l'autorité — `sale_document_number_per_tenant` l'est.**
 * Même partage qu'E2-06 pour le SKU engendré : l'appareil choisit, l'index
 * tranche. Trois conséquences, toutes trois éprouvées :
 *
 *   — la borne se lit dans `document_sequence`, que le serveur **constate** (un
 *     trigger y pose le plus grand numéro écrit) et n'attribue pas. Un
 *     stockage local vidé repart donc au-dessus du dernier numéro connu du
 *     serveur, jamais à `00001` ;
 *   — un `23505` sur `sale_document_number_per_tenant` — deux onglets qui
 *     confirment en même temps, un numéro posé à la main par l'API — fait
 *     passer au numéro suivant et retenter. Le refus est reconnu **au nom de la
 *     contrainte**, jamais au seul code : `variant_sku_per_tenant` et
 *     `product_code_per_tenant` répondent le même `23505` (CLAUDE.md, règle des
 *     unicités) ;
 *   — l'enjambement laisse un trou. C'est l'arbitrage, écrit dans BACKLOG
 *     E4-02 : un trou se retrouve, un doublon imprimé ne se répare pas.
 *
 * **Un brouillon ne consomme aucun numéro** (SPEC § 4) : c'est ce qui tient le
 * critère « aucun trou » en fonctionnement normal. Un bon abandonné avant la
 * confirmation ne laisse rien derrière lui.
 *
 * Ce qui n'est pas ici : la numérotation hors ligne. Elle lira la même borne
 * dans la base locale, et `max(doc_number)` des documents encore en attente
 * d'envoi — E9, où PowerSync tient la file. Aujourd'hui une borne illisible
 * fait refuser la confirmation, plutôt que de numéroter au hasard contre un
 * historique qu'on ne voit pas.
 *
 * La **forme** du numéro vit dans `documentNumber.ts`, sans aucune dépendance :
 * c'est ce qui permet au test de base d'y comparer les codes de type à ceux de
 * `merx.doc_type_code()` sans entraîner le client Supabase derrière lui.
 */

import { supabase } from '@/lib/supabase'
import {
  MAX_SEQUENCE,
  documentYear,
  formatDocumentNumber,
  type SaleDocType,
} from '@/modules/sales/documentNumber'

/** Combien de numéros déjà pris on enjambe avant d'abandonner. */
const MAX_ATTEMPTS = 5

export const NUMBERING_MESSAGES = {
  noDevice:
    'Cet appareil n’a pas encore sa lettre. Connectez-le une fois au réseau pour qu’il se présente à votre commerce.',
  unknownBound:
    'Impossible de lire le dernier numéro de cet appareil. Vérifiez la connexion : numéroter sans cette lecture risquerait de reprendre un numéro déjà imprimé.',
  exhausted:
    'Les numéros de cet appareil sont épuisés pour cette année. Enregistrez un second appareil pour obtenir une autre lettre.',
  notDraft:
    'Ce document n’est plus un brouillon — il a déjà son numéro — ou ce compte n’a pas le droit de le confirmer.',
} as const

export interface SequenceKey {
  docType: SaleDocType
  deviceId: string
  /** L'année pleine — `2026`. C'est la clé de `document_sequence`. */
  year: number
}

/**
 * Le plus grand numéro que le serveur ait vu de cet appareil, ou 0.
 *
 * Lu dans `document_sequence` et non en `max(doc_number)` sur les documents, et
 * la raison est mesurée : sous la paire de policies de SPEC § 2.1, une
 * comparaison de texte sur `doc_number` est un parcours séquentiel de toute la
 * table, tous commerces confondus — 493 ms par appel sur 20 000 documents, sur
 * le chemin d'une confirmation qu'un client attend debout. `document_sequence`
 * est une poignée de lignes par commerce, et son coût ne dépend d'aucun
 * historique. Le test de plan de `document-numbering.test.ts` tient la mesure.
 *
 * Une lecture en échec ne rend pas 0 : elle lève. Repartir de 1 contre un
 * historique qu'on n'a pas pu lire, c'est enjamber un numéro par document déjà
 * émis.
 */
export async function sequenceBound(key: SequenceKey): Promise<number> {
  const { data, error } = await supabase
    .from('document_sequence')
    .select('last_number')
    .eq('device_id', key.deviceId)
    .eq('doc_type', key.docType)
    .eq('year', key.year)
    .maybeSingle()

  if (error !== null) throw new Error(NUMBERING_MESSAGES.unknownBound)

  const row = data as { last_number: number } | null
  return row?.last_number ?? 0
}

export interface ConfirmationRequest {
  documentId: string
  docType: SaleDocType
  /** L'identifiant de cet appareil — `installationId()`, qui est sa clé en base. */
  deviceId: string
  /** Sa lettre — `cachedDevicePrefix()`. */
  prefix: string | null
  /** La date d'émission. Fournie pour que le test ne dépende pas de l'horloge. */
  issuedAt?: Date
}

export interface ConfirmedDocument {
  docNumber: string
  issuedAt: string
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

function isNumberCollision(error: PostgrestErrorLike): boolean {
  return (
    error.code === '23505' && error.message.includes('sale_document_number_per_tenant')
  )
}

/**
 * Confirme le brouillon et rend le numéro attribué.
 *
 * La transition `draft → confirmed` est la seule que la table figée laisse
 * écrire librement (RÈGLE M3-3) : numéro et date y sont posés du même geste, et
 * plus rien ne les changera après.
 *
 * `eq('status', 'draft')` n'est pas une ceinture de plus : c'est ce qui rend
 * l'opération sûre à retenter. Un UPDATE refusé par la RLS ne lève pas, il ne
 * trouve rien (même garde qu'`updateProduct`, E2-02) — sans le contrôle du
 * nombre de lignes rendues, un numéro s'imprimerait que la base n'a jamais
 * accepté.
 */
export async function confirmDocument(
  request: ConfirmationRequest,
): Promise<ConfirmedDocument> {
  const prefix = request.prefix
  if (prefix === null || !/^[A-Z]$/.test(prefix)) {
    throw new Error(NUMBERING_MESSAGES.noDevice)
  }

  // Un seul instant pour toute la confirmation : l'année du numéro est celle de
  // cette date-là, et le serveur recalcule la sienne depuis elle.
  const at = request.issuedAt ?? new Date()
  const issuedAt = at.toISOString()
  const year = documentYear(at)

  const bound = await sequenceBound({
    docType: request.docType,
    deviceId: request.deviceId,
    year,
  })

  let sequence = bound + 1

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (sequence > MAX_SEQUENCE) throw new Error(NUMBERING_MESSAGES.exhausted)

    const docNumber = formatDocumentNumber(request.docType, prefix, year, sequence)
    const { data, error } = await supabase
      .from('sale_document')
      .update({ status: 'confirmed', doc_number: docNumber, issued_at: issuedAt })
      .eq('id', request.documentId)
      .eq('status', 'draft')
      .select('id')

    if (error === null) {
      if ((data as unknown[] | null)?.length !== 1) {
        throw new Error(NUMBERING_MESSAGES.notDraft)
      }
      return { docNumber, issuedAt }
    }

    if (!isNumberCollision(error)) throw new Error(error.message)

    // Le numéro est pris — deux onglets qui confirment ensemble, ou une
    // écriture posée à la main par l'API. On enjambe, et l'index tranche à
    // nouveau. Le trou est assumé (BACKLOG E4-02).
    sequence += 1
  }

  throw new Error(NUMBERING_MESSAGES.exhausted)
}
