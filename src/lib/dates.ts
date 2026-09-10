/*
 * Affichage des dates. SPEC § 4 : `timestamptz`, UTC en base, affichage
 * `Africa/Casablanca`.
 *
 * Le fuseau est écrit, jamais déduit du navigateur. Une tablette dont l'horloge
 * ou le fuseau a dérivé — cela arrive, et plus souvent qu'on ne croit sur du
 * matériel bon marché — afficherait sinon des dates fausses de plusieurs
 * heures, sans que rien ne le signale.
 */

const TIME_ZONE = 'Africa/Casablanca'

const DATE = new Intl.DateTimeFormat('fr-MA', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const DATE_TIME = new Intl.DateTimeFormat('fr-MA', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** `08/09/2026`. Rend `null` tel quel : l'appelant décide quoi montrer. */
export function formatDate(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE.format(date)
}

/** `08/09/2026 14:30`. */
export function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE_TIME.format(date)
}
