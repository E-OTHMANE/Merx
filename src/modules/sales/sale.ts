/*
 * Le bon en cours de saisie — E4-03, E4-04. RÈGLES M1-2 à M1-4, M3-6, point de
 * rupture n° 2.
 *
 * Des fonctions pures, hors de l'écran : ce qui décide d'une ligne, d'une
 * quantité et d'un prix se mesure sans monter React. L'écran n'est que la
 * main posée dessus.
 *
 * **Une ligne par variante.** Les trois entrées de la RÈGLE M3-6 — scan,
 * référence, grille photo — aboutissent à la même ligne, et la même variante
 * ajoutée deux fois **fusionne** : +1 sur la ligne existante, au lieu d'une
 * seconde ligne qui dirait la même chose. Deux conséquences voulues : le
 * vendeur voit tout de suite que l'article est déjà au bon, et la variante est
 * la clé d'affichage — aucun identifiant à engendrer.
 *
 * **Le prix se résout, il ne se fige pas.** `resolvePriceBreak()` (E2-03) est
 * rejouée à chaque changement de quantité, sur les paliers lus à l'ajout de la
 * ligne. Trois cas :
 *
 *   — un palier avec prix s'applique : la ligne est `auto`, et son prix suit la
 *     quantité. Passer de 8 à 12 fait basculer **toute** la ligne ;
 *   — aucun palier ne convient, ou le palier retenu n'a pas de prix
 *     (« prix non renseigné », E2-03) : la ligne passe `manual` et le vendeur
 *     saisit. Rien ne bloque une vente (SPEC § 2.6) ;
 *   — la quantité redevient celle d'un palier pourvu d'un prix : la ligne
 *     repasse `auto`. Un prix saisi faute de palier n'est pas un forçage, et il
 *     ne survit pas à l'arrivée d'une réponse de la grille.
 *
 * **Le forçage, lui, survit à la quantité** — E4-04, et c'est l'inverse exact
 * du troisième cas. Forcer un prix, c'est décider que cette ligne-là se vend à
 * ce prix-là : si la quantité changeait le prix forcé, le forçage ne serait
 * qu'une suggestion. Ce qui suit la quantité est `overriddenPrice`, le prix que
 * la grille donne *maintenant* et que le forçage remplace — la colonne
 * `sale_line.overridden_price`, qui distingue en base les **deux sortes de
 * `manual`** :
 *
 *   auto    | overriddenPrice nul      le prix du palier
 *   manual  | overriddenPrice nul      aucun prix n'existait — E4-03
 *   manual  | overriddenPrice posé     forçage d'un prix qui existait — E4-04
 *
 * Deux retombées de cette règle, et elles sont voulues : un forçage dont la
 * grille cesse de répondre devient une ligne sans prix (il ne remplace plus
 * rien), et un forçage que la grille finit par rejoindre redevient `auto` — un
 * prix égal à celui du palier n'est pas un forçage, et la base le refuse
 * (`sale_line_override_shape`).
 *
 * **Le plancher** (`variant.floor_price`, SPEC § 3.1) est lu avec les paliers.
 * Ici il ne protège rien : il permet de refuser tôt, sous les doigts du
 * vendeur, ce que `merx.require_floor_price()` refusera de toute façon en base.
 */

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  decimalInput,
  inputText,
  parseDecimal,
  toSqlDecimal,
} from '@/lib/decimal'
import { resolvePriceBreak, type PriceBasis, type PriceBreakLike } from '@/modules/catalogue'
import { lineTotalOf } from '@/modules/sales/amounts'

/** D'où vient le prix d'une ligne — la colonne `sale_line.price_source`. */
export type PriceSource = 'auto' | 'manual'

/** Ce qu'une entrée — scan, référence, grille photo — apporte au bon. */
export interface SaleArticle {
  variantId: string
  productId: string
  name: string
  /** La référence lue sous le nom : celle du produit, ou à défaut le SKU. */
  reference: string | null
  photoPath: string | null
}

export interface SaleLine extends SaleArticle {
  /** Texte de champ : `"24"`, `"2,5"`. Jamais un nombre. */
  quantity: string
  /** Texte de champ. Vide : à saisir — la grille n'a pas de réponse. */
  unitPrice: string
  priceSource: PriceSource
  /**
   * Le prix que la grille donne pour cette quantité et que le forçage
   * remplace, en texte de base — `null` quand la ligne n'est pas un forçage.
   */
  overriddenPrice: string | null
  /** Les paliers vivants de la variante, lus une fois, à l'ajout de la ligne. */
  breaks: readonly PriceBreakLike[]
  /** Le plancher de la variante, lu avec eux. `null` : aucun plancher. */
  floorPrice: string | null
}

