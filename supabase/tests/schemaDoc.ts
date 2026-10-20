/*
 * `docs/SCHEMA.md` — engendré depuis le catalogue Postgres, jamais écrit à la
 * main.
 *
 * Ce fichier porte la **production** du document ; `scripts/schema-doc.mjs` ne
 * fait que l'écrire sur le disque, et `schema-doc.test.ts` que comparer le
 * disque à ce qu'il produit. Les trois lisent donc la même chose, ce qui est
 * tout l'intérêt : un document de schéma qui se recopie à la main dit, au bout
 * de deux migrations, ce que la base ne dit plus. Ici il n'y a rien à recopier,
 * et la suite rougit tant que le fichier et la base ne coïncident pas.
 *
 * **Aucun nom d'objet n'est écrit ici** — ni table, ni fonction, ni registre.
 * Tout est lu dans `pg_catalog`, comme le fait déjà `isolation.ts` : une table
 * ajoutée par une migration entre d'elle-même dans le document, et une table
 * oubliée ne peut pas en sortir en silence. Les deux seules exceptions sont
 * nommées et justifiées plus bas, dans la classification des registres de
 * `merx`.
 *
 * **Ce qui est lu est la base, pas les migrations.** Le document décrit l'état
 * que `npx supabase db reset` produit. Une migration éditée mais non rejouée
 * laisse la base en arrière, et c'est alors la base qui est décrite — même
 * famille de piège que le runtime Edge qui sert la version en cache
 * (CLAUDE.md) : on régénère après un `db reset`, pas avant.
 *
 * **Déterminisme.** Rien d'horodaté, rien de compté à la volée, et chaque
 * requête porte son `order by` : deux exécutions sur la même base rendent le
 * même texte, octet pour octet. Sans cela le test de différence rougirait au
 * hasard et finirait désarmé.
 */

import type { Client } from 'pg'

/** Les deux schémas que le projet possède. `public` est le métier, `merx` l'outillage. */
const SCHEMAS = ['public', 'merx'] as const

/**
 * Le chemin du document, dérivé de celui de ce fichier.
 *
 * Le script et le test le prennent ici tous les deux : deux copies du chemin,
 * c'est un jour où l'un écrit un fichier que l'autre ne lit pas.
 */
export const SCHEMA_DOC_URL = new URL('../../docs/SCHEMA.md', import.meta.url)

/* -------------------------------------------------------------------------- */
/* Mise en forme                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Une valeur du catalogue, prête à entrer dans une cellule de tableau.
 *
 * Trois replis, et chacun évite un document cassé plutôt qu'une laideur : la
 * barre verticale fermerait la colonne (les `||` de concaténation en sont
 * pleins), un saut de ligne fermerait la ligne (les expressions de policy en
 * portent), et une apostrophe inverse fermerait le code en ligne.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'oui' : 'non'
  if (Array.isArray(value)) return value.length === 0 ? '—' : `{${value.map(String).join(', ')}}`

  /*
   * Un `jsonb` arrive déjà analysé par le pilote : sans ce repli, un objet se
   * rendrait « [object Object] » — un défaut par le vide est pire qu'une
   * absence, parce qu'il se lit comme une donnée.
   */
  if (typeof value === 'object') return JSON.stringify(value)

  /* Une chaîne vide est une valeur, pas une absence : les deux se distinguent. */
  if (value === '') return '(vide)'

  return String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'").trim()
}

/** La même valeur, en code en ligne — ou le tiret cadratin, qui n'est pas du code. */
function code(value: unknown): string {
  const text = cell(value)
  return text === '—' ? text : `\`${text}\``
}

/**
 * Un tableau Markdown, ou une phrase quand il n'y a rien à montrer.
 *
 * « Aucune policy » doit se lire comme un fait du catalogue, pas comme un
 * tableau vide qu'on prendrait pour un oubli du générateur.
 */
function table(headers: readonly string[], rows: readonly string[][], empty: string): string {
  if (rows.length === 0) return `${empty}\n`

  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ]
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------------------- */
/* Lectures du catalogue                                                      */
/* -------------------------------------------------------------------------- */

interface Row {
  [column: string]: unknown
}

