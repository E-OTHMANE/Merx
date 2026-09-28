/*
 * Ce qu'une cellule veut dire. M1 — E2-05.
 *
 * BACKLOG E2-05 : « gère les cas réels : colonnes vides, doublons de
 * référence, prix en texte (« 15,00 DH »), accents cassés, espaces parasites ».
 * Ce fichier tient les trois derniers ; les doublons sont dans `rows.ts`.
 *
 * **La règle qui gouverne tout ici : ne jamais deviner.** Un prix mal lu n'est
 * pas une petite erreur — « 1.250 » vaut 1 250 DH ou 1,25 DH selon la
 * convention du fichier, et se tromper, c'est un facteur mille sur un prix de
 * vente, découvert au comptoir. Une valeur ambiguë est donc refusée, avec son
 * motif et la valeur citée ; le commerçant la corrige dans le fichier des
 * rejets, qui se réimporte tel quel. Le taux de rejet n'est pas un argument
 * pour se mettre à deviner.
 *
 * Jamais de flottant non plus : les montants restent en texte et passent par
 * `@/lib/decimal`, comme partout ailleurs (CLAUDE.md).
 */

import { MONEY_SCALE, parseDecimal, toSqlDecimal } from '@/lib/decimal'

/*
 * Les blancs qu'un fichier réel contient : espace insécable d'Excel, espace
 * fine des milliers, largeurs nulles collées par un copier-coller depuis le
 * web. Par numéro, parce qu'ils sont invisibles dans le code source.
 */
const BLANKS = [0x20, 0x09, 0xa0, 0x2007, 0x2009, 0x202f, 0x200b, 0x200c, 0x200d, 0xfeff]

/** Les monnaies qu'un commerçant écrit à côté du montant. */
const CURRENCIES = /\s*(dhs?|mad|dirhams?|درهم|د\.?م\.?)\s*/giu

/**
 * Le texte d'une cellule : blancs exotiques ramenés à l'espace, blancs
 * multiples à un seul, bords retirés, caractères de contrôle supprimés.
 */
export function cleanText(raw: string): string {
  let text = ''
  for (const char of raw) {
    const code = char.codePointAt(0)!
    if (BLANKS.includes(code)) text += ' '
    else if (code >= 0x20 || code === 0x0a) text += char
  }
  return text.replace(/ +/g, ' ').trim()
}

/** Une cellule vide, ou absente de la ligne. */
export function isBlank(raw: string | undefined): boolean {
  return raw === undefined || cleanText(raw) === ''
}

/* -------------------------------------------------------------------------- */
/* Les montants                                                                */
/* -------------------------------------------------------------------------- */

export type Amount =
  /** Cellule vide : le fichier ne dit rien, on n'écrit rien. */
  | { status: 'empty' }
  /** Un 0 saisi : une saisie, pas une absence. Compté à part à l'aperçu. */
  | { status: 'zero' }
  /** Un montant lisible, sous la forme que la base attend : `"15.00"`. */
  | { status: 'amount'; sql: string }
  /** « 1.250 » : 1 250 DH ou 1,25 DH ? On refuse de trancher. */
  | { status: 'ambiguous'; value: string }
  | { status: 'unreadable'; value: string; reason: string }

/** `money_amount` est `numeric(12,2)` : dix chiffres avant la virgule. */
const MAX_WHOLE_DIGITS = 10

function positionsOf(text: string, separator: string): number[] {
  const found: number[] = []
  for (let i = 0; i < text.length; i++) if (text[i] === separator) found.push(i)
  return found
}

/** Les groupes d'un nombre écrit avec des séparateurs de milliers : 1.250.000. */
function groupedByThousands(parts: string[]): boolean {
  return parts.every((part, index) => (index === 0 ? part.length <= 3 : part.length === 3))
}

/**
 * Un montant tel qu'un fichier le porte : « 15,00 DH », « 1 250,50 »,
 * « 1.250,50 », « 1,250.50 », « 15 ». Le résultat est en texte, à l'échelle
 * des montants.
 */
