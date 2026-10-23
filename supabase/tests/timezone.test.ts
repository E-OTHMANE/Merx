// @vitest-environment node

/*
 * E0-06 — la table des décalages du Maroc, mesurée contre Postgres.
 *
 * SPEC § 4 (RÈGLE du décalage du Maroc, RÈGLE des dates), § 8 (RÈGLE M3-2).
 *
 * **C'est le fichier qui compte, et il ne choisit pas ses dates.** Une table
 * écrite à la main se recopie mal, et une erreur de recopie d'un jour ne se
 * voit sur aucun écran : elle sort une heure fausse, pendant une semaine, une
 * année sur cinq. Donc pas d'échantillon de dates choisies — un balayage jour
 * par jour de 2019 à 2031, en une requête, `casablancaOffsetMinutes()` contre
 * `timezone('Africa/Casablanca', …)`.
 *
 * Trois choses, et la troisième est celle qui coûte une vente :
 *
 *   1. le balayage jour par jour — la table dit ce que Postgres dit ;
 *   2. les instants de bascule à ± 1 seconde — une table juste au jour près
 *      peut être fausse à l'heure près, et c'est 02:00 UTC qui tranche ;
 *   3. **l'accord sur l'année du numéro** : `documentYear()`, côté appareil,
 *      contre `merx.document_number_year()`, le calcul même du garde
 *      `merx.require_document_number_shape()`, sur le 31 décembre 23 h 30
 *      local de 2026 à 2030. Un désaccord d'une heure là-dedans fait refuser
 *      en `22023` un numéro pourtant juste, le soir du 31 décembre, au
 *      comptoir — et deux de ces cinq réveillons tombent pendant le Ramadan.
 *
 * Postgres est la référence : **le serveur n'est pas modifié par cette story.**
 * L'appareil doit lui obéir, pas l'inverse. Et comme la `tzdata` du serveur
 * hébergé ne sera pas forcément celle du stack local, ce balayage entre dans
 * la vérification de mise en ligne — même famille que la table de
 * correspondance de PostgREST, qui se mesure et ne se recopie jamais.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MOROCCO_STANDARD_OFFSET,
  RAMADAN_UTC_WINDOWS,
  casablancaOffsetMinutes,
} from '@/lib/dates'
import { documentYear } from '@/modules/sales/documentNumber'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/* Le balayage : du premier jour de 2019 au dernier de 2031, à midi UTC. */
const SWEEP_FROM = '2019-01-01T12:00:00Z'
const SWEEP_TO = '2031-12-31T12:00:00Z'

const client = new Client({ connectionString: CONNECTION_STRING })

/**
 * Le décalage que Postgres donne, en minutes, pour une liste d'instants.
 *
 * `timezone(zone, timestamptz)` rend l'heure locale nue ; la différence avec
 * l'heure UTC nue *est* le décalage. C'est la même lecture que celle de
 * `merx.document_number_year()`, qui fait `at time zone` sur `issued_at`.
 */
async function offsetsAt(instants: readonly string[]): Promise<number[]> {
  const { rows } = await client.query<{ minutes: string }>(
    `select extract(epoch from
              (timezone('Africa/Casablanca', ts) - timezone('UTC', ts)))::int / 60 as minutes
     from unnest($1::timestamptz[]) with ordinality as u(ts, n)
     order by u.n`,
    [instants],
  )
  return rows.map((row) => Number(row.minutes))
}

