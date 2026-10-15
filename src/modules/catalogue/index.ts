/*
 * Surface publique du module Catalogue (M1). E2-02.
 *
 * CLAUDE.md : un module s'importe par son `index.ts`, jamais par ses
 * internes. Ce qui n'est pas ici n'existe pas pour le reste de l'application.
 */

export { ProductListScreen } from '@/modules/catalogue/ProductListScreen'
export { ProductFormScreen } from '@/modules/catalogue/ProductFormScreen'
export {
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  type Product,
} from '@/modules/catalogue/products'
export {
  SEARCH_DELAY_MS,
  SEARCH_LIMIT,
  latestOnly,
  searchProducts,
  type SearchHit,
} from '@/modules/catalogue/search'
export { signedPhotoUrls } from '@/modules/catalogue/photo'
/* La vente lit les paliers par variante — E4-03. */
export { priceBasisFor, type PriceBasis, type VariantBreaks } from '@/modules/catalogue/priceLookup'
export { listCategories, type Category } from '@/modules/catalogue/categories'
export { PriceGridScreen } from '@/modules/catalogue/PriceGridScreen'
export { LabelSheetScreen } from '@/modules/catalogue/LabelSheetScreen'
export { listVariants, setBarcode, markSkuPrinted, type Variant } from '@/modules/catalogue/variants'
export { ImportScreen } from '@/modules/catalogue/import/ImportScreen'
export {
  nextBreakNudge,
  resolvePriceBreak,
  type BreakNudge,
  type PriceBreakLike,
} from '@/modules/catalogue/pricing'
