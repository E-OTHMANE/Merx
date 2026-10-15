/*
 * Surface publique du module Ventes (M3). E4-02.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses internes.
 * Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 *
 * E4-02 n'apporte que la numérotation : l'écran de vente est E4-03, la
 * résolution du prix E4-04, le cycle des documents E4-05.
 */

export {
  DOC_TYPE_CODES,
  MAX_SEQUENCE,
  documentYear,
  formatDocumentNumber,
  parseDocumentNumber,
  type DocumentNumberParts,
  type SaleDocType,
} from '@/modules/sales/documentNumber'
export {
  NUMBERING_MESSAGES,
  confirmDocument,
  sequenceBound,
  type ConfirmationRequest,
  type ConfirmedDocument,
  type SequenceKey,
} from '@/modules/sales/numbering'
