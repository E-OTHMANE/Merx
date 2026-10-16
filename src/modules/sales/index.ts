/*
 * Surface publique du module Ventes (M3). E4-02.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses internes.
 * Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 *
 * E4-02 a apporté la numérotation, E4-03 l'écran de vente, E4-04 la résolution
 * du prix — forçage, incitation au palier, plancher —, E4-05 le cycle des
 * documents : la filiation, et le stock qui bouge à la confirmation d'un bon.
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
export { SaleScreen } from '@/modules/sales/SaleScreen'
export {
  documentTotals,
  lineTotalOf,
  lineTotalText,
  type DocumentTotals,
} from '@/modules/sales/amounts'
export {
  DEFAULT_QUANTITY,
  PRICE_MESSAGES,
  addArticle,
  forceUnitPrice,
  lineBelowFloor,
  lineIsComplete,
  releaseUnitPrice,
  removeLine,
  resolvedPrice,
  saleIsComplete,
  setQuantity,
  setUnitPrice,
  stepQuantity,
  type PriceSource,
  type SaleArticle,
  type SaleLine,
} from '@/modules/sales/sale'
export {
  SALE_DOC_TYPE,
  SALE_MESSAGES,
  recordSale,
  type RecordSaleRequest,
  type SaleProgress,
} from '@/modules/sales/saleWrite'
export {
  TRANSFORM_MESSAGES,
  TRANSFORM_TARGET,
  loadForTransformation,
  type TransformationSource,
} from '@/modules/sales/transform'
export {
  documentLineage,
  type DocumentLineage,
  type LinkedDocument,
} from '@/modules/sales/lineage'
