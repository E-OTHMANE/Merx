/*
 * Les montants d'un bon — E4-03, règle tranchée en E4-04.
 *
 * Une quantité est un `numeric(12,3)`, un prix un `numeric(12,2)` : leur
 * produit porte cinq décimales, et il faut revenir à deux. La règle, RÈGLE M3-7
 * de SPEC § 8 :
 *
 *     line_total = round(quantity × unit_price, 2) − line_discount
 *
 * **demi loin de zéro**, **au niveau de la ligne** ; le document somme les
 * totaux de ligne *arrondis*, parce que c'est le total de ligne qui s'imprime.
 *
 * **Et elle n'est pas écrite ici.** `sale_line.line_total` est une colonne
 * **engendrée** depuis E4-04 : la base la calcule, l'appareil ne l'envoie pas
 * (`saleWrite.ts`), et l'accord sur le centime est structurel au lieu d'être
 * asserté. Ce qui suit ne sert qu'à **afficher** — le total d'une ligne pendant
 * la saisie, le total du bon sous le pouce — et doit donner le même centime que
 * la base : demi loin de zéro est ce que fait `round(numeric, 2)` de Postgres.
 * L'accord est **mesuré** à chaque passage de la suite, sur la vraie base, par
 * `supabase/tests/sale-price.test.ts` ; il n'est pas supposé.
 *
 * Les totaux du document, eux, sont bien envoyés — `subtotal`, `discount_total`
 * et `total` sont des colonnes ordinaires —, et la base vérifie à la
 * confirmation qu'ils disent la vérité sur les lignes
 * (`merx.require_consistent_totals()`).
 *
 * Tout est en entiers mis à l'échelle (`BigInt`, `@/lib/decimal`) : jamais de
 * flottant sur un montant, nulle part (CLAUDE.md).
 *
 * Pas de remise dans cette story : `line_discount` et `discount_total` restent
 * à zéro, et aucun écran ne les saisit. Les poser à zéro est ce que fait déjà
 * la base par défaut ; les calculer ici serait construire en avance.
 */

import { MONEY_SCALE, QUANTITY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'

/** 10³ : les trois décimales que le produit porte en trop. */
const EXCESS = 10n ** BigInt(QUANTITY_SCALE)

/**
 * Le total d'une ligne, à l'échelle des montants. `null` si la quantité ou le
 * prix n'est pas lisible — l'appelant n'affiche alors aucun total plutôt qu'un
 * total faux.
 *
 * `quantity` et `unitPrice` sont du texte, dans la forme de la base
 * (`"24.000"`, `"12.50"`) ou dans celle d'un champ (`"24"`, `"12,5"`).
 */
export function lineTotalOf(quantity: string, unitPrice: string): bigint | null {
  const qty = parseDecimal(quantity, QUANTITY_SCALE)
  const price = parseDecimal(unitPrice, MONEY_SCALE)
  if (qty === null || price === null) return null

  const exact = qty * price
  const whole = exact / EXCESS
  const rest = exact % EXCESS

  // Demi loin de zéro, comme `round(numeric, 2)`. Quantité et prix sont
  // positifs ou nuls (contraintes `sale_line_quantity_positive` et
  // `sale_line_amounts_not_negative`), donc le reste l'est aussi : pas de cas
  // négatif à traiter.
  return rest * 2n >= EXCESS ? whole + 1n : whole
}

/**
 * La même chose, en texte à deux décimales : `"300.00"`. L'affichage et la
 * somme du document en ont besoin ; la ligne, elle, ne l'envoie plus.
 */
export function lineTotalText(quantity: string, unitPrice: string): string | null {
  const total = lineTotalOf(quantity, unitPrice)
  return total === null ? null : toSqlDecimal(total, MONEY_SCALE)
}

export interface DocumentTotals {
  /** `"1250.00"` — la forme que la base reçoit. */
  subtotal: string
  discountTotal: string
  total: string
}

/**
 * Les totaux du document : la somme des totaux de ligne.
 *
 * Une ligne dont le total n'est pas calculable compte pour zéro — l'écran, lui,
 * interdit d'enregistrer un bon qui en contient une. Sommer les lignes
 * arrondies et non le produit exact est la seconde moitié de l'arbitrage
 * provisoire ci-dessus : c'est le total de ligne qui s'imprime, donc c'est lui
 * qui s'additionne.
 */
export function documentTotals(
  lines: ReadonlyArray<{ quantity: string; unitPrice: string }>,
): DocumentTotals {
  let subtotal = 0n
  for (const line of lines) {
    subtotal += lineTotalOf(line.quantity, line.unitPrice) ?? 0n
  }

  const text = toSqlDecimal(subtotal, MONEY_SCALE)
  return { subtotal: text, discountTotal: toSqlDecimal(0n, MONEY_SCALE), total: text }
}
