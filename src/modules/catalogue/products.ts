/*
 * Accès aux produits. M1 — E2-02.
 *
 * Ce fichier ne connaît aucun `tenant_id`. La lecture est bornée au commerce
 * par la RLS, et l'insertion prend le commerce du jeton par défaut (migration
 * `product_form`) : l'application n'a rien à envoyer, donc rien à oublier
 * (SPEC § 2.1).
 *
 * L'identifiant d'un produit neuf est engendré ici, par l'appareil — comme
 * celui d'un appareil en E1-03. C'est ce que fera la tablette hors-ligne (E9),
 * et c'est ce qui permet de ranger la photo sous l'identifiant du produit sans
 * relire la ligne.
 *
 * SPEC § 2.6 gouverne la forme des écritures :
 *
 *   — à la création, la charge ne porte que l'identifiant, le nom, et les
 *     champs qui ont une valeur. Un champ jamais rempli n'est pas envoyé du
 *     tout, pas même à `null` : un `null` explicite et une clé absente ne se
 *     distinguent pas à l'écran, mais ils se distinguent en base — l'absence
 *     laisse jouer le défaut de la colonne, le `null` l'écrase ;
 *   — à la modification, seules les colonnes changées partent. Un champ vidé
 *     part à `null`, parce que c'est ce que le patron a fait. Chaque écriture
 *     de trop est une ligne de plus à réconcilier au retour du réseau (§ 2.5).
 */

import { supabase } from '@/lib/supabase'

/** Un produit, tel que la fiche le lit. */
export interface Product {
  id: string
  name: string
  code: string | null
  nameAr: string | null
  categoryId: string | null
  brand: string | null
  /** Chemin dans le compartiment `product-photo`, pas une URL. */
  photoPath: string | null
  unitLabel: string | null
  piecesPerCarton: number | null
}

/** Ce que le formulaire manipule : du texte, et rien d'autre. */
export interface ProductDraft {
  name: string
  code: string
  nameAr: string
  categoryId: string
  brand: string
  unitLabel: string
  piecesPerCarton: string
}

export const EMPTY_DRAFT: ProductDraft = {
  name: '',
  code: '',
  nameAr: '',
  categoryId: '',
  brand: '',
  unitLabel: '',
  piecesPerCarton: '',
}

type Column =
  | 'name_fr'
  | 'code'
  | 'name_ar'
  | 'category_id'
  | 'brand'
  | 'unit_label'
  | 'pieces_per_carton'

/** Ce qu'une modification envoie : des colonnes, et la photo. */
export type ProductChanges = Partial<Record<Column, string | number | null>> & {
  photo_url?: string | null
}

const FIELDS: ReadonlyArray<readonly [keyof ProductDraft, Column]> = [
  ['name', 'name_fr'],
  ['code', 'code'],
  ['nameAr', 'name_ar'],
  ['categoryId', 'category_id'],
  ['brand', 'brand'],
  ['unitLabel', 'unit_label'],
  ['piecesPerCarton', 'pieces_per_carton'],
]

interface ProductRow {
  id: string
  name_fr: string
  code: string | null
  name_ar: string | null
  category_id: string | null
  brand: string | null
  photo_url: string | null
  unit_label: string | null
  pieces_per_carton: number | null
}

const COLUMNS =
  'id, name_fr, code, name_ar, category_id, brand, photo_url, unit_label, pieces_per_carton'

/*
 * Les messages. Chaque garde parle avec ses propres mots (CLAUDE.md, E1-02) :
 * l'écran masqué renvoie à l'accueil, la policy refuse en `42501`, et une
 * modification qui ne touche aucune ligne se dit autrement encore.
 */
export const PRODUCT_MESSAGES = {
  duplicateCode:
    'Cette référence est déjà utilisée par un autre produit. Changez-la ou laissez-la vide.',
  refused: 'Ce compte ne peut pas modifier le catalogue : la base a refusé l’enregistrement.',
  notSaved:
    'Produit non enregistré : il n’existe plus, ou ce compte n’a pas le droit de le modifier.',
} as const

/** Chiffres seuls — ce que le champ « pièces par carton » laisse entrer. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '')
}

/** Le seul champ qui conditionne l'enregistrement (SPEC § 2.6). */
export function canSave(draft: ProductDraft): boolean {
  return draft.name.trim() !== ''
}

