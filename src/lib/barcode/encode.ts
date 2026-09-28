/*
 * Code 128 — l'encodeur. E2-06.
 *
 * SPEC § 6, RÈGLE M1-5 : « Code 128 émis par le système, encodant
 * `variant.sku`, pour tout ce qui arrive sans code. »
 *
 * Écrit ici plutôt que pris en dépendance. La raison n'est pas l'orgueil : les
 * bibliothèques d'étiquettes rendent du canvas ou du PNG, et une planche A4
 * imprimée depuis un navigateur veut du SVG — le canvas s'imprime à la
 * résolution de l'écran, et des barres de 0,33 mm en sortent floues, donc
 * illisibles à la douchette. Le tableau ci-dessous et sa somme de contrôle
 * tiennent en cent lignes, et c'est tout ce dont une étiquette a besoin.
 *
 * Ce fichier ne dessine rien : il rend des largeurs de modules. Le SVG est
 * affaire de l'écran (`Code128.tsx`), l'ESC/POS le sera du ticket (E5).
 */

/*
 * Les 107 motifs du Code 128, un par valeur, dans l'ordre des valeurs.
 *
 * Chaque chiffre est une largeur en modules, barre et espace en alternance en
 * commençant par une barre. Les 106 premiers motifs font six éléments et
 * onze modules ; le motif d'arrêt en fait sept et treize — il finit par une
 * barre, la « barre de terminaison », sans quoi le dernier espace se confondrait
 * avec la marge blanche.
 *
 * Une faute de frappe dans ce tableau donne un code qui s'imprime sans erreur et
 * ne se lit pas. `code128.test.ts` vérifie chaque motif : six chiffres, onze
 * modules, et le total attendu pour l'arrêt.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
] as const

/** Les valeurs de service dont cet encodeur a besoin. */
const START_B = 104
const START_C = 105
const STOP = 106

/** Le premier et le dernier caractère imprimable que le jeu B encode. */
const FIRST_PRINTABLE = 32
const LAST_PRINTABLE = 126

/**
 * Un code-barres prêt à dessiner : les largeurs de modules, barre et espace en
 * alternance **en commençant par une barre**, et le texte tel qu'il est encodé.
 */
export interface Code128 {
  /** Largeurs en modules, alternées, la première étant une barre. */
  modules: readonly number[]
  /** La valeur encodée, celle qui s'imprime sous les barres. */
  value: string
}

/*
 * Le jeu C encode deux chiffres par symbole : un code de treize chiffres passe
 * de treize symboles à sept, soit une étiquette presque deux fois plus étroite —
 * ce qui décide de sa lisibilité sur 70 mm. On ne l'emploie que sur une valeur
 * entièrement numérique et de longueur paire, ce qui couvre l'EAN-13 précédé de
 * son chiffre de complément et les codes internes tout en chiffres. Toute autre
 * valeur part en jeu B, sans changement de jeu en cours de route : un SKU fait
 * six à huit caractères, l'économie serait de deux barres et le code de deux
 * fois plus de chemins à vérifier.
 */
function isNumericPair(value: string): boolean {
  return value.length % 2 === 0 && value.length > 0 && /^[0-9]+$/.test(value)
}

/** Les valeurs de données, sans le départ, la somme de contrôle ni l'arrêt. */
function dataValues(value: string, useSetC: boolean): number[] | null {
  if (useSetC) {
    const values: number[] = []
    for (let i = 0; i < value.length; i += 2) values.push(Number(value.slice(i, i + 2)))
    return values
  }

  const values: number[] = []
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    /*
     * Hors de l'imprimable ASCII, le jeu B n'a pas de symbole : une référence
     * en arabe, une lettre accentuée, un caractère de contrôle. On ne devine
     * pas une translittération — l'étiquette ne s'offre simplement pas pour
     * cette variante (SPEC § 2.6 : la fonctionnalité privée de sa donnée se
     * désactive, elle ne réclame rien).
     */
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) return null
    values.push(code - FIRST_PRINTABLE)
  }
  return values
}

/**
 * Encode une valeur en Code 128, ou rend `null` si elle ne s'encode pas — vide,
 * ou porteuse d'un caractère hors de l'imprimable ASCII.
 *
 * La somme de contrôle est celle de la norme : le code de départ, plus chaque
 * valeur de données multipliée par sa position (1 pour la première), modulo 103.
 * Une douchette la vérifie ; fausse, elle ne rend rien du tout, ce qui se
 * constate au comptoir et pas avant.
 */
export function encodeCode128(value: string): Code128 | null {
  if (value === '') return null

  const useSetC = isNumericPair(value)
  const data = dataValues(value, useSetC)
  if (data === null) return null

  const start = useSetC ? START_C : START_B

  let weighted = start
  data.forEach((item, index) => {
    weighted += item * (index + 1)
  })
  const checksum = weighted % 103

  const symbols = [start, ...data, checksum, STOP]

  const modules: number[] = []
  for (const symbol of symbols) {
    for (const width of PATTERNS[symbol]!) modules.push(Number(width))
  }

  return { modules, value }
}

/** Largeur totale du code, en modules. Sert à dimensionner le dessin. */
export function code128Width(code: Code128): number {
  return code.modules.reduce((total, width) => total + width, 0)
}

/** Le tableau des motifs, pour le test qui le vérifie. */
export const CODE128_PATTERNS: readonly string[] = PATTERNS
