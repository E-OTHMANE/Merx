// Engendre `docs/SCHEMA.md` depuis le catalogue de la base locale.
//
//   npm run schema:doc
//
// Le document n'est écrit nulle part à la main : c'est `pg_catalog` qui le
// dicte, et `supabase/tests/schema-doc.test.ts` qui refuse qu'il s'en écarte.
// Ce fichier ne fait que connecter, rendre et écrire — tout le rendu vit dans
// `supabase/tests/schemaDoc.ts`, pour que le script et le test produisent la
// même chose par construction et non par ressemblance.
//
// À lancer **après** `npx supabase db reset` : ce qui est décrit est la base
// telle qu'elle tourne, pas les migrations telles qu'elles sont écrites.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

import { SCHEMA_DOC_URL, renderSchemaDoc } from '../supabase/tests/schemaDoc.ts'

const CONNECTION_STRING =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54522/postgres'

const client = new Client({ connectionString: CONNECTION_STRING })

try {
  await client.connect()
} catch (cause) {
  console.error(
    `Base locale injoignable sur ${CONNECTION_STRING}.\n` +
      'Démarrer le stack : npx supabase start && npx supabase db reset',
  )
  console.error(cause)
  process.exit(1)
}

try {
  const document = await renderSchemaDoc(client)
  const path = fileURLToPath(SCHEMA_DOC_URL)
  writeFileSync(path, document, 'utf8')
  const lines = document.split('\n').length - 1
  console.log(`docs/SCHEMA.md engendré — ${lines} lignes.`)
} finally {
  await client.end()
}
