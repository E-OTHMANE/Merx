/*
 * Affichage des dates, et **le décalage du Maroc**. SPEC § 4 : `timestamptz`,
 * UTC en base, affichage `Africa/Casablanca`.
 *
 * Le fuseau est écrit, jamais déduit du navigateur. Une tablette dont l'horloge
 * ou le fuseau a dérivé — cela arrive, et plus souvent qu'on ne croit sur du
 * matériel bon marché — afficherait sinon des dates fausses de plusieurs
 * heures, sans que rien ne le signale.
 *
 * ----------------------------------------------------------------------------
 * E0-06 — et pourquoi la table est ici plutôt que dans le moteur
 *
 * Écrire `timeZone: 'Africa/Casablanca'` ne dépend plus de l'horloge de la
 * tablette, mais dépend encore de **sa table de fuseaux**. Mesuré le
 * 2026-10-23, même machine, même instant, pour `2026-10-20 12:00Z` :
 * Node 24 et Postgres 17.6 rendent 13:00, **ce Chrome rend 12:00** — son ICU
 * laisse le Maroc à UTC+0 après le Ramadan 2026 et ne l'en ramène jamais. Le
 * Maroc est à UTC+1 en permanence depuis 2018, sauf pendant le Ramadan :
 * c'est Postgres qui a raison, et le navigateur qui est en retard. Une WebView
 * Android bon marché peut l'être davantage.
 *
 * Ce n'est pas une curiosité d'affichage. `documentNumber.ts` calcule l'année
 * du numéro (RÈGLE M3-2) et `merx.require_document_number_shape()` la
 * recalcule depuis `issued_at` : deux tables qui ne disent pas la même chose,
 * et un bon émis le 31 décembre à 23 h 30 porte une année que le serveur
 * refuse en `22023`. En 2029 et en 2030, le 31 décembre tombe pendant le
 * Ramadan, donc sur une bascule : le cas revient deux fois en cinq ans.
 *
 * Donc **une seule fonction porte le décalage**, `casablancaOffsetMinutes()`,
 * et elle ne lit aucune table de fuseaux. `day.ts` et `documentNumber.ts` en
 * dérivent ; `Intl` ne sert plus qu'à mettre en forme, en UTC, un instant déjà
 * décalé. Le serveur, lui, ne bouge pas : il est la référence, et
 * `supabase/tests/timezone.test.ts` mesure la table contre lui jour par jour.
 *
 * Les deux limites de la chose, assumées (SPEC § 4, RÈGLE du décalage du
 * Maroc) : les dates de Ramadan sont des **prévisions** — le Maroc fixe la
 * bascule à l'observation de la lune, parfois à un jour près —, et les assets
 * étant empaquetés dans l'APK (§ 2.7), une correction passe par un APK. Une
 * table à un jour près une année sur cinq vaut mieux qu'un moteur à une heure
 * près toute l'année. La procédure annuelle est dans `docs/PENDING-CHECKS.md`.
 *
 * **Ce fichier n'importe rien**, et c'est ce qui permet à un test de base
 * d'importer `documentNumber.ts` sans entraîner derrière lui ni client
 * Supabase ni `import.meta.env`.
 * ----------------------------------------------------------------------------
 */

/** Le Maroc, hors Ramadan : UTC+1, sans saison, depuis le 2018-10-28. */
export const MOROCCO_STANDARD_OFFSET = 60

/*
 * Les fenêtres où le Maroc repasse à UTC+0, bornes **en UTC**, telles que
 * Postgres les donne. Les bascules tombent à 02:00 UTC (03:00 locales à
 * l'aller, 02:00 au retour) ; hors de ces fenêtres, UTC+1.
 *
 * La borne basse est incluse, la haute exclue : à `02:00:00Z` pile, le
 * décalage est déjà celui d'après.
 *
 * La table commence en 2019 parce que le régime permanent commence fin 2018 et
 * que Merx n'a aucune donnée avant d'exister ; elle s'arrête au 2032-01-18,
 * **et un test d'horizon rougit quand cette fin passe sous deux ans devant**
 * (`src/lib/dates.test.ts`), avec la requête de régénération dans son
 * commentaire. Une table écrite à la main a une fin ; autant que ce soit la
 * suite qui le dise, et non un commerçant.
 */