/*
 * La valeur d'une colonne, déduite du texte saisi. Le vide est `null` ; une
 * quantité de pièces nulle ou illisible aussi : la contrainte `> 0` de la base
 * ne doit jamais servir de reproche, elle ne voit donc jamais passer de zéro.
 */
function columnValue(field: keyof ProductDraft, raw: string): string | number | null {
  const text = raw.trim()
  if (field === 'piecesPerCarton') {
    const pieces = Number.parseInt(text, 10)
    return Number.isInteger(pieces) && pieces > 0 ? pieces : null
  }
  return text === '' ? null : text
}

export function draftOf(product: Product): ProductDraft {
  return {
    name: product.name,
    code: product.code ?? '',
    nameAr: product.nameAr ?? '',
    categoryId: product.categoryId ?? '',
    brand: product.brand ?? '',
    unitLabel: product.unitLabel ?? '',
    piecesPerCarton: product.piecesPerCarton === null ? '' : String(product.piecesPerCarton),
  }
}

/** La charge d'une création : l'identifiant, puis les seules colonnes qui ont une valeur. */
export function creationPayload(id: string, draft: ProductDraft): Record<string, string | number> {
  const payload: Record<string, string | number> = { id }
  for (const [field, column] of FIELDS) {
    const value = columnValue(field, draft[field])
    if (value !== null) payload[column] = value
  }
  return payload
}

/** Les colonnes qui ont changé entre l'état enregistré et le brouillon. */
export function changesBetween(saved: ProductDraft, draft: ProductDraft): ProductChanges {
  const changes: ProductChanges = {}
  for (const [field, column] of FIELDS) {
    const before = columnValue(field, saved[field])
    const after = columnValue(field, draft[field])
    if (before !== after) changes[column] = after
  }
  return changes
}

interface PostgrestErrorLike {
  code?: string
  message: string
}

/*
 * Une référence déjà prise se heurte à l'un de deux index : celui des
 * références, ou celui des SKU, que la référence alimente (E2-01). Pour le
 * patron, c'est la même chose — la référence est prise.
 */
function failure(error: PostgrestErrorLike): Error {
  if (
    error.code === '23505' &&
    (error.message.includes('product_code_per_tenant') ||
      error.message.includes('variant_sku_per_tenant'))
  ) {
    return new Error(PRODUCT_MESSAGES.duplicateCode)
  }
  if (error.code === '42501') return new Error(PRODUCT_MESSAGES.refused)
  return new Error(error.message)
}

function productOf(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name_fr,
    code: row.code,
    nameAr: row.name_ar,
    categoryId: row.category_id,
    brand: row.brand,
    photoPath: row.photo_url,
    unitLabel: row.unit_label,
    piecesPerCarton: row.pieces_per_carton,
  }
}

/** Un produit non supprimé, ou `null` s'il n'existe pas ou plus. */
export async function getProduct(id: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('product')
    .select(COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (error !== null) throw new Error(error.message)
  return data === null ? null : productOf(data as ProductRow)
}

export async function createProduct(id: string, draft: ProductDraft): Promise<void> {
  const { error } = await supabase.from('product').insert(creationPayload(id, draft))
  if (error !== null) throw failure(error)
}

/**
 * Modifie un produit, et exige d'avoir touché sa ligne. Un UPDATE refusé par la
 * RLS ne lève pas : il ne trouve rien. Sans ce contrôle, « Enregistré »
 * s'afficherait sur une écriture qui n'a pas eu lieu.
 */
export async function updateProduct(id: string, changes: ProductChanges | { deleted_at: string | null }): Promise<void> {
  const { data, error } = await supabase.from('product').update(changes).eq('id', id).select('id')

  if (error !== null) throw failure(error)
  if ((data as unknown[] | null)?.length !== 1) throw new Error(PRODUCT_MESSAGES.notSaved)
}

/*
 * Suppression douce (SPEC § 4). La base propage la date aux variantes, et la
 * restauration les rétablit (E2-01). La date vient de l'appareil, comme elle
 * en viendra hors-ligne.
 */
export async function deleteProduct(id: string): Promise<void> {
  await updateProduct(id, { deleted_at: new Date().toISOString() })
}

export async function restoreProduct(id: string): Promise<void> {
  await updateProduct(id, { deleted_at: null })
}
