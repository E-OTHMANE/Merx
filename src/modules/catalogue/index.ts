/*
 * Surface publique du module Catalogue (M1). E2-02.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses
 * internes. Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 */

export { ProductListScreen } from '@/modules/catalogue/ProductListScreen'
export { ProductFormScreen } from '@/modules/catalogue/ProductFormScreen'
export {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  type Product,
  type ProductSummary,
} from '@/modules/catalogue/products'
export { listCategories, type Category } from '@/modules/catalogue/categories'
export { PriceGridScreen } from '@/modules/catalogue/PriceGridScreen'
export { resolvePriceBreak, type PriceBreakLike } from '@/modules/catalogue/pricing'
