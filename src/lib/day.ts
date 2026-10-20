/*
 * Les bornes d'une journée de commerce. E1-04, déplacé ici en E4-07.
 *
 * Né dans le journal d'audit ; la liste des documents (E4-07) en a besoin à
 * l'identique, et une seconde copie aurait divergé le jour où le Maroc change
 * d'heure. Une seule copie, ici.
 */

/*
 * Une journée de commerce se lit à Casablanca, pas en UTC (SPEC § 4). Une borne
 * saisie « du 9 » doit donc couvrir le 9 marocain, et non le 9 à Greenwich :
 * pendant l'heure d'été, l'écart d'une heure ferait sortir les ventes du matin
 * ou entrer celles de la veille au soir. Le décalage est demandé au navigateur
 * pour la date concernée — jamais une constante, le Maroc en change.
 */
const TIME_ZONE = 'Africa/Casablanca'

function offsetAt(day: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(`${day}T12:00:00Z`))

  const zone = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  return zone.replace('GMT', '') || '+00:00'
}

/** Le début du jour local, en instant absolu. */
export function startOfDay(day: string): string {
  return `${day}T00:00:00${offsetAt(day)}`
}

/** Le début du jour *suivant* : la borne haute est exclusive, donc juste. */
export function endOfDay(day: string): string {
  const next = new Date(`${day}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  const following = next.toISOString().slice(0, 10)
  return `${following}T00:00:00${offsetAt(following)}`
}
