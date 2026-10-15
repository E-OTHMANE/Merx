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

import { MONEY_SCALE, QUANTITY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'

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

/* -------------------------------------------------------------------------- */
/* L'incitation au palier suivant — RÈGLE M1-4, E4-04                          */
/* -------------------------------------------------------------------------- */

/**
 * Ce qu'il manque pour atteindre le palier suivant, et ce qu'il y coûterait :
 * « +2 → 12,00 DH ».
 */
export interface BreakNudge {
  /** La quantité qui manque, en texte de base : `"2.000"`. */
  missing: string
  /** Le `min_qty` du palier visé. */
  minQty: string
  /** Son prix unitaire — jamais nul : un palier sans prix n'incite à rien. */
  unitPrice: string
}

/**
 * Le palier suivant vaut-il d'être annoncé ? RÈGLE M1-4 : « si la quantité est
 * à moins de 20 % du palier suivant, afficher « +2 → 12,00 DH ». Fonction
 * produit, pas décoration. »
 *
 * **Le seuil se mesure sur le palier, non sur la quantité demandée** (arbitré
 * en E4-04) : l'écart doit valoir au plus 20 % du `min_qty` visé. Sur l'exemple
 * du spec, un palier à 12 incite à partir de 10 (écart 2, seuil 2,4) et pas à 8
 * (écart 4) — les deux côtés de l'exemple tombent juste. Un seuil assis sur la
 * quantité demandée dériverait à chaque frappe du vendeur, alors que le palier
 * est une propriété de la grille : un carton, une remise.
 *
 * Deux conditions de plus, pour que l'incitation reste une fonction produit :
 *
 *   — le palier visé a un prix. « Prix non renseigné » (E2-03) n'incite à rien ;
 *   — ce prix est **meilleur** que celui de la ligne. Une grille où le palier
 *     suivant coûte plus cher — ou une ligne forcée en dessous — ne doit pas
 *     produire « +2 → 15,00 DH », qui serait une invitation à payer davantage.
 *     Prix de la ligne inconnu : on annonce, c'est alors la seule information
 *     que le vendeur ait.
 */
export function nextBreakNudge(
  breaks: readonly PriceBreakLike[],
  quantity: string,
  currentPrice: string | null,
): BreakNudge | null {
  const wanted = parseDecimal(quantity, QUANTITY_SCALE)
  if (wanted === null) return null

  let target: PriceBreakLike | null = null
  let targetMin: bigint | null = null

  for (const candidate of breaks) {
    if (candidate.unitPrice === null) continue
    const min = parseDecimal(candidate.minQty, QUANTITY_SCALE)
    if (min === null) throw new Error(`Palier illisible : min_qty = « ${candidate.minQty} »`)
    if (min > wanted && (targetMin === null || min < targetMin)) {
      target = candidate
      targetMin = min
    }
  }

  if (target === null || targetMin === null) return null

  const missing = targetMin - wanted
  // Au plus 20 % du palier visé, en entiers : jamais de flottant sur un seuil.
  if (missing * 5n > targetMin) return null

  const offered = parseDecimal(target.unitPrice!, MONEY_SCALE)
  const current = currentPrice === null ? null : parseDecimal(currentPrice, MONEY_SCALE)
  if (offered === null) return null
  if (current !== null && offered >= current) return null

  return {
    missing: toSqlDecimal(missing, QUANTITY_SCALE),
    minQty: target.minQty,
    unitPrice: target.unitPrice!,
  }
}