/** La quantité d'une ligne neuve : une pièce. */
export const DEFAULT_QUANTITY = '1'

export const PRICE_MESSAGES = {
  /*
   * La phrase de l'écran, et elle n'est pas celle de la base : celle du garde
   * nomme la capacité et ne se lit que lorsqu'on a parlé à PostgREST sans
   * passer par ici (CLAUDE.md, deux gardes sur le même chemin).
   */
  belowFloor: 'Prix trop bas pour cet article. Le patron seul peut descendre plus bas.',
} as const

/**
 * Le prix que la grille donne pour cette quantité, en texte de champ — `null`
 * quand elle n'en donne aucun.
 */
export function resolvedPrice(
  breaks: readonly PriceBreakLike[],
  quantity: string,
): string | null {
  const applicable = resolvePriceBreak(breaks, quantity.replace(',', '.'))
  if (applicable === null || applicable.unitPrice === null) return null
  return inputText(applicable.unitPrice, 'money')
}

/** Deux prix de champ désignent-ils le même montant ? */
function sameAmount(left: string, right: string): boolean {
  const a = parseDecimal(left, MONEY_SCALE)
  const b = parseDecimal(right, MONEY_SCALE)
  return a !== null && b !== null && a === b
}

/** Le prix de la grille, dans la forme de la base — pour `overridden_price`. */
function storedResolved(line: SaleLine, quantity: string): string | null {
  const automatic = resolvedPrice(line.breaks, quantity)
  if (automatic === null) return null
  const parsed = parseDecimal(automatic, MONEY_SCALE)
  return parsed === null ? null : toSqlDecimal(parsed, MONEY_SCALE)
}

/** Le prix et sa provenance, après un changement de quantité. */
function priced(line: SaleLine, quantity: string): SaleLine {
  const automatic = resolvedPrice(line.breaks, quantity)

  /*
   * Un forçage traverse le changement de quantité : son prix ne bouge pas, et
   * c'est ce qu'il remplace qui se recalcule. La grille qui le rejoint le
   * dissout — il n'y a plus de forçage quand les deux prix sont le même.
   */
  if (line.overriddenPrice !== null) {
    if (automatic !== null && sameAmount(automatic, line.unitPrice)) {
      return { ...line, quantity, unitPrice: automatic, priceSource: 'auto', overriddenPrice: null }
    }
    return { ...line, quantity, overriddenPrice: storedResolved(line, quantity) }
  }

  if (automatic !== null) {
    return { ...line, quantity, unitPrice: automatic, priceSource: 'auto', overriddenPrice: null }
  }

  // La grille ne répond pas : ce qui restait d'elle s'en va avec elle.
  const kept = line.priceSource === 'manual' ? line.unitPrice : ''
  return { ...line, quantity, unitPrice: kept, priceSource: 'manual', overriddenPrice: null }
}

/**
 * Ajoute l'article au bon, ou ajoute une pièce à sa ligne s'il y est déjà.
 *
 * L'ordre ne bouge pas à la fusion : une ligne qui remonterait d'un coup se
 * perdrait de vue, et le vendeur cherche des yeux ce qu'il vient de scanner.
 */
export function addArticle(
  lines: readonly SaleLine[],
  article: SaleArticle,
  basis: PriceBasis,
): SaleLine[] {
  const existing = lines.find((line) => line.variantId === article.variantId)
  if (existing !== undefined) return stepQuantity(lines, article.variantId, 1)

  const line: SaleLine = {
    ...article,
    quantity: DEFAULT_QUANTITY,
    unitPrice: '',
    priceSource: 'manual',
    overriddenPrice: null,
    breaks: basis.breaks,
    floorPrice: basis.floorPrice,
  }
  return [...lines, priced(line, DEFAULT_QUANTITY)]
}

/**
 * La quantité, telle que le vendeur la tape. Le texte est filtré comme dans
 * tout champ décimal du projet (`decimalInput`) : le champ ne peut pas contenir
 * ce que la base refuserait.
 *
 * Un champ vidé reste vide — on ne remet pas « 1 » sous les doigts de quelqu'un
 * qui efface pour taper 120. L'enregistrement, lui, l'exigera.
 */
export function setQuantity(
  lines: readonly SaleLine[],
  variantId: string,
  raw: string,
): SaleLine[] {
  const quantity = decimalInput(raw, QUANTITY_SCALE)
  return lines.map((line) => (line.variantId === variantId ? priced(line, quantity) : line))
}

/**
 * Une pièce de plus ou de moins. Les deux boutons sont là pour l'ajustement
 * d'une unité ; la quantité d'un grossiste — 24, 48, 120 — se **tape**
 * (BACKLOG E4-03 : chaque tap superflu est payé mille fois par jour).
 *
 * Le plancher est 1 : `sale_line_quantity_positive` refuse 0, et une ligne à
 * zéro se supprime, elle ne se garde pas.
 */
