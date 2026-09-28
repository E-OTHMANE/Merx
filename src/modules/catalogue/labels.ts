/*
 * Les étiquettes — E2-06.
 *
 * SPEC § 6, RÈGLE M1-5, et l'arbitrage de cette story : **ce qui est imprimé
 * fige ce qui est imprimé.**
 *
 * Deux sources, et elles ne se comportent pas pareil devant l'impression :
 *
 *   — le **code-barres fabricant** (`variant.barcode`) est la voie principale.
 *     Il vient du carton, le système ne l'a pas inventé, et l'imprimer ne
 *     l'engage à rien : le fabricant en répond ;
 *   — le **SKU** n'est imprimé que faute de mieux, et là le système s'engage.
 *     L'étiquette collée doit continuer de désigner la variante, donc le SKU se
 *     fige — `variant.sku_printed_at`, posée à l'impression, jamais effacée.
 *
 * D'où la règle de ce fichier : **une planche ne fige que les SKU qu'elle
 * imprime réellement.** Une étiquette qui porte l'EAN du fabricant ne fige rien,
 * et la référence interne de ce produit-là reste librement corrigeable.
 */

/*
 * La planche : A4 pleine, 3 colonnes de 70 mm par 8 rangées de 37 mm — le
 * format d'étiquettes autocollantes le plus courant, 24 par feuille. 3 × 70 fait
 * exactement les 210 mm de la largeur, 8 × 37 les 296 des 297 : aucune marge à
 * régler, donc aucune dérive d'une imprimante à l'autre.
 */
export const SHEET = {
  columns: 3,
  rows: 8,
  labelWidthMm: 70,
  labelHeightMm: 37,
} as const

export const LABELS_PER_SHEET = SHEET.columns * SHEET.rows

/** Ce qu'on sait d'une variante quand il s'agit de l'étiqueter. */
export interface LabelVariant {
  id: string
  sku: string | null
  barcode: string | null
  skuPrintedAt: string | null
}

/** Ce qu'une étiquette porte. */
export interface Label {
  variantId: string
  /** Le nom du produit, en haut de l'étiquette. */
  name: string
  /** La valeur encodée en barres, et écrite en clair dessous. */
  code: string
  /** Vrai quand c'est le SKU qui est encodé — donc ce qui se fige. */
  isSku: boolean
}

/**
 * Ce qu'une étiquette encode : le code-barres fabricant s'il y en a un, sinon le
 * SKU. `null` quand la variante n'a ni l'un ni l'autre — il faut alors lui
 * attribuer un SKU avant d'imprimer.
 *
 * L'EAN passe devant : c'est celui qui est déjà sur le carton, et le scanner
 * doit rendre le même produit qu'on lise l'étiquette ou l'emballage.
 */
export function encodedValue(variant: LabelVariant): { code: string; isSku: boolean } | null {
  if (variant.barcode !== null) return { code: variant.barcode, isSku: false }
  if (variant.sku !== null) return { code: variant.sku, isSku: true }
  return null
}

/**
 * La planche : chaque variante répétée autant de fois que demandé, dans l'ordre
 * de la liste. Une quantité nulle ou négative ne produit rien — sans reproche,
 * c'est la manière de retirer une ligne de la planche.
 */
export function buildLabels(
  entries: ReadonlyArray<{ variant: LabelVariant; name: string; quantity: number }>,
): Label[] {
  const labels: Label[] = []

  for (const entry of entries) {
    const encoded = encodedValue(entry.variant)
    if (encoded === null) continue

    for (let index = 0; index < Math.floor(entry.quantity); index += 1) {
      labels.push({
        variantId: entry.variant.id,
        name: entry.name,
        code: encoded.code,
        isSku: encoded.isSku,
      })
    }
  }

  return labels
}

/**
 * Les variantes dont l'impression fige le SKU : celles dont l'étiquette encode
 * le SKU, et qui n'en ont pas déjà une d'imprimée.
 *
 * Une seule fois par variante, même répétée douze fois sur la planche : la date
 * est celle de la première impression, et le garde en base refuse la seconde
 * écriture (`2F004`).
 */
export function skusToFreeze(
  entries: ReadonlyArray<{ variant: LabelVariant; quantity: number }>,
): string[] {
  const frozen: string[] = []

  for (const entry of entries) {
    if (Math.floor(entry.quantity) < 1) continue
    if (entry.variant.skuPrintedAt !== null) continue
    if (encodedValue(entry.variant)?.isSku !== true) continue
    if (!frozen.includes(entry.variant.id)) frozen.push(entry.variant.id)
  }

  return frozen
}

/** Le nombre de feuilles A4 qu'une planche consomme — l'écran l'annonce avant d'imprimer. */
export function sheetCount(labelCount: number): number {
  return Math.ceil(labelCount / LABELS_PER_SHEET)
}
