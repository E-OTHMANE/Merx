/*
 * Montants et quantités, côté appareil. E2-03.
 *
 * CLAUDE.md : jamais de flottant, nulle part. En base, un montant est un
 * `money_amount` (`numeric(12,2)`) et une quantité une `quantity`
 * (`numeric(12,3)`). Côté appareil, la règle tient ainsi :
 *
 *   — les valeurs voyagent en **chaînes décimales**. PostgREST rendrait un
 *     `numeric` en nombre JSON, donc en flottant une fois parsé ; on les lui
 *     demande en texte (`min_qty::text`), et on les lui renvoie en texte ;
 *   — elles se comparent en **entiers mis à l'échelle** (`BigInt`) : 12,50 DH à
 *     l'échelle 2 vaut `1250n`, 10 pièces à l'échelle 3 valent `10000n`.
 *
 * `Number` n'est jamais appelé sur un montant ni sur une quantité. `0.1 + 0.2`
 * ne vaut pas `0.3`, et c'est une erreur qui ne se voit qu'au centime, sur une
 * facture.
 */

/** Deux décimales : `money_amount`. */
export const MONEY_SCALE = 2
/** Trois décimales : `quantity`. */
export const QUANTITY_SCALE = 3

/* Chiffres, puis une virgule ou un point et des chiffres. Ni signe, ni exposant. */
const DECIMAL = /^(\d+)(?:[.,](\d*))?$/

/**
 * Lit une valeur décimale à l'échelle donnée : `"12,5"` → `1250n` à l'échelle 2.
 *
 * La virgule et le point sont acceptés : le commerçant tape une virgule, la
 * base rend un point. `null` pour tout ce qui n'est pas un décimal positif, et
 * pour une précision que la colonne ne tiendrait pas — `"12,505"` n'est pas un
 * montant. Des zéros au-delà de l'échelle sont admis (`"12.500"`) : ils ne
 * changent pas la valeur.
 */
export function parseDecimal(text: string, scale: number): bigint | null {
  const match = DECIMAL.exec(text.trim())
  if (match === null) return null

  const whole = match[1]!
  const fraction = match[2] ?? ''
  if (/[^0]/.test(fraction.slice(scale))) return null

  return BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'))
}

/** La forme que la base reçoit : `1250n` à l'échelle 2 → `"12.50"`. */
export function toSqlDecimal(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0')
  if (scale === 0) return digits
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

/**
 * La forme qu'un champ affiche, à partir de celle de la base. `NULL` donne un
 * champ vide.
 *
 *   — un montant garde ses deux décimales : `"12.50"` → `"12,50"` ;
 *   — une quantité perd ses zéros inutiles : `"10.000"` → `"10"`,
 *     `"2.500"` → `"2,5"`. Personne n'écrit « à partir de 10,000 pièces ».
 *
 * Virgule décimale, BRAND-UI § 6.
 */
export function inputText(stored: string | null, kind: 'money' | 'quantity'): string {
  if (stored === null) return ''
  const scale = kind === 'money' ? MONEY_SCALE : QUANTITY_SCALE
  const value = parseDecimal(stored, scale)
  if (value === null) return stored

  let text = toSqlDecimal(value, scale)
  if (kind === 'quantity') text = text.replace(/\.?0+$/, '')
  return text.replace('.', ',')
}

/**
 * Filtre la frappe dans un champ décimal : des chiffres, un seul séparateur —
 * rendu en virgule —, et pas plus de décimales que l'échelle. Le champ ne peut
 * donc pas contenir ce que la base refuserait ; il n'a jamais à le reprocher
 * (SPEC § 2.6).
 */
export function decimalInput(raw: string, scale: number): string {
  let separated = false
  let decimals = 0
  let result = ''

  for (const char of raw) {
    if (char >= '0' && char <= '9') {
      if (separated) {
        if (decimals === scale) continue
        decimals += 1
      }
      result += char
    } else if ((char === ',' || char === '.') && !separated && scale > 0) {
      separated = true
      result += result === '' ? '0,' : ','
    }
  }
  return result
}

/**
 * La forme qu'une quantité **signée** s'affiche : `"-7.500"` → `"-7,5"`,
 * `"0.000"` → `"0"`.
 *
 * `parseDecimal()` ne lit que du positif — c'est voulu, aucun champ de saisie
 * n'accepte de signe. Une quantité en stock, elle, peut être négative
 * (RÈGLE M2-3 : le stock négatif est autorisé, signalé, jamais bloquant), et
 * elle n'est jamais saisie : elle est lue. Le signe est donc traité ici, et le
 * reste passe par le même chemin que les champs — mêmes décimales inutiles
 * retirées, même virgule (BRAND-UI § 6).
 */
export function quantityText(stored: string): string {
  const negative = stored.trimStart().startsWith('-')
  const text = inputText(negative ? stored.trimStart().slice(1) : stored, 'quantity')
  if (text === '') return ''
  // Un zéro n'a pas de signe : « -0 » ne veut rien dire au comptoir.
  if (parseDecimal(text.replace(',', '.'), QUANTITY_SCALE) === 0n) return '0'
  return negative ? `-${text}` : text
}

/*
 * L'espace insécable des milliers, et celui qui précède `DH` (BRAND-UI § 6).
 * Insécable aux deux places : un montant ne se coupe pas en fin de ligne, et
 * « 1 250,00 » lu sur deux lignes est un autre nombre.
 */
const NBSP = ' '

/**
 * Un montant tel qu'il s'affiche : `"1250.00"` → `"1 250,00 DH"`.
 *
 * BRAND-UI § 6 : séparateur de milliers en espace insécable, virgule décimale,
 * `DH` après le montant, **deux décimales toujours** — un total qui perd ses
 * centimes dans une colonne ne s'aligne plus. Le signe est traité (un total de
 * ligne ne l'est jamais, un écart le sera) ; un zéro n'en porte pas.
 *
 * `Intl.NumberFormat` n'est pas employé : il prendrait un `number`, donc un
 * flottant, sur une valeur qui est exacte en base (`@/lib/decimal`, premier
 * paragraphe). Le groupement se fait sur les chiffres, en texte.
 */
export function moneyText(stored: string): string {
  const trimmed = stored.trim()
  const negative = trimmed.startsWith('-')
  const value = parseDecimal(negative ? trimmed.slice(1) : trimmed, MONEY_SCALE)
  if (value === null) return stored

  const [whole = '0', fraction = ''] = toSqlDecimal(value, MONEY_SCALE).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  const sign = negative && value !== 0n ? '-' : ''

  return `${sign}${grouped},${fraction}${NBSP}DH`
}
