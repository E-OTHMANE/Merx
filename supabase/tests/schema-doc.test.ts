// @vitest-environment node

/*
 * `docs/SCHEMA.md` est engendré, et ce fichier est ce qui le tient.
 *
 * Le document est produit par `npm run schema:doc` depuis `pg_catalog`
 * (`schemaDoc.ts`). Rien n'oblige en soi un développeur à le régénérer après
 * une migration — sauf ceci : la suite compare le fichier du disque à ce que le
 * catalogue produit **maintenant**, et une migration sans régénération laisse
 * un rouge qui nomme la commande à lancer.
 *
 * Trois cas, et le troisième n'est pas du zèle :
 *
 *   1. le fichier existe et n'est pas vide — sinon le cas 2 comparerait deux
 *      vides et passerait au vert sans rien mesurer ;
 *   2. il est identique, octet pour octet, à ce que le catalogue produit ;
 *   3. il **nomme** chaque table, chaque énumération et chaque fonction des
 *      deux schémas. Le cas 2 compare le document au générateur : un
 *      générateur qui cesserait de rendre les tables produirait un document
 *      amputé que le cas 2 accepterait sans broncher, le jour où quelqu'un
 *      régénère. Ce cas-ci compare le document à la **base**, et ferme ce
 *      trou-là — même famille que les règles de `conventions.ts`, qui ne se
 *      croient jamais sur parole.
 *
 * Ce qui est mesuré est la base telle qu'elle tourne, pas les migrations telles
 * qu'elles sont écrites : un rouge ici se lit après un `npx supabase db reset`,
 * jamais avant (CLAUDE.md).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SCHEMA_DOC_URL, renderSchemaDoc } from './schemaDoc'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const DOC_PATH = fileURLToPath(SCHEMA_DOC_URL)

/** Ce qu'il faut taper. La phrase est la même partout : c'est elle qu'on lit dans le rouge. */
const REGENERATE = 'Régénérer : npm run schema:doc (après npx supabase db reset)'

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
  await client.end()
})

function onDisk(): string {
  try {
    return readFileSync(DOC_PATH, 'utf8')
  } catch (cause) {
    throw new Error(`docs/SCHEMA.md illisible.\n${REGENERATE}`, { cause })
  }
}

/**
 * Les premières lignes qui diffèrent, numérotées.
 *
 * Pas un `expect(a).toBe(b)` sur treize cents lignes : le rapport de vitest
 * serait illisible et personne n'y verrait la ligne fautive. Trois écarts
 * suffisent à savoir quoi régénérer.
 */
function report(actual: string, expected: string): string {
  const got = actual.split('\n')
  const want = expected.split('\n')
  const total = Math.max(got.length, want.length)

  const differing: string[] = []
  let count = 0

  for (let line = 0; line < total; line += 1) {
    if ((got[line] ?? '') === (want[line] ?? '')) continue
    count += 1
    if (differing.length < 3) {
      differing.push(
        `  ligne ${line + 1}\n` +
          `    sur le disque : ${JSON.stringify(got[line] ?? '(absente)')}\n` +
          `    dans la base  : ${JSON.stringify(want[line] ?? '(absente)')}`,
      )
    }
  }

  return (
    `docs/SCHEMA.md ne décrit plus la base : ${count} ligne(s) d'écart ` +
    `(${got.length} sur le disque, ${want.length} dans la base).\n` +
    `${differing.join('\n')}\n${REGENERATE}`
  )
}

describe('docs/SCHEMA.md', () => {
  it('existe et porte son avertissement d’engendrement', () => {
    const document = onDisk()

    expect(document.length).toBeGreaterThan(1_000)
    expect(document).toContain('ENGENDRÉ — ne pas écrire à la main.')
  })

  it('est identique à ce que le catalogue produit', async () => {
    const expected = await renderSchemaDoc(client)
    const actual = onDisk()

    if (actual !== expected) expect.fail(report(actual, expected))
  })

  it('nomme chaque table, chaque énumération et chaque fonction des deux schémas', async () => {
    const document = onDisk()

    const tables = await client.query<{ relname: string }>(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relkind = 'r'
       order by c.relname
    `)
    const enums = await client.query<{ schema_name: string; typname: string }>(`
      select n.nspname as schema_name, t.typname
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
       where t.typtype = 'e' and n.nspname in ('public', 'merx')
       order by 1, 2
    `)
    const functions = await client.query<{ proname: string }>(`
      select distinct p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'merx')
       order by p.proname
    `)

    /* Des tables, il y en a : une liste vide ferait passer les trois boucles. */
    expect(tables.rowCount).toBeGreaterThan(0)
    expect(enums.rowCount).toBeGreaterThan(0)
    expect(functions.rowCount).toBeGreaterThan(0)

    const missing: string[] = []

    for (const { relname } of tables.rows) {
      if (!document.includes(`### \`${relname}\``)) missing.push(`table ${relname}`)
    }
    for (const { schema_name, typname } of enums.rows) {
      if (!document.includes(`\`${schema_name}.${typname}\``)) {
        missing.push(`énumération ${schema_name}.${typname}`)
      }
    }
    for (const { proname } of functions.rows) {
      if (!document.includes(`\`${proname}(`)) missing.push(`fonction ${proname}`)
    }

    expect(missing, `Absents de docs/SCHEMA.md : ${missing.join(', ')}.\n${REGENERATE}`).toEqual([])
  })
})
