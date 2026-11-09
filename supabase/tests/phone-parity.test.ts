// @vitest-environment node

/*
 * E6-01 — parité entre `normalizePhone()` (E1-01, TypeScript, partagée par le
 * front et la fonction Edge) et `merx.phone_digits()` (SQL, le cœur de la même
 * règle sans sa validation finale).
 *
 * Deux copies existent par nécessité — l'une tourne côté application avant
 * l'écriture, l'autre dans une colonne engendrée, sous Postgres, sans accès au
 * code TypeScript. Une divergence future ferait écrire un `phone_digits` qui
 * ne correspond plus à ce que `normalizePhone()` dirait du même numéro : la
 * recherche par téléphone (`search_clients()`) trouverait la fiche sous une
 * forme et la raterait sous une autre, en silence.
 *
 * Ce test rejoue chaque écriture valide de `src/lib/phone.test.ts` — la même
 * liste, importée, pas recopiée — et exige que les deux rendent la même forme
 * canonique. Même famille que la table du fuseau mesurée contre Postgres
 * (SPEC § 4) : une copie se mesure contre l'autre, elle ne se suppose pas
 * d'accord avec elle.
 *
 * Exige le stack local : npx supabase start && npx supabase db reset
 */

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { normalizePhone } from '../functions/_shared/phone'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

/* La même liste que phone.test.ts : toutes les écritures de 0612345678. */
const SAME_NUMBER = [
  '0612345678',
  '06 12 34 56 78',
  '06-12-34-56-78',
  '06.12.34.56.78',
  '  0612345678  ',
  '+212612345678',
  '+212 6 12 34 56 78',
  '00212612345678',
  '212612345678',
  '612345678',
]

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: CONNECTION_STRING })
  try {
    await client.connect()
  } catch (cause) {
    throw new Error(
      `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
        'Démarrer le stack : npx supabase start && npx supabase db reset',
      { cause },
    )
  }
})

afterAll(async () => {
  await client?.end()
})

async function phoneDigits(value: string): Promise<string | null> {
  const { rows } = await client.query<{ digits: string | null }>(
    'select merx.phone_digits($1) as digits',
    [value],
  )
  return rows[0]!.digits
}

describe('merx.phone_digits() ↔ normalizePhone() — parité sur les écritures valides', () => {
  it.each(SAME_NUMBER)('« %s » : les deux rendent 0612345678', async (written) => {
    const expected = normalizePhone(written)
    expect(expected, 'précondition : phone.test.ts attend ce numéro comme valide').toBe('0612345678')

    expect(await phoneDigits(written)).toBe(expected)
  })

  it.each([
    ['0522334455'],
    ['0712345678'],
  ])('« %s » — les autres préfixes marocains aussi', async (written) => {
    const expected = normalizePhone(written)
    expect(await phoneDigits(written)).toBe(expected)
  })

  /*
   * Au-delà de la parité : `phone_digits()` n'a pas la validation finale de
   * `normalizePhone()`, et c'est voulu — un numéro étranger ou tronqué reste
   * cherchable par ses chiffres plutôt que de ne rien stocker. Ce n'est donc
   * **pas** un test de parité : il montre juste que la fonction ne lève
   * jamais et rend toujours quelque chose de plausible.
   */
  it.each([
    ['vide', '', null],
    ['espaces seuls', '   ', null],
    ['lettres seules', 'zéro six', null],
    ['indicatif étranger', '+33612345678', '33612345678'],
  ])('« %s » (%s) : normalizePhone refuse, phone_digits rend %s sans lever', async (_label, written, expected) => {
    expect(normalizePhone(written)).toBeNull()
    expect(await phoneDigits(written)).toBe(expected)
  })
})
