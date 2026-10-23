/*
 * Les bornes d'une journée de commerce. E1-04, déplacé ici en E4-07.
 *
 * Né dans le journal d'audit ; la liste des documents (E4-07) en a besoin à
 * l'identique, et une seconde copie aurait divergé le jour où le Maroc change
 * d'heure. Une seule copie, ici.
 */

import { casablancaOffsetLabel, casablancaOffsetMinutes } from '@/lib/dates'

/*
 * Une journée de commerce se lit à Casablanca, pas en UTC (SPEC § 4). Une borne
 * saisie « du 9 » doit donc couvrir le 9 marocain, et non le 9 à Greenwich :
 * pendant le Ramadan, l'écart d'une heure ferait sortir les ventes du matin ou
 * entrer celles de la veille au soir.
 *
 * Le décalage ne vient plus du navigateur mais de `dates.ts` (E0-06) : l'ICU de
 * la tablette peut être en retard d'un régime entier, et une journée décalée
 * d'une heure se lit comme une vente disparue.
 *
 * **Et il est pris à minuit local, pas à midi UTC.** C'était le défaut : les
 * bascules tombent à 02:00 UTC, donc le jour d'une bascule, minuit local et
 * midi UTC ne sont pas du même côté. Le 2026-03-22 commençait ainsi à
 * `00:00+01:00` — une heure trop tôt, c'est-à-dire la veille à 23 h.
 */
function offsetAt(day: string): string {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`)

  // Deux passes : la première donne un décalage approché, la seconde le lit à
  // l'instant de minuit local. Les fenêtres durant des semaines, la seconde
  // passe est toujours la bonne — une bascule n'en déplace la borne que d'une
  // heure.
  const approximate = casablancaOffsetMinutes(new Date(utcMidnight))
  return casablancaOffsetLabel(new Date(utcMidnight - approximate * 60_000))
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
