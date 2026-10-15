/*
 * Les SQLSTATE qu'un garde a le droit de lever — SPEC § 4, RÈGLE des refus en
 * 4xx.
 *
 * Une seule copie. `conventions.ts` en fait sa règle « aucun refus rendu en
 * 5xx » (ce qui refuse un garde qui lèverait autre chose), et
 * `refusal-status.test.ts` **mesure** chacun de ces codes à travers PostgREST à
 * chaque passage de la suite. Une liste mesurée une fois puis recopiée serait
 * la recopie à la main que la RÈGLE des domaines nommés refuse : le jour où
 * l'épingle du CLI monte et qu'un code change de statut, c'est la suite qui le
 * dit, pas une relecture.
 *
 * Deux familles :
 *
 *   — les codes de Postgres que PostgREST range déjà en 4xx ;
 *   — la famille `PTxxx` de PostgREST, dont les trois chiffres *sont* le statut
 *     HTTP. C'est par elle que passent nos gardes, pour que chacun garde un
 *     code propre sans détourner un code de Postgres de son sens.
 */

/** Les codes de Postgres admis, et le statut mesuré de chacun. */
export const POSTGRES_REFUSAL_CODES = [
  '22000',
  '22023',
  '23502',
  '23503',
  '23505',
  '23514',
  '2F004',
  '42501',
  '42P01',
  'P0001',
] as const

/**
 * Les codes `PTxxx` que nos gardes lèvent. Le test les mesure comme les
 * autres : la famille est admise par la règle, mais « admise » n'est pas
 * « vérifiée ».
 */
export const PT_REFUSAL_CODES = ['PT400', 'PT403', 'PT404', 'PT409', 'PT422'] as const

/** Tout ce qu'un garde peut lever, mesuré à chaque passage de la suite. */
export const REFUSAL_CODES_4XX = [...POSTGRES_REFUSAL_CODES, ...PT_REFUSAL_CODES] as const

/**
 * Un littéral SQL de la liste des codes de Postgres admis, pour la règle de
 * `conventions.ts`. La famille `PT4xx` y est reconnue par motif, pas par
 * énumération : un `PT451` futur serait admis sans toucher à la règle, et
 * mesuré par le test dès qu'un garde le lève.
 */
export const postgresCodesSqlArray = (): string =>
  `array[${POSTGRES_REFUSAL_CODES.map((code) => `'${code}'`).join(', ')}]`
