/*
 * Surface publique du module Stock (M2). E3-02.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses internes.
 * Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 *
 * La dépendance va **du catalogue vers le stock**, jamais l'inverse : la liste
 * des produits lit les quantités, et le stock lit ce dont il a besoin du
 * produit par ses propres requêtes (`loadProductStock`). Importer
 * `@/modules/catalogue` ici ferait un cycle.
 */

export { VariantStockScreen } from '@/modules/stock/VariantStockScreen'
export { Quantity } from '@/modules/stock/Quantity'
export { readQuantity, type ReadableLevel } from '@/modules/stock/quantityReading'
export {
  listByStockFilter,
  loadProductStock,
  stockLevelsFor,
  STOCK_FILTER_LIMIT,
  type ProductStock,
  type StockEntry,
  type StockFilter,
  type StockLevel,
  type VariantStock,
} from '@/modules/stock/levels'
export {
  listStockMovements,
  MOVEMENT_LABELS,
  SOURCE_LABELS,
  type MovementType,
  type StockMovement,
} from '@/modules/stock/movements'
