/*
 * Accès aux variantes — E2-06.
 *
 * Ce fichier ne connaît aucun `tenant_id` : la RLS borne la lecture, et les
 * policies d'écriture de `variant` exigent `manage_product` (§ 3.1). Il ne
 * connaît pas non plus de coût — `cost_price` vit sur `variant_cost`, relation
 * restreinte (SPEC § 3, RÈGLE de placement des coûts), et rien ici ne la lit.
 */

import { supabase } from '@/lib/supabase'

export interface Variant {
  id: string
  sku: string | null
  barcode: string | null
  /** Date de la première étiquette imprimée, ou `null`. Le SKU est figé dès qu'elle existe. */
  skuPrintedAt: string | null
  isDefault: boolean
}

interface VariantRow {
  id: string
  sku: string | null
  barcode: string | null
  sku_printed_at: string | null
  is_default: boolean
}

const COLUMNS = 'id, sku, barcode, sku_printed_at, is_default'

/*
 * Chaque refus parle avec ses propres mots (CLAUDE.md, E1-02). Le code-barres en
 * double et la référence en double répondent le même `23505` : c'est le **nom de
 * la contrainte** qui les sépare, jamais le code seul.
 */
export const VARIANT_MESSAGES = {
  duplicateBarcode:
    'Ce code-barres est déjà celui d’un autre produit. Scannez-le pour retrouver ce produit, ou corrigez la saisie.',
  printedSku:
    'Une étiquette porte déjà ce code : il ne se modifie plus, sinon l’étiquette ne désigne plus rien.',
  refused: 'Ce compte ne peut pas modifier le catalogue : la base a refusé l’enregistrement.',
  notSaved:
    'Non enregistré : cette variante n’existe plus, ou ce compte n’a pas le droit de la modifier.',
} as const

interface PostgrestErrorLike {
  code?: string
  message: string
}

function failure(error: PostgrestErrorLike): Error {
  if (error.code === '23505' && error.message.includes('variant_barcode_per_tenant')) {
    return new Error(VARIANT_MESSAGES.duplicateBarcode)
  }
  // `2F004` — le garde de l'étiquette imprimée (migration `barcodes`).
  if (error.code === '2F004') return new Error(VARIANT_MESSAGES.printedSku)
  if (error.code === '42501') return new Error(VARIANT_MESSAGES.refused)
  return new Error(error.message)
}

function variantOf(row: VariantRow): Variant {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    skuPrintedAt: row.sku_printed_at,
    isDefault: row.is_default,
  }
}

/** Les variantes vivantes d'un produit, la variante par défaut en tête. */
export async function listVariants(productId: string): Promise<Variant[]> {
  const { data, error } = await supabase
    .from('variant')
    .select(COLUMNS)
    .eq('product_id', productId)
    .is('deleted_at', null)
    .order('is_default', { ascending: false })
    .order('sku', { ascending: true })

  if (error !== null) throw new Error(error.message)
  return ((data ?? []) as VariantRow[]).map(variantOf)
}

/**
 * Pose ou retire le code-barres d'une variante.
 *
 * Vide vaut `null` : « pas de code-barres » est une absence. La base le
 * normalise déjà — espaces de bord et retour chariot de la douchette — mais
 * l'envoyer propre évite une écriture qui ne change rien (SPEC § 2.5).
 */
export async function setBarcode(variantId: string, barcode: string): Promise<void> {
  const value = barcode.trim() === '' ? null : barcode.trim()

  const { data, error } = await supabase
    .from('variant')
    .update({ barcode: value })
    .eq('id', variantId)
    .select('id')

  if (error !== null) throw failure(error)
  if ((data as unknown[] | null)?.length !== 1) throw new Error(VARIANT_MESSAGES.notSaved)
}

/**
 * Fige les SKU que la planche vient d'imprimer.
 *
 * `is('sku_printed_at', null)` : la date est celle de la **première**
 * impression. Réimprimer une planche ne la repousse pas — le garde en base
 * refuserait l'écriture en `2F004`, et ce filtre fait que la question ne se pose
 * pas. Le silence est ici la bonne réponse : rien à figer n'est pas une erreur.
 *
 * La date vient de l'appareil, comme celle de la suppression douce (E2-02) :
 * c'est l'heure de l'impression, pas celle de la synchronisation (SPEC § 2.5).
 */
export async function markSkuPrinted(variantIds: readonly string[]): Promise<void> {
  if (variantIds.length === 0) return

  const { error } = await supabase
    .from('variant')
    .update({ sku_printed_at: new Date().toISOString() })
    .in('id', [...variantIds])
    .is('sku_printed_at', null)

  if (error !== null) throw failure(error)
}
