/*
 * La grille de prix d'une variante : paliers, plancher, prix d'achat. M1 — E2-03.
 *
 * La grille est celle de la variante **par défaut** : sans le pack de
 * déclinaisons, un produit n'en a qu'une (SPEC § 2.3). Le jour où le pack
 * existe, il choisira la variante ; ce fichier n'aura pas à changer de forme.
 *
 * Trois relations, trois droits, et ce fichier n'en vérifie aucun : la base le
 * fait (SPEC § 3.1).
 *
 *   — `price_break` : les paliers, `manage_price_list` ;
 *   — `variant.floor_price` : le plancher, un prix de vente — `manage_product` ;
 *   — `variant_cost` : le prix d'achat, `view_cost`. Lu seulement quand le
 *     compte a ce droit : pour un autre, la requête rendrait une liste vide, et
 *     l'écran afficherait « aucun coût » là où il n'a simplement rien à dire.
 *
 * Montants et quantités voyagent en texte, demandés en texte à PostgREST
 * (`min_qty::text`) : jamais de flottant (`@/lib/decimal`).
 *
 * L'enregistrement se fait ligne par ligne, dans la forme que la
 * synchronisation hors-ligne rejouera (E9) — pas par une fonction serveur qui
 * réécrirait la grille d'un bloc. L'ordre compte :
 *
 *   1. les paliers retirés partent d'abord (suppression douce, SPEC § 4) —
 *      sinon un palier déplacé de 10 à 12, puis un nouveau posé à 10,
 *      heurteraient l'unicité des paliers ;
 *   2. les prix changés ;
 *   3. les paliers ajoutés.
 *
 * Un palier dont la quantité change est retiré puis recréé : la quantité est
 * ce qui identifie un palier, pour le commerçant comme pour l'unicité.
 *
 * La ligne à l'unité (`min_qty = 1`) n'est jamais retirée ni déplacée : la base
 * le refuserait (RÈGLE M1-2, E2-03). Seul son prix se modifie, et il peut
 * rester vide — « prix non renseigné » (SPEC § 2.6).
 */

import {
  MONEY_SCALE,
  QUANTITY_SCALE,
  inputText,
  parseDecimal,
  toSqlDecimal,
} from '@/lib/decimal'
import { supabase } from '@/lib/supabase'
import { getProduct } from '@/modules/catalogue/products'

/** 1, à l'échelle des quantités. */
const BASE_QUANTITY = parseDecimal('1', QUANTITY_SCALE)!

/** Un palier, tel que la base le rend. */
export interface StoredBreak {
  id: string
  /** `"10.000"` */
  minQty: string
  /** `"11.00"`, ou `null` : prix non renseigné. */
  unitPrice: string | null
}

/** La grille enregistrée. */
export interface SavedGrid {
  productId: string
  productName: string
  variantId: string
  breaks: StoredBreak[]
  floorPrice: string | null
  /** Absent : ce compte ne lit pas le prix d'achat. `null` : aucun coût connu. */
  costPrice?: string | null
}

/** Un palier, tel que le formulaire le manipule : du texte. */
export interface BreakDraft {
  /** Clé d'affichage, stable pendant l'édition. */
  key: string
  /** `null` : palier ajouté, pas encore enregistré. */
  id: string | null
  /** La ligne à l'unité : quantité figée à 1, jamais retirée. */
  base: boolean
  minQty: string
  unitPrice: string
}

export interface GridDraft {
  breaks: BreakDraft[]
  floorPrice: string
  costPrice: string
}

/** Ce qu'un enregistrement envoie. */
export interface GridChanges {
  retired: string[]
  repriced: Array<{ id: string; unitPrice: string | null }>
  added: Array<{ id: string; minQty: string; unitPrice: string }>
  floorPrice?: string | null
  costPrice?: string | null
}

/*
 * Chaque garde parle avec ses propres mots (CLAUDE.md, E1-02) : l'écran masqué
 * renvoie à l'accueil, la policy qui refuse une insertion répond `42501`, et
 * une modification qui ne touche aucune ligne se dit autrement encore.
 */
export const PRICE_GRID_MESSAGES = {
  duplicateQuantity:
    'Deux paliers ont la même quantité. Changez la quantité de l’un des deux.',
  refused: 'Ce compte ne peut pas modifier les prix : la base a refusé l’enregistrement.',
  notSaved:
    'Grille non enregistrée : ce produit n’existe plus, ou ce compte n’a pas le droit de la modifier.',
} as const

interface PostgrestErrorLike {
  code?: string
  message: string
}