async function rows(client: Client, sql: string, params: readonly unknown[] = []): Promise<Row[]> {
  const result = await client.query(sql, params as unknown[])
  return result.rows as Row[]
}

/* Les deux domaines nommés de SPEC § 4 — et tout domaine qu'une migration ajoutera. */
const DOMAINS = `
  select n.nspname                                        as schema_name,
         t.typname                                        as domain_name,
         format_type(t.typbasetype, t.typtypmod)          as base_type,
         t.typnotnull                                     as not_null,
         t.typdefault                                     as default_value,
         (select string_agg(pg_get_constraintdef(c.oid), ' ; ' order by c.conname)
            from pg_constraint c
           where c.contypid = t.oid)                      as checks
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
   where t.typtype = 'd'
     and n.nspname = any($1)
   order by n.nspname, t.typname
`

const ENUMS = `
  select n.nspname as schema_name,
         t.typname as enum_name,
         (select array_agg(e.enumlabel::text order by e.enumsortorder)
            from pg_enum e
           where e.enumtypid = t.oid) as labels
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
   where t.typtype = 'e'
     and n.nspname = any($1)
   order by n.nspname, t.typname
`

/*
 * Toutes les tables de `public`, pas celles d'un registre — même raison qu'en
 * tête d'`isolation.ts` : partir du registre revient à ne décrire que les
 * tables déjà passées par les helpers, c'est-à-dire exactement celles dont on
 * est sûr. Une table écrite en `create table` direct est justement celle qu'on
 * veut voir apparaître.
 */
const TABLES = `
  select c.oid,
         c.relname                                   as table_name,
         c.relrowsecurity                            as rls_enabled,
         c.relforcerowsecurity                       as rls_forced,
         obj_description(c.oid, 'pg_class')          as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relkind = 'r'
   order by c.relname
`

const COLUMNS = `
  select a.attname                                   as column_name,
         format_type(a.atttypid, a.atttypmod)        as column_type,
         a.attnotnull                                as not_null,
         pg_get_expr(d.adbin, d.adrelid)             as default_expr,
         a.attgenerated                              as generated
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = $1
     and a.attnum > 0
     and not a.attisdropped
   order by a.attnum
`

const CONSTRAINTS = `
  select c.conname                      as constraint_name,
         c.contype                      as kind,
         pg_get_constraintdef(c.oid)    as definition
    from pg_constraint c
   where c.conrelid = $1
   order by c.conname
`

/* Les index qui ne servent pas une contrainte : ceux-là sont des décisions de plan. */
const INDEXES = `
  select i.relname                          as index_name,
         pg_get_indexdef(x.indexrelid)      as definition
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
   where x.indrelid = $1
     and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid)
   order by i.relname
`

const POLICIES = `
  select p.polname                                   as policy_name,
         p.polpermissive                             as permissive,
         p.polcmd                                    as cmd,
         case when 0 = any(p.polroles) then 'public'
              else (select string_agg(r.rolname, ', ' order by r.rolname)
                      from pg_roles r
                     where r.oid = any(p.polroles))
         end                                         as roles,
         pg_get_expr(p.polqual, p.polrelid)          as using_expr,
         pg_get_expr(p.polwithcheck, p.polrelid)     as check_expr
    from pg_policy p
   where p.polrelid = $1
   order by p.polname
`

/*
 * La condition d'un trigger est extraite de `pg_get_triggerdef()`, et non lue
 * par `pg_get_expr(tgqual, tgrelid)` : un `when` nomme `old` **et** `new`, donc
 * deux relations, et `pg_get_expr` refuse une expression qui en porte plus
 * d'une (« expression contains variables of more than one relation »). Le reste
 * de la définition est redit colonne par colonne, plus lisible qu'un
 * `create trigger` complet par ligne.
 */
const TRIGGERS = `
  select t.tgname                                        as trigger_name,
         t.tgtype                                        as type_bits,
         substring(pg_get_triggerdef(t.oid)
                   from 'WHEN \\((.+)\\) EXECUTE FUNCTION')
                                                         as when_expr,
         quote_ident(fn.nspname) || '.' || p.proname     as function_name
    from pg_trigger t
    join pg_proc p      on p.oid = t.tgfoid
    join pg_namespace fn on fn.oid = p.pronamespace
   where t.tgrelid = $1
     and not t.tgisinternal
   order by t.tgname
`

