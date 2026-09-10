// @vitest-environment node

/*
 * E0-02 — les conventions de schéma, vérifiées sur la base réelle.
 *
 * Ces tests demandent le stack local : `npx supabase start`, puis
 * `npx supabase db reset`. Ils échouent bruyamment si la base est absente.
 * Un test de convention qui se saute tout seul laisserait la suite passer au
 * vert sans avoir rien vérifié — SPEC § 2.7, RÈGLE tests.
 *
 * Aujourd'hui `public` ne contient aucune table : les balayages sont vides.
 * Le dernier bloc le compense en soumettant aux mêmes règles une table
 * conforme et une table fautive, dans une transaction annulée. Sans lui, on
 * n'aurait que la promesse d'un contrôle.
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  RULES,
  describe as describeViolations,
  violations,
  type RuleName,
  type Violation,
} from './conventions'

/*
 * Les tests d'auto-contrôle ne parlent que de leur propre table. Sans ce
 * filtre, une infraction réelle ailleurs dans `public` les ferait échouer eux
 * aussi, et le rapport désignerait le mauvais coupable : c'est au bloc
 * « schéma public » de signaler le schéma réel.
 */
function onProbe(found: readonly Violation[], table: string): Violation[] {
  return found.filter((v) => v.table_name === table)
}

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))

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

/*
 * E0-02 demandait « une seule migration initiale, relisible » : les conventions
 * arrivent d'un bloc, pas en douze fragments qu'il faudrait recoudre pour
 * comprendre le schéma. Les migrations suivantes s'ajoutent normalement — elles
 * sont en ajout seul, comme tout le reste du projet (SPEC § 2.5).
 */
describe('migrations', () => {
  it('partent d\'une migration initiale unique', () => {
    const migrations = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()

    expect(migrations[0]).toMatch(/^\d{14}_init\.sql$/)
    expect(migrations.filter((file) => file.endsWith('_init.sql'))).toHaveLength(1)
  })

  it('sont horodatées, donc ordonnées sans ambiguïté', () => {
    const migrations = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))

    for (const migration of migrations) {
      expect(migration).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/)
    }
  })
})

describe('domaines numériques', () => {
  it('money_amount est numeric(12,2) et quantity numeric(12,3)', async () => {
    const { rows } = await client.query<{ typname: string; base: string }>(`
      select t.typname, format_type(t.typbasetype, t.typtypmod) as base
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      where t.typtype = 'd' and t.typname in ('money_amount', 'quantity')
      order by 1
    `)

    expect(rows).toEqual([
      { typname: 'money_amount', base: 'numeric(12,2)' },
      { typname: 'quantity', base: 'numeric(12,3)' },
    ])
  })
})

describe('schéma public', () => {
  for (const rule of Object.keys(RULES) as RuleName[]) {
    it(`respecte la règle : ${rule}`, async () => {
      const found = await violations(client, rule)
      expect(describeViolations(found)).toBe('')
    })
  }
})

/*
 * Les règles savent-elles dire non ? On les confronte à deux tables créées
 * puis annulées : l'une passée par les fonctions de convention, l'autre écrite
 * comme on écrirait sans les lire.
 */
describe('les règles attrapent une table fautive', () => {
  afterEach(async () => {
    await client.query('rollback')
  })

  it('laisse passer une table conforme', async () => {
    await client.query('begin')
    await client.query(`
      create table public.compliant_probe (id uuid primary key default gen_random_uuid());
      select merx.apply_reference_conventions('public.compliant_probe');
      alter table public.compliant_probe
        add column unit_price money_amount,
        add column on_hand    quantity;
    `)

    for (const rule of Object.keys(RULES) as RuleName[]) {
      const found = await violations(client, rule)
      expect(describeViolations(onProbe(found, 'compliant_probe')), `règle : ${rule}`).toBe('')
    }
  })

  it('signale chaque écart d\'une table écrite sans les conventions', async () => {
    await client.query('begin')
    await client.query(`
      create table public.rogue_probe (
        id         bigserial primary key,
        unit_price numeric(12, 2),
        ratio      double precision,
        counted_at timestamp
      );
    `)

    // Hors registre : la première règle suffit à la voir. On ne regarde que
    // notre propre sonde — c'est au bloc « schéma public » de signaler les
    // autres infractions, et ce test ne doit pas dépendre de leur absence.
    expect(onProbe(await violations(client, 'table non enregistrée'), 'rogue_probe')).toHaveLength(1)

    // On l'enregistre de force, pour soumettre la table aux règles suivantes.
    await client.query(
      "insert into merx.convention_registry (table_name, kind) values ('rogue_probe', 'reference')",
    )

    const expected: RuleName[] = [
      'clé primaire uuid générée',
      'colonnes standard',
      'trigger updated_at',
      'deleted_at sur les tables de référence',
      'aucun flottant',
      'aucun numeric nu',
      'aucune date sans fuseau',
    ]

    for (const rule of expected) {
      const found = onProbe(await violations(client, rule), 'rogue_probe')
      expect(found.length, `règle non déclenchée : ${rule}`).toBeGreaterThan(0)
    }
  })

  it('signale une entrée de registre sans table', async () => {
    await client.query('begin')
    await client.query(
      "insert into merx.convention_registry (table_name, kind) values ('ghost_probe', 'business')",
    )

    const found = await violations(client, 'registre périmé')
    expect(found.map((v) => v.table_name)).toEqual(['ghost_probe'])
  })
})