function failure(error: PostgrestErrorLike): Error {
  if (error.code === '23505' && error.message.includes('price_break_min_qty_per_variant')) {
    return new Error(PRICE_GRID_MESSAGES.duplicateQuantity)
  }
  if (error.code === '42501') return new Error(PRICE_GRID_MESSAGES.refused)
  return new Error(error.message)
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * La grille de la variante par défaut d'un produit non supprimé, ou `null` s'il
 * n'existe pas ou plus. `withCost` : le compte a `view_cost`.
 */
export async function loadGrid(productId: string, withCost: boolean): Promise<SavedGrid | null> {
  const product = await getProduct(productId)
  if (product === null) return null

  const { data: variant, error: variantError } = await supabase
    .from('variant')
    .select('id, floor_price::text')
    .eq('product_id', productId)
    .eq('is_default', true)
    .is('deleted_at', null)
    .maybeSingle()
  if (variantError !== null) throw new Error(variantError.message)
  if (variant === null) return null
  const { id: variantId, floor_price: floorPrice } = variant as {
    id: string
    floor_price: string | null
  }

  const { data: rows, error: breaksError } = await supabase
    .from('price_break')
    .select('id, min_qty::text, unit_price::text')
    .eq('variant_id', variantId)
    .is('deleted_at', null)
  if (breaksError !== null) throw new Error(breaksError.message)

  const breaks = (rows as Array<{ id: string; min_qty: string; unit_price: string | null }>).map(
    (row) => ({ id: row.id, minQty: row.min_qty, unitPrice: row.unit_price }),
  )
  const grid: SavedGrid = { productId, productName: product.name, variantId, breaks, floorPrice }
  if (!withCost) return grid

  const { data: cost, error: costError } = await supabase
    .from('variant_cost')
    .select('cost_price::text')
    .eq('variant_id', variantId)
    .maybeSingle()
  if (costError !== null) throw new Error(costError.message)

  return { ...grid, costPrice: (cost as { cost_price: string } | null)?.cost_price ?? null }
}

/* -------------------------------------------------------------------------- */
/* Le formulaire                                                               */
/* -------------------------------------------------------------------------- */

const quantityOf = (text: string): bigint | null => parseDecimal(text, QUANTITY_SCALE)

/** Un montant saisi : `null` pour un champ vide, `undefined` s'il est illisible. */
function amountOf(text: string): bigint | null | undefined {
  if (text.trim() === '') return null
  return parseDecimal(text, MONEY_SCALE) ?? undefined
}

const storedAmount = (text: string | null): bigint | null =>
  text === null ? null : parseDecimal(text, MONEY_SCALE)

const isBase = (stored: StoredBreak): boolean => quantityOf(stored.minQty) === BASE_QUANTITY

function compareQuantities(a: StoredBreak, b: StoredBreak): number {
  const qa = quantityOf(a.minQty) ?? 0n
  const qb = quantityOf(b.minQty) ?? 0n
  return qa < qb ? -1 : qa > qb ? 1 : 0
}

/**
 * Le formulaire, à partir de la grille enregistrée, par quantité croissante :
 * la ligne à l'unité d'abord, sauf palier posé sous l'unité.
 */
export function draftOfGrid(saved: SavedGrid): GridDraft {
  return {
    breaks: [...saved.breaks].sort(compareQuantities).map((stored) => ({
      key: stored.id,
      id: stored.id,
      base: isBase(stored),
      minQty: inputText(stored.minQty, 'quantity'),
      unitPrice: inputText(stored.unitPrice, 'money'),
    })),
    floorPrice: inputText(saved.floorPrice, 'money'),
    costPrice: inputText(saved.costPrice ?? null, 'money'),
  }
}

/** Un palier vierge, que « Ajouter un palier » pose au bas de la grille. */
export function newBreak(key: string): BreakDraft {
  return { key, id: null, base: false, minQty: '', unitPrice: '' }
}

type RowState = 'empty' | 'partial' | 'complete'

/*
 * Un palier vide est ignoré ; un palier à moitié rempli retient
 * l'enregistrement, sans un mot (SPEC § 2.6) — on ne sait pas encore ce que le
 * patron veut, et on ne l'invente pas. La ligne à l'unité est toujours
 * complète : son prix peut rester vide.
 */
function rowState(row: BreakDraft): RowState {
  if (row.base) return amountOf(row.unitPrice) === undefined ? 'partial' : 'complete'
  if (row.minQty === '' && row.unitPrice === '') return 'empty'

  const quantity = quantityOf(row.minQty)
  const price = amountOf(row.unitPrice)
  if (quantity === null || quantity <= 0n || price === undefined || price === null) return 'partial'
  return 'complete'
}

/**
 * Le formulaire peut-il partir ? Non si un palier est à moitié rempli, si deux
 * paliers ont la même quantité — la ligne à l'unité comprise —, ou si un
 * montant est illisible. La base refuserait les deux premiers ; l'écran ne lui
 * envoie pas ce qu'il sait refusé.
 */
export function canSaveGrid(draft: GridDraft): boolean {
  const quantities = new Set<bigint>()

  for (const row of draft.breaks) {
    const state = rowState(row)
    if (state === 'partial') return false
    if (state === 'empty') continue

    const quantity = row.base ? BASE_QUANTITY : quantityOf(row.minQty)!
    if (quantities.has(quantity)) return false
    quantities.add(quantity)
  }

  return amountOf(draft.floorPrice) !== undefined && amountOf(draft.costPrice) !== undefined
}

const moneySql = (value: bigint | null): string | null =>
  value === null ? null : toSqlDecimal(value, MONEY_SCALE)

/**
 * Ce qui a changé entre la grille enregistrée et le formulaire. Suppose
 * `canSaveGrid(draft)`. Seul ce qui a changé part : chaque écriture de trop est
 * une ligne de plus à réconcilier au retour du réseau (SPEC § 2.5).
 */
export function gridChanges(saved: SavedGrid, draft: GridDraft, newId: () => string): GridChanges {
  const changes: GridChanges = { retired: [], repriced: [], added: [] }
  const rows = new Map(
    draft.breaks.filter((row) => row.id !== null).map((row) => [row.id!, row]),
  )

  for (const stored of saved.breaks) {
    const row = rows.get(stored.id)
    const base = isBase(stored)

    if (!base && (row === undefined || rowState(row) === 'empty')) {
      changes.retired.push(stored.id)
      continue
    }
    if (row === undefined) continue

    const price = amountOf(row.unitPrice) ?? null
    const quantity = quantityOf(row.minQty)

    if (!base && quantity !== quantityOf(stored.minQty)) {
      changes.retired.push(stored.id)
      changes.added.push({
        id: newId(),
        minQty: toSqlDecimal(quantity!, QUANTITY_SCALE),
        unitPrice: moneySql(price)!,
      })
      continue
    }

    if (price !== storedAmount(stored.unitPrice)) {
      changes.repriced.push({ id: stored.id, unitPrice: moneySql(price) })
    }
  }

  for (const row of draft.breaks) {
    if (row.id !== null || rowState(row) !== 'complete') continue
    changes.added.push({
      id: newId(),
      minQty: toSqlDecimal(quantityOf(row.minQty)!, QUANTITY_SCALE),
      unitPrice: moneySql(amountOf(row.unitPrice) ?? null)!,
    })
  }

  const floor = amountOf(draft.floorPrice) ?? null
  if (floor !== storedAmount(saved.floorPrice)) changes.floorPrice = moneySql(floor)

  if (saved.costPrice !== undefined) {
    const cost = amountOf(draft.costPrice) ?? null
    if (cost !== storedAmount(saved.costPrice)) changes.costPrice = moneySql(cost)
  }

  return changes
}

export function hasChanges(changes: GridChanges): boolean {
  return (
    changes.retired.length > 0 ||
    changes.repriced.length > 0 ||
    changes.added.length > 0 ||
    'floorPrice' in changes ||
    'costPrice' in changes
  )
}

/* -------------------------------------------------------------------------- */
/* Écriture                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Modifie une ligne, et exige de l'avoir touchée. Un UPDATE refusé par la RLS
 * ne lève pas : il ne trouve rien. Sans ce contrôle, « Grille enregistrée »
 * s'afficherait sur une écriture qui n'a pas eu lieu.
 */
async function touch(
  table: 'price_break' | 'variant',
  id: string,
  values: Record<string, string | null>,
): Promise<void> {
  const { data, error } = await supabase.from(table).update(values).eq('id', id).select('id')
  if (error !== null) throw failure(error)
  if ((data as unknown[] | null)?.length !== 1) throw new Error(PRICE_GRID_MESSAGES.notSaved)
}

export async function saveGrid(
  saved: SavedGrid,
  changes: GridChanges,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  for (const id of changes.retired) await touch('price_break', id, { deleted_at: now() })
  for (const { id, unitPrice } of changes.repriced) {
    await touch('price_break', id, { unit_price: unitPrice })
  }

  if (changes.added.length > 0) {
    const { error } = await supabase.from('price_break').insert(
      changes.added.map(({ id, minQty, unitPrice }) => ({
        id,
        variant_id: saved.variantId,
        min_qty: minQty,
        unit_price: unitPrice,
      })),
    )
    if (error !== null) throw failure(error)
  }

  if ('floorPrice' in changes) {
    await touch('variant', saved.variantId, { floor_price: changes.floorPrice ?? null })
  }

  /*
   * Le prix d'achat : une ligne au plus par variante (`variant_cost`). Vider le
   * champ supprime la ligne — pas de coût connu, pas de ligne.
   */
  if ('costPrice' in changes) {
    const { error } =
      changes.costPrice === null || changes.costPrice === undefined
        ? await supabase.from('variant_cost').delete().eq('variant_id', saved.variantId)
        : await supabase
            .from('variant_cost')
            .upsert(
              { variant_id: saved.variantId, cost_price: changes.costPrice },
              { onConflict: 'variant_id' },
            )
    if (error !== null) throw failure(error)
  }
}
