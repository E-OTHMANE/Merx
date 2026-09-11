/*
 * La résolution du prix par palier. M1 — E2-03, RÈGLE M1-2.
 *
 * « Prix : prendre la ligne `price_break` de plus grand `min_qty` inférieur ou
 * égal à la quantité demandée. »
 *
 * Sur l'appareil, pas en base : l'écran de vente la rejoue à chaque changement
 * de quantité (RÈGLE M1-3, E4-04), y compris après des jours sans réseau
 * (SPEC § 2.5). Une fonction pure, sans accès aux données — l'appelant lui
 * passe les paliers vivants de la variante, ceux dont `deleted_at` est nul.
 *
 * Deux absences, et elles ne se comblent pas l'une par l'autre :
 *
 *   — aucun palier ne convient (quantité inférieure au plus petit `min_qty`,
 *     par exemple 0,5 face à la ligne à l'unité) : `null`. La RÈGLE ne dit pas
 *     d'appliquer la ligne à l'unité en dessous de 1, et étendre la ligne à
 *     l'unité serait la réinterpréter. Arbitré en E2-03 ;
 *   — le palier retenu n'a pas de prix (« prix non renseigné ») : il est rendu
 *     tel quel, `unitPrice` nul. On ne retombe pas sur un palier inférieur —
 *     ce serait choisir une ligne que la RÈGLE ne désigne pas.
 *
 * Dans les deux cas, la vente ne propose aucun prix automatique et le vendeur
 * le saisit. Rien ne bloque une vente (SPEC § 2.6).
 *
 * Comparaisons exactes, en entiers mis à l'échelle (`@/lib/decimal`) : jamais
 * de flottant.
 */

import { QUANTITY_SCALE, parseDecimal } from '@/lib/decimal'

/** Un palier, tel que la base le rend en texte. */
export interface PriceBreakLike {
  /** `quantity`, en texte : `"10.000"`. */
  minQty: string
  /** `money_amount`, en texte ; `null` : prix non renseigné. */
  unitPrice: string | null
}

/**
 * Le palier qui s'applique à `quantity`, ou `null` si aucun ne convient —
 * quantité illisible comprise.
 */
export function resolvePriceBreak<T extends PriceBreakLike>(
  breaks: readonly T[],
  quantity: string,
): T | null {
  const wanted = parseDecimal(quantity, QUANTITY_SCALE)
  if (wanted === null) return null

  let best: T | null = null
  let bestMin: bigint | null = null

  for (const candidate of breaks) {
    const min = parseDecimal(candidate.minQty, QUANTITY_SCALE)
    if (min === null) {
      // La base ne rend jamais cela : `quantity` est un numeric(12,3). Mieux
      // vaut le dire que d'ignorer un palier et vendre au mauvais prix.
      throw new Error(`Palier illisible : min_qty = « ${candidate.minQty} »`)
    }
    if (min <= wanted && (bestMin === null || min > bestMin)) {
      best = candidate
      bestMin = min
    }
  }

  return best
}
