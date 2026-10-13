/*
 * L'affichage d'une quantité de stock. M2 — E3-02.
 *
 * La règle de lecture vit dans `quantity.ts` ; ce fichier ne fait que la
 * peindre. BRAND-UI § 6 : chiffres tabulaires, parce qu'une colonne de
 * quantités doit s'aligner.
 */

import { QUANTITY_TONE, readQuantity, type ReadableLevel } from '@/modules/stock/quantityReading'

export function Quantity({
  level,
  size = 'body',
}: {
  level: ReadableLevel
  size?: 'body' | 'subtitle'
}) {
  const { text, tone } = readQuantity(level)
  const weight = size === 'subtitle' ? 'text-subtitle' : 'text-body'

  return (
    <span className={`tabular ${weight} ${QUANTITY_TONE[tone]}`}>
      {text}
      {/* « 12 » seul ne dit pas de quoi il s'agit à qui écoute l'écran. */}
      {tone === 'unknown' ? null : <span className="sr-only"> en stock</span>}
    </span>
  )
}