const FUNCTIONS = `
  select n.nspname                                      as schema_name,
         p.proname                                      as function_name,
         pg_get_function_identity_arguments(p.oid)      as arguments,
         pg_get_function_result(p.oid)                  as returns,
         l.lanname                                      as language,
         p.provolatile                                  as volatility,
         p.prosecdef                                    as security_definer,
         p.proconfig                                    as settings,
         r.guard                                        as guard
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l  on l.oid = p.prolang
    left join merx.rls_exception_registry r
           on r.schema_name = n.nspname and r.function_name = p.proname
   where n.nspname = any($1)
   order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
`

const RLS_EXCEPTIONS = `
  select schema_name, function_name, guard, justification
    from merx.rls_exception_registry
   order by schema_name, function_name
`

const ROLE_CAPABILITY = `
  select capability,
         (select array_agg(r2.role::text order by r2.role::text)
            from merx.role_capability r2
           where r2.capability = r.capability) as roles
    from merx.role_capability r
   group by capability
   order by capability
`

const USER_ROLES = `
  select array_agg(e.enumlabel::text order by e.enumsortorder) as labels
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
   where t.typname = 'user_role'
`

/*
 * Les registres de `merx`, classés **par leur forme** et non par une liste de
 * noms : un registre qui porte une colonne `table_name` parle d'une table, et
 * se lit dans le bloc de cette table ; les autres portent une décision qui ne
 * se rattache à aucune table, et se lisent ensemble à la fin.
 *
 * Deux noms sont tout de même écrits, et c'est pour les sortir de ce balayage,
 * pas pour les y faire entrer : `role_capability` est la matrice § 3.1, qui a
 * sa section, et `rls_exception_registry` est clé par fonction, donc il se lit
 * avec les fonctions. Un registre que personne n'a prévu finit dans la section
 * générique — visible, jamais perdu.
 */
const REGISTRIES = `
  select c.relname as registry_name,
         exists (select 1
                   from pg_attribute a
                  where a.attrelid = c.oid
                    and a.attname = 'table_name'
                    and a.attnum > 0
                    and not a.attisdropped) as keyed_by_table
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'merx'
   where c.relkind = 'r'
     and c.relname not in ('role_capability', 'rls_exception_registry')
   order by c.relname
`

const REGISTRY_COLUMNS = `
  select a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'merx'
   where c.relname = $1
     and a.attnum > 0
     and not a.attisdropped
   order by a.attnum
`

/* -------------------------------------------------------------------------- */
/* Décodage                                                                   */
/* -------------------------------------------------------------------------- */

/** La lettre de `pg_proc.provolatile`, dite en français. */
const VOLATILITY: Readonly<Record<string, string>> = {
  i: 'immutable',
  s: 'stable',
  v: 'volatile',
}

/** La lettre de `pg_constraint.contype`, dite en français. */
const CONSTRAINT_KIND: Readonly<Record<string, string>> = {
  p: 'clé primaire',
  u: 'unicité',
  f: 'clé étrangère',
  c: 'check',
  x: 'exclusion',
  t: 'trigger',
}

/** La lettre de `pg_policy.polcmd`, dite en français — comme dans `isolation.ts`. */
const POLICY_CMD: Readonly<Record<string, string>> = {
  '*': 'les quatre opérations',
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
}

/**
 * Les bits de `pg_trigger.tgtype`, tels que `trigger.h` les définit.
 *
 * Lus ici plutôt que par `pg_get_triggerdef()` : la définition complète répète
 * le nom de la table et de la fonction à chaque ligne, et le document doit se
 * parcourir à l'œil.
 */
function triggerTiming(bits: number): string {
  if ((bits & 2) !== 0) return 'BEFORE'
  if ((bits & 64) !== 0) return 'INSTEAD OF'
  return 'AFTER'
}

function triggerEvents(bits: number): string {
  const events: string[] = []
  if ((bits & 4) !== 0) events.push('INSERT')
  if ((bits & 8) !== 0) events.push('DELETE')
  if ((bits & 16) !== 0) events.push('UPDATE')
  if ((bits & 32) !== 0) events.push('TRUNCATE')
  return events.join(' OR ')
}