export const RAMADAN_UTC_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['2019-05-05T02:00:00Z', '2019-06-09T02:00:00Z'],
  ['2020-04-19T02:00:00Z', '2020-05-31T02:00:00Z'],
  ['2021-04-11T02:00:00Z', '2021-05-16T02:00:00Z'],
  ['2022-03-27T02:00:00Z', '2022-05-08T02:00:00Z'],
  ['2023-03-19T02:00:00Z', '2023-04-23T02:00:00Z'],
  ['2024-03-10T02:00:00Z', '2024-04-14T02:00:00Z'],
  ['2025-02-23T02:00:00Z', '2025-04-06T02:00:00Z'],
  ['2026-02-15T02:00:00Z', '2026-03-22T02:00:00Z'],
  ['2027-02-07T02:00:00Z', '2027-03-14T02:00:00Z'],
  ['2028-01-23T02:00:00Z', '2028-03-05T02:00:00Z'],
  ['2029-01-14T02:00:00Z', '2029-02-18T02:00:00Z'],
  ['2029-12-30T02:00:00Z', '2030-02-10T02:00:00Z'],
  ['2030-12-22T02:00:00Z', '2031-01-26T02:00:00Z'],
  // Quatorzième fenêtre, absente du tableau d'E0-06 et donnée par Postgres :
  // le balayage va jusqu'à fin 2031, et sans elle il rougissait sur dix-huit
  // jours de décembre. La table se mesure, elle ne se recopie pas.
  ['2031-12-14T02:00:00Z', '2032-01-18T02:00:00Z'],
]

/** Les mêmes bornes en millisecondes, lues une fois. */
const WINDOWS: ReadonlyArray<readonly [number, number]> = RAMADAN_UTC_WINDOWS.map(
  ([from, to]) => [Date.parse(from), Date.parse(to)] as const,
)

/**
 * Le premier instant que la table ne décrit plus — la dernière bascule connue.
 *
 * Au-delà, `casablancaOffsetMinutes()` rend UTC+1, ce qui est juste jusqu'au
 * Ramadan suivant et faux pendant. C'est ce que le test d'horizon surveille.
 */
export const RAMADAN_TABLE_HORIZON = RAMADAN_UTC_WINDOWS[RAMADAN_UTC_WINDOWS.length - 1]![1]

/**
 * Le décalage du Maroc, en minutes, pour un instant donné. **La seule fonction
 * du projet qui le porte** — tout le reste en dérive.
 */
export function casablancaOffsetMinutes(at: Date): number {
  const instant = at.getTime()
  for (const [from, to] of WINDOWS) {
    // La table est triée : passée la fenêtre qui commence après l'instant,
    // aucune des suivantes ne peut le contenir.
    if (instant < from) break
    if (instant < to) return 0
  }
  return MOROCCO_STANDARD_OFFSET
}

/** `+01:00` — le décalage sous la forme qu'un instant ISO accepte. */
export function casablancaOffsetLabel(at: Date): string {
  const minutes = casablancaOffsetMinutes(at)
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  return `${sign}${hours}:${String(absolute % 60).padStart(2, '0')}`
}

/**
 * L'instant tel que le comptoir le lit — décalé, donc à formater **en UTC**.
 *
 * C'est le tour de passe-passe qui retire `Intl` de la décision : il met en
 * forme, il ne choisit plus le décalage.
 */
function atCounter(at: Date): Date {
  return new Date(at.getTime() + casablancaOffsetMinutes(at) * 60_000)
}

const DATE = new Intl.DateTimeFormat('fr-MA', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

const DATE_TIME = new Intl.DateTimeFormat('fr-MA', {
  timeZone: 'UTC',
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
  return Number.isNaN(date.getTime()) ? null : DATE.format(atCounter(date))
}

/** `08/09/2026 14:30`. */
export function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE_TIME.format(atCounter(date))
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
 * même raison que les deux autres — ce qui est calculé ici est le **décalage**,
 * pas la mise en forme.
 */
const FILE_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

/** `2026-09-04`, au comptoir. `null` tel quel. */
export function fileDate(iso: string | null): string | null {
  if (iso === null) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : FILE_DATE.format(atCounter(date))
}
