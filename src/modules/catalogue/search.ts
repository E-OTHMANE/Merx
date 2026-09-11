/*
 * La recherche produit. M1 — E2-04.
 *
 * Tout se passe en base, dans `public.search_products()` : pliage des accents
 * et de l'arabe, tolérance aux fautes, référence partielle, classement, et le
 * filtre du commerce (SPEC § 6, Recherche ; § 2.1, exception nommée). Ce
 * fichier n'en réimplémente rien — une seconde copie de ces règles, côté
 * écran, divergerait de la première sans que rien le dise.
 *
 * Une requête vide rend les 50 premières variantes par ordre alphabétique :
 * c'est la liste, et c'est la même fonction.
 *
 * Hors-ligne, la recherche tournera sur l'appareil (E9) ; rien ici ne le
 * prépare.
 */

import { supabase } from '@/lib/supabase'

/** Une variante trouvée, telle que la liste et la grille la montrent. */
export interface SearchHit {
  variantId: string
  productId: string
  name: string
  nameAr: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  /** Chemin dans le compartiment `product-photo`, pas une URL. */
  photoPath: string | null
}

interface SearchRow {
  variant_id: string
  product_id: string
  name_fr: string
  name_ar: string | null
  code: string | null
  sku: string | null
  barcode: string | null
  photo_url: string | null
}

/*
 * Le temps laissé à la frappe avant d'interroger. Sur une tablette d'entrée de
 * gamme, un appel par touche encombre le réseau pour des réponses aussitôt
 * périmées ; au-delà de 200 ms, le vendeur attend.
 */
export const SEARCH_DELAY_MS = 200

/* Ce que la base rend au plus : `limit 50` dans `public.search_products()`. */
export const SEARCH_LIMIT = 50

export async function searchProducts(query: string): Promise<SearchHit[]> {
  const { data, error } = await supabase.rpc('search_products', { q: query.trim() })
  if (error !== null) throw new Error(error.message)

  return (data as SearchRow[]).map((row) => ({
    variantId: row.variant_id,
    productId: row.product_id,
    name: row.name_fr,
    nameAr: row.name_ar,
    code: row.code,
    sku: row.sku,
    barcode: row.barcode,
    photoPath: row.photo_url,
  }))
}

/**
 * Garde contre les réponses dans le désordre. Une recherche lancée à « cr »
 * peut revenir après celle lancée à « creme » : sans ce garde, la liste
 * afficherait les résultats d'une saisie que le vendeur a déjà dépassée.
 * Chaque appel prend un numéro ; seule la réponse du dernier est retenue — son
 * échec aussi : l'échec d'une saisie dépassée n'a rien à dire au vendeur.
 */
export function latestOnly<T>(run: (query: string) => Promise<T>) {
  let latest = 0
  return async (query: string): Promise<{ current: true; value: T } | { current: false }> => {
    const ticket = ++latest
    try {
      const value = await run(query)
      return ticket === latest ? { current: true, value } : { current: false }
    } catch (error) {
      if (ticket !== latest) return { current: false }
      throw error
    }
  }
}
