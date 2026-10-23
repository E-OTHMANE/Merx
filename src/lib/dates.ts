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

/*
 * `2026-09-04` — la date pour un **nom de fichier**, pas pour un écran.
 *
 * ISO et non `04/09/2026` : un dossier de téléchargements trie par nom, et des
 * bons d'un même client doivent s'y ranger dans l'ordre. Le fuseau est celui du
 * comptoir, comme partout (§ 4) et comme l'année du numéro de document
 * (RÈGLE M3-2) : un bon émis le 31 décembre à 23 h 30 porte la date du
 * comptoir, pas celle d'UTC.
 *
 * `en-CA` rend `AAAA-MM-JJ` ; le format n'est pas construit à la main pour la
 * même raison que les deux autres — le décalage est lu par `Intl`, jamais
 * calculé ici.
 */
const FILE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** `2026-09-04`, en `Africa/Casablanca`. `null` tel quel. */
export function fileDate(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : FILE_DATE.format(date)
}