/** `for each row` ou `for each statement` : le premier bit de `tgtype`. */
function triggerLevel(bits: number): string {
  return (bits & 1) !== 0 ? 'ligne' : 'instruction'
}

/* -------------------------------------------------------------------------- */
/* Les sections                                                               */
/* -------------------------------------------------------------------------- */

const HEADER = `# SCHEMA — le catalogue, tel que la base le porte

<!--
  ENGENDRÉ — ne pas écrire à la main.

  Produit par \`npm run schema:doc\` depuis \`pg_catalog\`, sur la base locale
  telle qu'un \`npx supabase db reset\` vient de la rebâtir.
  \`supabase/tests/schema-doc.test.ts\` compare ce fichier à ce que le catalogue
  produit : une migration sans régénération laisse la suite rouge.

  Toute correction se fait dans une migration, puis on régénère. Corriger ce
  fichier ne corrige rien : il n'est la source de rien.
-->

Ce document décrit ce que la base **est**. Ce qu'elle **doit** être, et pourquoi,
vit dans \`docs/SPEC.md\` ; les décisions de chaque story dans \`docs/BACKLOG.md\`.
Quand les deux divergent, c'est le spec qui tranche et une migration qui corrige.
`

async function domainsSection(client: Client): Promise<string> {
  const found = await rows(client, DOMAINS, [SCHEMAS])

  const body = table(
    ['domaine', 'type de base', 'non nul', 'défaut', 'contraintes'],
    found.map((row) => [
      code(`${row.schema_name}.${row.domain_name}`),
      code(row.base_type),
      cell(row.not_null),
      code(row.default_value),
      code(row.checks),
    ]),
    'Aucun domaine.',
  )

  return `## Domaines

Les domaines de SPEC § 4 : tout montant est un \`money_amount\`, toute quantité une
\`quantity\`. Un \`numeric\` nu dans une table métier est une infraction, que
\`conventions.ts\` signale.

${body}`
}

async function enumsSection(client: Client): Promise<string> {
  const found = await rows(client, ENUMS, [SCHEMAS])

  const body = found
    .map((row) => {
      const labels = (row.labels as string[] | null) ?? []
      return `- \`${row.schema_name}.${row.enum_name}\` — ${labels.map((l) => `\`${l}\``).join(', ')}`
    })
    .join('\n')

  return `## Énumérations

Une étiquette d'enum est une valeur que le balayage d'isolation sait fabriquer
(CLAUDE.md) : c'est pourquoi un domaine machine-lisible est préféré à un \`check\`
porteur d'un motif.

${body === '' ? 'Aucune énumération.' : body}
`
}

/**
 * Les registres de `merx` clés par table, rangés par table.
 *
 * Chaque registre est nommé par son vrai nom, sans traduction : un libellé
 * français en regard serait une seconde copie à tenir, et celle qui se périme.
 */
async function tableRegistries(client: Client): Promise<Map<string, string[]>> {
  const byTable = new Map<string, string[]>()
  const registries = (await rows(client, REGISTRIES)).filter((row) => row.keyed_by_table === true)

  for (const registry of registries) {
    const name = String(registry.registry_name)
    const columns = (await rows(client, REGISTRY_COLUMNS, [name])).map((row) =>
      String(row.column_name),
    )
    const others = columns.filter((column) => column !== 'table_name')
    const ordering = columns.map((_, index) => index + 1).join(', ')
    const entries = await rows(client, `select * from merx.${name} order by ${ordering}`)

    for (const entry of entries) {
      const detail = others
        .map((column) => `${column} = ${cell(entry[column])}`)
        .join(', ')
      const line = detail === '' ? `\`merx.${name}\`` : `\`merx.${name}\` (${detail})`
      const key = String(entry.table_name)
      byTable.set(key, [...(byTable.get(key) ?? []), line])
    }
  }

  return byTable
}

