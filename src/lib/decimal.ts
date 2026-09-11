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