export function parseAmount(raw: string): Amount {
  const shown = cleanText(raw)
  if (shown === '') return { status: 'empty' }

  const stripped = cleanText(shown.replace(CURRENCIES, ' '))
  const compact = [...stripped].filter((char) => !BLANKS.includes(char.codePointAt(0)!)).join('')

  if (compact === '') return { status: 'empty' }
  if (compact.startsWith('-')) {
    return { status: 'unreadable', value: shown, reason: 'un prix ne peut pas être négatif' }
  }
  if (/e[+-]?\d/i.test(compact)) {
    return {
      status: 'unreadable',
      value: shown,
      reason: 'Excel l’a écrit en notation scientifique',
    }
  }

  const digits = compact.replace(/^\+/, '')
  if (!/^[\d.,]+$/.test(digits)) {
    return { status: 'unreadable', value: shown, reason: 'ce n’est pas un nombre' }
  }

  const commas = positionsOf(digits, ',')
  const dots = positionsOf(digits, '.')
  let whole: string
  let decimals = ''

  if (commas.length > 0 && dots.length > 0) {
    // Les deux sortes : la dernière est la décimale, les autres des milliers.
    const cut = Math.max(commas[commas.length - 1]!, dots[dots.length - 1]!)
    whole = digits.slice(0, cut).replace(/[.,]/g, '')
    decimals = digits.slice(cut + 1)
  } else {
    const separator = commas.length > 0 ? ',' : dots.length > 0 ? '.' : null
    const positions = commas.length > 0 ? commas : dots

    if (separator === null) {
      whole = digits
    } else if (positions.length > 1) {
      // Plusieurs fois le même séparateur : ce sont des milliers.
      const parts = digits.split(separator)
      if (!groupedByThousands(parts)) {
        return { status: 'unreadable', value: shown, reason: 'les chiffres ne se groupent pas' }
      }
      whole = parts.join('')
    } else {
      const cut = positions[0]!
      whole = digits.slice(0, cut)
      decimals = digits.slice(cut + 1)

      /*
       * Le cas qui décide de tout. Un seul séparateur suivi de trois chiffres
       * est indécidable : « 1.250 » est 1 250 DH pour un Excel anglais, 1,25 DH
       * pour un Excel français qui aurait tapé un point. Deux décimales ou une
       * seule sont sans ambiguïté ; au-delà de trois, la colonne n'est pas un
       * prix.
       */
      if (decimals.length === 3) return { status: 'ambiguous', value: shown }
      if (decimals.length === 0) {
        return { status: 'unreadable', value: shown, reason: 'il manque les centimes' }
      }
      if (decimals.length > 3) {
        return { status: 'unreadable', value: shown, reason: 'trop de décimales pour un prix' }
      }
    }
  }

  if (whole === '') whole = '0'
  if (whole.replace(/^0+(?=\d)/, '').length > MAX_WHOLE_DIGITS) {
    return { status: 'unreadable', value: shown, reason: 'montant trop grand' }
  }

  const value = parseDecimal(decimals === '' ? whole : `${whole}.${decimals}`, MONEY_SCALE)
  if (value === null) {
    return { status: 'unreadable', value: shown, reason: 'ce n’est pas un nombre' }
  }
  if (value === 0n) return { status: 'zero' }

  return { status: 'amount', sql: toSqlDecimal(value, MONEY_SCALE) }
}

/* -------------------------------------------------------------------------- */
/* Les entiers, les références, les codes-barres                               */
/* -------------------------------------------------------------------------- */

export type Count =
  | { status: 'empty' }
  | { status: 'count'; value: number }
  | { status: 'unreadable'; value: string; reason: string }

/** Les pièces par carton : un entier strictement positif, ou rien (SPEC § 6). */
export function parseCount(raw: string): Count {
  const shown = cleanText(raw)
  if (shown === '') return { status: 'empty' }

  /*
   * Les milliers groupés par trois disparaissent ; un séparateur décimal, non
   * — on ne tronque pas 12,5 en 12, on refuse la cellule et on le dit.
   */
  const spaceless = shown.replace(/ /g, '')
  const compact = /^\d{1,3}([.,]\d{3})+$/.test(spaceless)
    ? spaceless.replace(/[.,]/g, '')
    : spaceless

  if (!/^\d+$/.test(compact)) {
    return { status: 'unreadable', value: shown, reason: 'ce n’est pas un nombre entier' }
  }
  const value = Number.parseInt(compact, 10)
  if (value <= 0) {
    return { status: 'unreadable', value: shown, reason: 'il en faut au moins une' }
  }
  return { status: 'count', value }
}

export type Reference =
  | { status: 'empty' }
  | { status: 'text'; value: string }
  | { status: 'unreadable'; value: string; reason: string }

/**
 * Une référence ou un code-barres. Excel transforme volontiers un EAN de
 * treize chiffres en « 6,11123E+12 » : la valeur affichée ne porte plus le
 * code, et l'importer écrirait un code-barres faux sur un produit vrai.
 */
export function parseReference(raw: string): Reference {
  const shown = cleanText(raw)
  if (shown === '') return { status: 'empty' }
  if (/^\d+([.,]\d+)?e[+-]?\d+$/i.test(shown)) {
    return {
      status: 'unreadable',
      value: shown,
      reason: 'Excel l’a écrit en notation scientifique',
    }
  }
  return { status: 'text', value: shown }
}