async function tablesSection(client: Client): Promise<string> {
  const registries = await tableRegistries(client)
  const tables = await rows(client, TABLES)
  const blocks: string[] = []

  for (const entry of tables) {
    const oid = entry.oid
    const name = String(entry.table_name)

    /*
     * Séquentiel, et non `Promise.all` : une connexion `pg` ne mène qu'une
     * requête à la fois — en lancer cinq ensemble ne les parallélise pas, cela
     * réveille un avertissement de dépréciation et mélange les réponses.
     */
    const columns = await rows(client, COLUMNS, [oid])
    const constraints = await rows(client, CONSTRAINTS, [oid])
    const indexes = await rows(client, INDEXES, [oid])
    const policies = await rows(client, POLICIES, [oid])
    const triggers = await rows(client, TRIGGERS, [oid])

    const comment = entry.comment === null ? '' : `> ${cell(entry.comment)}\n\n`

    const rls =
      entry.rls_enabled === true
        ? entry.rls_forced === true
          ? 'RLS activée et **forcée**.'
          : 'RLS activée, **non forcée**.'
        : "**RLS absente** — SPEC § 2.1 l'exige sur toute table métier."

    const inscribed = registries.get(name) ?? []
    const registryLines =
      inscribed.length === 0
        ? "Inscrite à aucun registre de `merx`.\n"
        : `${inscribed.map((line) => `- ${line}`).join('\n')}\n`

    blocks.push(
      `### \`${name}\`

${comment}${rls}

**Registres**

${registryLines}
**Colonnes**

${table(
  ['colonne', 'type', 'non nul', 'défaut ou expression'],
  columns.map((column) => [
    code(column.column_name),
    code(column.column_type),
    cell(column.not_null),
    column.generated === 's'
      ? `engendrée : ${code(column.default_expr)}`
      : code(column.default_expr),
  ]),
  'Aucune colonne.',
)}
**Contraintes**

${table(
  ['nom', 'genre', 'définition'],
  constraints.map((constraint) => [
    code(constraint.constraint_name),
    CONSTRAINT_KIND[String(constraint.kind)] ?? String(constraint.kind),
    code(constraint.definition),
  ]),
  'Aucune contrainte.',
)}
**Index** (hors ceux qui servent une contrainte)

${table(
  ['nom', 'définition'],
  indexes.map((index) => [code(index.index_name), code(index.definition)]),
  'Aucun index propre.',
)}
**Policies**

${table(
  ['nom', 'genre', 'opérations', 'rôles', 'using', 'with check'],
  policies.map((policy) => [
    code(policy.policy_name),
    policy.permissive === true ? 'permissive' : 'restrictive',
    POLICY_CMD[String(policy.cmd)] ?? String(policy.cmd),
    code(policy.roles),
    code(policy.using_expr),
    code(policy.check_expr),
  ]),
  'Aucune policy.',
)}
**Triggers**

${table(
  ['nom', 'moment', 'événements', 'portée', 'condition', 'fonction'],
  triggers.map((trigger) => {
    const bits = Number(trigger.type_bits)
    return [
      code(trigger.trigger_name),
      triggerTiming(bits),
      triggerEvents(bits),
      triggerLevel(bits),
      code(trigger.when_expr),
      code(trigger.function_name),
    ]
  }),
  'Aucun trigger.',
)}`,
    )
  }

  const index = tables.map((entry) => `\`${String(entry.table_name)}\``).join(' · ')

  return `## Tables de \`public\`

${tables.length} tables : ${index}

${blocks.join('\n')}`
}

async function functionsSection(client: Client): Promise<string> {
  const found = await rows(client, FUNCTIONS, [SCHEMAS])
  const blocks: string[] = []

  for (const schema of SCHEMAS) {
    const own = found.filter((row) => row.schema_name === schema)

    blocks.push(
      `### Schéma \`${schema}\`

${table(
  ['fonction', 'rend', 'langage', 'volatilité', 'sécurité', 'réglages', 'garde § 2.1'],
  own.map((fn) => [
    code(`${fn.function_name}(${cell(fn.arguments) === '—' ? '' : fn.arguments})`),
    code(fn.returns),
    cell(fn.language),
    VOLATILITY[String(fn.volatility)] ?? String(fn.volatility),
    fn.security_definer === true ? '**definer**' : 'invoker',
    cell(fn.settings),
    code(fn.guard),
  ]),
  'Aucune fonction.',
)}`,
    )
  }

  return `## Fonctions

« Garde § 2.1 » est la forme déclarée à \`merx.rls_exception_registry\`, que
\`conventions.ts\` contrôle **au corps** de la fonction : inscrire une forme sans
l'avoir ne passe pas. Une fonction \`definer\` sans garde inscrit est une
infraction, pas une colonne vide.

${blocks.join('\n')}`
}