beforeAll(async () => {
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

describe('le décalage du Maroc, jour par jour contre Postgres', () => {
  it('s’accorde sur chaque jour de 2019 à 2031', async () => {
    const { rows } = await client.query<{ ts: Date; minutes: string }>(
      `select ts,
              extract(epoch from
                (timezone('Africa/Casablanca', ts) - timezone('UTC', ts)))::int / 60 as minutes
       from generate_series($1::timestamptz, $2::timestamptz, interval '24 hours') ts
       order by ts`,
      [SWEEP_FROM, SWEEP_TO],
    )

    // Treize ans de jours : si la requête en rend beaucoup moins, c'est elle
    // qui est fausse, et le balayage ne mesurerait rien en restant vert.
    expect(rows.length).toBeGreaterThan(4_700)

    /*
     * Les désaccords sont **collectés**, pas levés au premier : une table
     * décalée d'un jour sur une fenêtre produit une poignée de jours faux, et
     * c'est la liste qui dit laquelle des treize fenêtres est à reprendre. Un
     * `expect` dans la boucle n'en montrerait que le premier.
     */
    const disagreements = rows
      .map((row) => ({
        instant: row.ts.toISOString(),
        postgres: Number(row.minutes),
        merx: casablancaOffsetMinutes(row.ts),
      }))
      .filter((day) => day.postgres !== day.merx)

    expect(disagreements.slice(0, 20)).toStrictEqual([])
    expect(disagreements).toHaveLength(0)
  })

  it('ne connaît que deux décalages, +01:00 et +00:00', async () => {
    const { rows } = await client.query<{ minutes: string }>(
      `select distinct extract(epoch from
                (timezone('Africa/Casablanca', ts) - timezone('UTC', ts)))::int / 60 as minutes
       from generate_series($1::timestamptz, $2::timestamptz, interval '24 hours') ts
       order by 1`,
      [SWEEP_FROM, SWEEP_TO],
    )
    expect(rows.map((row) => Number(row.minutes))).toStrictEqual([0, MOROCCO_STANDARD_OFFSET])
  })
})

describe('les instants de bascule', () => {
  /*
   * Chaque fenêtre a deux bords, chaque bord se mesure une seconde avant et
   * une seconde après. Une table juste au jour près et fausse à l'heure près
   * passerait le balayage de midi sans qu'on le sache — les bascules tombent à
   * 02:00 UTC, dix heures plus tôt.
   */
  const SECOND = 1_000
  const edges = RAMADAN_UTC_WINDOWS.flat()

  it('tombe au même instant que Postgres, à la seconde', async () => {
    const instants = edges.flatMap((edge) => [
      new Date(Date.parse(edge) - SECOND).toISOString(),
      edge,
    ])

    const postgres = await offsetsAt(instants)

    const disagreements = instants
      .map((instant, index) => ({
        instant,
        postgres: postgres[index]!,
        merx: casablancaOffsetMinutes(new Date(instant)),
      }))
      .filter((edge) => edge.postgres !== edge.merx)

    expect(disagreements).toStrictEqual([])
  })

  it('change bien de décalage d’une seconde à l’autre', async () => {
    // Le test précédent dirait « d'accord » si les deux moteurs rendaient la
    // même valeur de part et d'autre, c'est-à-dire si la bascule n'existait
    // pas. Celui-ci exige qu'elle existe, et aux vingt-six bords.
    const before = await offsetsAt(
      edges.map((edge) => new Date(Date.parse(edge) - SECOND).toISOString()),
    )
    const after = await offsetsAt(edges)

    expect(edges).toHaveLength(RAMADAN_UTC_WINDOWS.length * 2)
    edges.forEach((edge, index) => {
      expect(after[index], `${edge} — le décalage doit changer`).not.toBe(before[index])
    })
  })
})

describe('l’année du numéro de document', () => {
  /*
   * Les cinq réveillons, à 23 h 30 **locales**. L'instant UTC n'est pas le
   * même d'une année à l'autre : en 2029 et en 2030 le 31 décembre tombe
   * pendant le Ramadan, donc à UTC+0, et 23 h 30 au comptoir est 23:30Z.
   *
   * L'instant est construit depuis la table — `casablancaOffsetMinutes()` —
   * puis l'année est demandée aux deux côtés. Si la table se trompait,
   * l'instant lui-même serait faux et Postgres rendrait une autre année : le
   * cas ne peut pas s'auto-confirmer.
   */
  const COUNTER_NEW_YEAR_EVE = [2026, 2027, 2028, 2029, 2030].map((year) => {
    const naive = Date.parse(`${year}-12-31T23:30:00Z`)
    // Le décalage de l'instant visé, pris en deux passes comme dans `day.ts`.
    const approximate = casablancaOffsetMinutes(new Date(naive))
    const offset = casablancaOffsetMinutes(new Date(naive - approximate * 60_000))
    return { year, instant: new Date(naive - offset * 60_000).toISOString() }
  })

  it('est la même pour l’appareil et pour le garde de la base', async () => {
    for (const { year, instant } of COUNTER_NEW_YEAR_EVE) {
      const { rows } = await client.query<{ year: number }>(
        'select merx.document_number_year($1::timestamptz) as year',
        [instant],
      )
      expect(Number(rows[0]!.year), `${instant} — la base`).toBe(year)
      expect(documentYear(new Date(instant)), `${instant} — l’appareil`).toBe(year)
    }
  })

  it('bascule d’année au même instant des deux côtés', async () => {
    // Une demi-heure plus tard, le comptoir a changé d'année. Les deux côtés
    // doivent changer **ensemble** : c'est l'accord qui tient la ligne, pas
    // l'exactitude de l'un des deux.
    for (const { year, instant } of COUNTER_NEW_YEAR_EVE) {
      const later = new Date(Date.parse(instant) + 30 * 60 * 1_000 + 1_000).toISOString()
      const { rows } = await client.query<{ year: number }>(
        'select merx.document_number_year($1::timestamptz) as year',
        [later],
      )
      expect(Number(rows[0]!.year), `${later} — la base`).toBe(year + 1)
      expect(documentYear(new Date(later)), `${later} — l’appareil`).toBe(year + 1)
    }
  })
})
