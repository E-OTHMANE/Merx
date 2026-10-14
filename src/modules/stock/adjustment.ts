/*
 * L'ajustement manuel d'une quantité. M2 — E3-03.
 *
 * Le patron saisit la quantité qu'il a devant lui ; ce qui part en base est la
 * **différence**, en un `stock_movement` de type `adjustment` (RÈGLE M2-1 :
 * `stock_level` ne s'écrit jamais directement). Le motif voyage dans `note`, et
 * il est obligatoire — contrainte `stock_movement_adjustment_reason`, § 2.6 ne
 * s'y appliquant pas : le motif n'est pas un accessoire de l'ajustement, il en
 * est le contenu.
 *
 * Insertion directe, sans RPC. Trois gardes la tiennent, et aucun n'est ici :
 * la policy `column_capability_insert` exige `adjust_stock` (le patron seul,
 * § 3.1), la contrainte refuse un motif vide, le trigger d'audit journalise
 * l'écriture sous `stock_adjustment` (RÈGLE M8-1) et refuse ce qui n'a pas
 * d'auteur. Une fonction `security definer` aurait contourné la policy et
 * obligé à réécrire le droit ailleurs que dans la matrice.
 *
 * **Ni `tenant_id` ni `created_by` ne sont envoyés** : ils ont pour défaut le
 * commerce et la fiche du jeton (SPEC § 4, et E3-03 pour l'auteur). Les écrire
 * ici serait laisser l'appareil signer à la place du jeton.
 *
 * La différence est calculée sur le niveau **lu à l'écran**. Une vente
 * concurrente entre la lecture et l'écriture décale le résultat du nombre
 * saisi : assumé — un appareil par commerce en V1 (SPEC § 2.5), mouvements
 * additifs, et une correction se corrige par une autre correction (RÈGLE M2-2).
 * Aucun verrou n'est construit en avance pour E10.
 */

import { QUANTITY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'
import { supabase } from '@/lib/supabase'

export const ADJUSTMENT_MESSAGES = {
  unreadable: 'Quantité illisible.',
  reasonRequired: 'Le motif est obligatoire.',
  noChange: 'Cette quantité est déjà celle du stock.',
  refused: 'Seul le patron peut ajuster une quantité.',
} as const

export interface AdjustmentDraft {
  variantId: string
  warehouseId: string
  /** Le niveau lu à l'écran, en décimal texte, signé. */
  currentQuantity: string
  /** La quantité corrigée, telle que le patron l'a tapée. */
  correctedQuantity: string
  reason: string
}

/**
 * La différence à poser, en entier mis à l'échelle — jamais un flottant
 * (CLAUDE.md). `null` quand l'une des deux quantités est illisible.
 *
 * La quantité corrigée est toujours positive : c'est ce qui est physiquement
 * sur l'étagère, et `parseDecimal()` n'accepte pas de signe. Le niveau actuel,
 * lui, peut être négatif (RÈGLE M2-3) — d'où le signe traité à part, comme
 * `quantityText()` le fait pour l'affichage.
 */
export function adjustmentDelta(current: string, corrected: string): bigint | null {
  const trimmed = current.trimStart()
  const negative = trimmed.startsWith('-')

  const from = parseDecimal(negative ? trimmed.slice(1) : trimmed, QUANTITY_SCALE)
  const to = parseDecimal(corrected, QUANTITY_SCALE)
  if (from === null || to === null) return null

  return to - (negative ? -from : from)
}

/** La différence telle qu'elle s'affiche avant validation : `+12`, `-3,5`. */
export function deltaText(delta: bigint): string {
  const text = toSqlDecimal(delta < 0n ? -delta : delta, QUANTITY_SCALE)
    .replace(/\.?0+$/, '')
    .replace('.', ',')

  if (delta === 0n) return '0'
  return `${delta < 0n ? '-' : '+'}${text}`
}

/**
 * Pose l'ajustement, et rend la différence écrite.
 *
 * Les trois refus sont dits avant l'aller-retour parce que l'écran les connaît
 * déjà — il n'offre pas le bouton sans motif ni sans quantité lisible. Ils sont
 * quand même vérifiés ici : ce qui garde la base est la base, et ce qui garde
 * cette fonction d'écrire n'importe quoi est ce bloc-ci.
 */
export async function adjustStock(draft: AdjustmentDraft): Promise<bigint> {
  const reason = draft.reason.trim()
  if (reason === '') throw new Error(ADJUSTMENT_MESSAGES.reasonRequired)

  const delta = adjustmentDelta(draft.currentQuantity, draft.correctedQuantity)
  if (delta === null) throw new Error(ADJUSTMENT_MESSAGES.unreadable)

  /*
   * Une différence nulle n'est pas une erreur de saisie, et elle n'écrit rien :
   * `stock_movement` refuse une quantité de zéro depuis E3-01 — un mouvement
   * qui ne dit rien encombrerait l'historique qu'on relit pour comprendre un
   * écart.
   */
  if (delta === 0n) throw new Error(ADJUSTMENT_MESSAGES.noChange)

  const { error } = await supabase.from('stock_movement').insert({
    variant_id: draft.variantId,
    warehouse_id: draft.warehouseId,
    movement_type: 'adjustment',
    quantity: toSqlDecimal(delta, QUANTITY_SCALE),
    note: reason,
  })

  if (error !== null) {
    if (error.code === '42501') throw new Error(ADJUSTMENT_MESSAGES.refused)
    if (error.code === '23514' && error.message.includes('stock_movement_adjustment_reason')) {
      throw new Error(ADJUSTMENT_MESSAGES.reasonRequired)
    }
    throw new Error(error.message)
  }

  return delta
}