export function stepQuantity(
  lines: readonly SaleLine[],
  variantId: string,
  delta: number,
): SaleLine[] {
  return lines.map((line) => {
    if (line.variantId !== variantId) return line

    const one = 10n ** BigInt(QUANTITY_SCALE)
    const next = (parseDecimal(line.quantity, QUANTITY_SCALE) ?? 0n) + BigInt(delta) * one
    const kept = next < one ? one : next

    return priced(line, inputText(toSqlDecimal(kept, QUANTITY_SCALE), 'quantity'))
  })
}

/**
 * Le prix saisi à la main, faute de palier — la ligne était déjà `manual` et
 * sans prix de grille, et elle le reste. Ce n'est pas un forçage : il n'y a
 * rien à remplacer (E4-03).
 */
export function setUnitPrice(
  lines: readonly SaleLine[],
  variantId: string,
  raw: string,
): SaleLine[] {
  return lines.map((line) =>
    line.variantId === variantId
      ? { ...line, unitPrice: decimalInput(raw, MONEY_SCALE), priceSource: 'manual' }
      : line,
  )
}

/**
 * Le prix forcé — E4-04. La ligne retient ce que la grille donnait : c'est ce
 * qui en fait un forçage, et c'est l'« avant » de l'entrée `price_override`
 * (RÈGLE M8-1).
 *
 * Un prix illisible, ou égal à celui de la grille, ne force rien : la ligne
 * revient au palier plutôt que de porter un forçage qui n'en est pas un, que la
 * base refuserait (`sale_line_override_shape`).
 */
export function forceUnitPrice(
  lines: readonly SaleLine[],
  variantId: string,
  raw: string,
): SaleLine[] {
  const typed = decimalInput(raw, MONEY_SCALE)

  return lines.map((line) => {
    if (line.variantId !== variantId) return line

    const automatic = resolvedPrice(line.breaks, line.quantity)
    if (automatic === null) {
      // Aucun prix à remplacer : c'est la saisie d'E4-03, pas un forçage.
      return { ...line, unitPrice: typed, priceSource: 'manual', overriddenPrice: null }
    }
    if (sameAmount(typed, automatic)) {
      return { ...line, unitPrice: automatic, priceSource: 'auto', overriddenPrice: null }
    }

    return {
      ...line,
      unitPrice: typed,
      priceSource: 'manual',
      overriddenPrice: storedResolved(line, line.quantity),
    }
  })
}

/** Le retour au prix du palier. Le forçage s'abandonne d'un geste. */
export function releaseUnitPrice(lines: readonly SaleLine[], variantId: string): SaleLine[] {
  return lines.map((line) =>
    line.variantId === variantId
      ? priced({ ...line, overriddenPrice: null, priceSource: 'auto' }, line.quantity)
      : line,
  )
}

export function removeLine(lines: readonly SaleLine[], variantId: string): SaleLine[] {
  return lines.filter((line) => line.variantId !== variantId)
}

/** La ligne est-elle sous le plancher de sa variante ? */
export function lineBelowFloor(line: SaleLine): boolean {
  if (line.floorPrice === null) return false
  const floor = parseDecimal(line.floorPrice, MONEY_SCALE)
  const price = parseDecimal(line.unitPrice, MONEY_SCALE)
  return floor !== null && price !== null && price < floor
}

/** Une ligne est complète quand sa quantité et son prix sont lisibles. */
export function lineIsComplete(line: SaleLine): boolean {
  return lineTotalOf(line.quantity, line.unitPrice) !== null
}

/**
 * Le bon peut-il partir ? Au moins une ligne, aucune incomplète, et aucune sous
 * le plancher quand celui qui vend n'a pas le droit d'y descendre. Une quantité
 * à zéro ne passe pas : la base la refuse (`sale_line_quantity_positive`), et
 * l'écran ne la lui présente pas.
 *
 * `belowFloorAllowed` est la capacité `override_price_below_floor`, lue par
 * l'écran. Elle ne protège rien — `merx.require_floor_price()` protège — mais
 * elle évite de présenter à l'employé un bouton qui ne mènerait qu'à un refus.
 */
export function saleIsComplete(
  lines: readonly SaleLine[],
  belowFloorAllowed = true,
): boolean {
  if (lines.length === 0) return false
  return lines.every(
    (line) =>
      lineIsComplete(line) &&
      (parseDecimal(line.quantity, QUANTITY_SCALE) ?? 0n) > 0n &&
      (belowFloorAllowed || !lineBelowFloor(line)),
  )
}
