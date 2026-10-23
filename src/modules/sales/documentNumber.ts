/*
 * La forme d'un numéro de document — E4-02. `BL-A-26-00001`.
 *
 * SPEC § 8, RÈGLE M3-2. Le code du type (`DV` devis, `CM` commande, `BL` bon de
 * livraison, `RT` retour), la lettre de l'appareil (E1-03, unique par commerce
 * et jamais recyclée), l'année sur deux chiffres, la séquence sur cinq.
 *
 * **Ce fichier ne dépend que de `src/lib/dates.ts`, qui n'importe rien.** C'est
 * délibéré : `merx.doc_type_code()` tient l'autre copie des codes en base, et
 * `supabase/tests/document-numbering.test.ts` compare les deux étiquette par
 * étiquette. Une comparaison n'a de valeur que si les deux copies sont les
 * vraies, donc le test de base importe ce module-ci — et il ne peut le faire
 * que s'il n'entraîne derrière lui ni client Supabase ni `import.meta.env`
 * (même frontière que la matrice des capacités, E0-05).
 *
 * Ce qui parle au réseau est dans `numbering.ts`.
 */

import { casablancaOffsetMinutes } from '@/lib/dates'

/** Les quatre types de document du § 8 — `return` ajouté en E4-06. */
export type SaleDocType = 'quote' | 'order' | 'delivery_note' | 'return'

/**
 * Le code que porte le numéro, par type.
 *
 * `merx.doc_type_code()` en tient l'autre copie, comparée à celle-ci sur les
 * étiquettes **lues au catalogue** : un quatrième type de document fait rougir
 * la suite au lieu de sortir un numéro muet.
 */
export const DOC_TYPE_CODES: Readonly<Record<SaleDocType, string>> = {
  quote: 'DV',
  order: 'CM',
  delivery_note: 'BL',
  // E4-06. Pas `BR` (« bon de retour ») : `BL` et `BR` ne diffèrent que d'une
  // lettre sur un numéro qui se dicte au téléphone, ce qui est précisément
  // pourquoi l'année ne fait que deux chiffres.
  return: 'RT',
}

/** Cinq chiffres, largeur fixe : l'ordre du texte est celui des nombres. */
const SEQUENCE_DIGITS = 5

/** Le plus grand numéro qu'un appareil peut porter dans une année. */
export const MAX_SEQUENCE = 10 ** SEQUENCE_DIGITS - 1

const NUMBER_PATTERN = new RegExp(
  `^(DV|CM|BL|RT)-([A-Z])-([0-9]{2})-([0-9]{${SEQUENCE_DIGITS}})$`,
)

/**
 * L'année que porte le numéro, telle que le commerçant l'a vécue.
 *
 * Le décalage vient de `casablancaOffsetMinutes()`, jamais de la table de
 * fuseaux du moteur (E0-06) : un bon émis le 31 décembre à 23 h 30 porte
 * l'année du comptoir, et c'est aussi l'année que le garde de la base
 * recalcule depuis `issued_at`. Les deux lectures doivent tomber d'accord,
 * sans quoi le serveur refuserait un numéro pourtant juste — et l'ICU de ce
 * Chrome, qui laisse le Maroc à UTC+0 après février 2026, les faisait
 * précisément diverger. `supabase/tests/timezone.test.ts` mesure l'accord
 * contre le calcul même du garde.
 */
export function documentYear(at: Date): number {
  return new Date(at.getTime() + casablancaOffsetMinutes(at) * 60_000).getUTCFullYear()
}

/** `BL-A-26-00001`. */
export function formatDocumentNumber(
  docType: SaleDocType,
  prefix: string,
  year: number,
  sequence: number,
): string {
  const century = String(year % 100).padStart(2, '0')
  return `${DOC_TYPE_CODES[docType]}-${prefix}-${century}-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}`
}

export interface DocumentNumberParts {
  code: string
  prefix: string
  /** Les deux chiffres du numéro, tels quels — `26`. */
  year: number
  sequence: number
}

/** Les morceaux d'un numéro, ou `null` si ce texte n'en est pas un. */
export function parseDocumentNumber(text: string): DocumentNumberParts | null {
  const match = NUMBER_PATTERN.exec(text)
  if (match === null) return null
  return {
    code: match[1]!,
    prefix: match[2]!,
    year: Number(match[3]),
    sequence: Number(match[4]),
  }
}