async function rlsExceptionsSection(client: Client): Promise<string> {
  const found = await rows(client, RLS_EXCEPTIONS)

  const body = found
    .map(
      (row) =>
        `- \`${row.schema_name}.${row.function_name}\` — garde \`${cell(row.guard)}\`\n` +
        `  ${cell(row.justification)}`,
    )
    .join('\n')

  return `## Exceptions RLS inscrites — SPEC § 2.1

${found.length} entrées. Une exception n'est pas un précédent : chacune porte son
garde et sa justification en texte, que la base refuse vide.

${body === '' ? 'Aucune exception.' : body}
`
}

async function matrixSection(client: Client): Promise<string> {
  const roleRow = (await rows(client, USER_ROLES))[0]
  const allRoles = ((roleRow?.labels as string[] | null) ?? []).filter(
    (role) => role !== 'super_admin',
  )
  const found = await rows(client, ROLE_CAPABILITY)

  const body = table(
    ['capacité', ...allRoles],
    found.map((row) => {
      const granted = new Set((row.roles as string[] | null) ?? [])
      return [code(row.capability), ...allRoles.map((role) => (granted.has(role) ? '✓' : '—'))]
    }),
    'Aucune capacité.',
  )

  return `## Matrice \`merx.role_capability\` — SPEC § 3.1

La seule copie qui gouverne quelque chose : \`merx.can()\` ne lit qu'elle. Les
trois autres copies — l'union \`Capability\` et l'objet \`CAPABILITIES\` de
\`src/lib/auth/permissions.ts\`, et les deux fichiers de test qui les confrontent —
en sont le reflet, et la suite rougit dès qu'une capacité manque à l'une d'elles
(CLAUDE.md).

\`super_admin\` n'y figure pas : l'éditeur est traité en amont, par
\`merx.is_super_admin()\` et par la policy \`super_admin_all\`.

${body}`
}

async function decisionRegistriesSection(client: Client): Promise<string> {
  const registries = (await rows(client, REGISTRIES)).filter((row) => row.keyed_by_table !== true)
  const blocks: string[] = []

  for (const registry of registries) {
    const name = String(registry.registry_name)
    const columns = (await rows(client, REGISTRY_COLUMNS, [name])).map((row) =>
      String(row.column_name),
    )
    const ordering = columns.map((_, index) => index + 1).join(', ')
    const entries = await rows(client, `select * from merx.${name} order by ${ordering}`)

    blocks.push(
      `### \`merx.${name}\`

${table(
  columns,
  entries.map((entry) => columns.map((column) => code(entry[column]))),
  'Registre vide.',
)}`,
    )
  }

  return `## Registres de décision de \`merx\`

Les registres qui ne parlent d'aucune table en particulier : une chaîne admise,
un écrivain déclaré, un type ouvert sur une capacité. Ce sont des **données**, et
c'est volontaire — une règle écrite en données se lit, se teste et s'énumère,
alors qu'une règle écrite dans un corps de fonction se contourne en écrivant
autrement (BACKLOG E4-05).

Les registres clés par table, eux, se lisent dans le bloc de leur table.

${blocks.join('\n')}`
}

/* -------------------------------------------------------------------------- */
/* Le document                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Le texte entier de `docs/SCHEMA.md`, lu sur la base donnée.
 *
 * Le document finit par un saut de ligne et par rien d'autre : un fichier dont
 * la fin varie ferait rougir le test pour une raison que personne ne verrait.
 */
export async function renderSchemaDoc(client: Client): Promise<string> {
  const sections = [
    HEADER,
    await domainsSection(client),
    await enumsSection(client),
    await tablesSection(client),
    await functionsSection(client),
    await rlsExceptionsSection(client),
    await matrixSection(client),
    await decisionRegistriesSection(client),
  ]

  return `${sections.map((section) => section.trimEnd()).join('\n\n---\n\n')}\n`
}
