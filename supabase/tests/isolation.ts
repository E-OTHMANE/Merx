/*
 * Machinerie du test d'isolation — docs/SPEC.md § 2.1, docs/BACKLOG.md E0-03.
 *
 * Deux couches. Aucun nom de table n'est écrit ici : une table ajoutée plus
 * tard entre d'elle-même dans le balayage, et si elle n'a pas de policy, elle
 * échoue d'elle-même.
 *
 *   1. Structurelle — la RLS est-elle activée, forcée, et les policies
 *      sont-elles exactement celles attendues ? Lu dans le catalogue Postgres,
 *      sur **toutes** les tables de `public`, enregistrées ou non. Une table
 *      écrite sans passer par les conventions est justement celle qui risque
 *      de n'avoir aucune policy : la chercher dans le registre des tables
 *      conventionnées reviendrait à ne regarder que là où l'on est sûr de ne
 *      rien trouver.
 *
 *   2. Comportementale — deux commerces sont peuplés pour de bon, puis les
 *      quatre opérations sont tentées à travers la frontière. C'est la seule
 *      couche qui prouve quelque chose : une policy peut exister et être
 *      fausse. Elle part du registre, elle : fabriquer une ligne suppose les
 *      colonnes standard, `tenant_id` le premier.
 *
 * La couche 2 fabrique ses lignes en lisant le schéma. Quand elle ne sait pas
 * fabriquer une ligne, elle échoue en nommant la table et la colonne — elle ne
 * saute jamais une table en silence. Un test qui s'esquive tout seul laisse la
 * suite au vert sans avoir rien vérifié.
 */

import type { Client } from 'pg'

import type { Violation } from './conventions'

/* -------------------------------------------------------------------------- */
/* Couche 1 — le catalogue                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Les expressions attendues, telles que Postgres les restitue. Elles sont
 * comparées au texte près : une policy réécrite à la main, même équivalente,
 * doit passer par `merx.apply_tenant_isolation()` pour rester uniforme.
 */
const TENANT_QUAL = '(tenant_id = merx.current_tenant_id())'
const SUPER_ADMIN_QUAL = 'merx.is_super_admin()'

/**
 * La lettre de `pg_policy.polcmd`, dite en français. Le message d'infraction
 * est ce qu'on lit à 8 h du matin devant une suite rouge : « porte sur insert
 * seul » se comprend sans aller chercher ce que vaut `a`.
 */
const cmdLabel = (column: string): string => `case ${column}
                  when '*' then 'les quatre opérations'
                  when 'r' then 'select seul'
                  when 'a' then 'insert seul'
                  when 'w' then 'update seul'
                  when 'd' then 'delete seul'
                  else ${column} end`

/*
 * Toutes les tables de `public` — pas celles du registre.
 *
 * La nuance décide de ce que ces règles peuvent attraper. Partir du registre
 * revient à ne contrôler que les tables déjà passées par
 * `merx.apply_business_conventions()`, c'est-à-dire exactement celles qui ont
 * reçu leurs policies par construction. Une table écrite en CREATE TABLE
 * direct, sans helper, n'est pas au registre : elle serait invisible au
 * balayage censé la débusquer.
 *
 * `public` ne contient que du métier (SPEC § 4) : toute table qui s'y trouve
 * porte des données de commerce et doit donc être isolée, enregistrée ou non.
 */
const PUBLIC_TABLES = `
  select c.oid, c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind = 'r'
`

/* SPEC § 2.1 : RLS sur toute table métier, sans exception. */
const RLS_NOT_ENABLED = `
  with business as (${PUBLIC_TABLES})
  select t.relname as table_name,
         case
           when not c.relrowsecurity then 'RLS non activée'
           else 'RLS activée mais non forcée — le propriétaire y échappe'
         end as detail
  from business t
  join pg_class c on c.oid = t.oid
  where not c.relrowsecurity or not c.relforcerowsecurity
  order by 1
`

/*
 * Les policies attendues, exactement : ni manquante, ni supplémentaire, ni
 * altérée. Une policy de plus sur une table métier est une porte que personne
 * n'a décidé d'ouvrir.
 *
 * Deux policies permissives sur toute table, plus — pour les seules tables
 * inscrites au registre confidentiel (E0-05) — une troisième, **restrictive**.
 * La distinction porte tout le raisonnement : une policy restrictive se combine
 * en ET avec les permissives, elle ne peut donc qu'ajouter une condition. Une
 * permissive de plus aurait été un OU, c'est-à-dire une porte ouverte à côté de
 * la serrure. Le contrôle vérifie `polpermissive` case par case, précisément
 * pour que l'une ne puisse pas se faire passer pour l'autre.
 *
 * Le registre décide, jamais une liste écrite ici : une relation confidentielle
 * ajoutée en E2 entre d'elle-même dans le contrôle, et une policy restrictive
 * posée sans passer par `merx.apply_capability_restriction()` — donc sans
 * inscription au registre — est signalée comme inattendue.
 */
const POLICY_SET = `
  with business as (${PUBLIC_TABLES}),
  expected as (
    select t.relname, e.polname, true as permissive, '*' as cmd, e.qual, e.withcheck
    from business t
    cross join (values
      ('tenant_isolation', '${TENANT_QUAL}',      '${TENANT_QUAL}'),
      ('super_admin_all',  '${SUPER_ADMIN_QUAL}', '${SUPER_ADMIN_QUAL}')
    ) e(polname, qual, withcheck)

    union all

    select t.relname,
           'capability_restriction',
           false,
           '*',
           format('merx.can(%L::text)', c.capability),
           format('merx.can(%L::text)', c.capability)
    from business t
    join merx.confidential_registry c on c.table_name = t.relname

    union all

    /*
     * E1-05. Les tables dont l'écriture seule est réservée à une capacité :
     * trois policies restrictives, une par opération d'écriture, la lecture
     * laissée aux permissives d'isolation.
     *
     * Le registre décide, jamais une liste écrite ici — une table qui s'y
     * inscrit est vérifiée sans qu'une ligne de ce fichier change. Les vides
     * sont significatifs : un INSERT n'a pas de \`using\`, un DELETE pas de
     * \`with check\`, et exiger le contraire laisserait passer une policy qui
     * qualifie ce qu'elle ne devrait pas.
     */
    select t.relname, w.polname, false, w.cmd,
           case when w.has_qual      then format('merx.can(%L::text)', c.capability) else '' end,
           case when w.has_withcheck then format('merx.can(%L::text)', c.capability) else '' end
    from business t
    join merx.write_capability_registry c on c.table_name = t.relname
    cross join (values
      ('write_capability_insert', 'a', false, true),
      ('write_capability_update', 'w', true,  true),
      ('write_capability_delete', 'd', true,  false)
    ) w(polname, cmd, has_qual, has_withcheck)

    union all

    /*
     * E3-01. Les tables dont l'insertion exige une capacité résolue depuis une
     * colonne de la ligne — \`stock_movement\` et son type de mouvement. Une
     * policy restrictive pour INSERT seul, sans \`using\` : il n'y a pas de
     * ligne existante à qualifier.
     *
     * Le registre décide, comme pour les trois autres branches. Le résolveur
     * doit passer par \`merx.can()\` (SPEC § 3, RÈGLE un seul helper) ; ce
     * contrôle-ci vérifie la forme de la policy, pas le corps du résolveur.
     */
    select t.relname, 'column_capability_insert', false, 'a',
           '',
           format('merx.%s(%s)', c.resolver_function, c.column_name)
    from business t
    join merx.column_capability_registry c on c.table_name = t.relname
  ),
  actual as (
    select t.relname,
           p.polname,
           p.polpermissive,
           p.polcmd,
           pg_get_expr(p.polqual, p.polrelid)      as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as withcheck,
           coalesce(
             (select array_agg(pg_get_userbyid(oid)::text order by pg_get_userbyid(oid)::text)
              from unnest(p.polroles) as oid
              where oid <> 0),
             array['public']
           ) as roles
    from business t
    join pg_policy p on p.polrelid = t.oid
  )
  select e.relname as table_name,
         format('policy %I absente', e.polname) as detail
  from expected e
  where not exists (
    select 1 from actual a where a.relname = e.relname and a.polname = e.polname
  )

  union all

  select a.relname as table_name,
         format('policy %I inattendue — l''isolation passe par '
                'merx.apply_tenant_isolation(), la confidentialité par '
                'merx.apply_capability_restriction(), l''écriture restreinte par '
                'merx.apply_write_capability_restriction() ou '
                'merx.apply_column_capability_insert()', a.polname) as detail
  from actual a
  where not exists (
    select 1 from expected e where e.relname = a.relname and e.polname = a.polname
  )

  union all

  select a.relname as table_name,
         format('policy %I : %s', a.polname,
                case
                  when a.polpermissive <> e.permissive
                    then format('%s, attendue %s',
                                case when a.polpermissive then 'permissive' else 'restrictive' end,
                                case when e.permissive then 'permissive' else 'restrictive' end)
                  when a.polcmd <> e.cmd
                    then format('porte sur %s, attendue sur %s',
                                ${cmdLabel('a.polcmd')}, ${cmdLabel('e.cmd')})
                  when a.roles <> array['authenticated']
                    then format('accordée à %s, attendue authenticated seul',
                                array_to_string(a.roles, ', '))
                  when coalesce(a.qual, '') <> e.qual
                    then format('using %s, attendu %s', coalesce(a.qual, '(aucun)'), e.qual)
                  else format('with check %s, attendu %s',
                              coalesce(a.withcheck, '(aucun)'), e.withcheck)
                end) as detail
  from actual a
  join expected e on e.relname = a.relname and e.polname = a.polname
  where a.polpermissive <> e.permissive
     or a.polcmd <> e.cmd
     or a.roles <> array['authenticated']
     or coalesce(a.qual, '') <> e.qual
     or coalesce(a.withcheck, '') <> e.withcheck

  order by 1, 2
`

/*
 * Les ACL par défaut de Supabase accordent tout à `anon` sur chaque nouvelle
 * table de `public`. Aucune policy ne vise `anon`, donc il ne lit rien — mais
 * un privilège qu'aucune policy ne rattrape est un accident qui attend une
 * policy trop large. Tout est derrière authentification (SPEC § 2.7).
 */
const ANON_PRIVILEGES = `
  with business as (${PUBLIC_TABLES})
  select t.relname as table_name,
         format('%s détient %s', g.grantee,
                string_agg(distinct g.privilege_type, ', ' order by g.privilege_type)) as detail
  from business t
  join information_schema.role_table_grants g
    on g.table_schema = 'public' and g.table_name = t.relname
  where g.grantee in ('anon', 'PUBLIC')
  group by 1, g.grantee
  order by 1, 2
`

export const ISOLATION_RULES = {
  'RLS activée et forcée': RLS_NOT_ENABLED,
  'les policies attendues, exactement': POLICY_SET,
  'aucun privilège pour anon': ANON_PRIVILEGES,
} as const

export type IsolationRuleName = keyof typeof ISOLATION_RULES

export async function isolationViolations(
  client: Client,
  rule: IsolationRuleName,
): Promise<Violation[]> {
  const result = await client.query<Violation>(ISOLATION_RULES[rule])
  return result.rows
}

/* -------------------------------------------------------------------------- */
/* Couche 2 — deux commerces, pour de bon                                      */
/* -------------------------------------------------------------------------- */

interface Column {
  name: string
  type: string
  category: string
  kind: string
  notnull: boolean
  hasdefault: boolean
  generated: boolean
  enum_labels: string[] | null
  fk_table: string | null
  /** Membre d'une clé étrangère composite d'une forme que le générateur ne sait pas remplir. */
  fk_unsupported: boolean
}

/*
 * La clé étrangère d'une colonne, lue dans le catalogue sous ses deux formes :
 *
 *   — à une colonne, `(x) references t (id)` ;
 *   — composite sur le commerce, `(tenant_id, x) references t (tenant_id, id)` —
 *     SPEC § 4, RÈGLE des clés étrangères composites, posée en E2-01. C'est la
 *     forme de toute clé entre tables métier désormais.
 *
 * Les deux se remplissent de la même façon : avec l'identifiant de la ligne
 * cible *du même commerce*, que le peuplement a déjà créée. La forme composite
 * est reconnue à sa structure — deux colonnes, dont `tenant_id` — et jamais à
 * un nom de table : une table ajoutée en E3 ou en E8 en hérite sans qu'une
 * ligne de ce fichier change.
 *
 * `tenant_id` lui-même participe à toutes ces clés composites ; seule sa clé à
 * une colonne, vers le commerce, le décrit. D'où l'exclusion.
 *
 * Une colonne prise dans une clé composite d'une autre forme est signalée
 * (`fk_unsupported`) : le générateur y écrirait un uuid au hasard, la clé
 * refuserait, et l'échec se lirait comme une policy fautive.
 */
const COLUMNS = `
  select a.attname                              as name,
         format_type(a.atttypid, a.atttypmod)   as type,
         coalesce(bt.typcategory, t.typcategory) as category,
         coalesce(bt.typtype, t.typtype)         as kind,
         a.attnotnull                            as notnull,
         a.atthasdef                             as hasdefault,
         (a.attgenerated <> '')                  as generated,
         (select array_agg(e.enumlabel::text order by e.enumsortorder)
          from pg_enum e
          where e.enumtypid = coalesce(nullif(t.typbasetype, 0), t.oid)) as enum_labels,
         fk.reftable                             as fk_table,
         (fk.reftable is null and exists (
            select 1 from pg_constraint k
            where k.conrelid = a.attrelid
              and k.contype = 'f'
              and a.attnum = any (k.conkey)
              and a.attname <> 'tenant_id'
          ))                                     as fk_unsupported
  from pg_attribute a
  join pg_type t on t.oid = a.atttypid
  left join pg_type bt on bt.oid = nullif(t.typbasetype, 0)
  left join pg_attribute ta
    on ta.attrelid = a.attrelid and ta.attname = 'tenant_id' and not ta.attisdropped
  left join lateral (
    select cf.oid::regclass::text as reftable
    from pg_constraint k
    join pg_class cf on cf.oid = k.confrelid
    where k.conrelid = a.attrelid
      and k.contype = 'f'
      and (
        k.conkey = array[a.attnum]
        or (a.attname <> 'tenant_id'
            and array_length(k.conkey, 1) = 2
            and a.attnum = any (k.conkey)
            and ta.attnum = any (k.conkey))
      )
    order by array_length(k.conkey, 1)
    limit 1
  ) fk on true
  where a.attrelid = $1::regclass
    and a.attnum > 0
    and not a.attisdropped
  order by a.attnum
`

/** Les tables placées sous convention — c'est-à-dire toutes les tables métier. */
export async function registeredTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    'select table_name from merx.convention_registry order by table_name',
  )
  return rows.map((r) => r.table_name)
}

/**
 * Comment s'écrit une ligne d'une table en ajout seul. E1-04 ; `restricted`
 * E3-01.
 */
export type WritePath = 'application' | 'helper' | 'restricted'

/**
 * Les tables en ajout seul, et par quel chemin elles s'écrivent — lues au
 * registre, jamais énumérées ici.
 *
 * Le balayage comportemental doit *inverser* son contrôle positif sur ces
 * tables-là : ce qui prouve qu'une table ordinaire n'est pas simplement
 * verrouillée pour tout le monde, c'est qu'un `owner` modifie et supprime sa
 * propre ligne. Sur une table en ajout seul, c'est le contraire qui est vrai,
 * et le contrôle positif devient l'insertion — sauf pour les deux chemins où
 * `authenticated` n'insère pas de ligne que le générateur sache fabriquer, et
 * où il reste la lecture :
 *
 *   'helper'     — le privilège d'INSERT est retiré ; seule une fonction
 *                  `security definer` écrit. C'est `audit_log` (E1-04).
 *   'restricted' — l'application insère, mais une policy qualifie chaque
 *                  insertion depuis une colonne de la ligne. C'est
 *                  `stock_movement` (E3-01), dont aucun type de mouvement n'est
 *                  ouvert aujourd'hui.
 *
 * Le registre décide parce que le grand livre (E6) arrivera après : il héritera
 * du balayage en s'inscrivant, sans qu'une ligne de ce fichier change.
 */
export async function appendOnlyTables(client: Client): Promise<Map<string, WritePath>> {
  const { rows } = await client.query<{ table_name: string; write_path: WritePath }>(
    'select table_name, write_path from merx.append_only_registry order by table_name',
  )
  return new Map(rows.map((r) => [r.table_name, r.write_path]))
}

/**
 * Les tables lisibles par tout le commerce mais dont l'écriture exige une
 * capacité, et laquelle — lues au registre, jamais énumérées ici. E1-05.
 *
 * `settings.test.ts` en dérive son balayage de comportement : la prochaine
 * table à écriture restreinte (la grille de prix en E2-03, les plafonds de
 * crédit en E6) sera éprouvée en s'inscrivant, sans qu'une ligne de test change.
 */
export async function writeCapabilityTables(client: Client): Promise<Map<string, string>> {
  const { rows } = await client.query<{ table_name: string; capability: string }>(
    'select table_name, capability from merx.write_capability_registry order by table_name',
  )
  return new Map(rows.map((r) => [r.table_name, r.capability]))
}

/**
 * Les tables dont chaque écriture est journalisée par trigger — lues au
 * registre, jamais énumérées ici. RÈGLE M8-1, addendum E2-03.
 *
 * Leur trigger refuse toute écriture sans commerce ni auteur dans le jeton ; le
 * harnais les peuple et les range donc triggers suspendus, comme les tables en
 * ajout seul (`rest.ts`, `withoutTriggers`).
 */
export async function auditedTables(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    'select table_name from merx.audited_registry order by table_name',
  )
  return new Set(rows.map((r) => r.table_name))
}

/**
 * Les tables dérivées — des agrégats maintenus par un trigger sur leur table
 * source, que l'application n'écrit jamais. Lues au registre, jamais énumérées
 * ici. RÈGLE M2-1, E3-01.
 *
 * Troisième façon pour une table de ne pas se laisser écrire, et elle se
 * distingue des deux autres par ce qu'elle laisse passer :
 *
 *   ajout seul — UPDATE et DELETE sont refusés **par le privilège** (`42501`),
 *                donc sur la ligne du voisin comme sur la sienne ;
 *   dérivée    — le privilège est intact (le trigger d'agrégat en a besoin), et
 *                c'est un garde de ligne qui refuse (`55000`). Une ligne du
 *                voisin n'étant pas visible, aucune ligne n'est touchée et
 *                aucun garde ne s'exécute : le balayage garde donc ses
 *                assertions de fuite, et n'inverse que le contrôle positif.
 */
export async function derivedTables(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(
    'select table_name from merx.derived_registry order by table_name',
  )
  return new Set(rows.map((r) => r.table_name))
}

async function columnsOf(client: Client, table: string): Promise<Column[]> {
  const { rows } = await client.query<Column>(COLUMNS, [`public.${table}`])
  return rows
}

/**
 * Une valeur SQL plausible pour une colonne, déduite de son type. Le but n'est
 * pas d'être réaliste : c'est d'obtenir une ligne valide sans rien savoir de la
 * table. Un type non couvert lève — jamais de table sautée en silence.
 */
function literalFor(table: string, column: Column, seed: number): string {
  const cast = (value: string): string => `(${value})::${column.type}`

  if (column.kind === 'e') {
    const label = column.enum_labels?.[0]
    if (label === undefined) {
      throw new Error(`${table}.${column.name} : enum ${column.type} sans valeur`)
    }
    return cast(`'${label}'`)
  }

  switch (column.category) {
    case 'S': // texte
      return cast(`'probe-${seed}'`)
    case 'B': // booléen
      return cast('false')
    case 'N': // numérique — couvre money_amount et quantity
      /*
       * Jamais 1. Depuis E2-03, un trigger pose d'office une ligne à la valeur
       * naturelle — le palier `min_qty = 1` de toute variante — et un 1 écrit
       * ici heurtait l'unicité des paliers (`23505`) : l'échec se serait lu
       * comme une policy fautive. `seed + 1` vaut au moins 2, et change d'une
       * colonne à l'autre.
       */
      return cast(String(seed + 1))
    case 'D': // date et heure
      return cast('now()')
    case 'U': // uuid, jsonb, et autres types « utilisateur »
      if (column.type === 'uuid') return 'gen_random_uuid()'
      if (column.type === 'jsonb' || column.type === 'json') return cast(`'{}'`)
      break
    case 'A': // tableau
      return cast(`'{}'`)
  }

  throw new Error(
    `${table}.${column.name} : type ${column.type} non couvert par le générateur ` +
      `de lignes. Étendre literalFor() dans supabase/tests/isolation.ts.`,
  )
}

/**
 * Ordonne les tables pour qu'une table soit toujours créée après celles dont
 * ses colonnes obligatoires dépendent — `tenant_id` compris, même si sa valeur
 * est résolue à part : c'est une vraie clé étrangère, et l'ordre inverse sert
 * aussi à supprimer. Sans elle dans le graphe, `tenant` et `app_user`
 * paraissent indépendants, et supprimer le commerce avant ses utilisateurs
 * bute sur la clé étrangère.
 *
 * `created_by` est nullable, donc jamais rempli, donc jamais un cycle entre
 * `tenant` et `app_user`.
 */
function topologicalOrder(dependencies: Map<string, Set<string>>): string[] {
  const ordered: string[] = []
  const pending = new Map(dependencies)

  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => [...deps].every((d) => ordered.includes(d)))
      .map(([table]) => table)
      .sort()

    if (ready.length === 0) {
      throw new Error(
        `Cycle de clés étrangères obligatoires entre : ${[...pending.keys()].join(', ')}`,
      )
    }

    for (const table of ready) {
      ordered.push(table)
      pending.delete(table)
    }
  }

  return ordered
}

/** Les lignes d'un commerce : une par table, indexées par nom de table. */
export type TenantRows = Map<string, string>

export interface Seeded {
  /** Table cible de la clé étrangère `tenant_id` — le commerce lui-même. */
  tenantTable: string
  tenants: { a: string; b: string }
  rows: { a: TenantRows; b: TenantRows }
  /** Tables dans l'ordre de création. Supprimer se fait dans l'ordre inverse. */
  order: string[]
  /**
   * Fabrique l'ordre d'insertion d'une ligne de plus, sans l'exécuter — de quoi
   * tenter une écriture dans le commerce d'en face.
   */
  insertSql: (table: string, tenant: string, rows: TenantRows) => string
}

/**
 * Peuple deux commerces complets : une ligne par table métier, de chaque côté
 * de la frontière. À exécuter en tant que `postgres`, qui porte BYPASSRLS.
 *
 * L'identité du commerce n'est pas devinée : elle est lue dans le schéma, en
 * suivant la clé étrangère `tenant_id`.
 */
export async function seedTwoTenants(client: Client): Promise<Seeded> {
  const tables = await registeredTables(client)
  if (tables.length === 0) {
    throw new Error('Registre de conventions vide : rien à vérifier.')
  }

  const columns = new Map<string, Column[]>()
  for (const table of tables) {
    columns.set(table, await columnsOf(client, table))
  }

  const tenantColumn = (table: string): Column => {
    const found = columns.get(table)?.find((c) => c.name === 'tenant_id')
    if (!found) throw new Error(`${table} : aucune colonne tenant_id`)
    return found
  }

  const targets = new Set(
    tables.map((t) => tenantColumn(t).fk_table).filter((t): t is string => t !== null),
  )
  if (targets.size !== 1) {
    throw new Error(
      'tenant_id doit pointer sur une seule et même table partout ; trouvé : ' +
        `${[...targets].join(', ') || '(aucune clé étrangère)'}`,
    )
  }
  const tenantTable = [...targets][0]!.replace(/^public\./, '')

  /*
   * Colonnes à renseigner : obligatoires et sans valeur par défaut — plus
   * `tenant_id`, toujours.
   *
   * Depuis E2-02, `tenant_id` a pour défaut `merx.current_tenant_id()`, le
   * commerce du jeton. Le peuplement tourne en `postgres`, sans jeton : laissé
   * au défaut, `tenant_id` vaudrait NULL et toute la base refuserait (`23502`,
   * constaté en retirant cette exception). Le générateur dit donc lui-même de
   * quel commerce il s'agit, comme tout chemin hors session doit le faire.
   */
  const required = (table: string): Column[] =>
    (columns.get(table) ?? []).filter(
      (c) => c.name === 'tenant_id' || (c.notnull && !c.hasdefault && !c.generated),
    )

  const dependencies = new Map<string, Set<string>>(
    tables.map((table) => [
      table,
      new Set(
        required(table)
          .filter((c) => c.fk_table !== null)
          .map((c) => c.fk_table!.replace(/^public\./, ''))
          .filter((dep) => dep !== table),
      ),
    ]),
  )

  /*
   * Une dépendance que `pg_constraint` ne porte pas. Depuis E3-02, insérer une
   * `variant` déclenche `open_stock_level`, qui ouvre sa ligne de `stock_level`
   * sur le dépôt par défaut du commerce — et refuse en `55000` s'il n'y en a
   * pas. Aucune colonne de `variant` ne pointe sur `warehouse`, donc l'ordre
   * dérivé des clés étrangères peut poser la variante avant le dépôt, et c'est
   * ce qui s'est produit.
   *
   * Déclarée, et non contournée en suspendant les triggers de `variant` : sous
   * suspension le balayage passerait sans créer aucune ligne de stock, et le
   * jour où un autre trigger de `variant` portera une propriété d'isolation, il
   * ne tournerait pas davantage. La déclaration se périme bruyamment — si l'une
   * des deux tables quitte le registre, le peuplement s'arrête en le disant.
   */
  const TRIGGER_DEPENDENCIES: ReadonlyArray<readonly [string, string]> = [
    ['variant', 'warehouse'],
    // Et `product`, parce que la chaîne a un maillon de plus : insérer un
    // produit déclenche le trigger d'E2-01 qui crée sa variante par défaut,
    // laquelle déclenche `open_stock_level`. La dépendance est transitive, et
    // aucune colonne ne la porte à aucun des deux étages.
    ['product', 'warehouse'],
  ]

  for (const [table, dependency] of TRIGGER_DEPENDENCIES) {
    if (!dependencies.has(table) || !dependencies.has(dependency)) {
      throw new Error(
        `Dépendance par trigger déclarée de ${table} vers ${dependency}, dont l'une n'est ` +
          'pas au registre de conventions : la déclaration est périmée (isolation.ts).',
      )
    }
    dependencies.get(table)!.add(dependency)
  }

  const order = topologicalOrder(dependencies)
  let seed = 0

  const insertSql = (table: string, tenant: string | null, rows: TenantRows): string => {
    const names: string[] = []
    const values: string[] = []

    for (const column of required(table)) {
      names.push(`"${column.name}"`)

      if (column.name === 'tenant_id') {
        // Pour la table `tenant` elle-même, le trigger réaligne sur `id` : la
        // valeur posée ici est sans importance, la colonne reste obligatoire.
        values.push(tenant === null ? 'gen_random_uuid()' : `'${tenant}'::uuid`)
        continue
      }

      if (column.fk_unsupported) {
        throw new Error(
          `${table}.${column.name} appartient à une clé étrangère composite qui n'est pas ` +
            'de la forme (tenant_id, x) → (tenant_id, id) — SPEC § 4. Le générateur ne sait ' +
            'pas la remplir ; étendre COLUMNS dans supabase/tests/isolation.ts.',
        )
      }

      if (column.fk_table !== null) {
        const parent = rows.get(column.fk_table.replace(/^public\./, ''))
        if (parent === undefined) {
          throw new Error(
            `${table}.${column.name} pointe sur ${column.fk_table}, dont aucune ligne ` +
              "n'a été créée. Vérifier l'ordre topologique.",
          )
        }
        values.push(`'${parent}'::uuid`)
        continue
      }

      values.push(literalFor(table, column, (seed += 1)))
    }

    return (
      `insert into public."${table}" (${names.join(', ')})` +
      ` values (${values.join(', ')}) returning id`
    )
  }

  /*
   * Trois familles de tables dont un trigger refuse ce que ce peuplement-ci ne
   * sait pas lui donner. Leurs lignes sont posées triggers suspendus. C'est un
   * contournement de harnais, et seulement cela : chaque propriété est éprouvée
   * sur son chemin réel, ailleurs.
   *
   *   journalisée — refuse toute écriture sans commerce ni auteur dans le jeton
   *                 (RÈGLE M8-1), et ce peuplement tourne en `postgres`, sans
   *                 jeton. Éprouvée dans `purchase-price-audit.test.ts`.
   *   dérivée     — refuse toute écriture qui ne vient pas de son trigger
   *                 d'agrégat (RÈGLE M2-1). Éprouvée dans
   *                 `stock-movements.test.ts`.
   *   `restricted`— refuse toute insertion dont la colonne qualifiante n'est
   *                 pas ouverte, et le générateur de lignes prend la première
   *                 étiquette de l'enum, qui ne l'est pas. Éprouvée dans
   *                 `stock-movements.test.ts`.
   *
   * Pour la table dérivée, la suspension a un effet second utile : le trigger
   * d'agrégat ne tourne pas non plus, donc la ligne de la table source ne vient
   * pas modifier la ligne d'agrégat que le balayage vient de poser.
   */
  const audited = await auditedTables(client)
  const derived = await derivedTables(client)
  const appendOnly = await appendOnlyTables(client)

  const needsTriggerBypass = (table: string): boolean =>
    audited.has(table) || derived.has(table) || appendOnly.get(table) === 'restricted'

  /*
   * `stock_level` ne s'insère plus : depuis E3-02 sa ligne naît avec la
   * variante, et l'unicité `(variant_id, warehouse_id)` refuse la seconde. Le
   * balayage prend donc celle qui est là, au lieu d'en poser une — et c'est la
   * bonne ligne, celle que l'application rencontrera.
   *
   * Lue plutôt que devinée, et exigée : une table déclarée peuplée d'office
   * dont aucune ligne n'existe arrête le peuplement. Sans quoi le jour où le
   * trigger cesserait d'ouvrir la ligne, le balayage sauterait silencieusement
   * la table — et `stock_level` sortirait du contrôle d'isolation sans que rien
   * ne le dise.
   */
  const SEEDED_BY_TRIGGER: Readonly<Record<string, { column: string; parent: string }>> = {
    stock_level: { column: 'variant_id', parent: 'variant' },
    // Depuis E3-02 le dépôt naît avec le commerce (SPEC § 2.4, « créée
    // automatiquement ») : en insérer un second heurterait
    // `warehouse_one_default_per_tenant`.
    warehouse: { column: 'tenant_id', parent: tenantTable },
  }

  /*
   * La ligne est désignée par son parent, jamais par « la première du
   * commerce » : le peuplement crée deux variantes par commerce — la sienne, et
   * celle que le trigger d'E2-01 pose sous le produit — donc deux lignes de
   * stock. Adopter la plus ancienne reviendrait à laisser la seconde derrière,
   * et la suppression de la variante du balayage buterait sur sa clé étrangère.
   * Mesuré : c'est exactement ce qui s'est produit.
   */
  const adopt = async (
    table: string,
    tenant: string,
    rows: TenantRows,
    link: { column: string; parent: string },
  ): Promise<string> => {
    const parent = rows.get(link.parent)
    if (parent === undefined) {
      throw new Error(
        `${table} est déclarée peuplée d'office à partir de ${link.parent}, dont aucune ligne ` +
          "n'a été créée. Vérifier l'ordre topologique (isolation.ts).",
      )
    }

    const { rows: found } = await client.query<{ id: string }>(
      `select id from public."${table}" where tenant_id = $1 and "${link.column}" = $2`,
      [tenant, parent],
    )
    const id = found[0]?.id
    if (id === undefined) {
      throw new Error(
        `${table} est déclarée peuplée d'office par un trigger, mais ${link.parent} ${parent} ` +
          "n'en a aucune ligne : le trigger ne l'ouvre plus (isolation.ts).",
      )
    }
    return id
  }

  const insert = async (table: string, tenant: string | null, rows: TenantRows): Promise<string> => {
    const link = SEEDED_BY_TRIGGER[table]
    if (tenant !== null && link !== undefined) return adopt(table, tenant, rows, link)

    const run = () => client.query<{ id: string }>(insertSql(table, tenant, rows))
    const { rows: inserted } = needsTriggerBypass(table)
      ? await withoutTriggers(client, run)
      : await run()
    const id = inserted[0]?.id
    if (id === undefined) throw new Error(`${table} : insertion sans identifiant rendu`)
    return id
  }

  const seedOne = async (): Promise<{ tenant: string; rows: TenantRows }> => {
    const rows: TenantRows = new Map()

    // Le commerce d'abord : son identifiant est le tenant de tout le reste.
    const tenant = await insert(tenantTable, null, rows)
    rows.set(tenantTable, tenant)

    for (const table of order) {
      if (table === tenantTable) continue
      rows.set(table, await insert(table, tenant, rows))
    }

    return { tenant, rows }
  }

  const a = await seedOne()
  const b = await seedOne()

  return {
    tenantTable,
    tenants: { a: a.tenant, b: b.tenant },
    rows: { a: a.rows, b: b.rows },
    order,
    insertSql,
  }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Se fait passer pour un utilisateur, le temps de la transaction : claims du
 * JWT posés comme Supabase les pose, puis bascule sur le rôle `authenticated`.
 * Aucun raccourci — c'est exactement l'état dans lequel une requête PostgREST
 * arrive.
 */
export async function actAs(
  client: Client,
  claims: Record<string, unknown> | null,
  postgresRole: 'authenticated' | 'anon' = 'authenticated',
): Promise<void> {
  await client.query('reset role')
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    claims === null ? '' : JSON.stringify(claims),
  ])
  await client.query(`set local role ${postgresRole}`)

  if (postgresRole !== 'authenticated') return

  /*
   * On vérifie que la base voit bien le tenant qu'on croit lui avoir donné.
   *
   * Sans ce contrôle, une erreur d'usurpation — un claim mal placé, un jeton
   * construit à côté de `tokenFor()` — produirait une session sans tenant, et
   * *toutes* les assertions négatives passeraient : rien n'est lisible, rien
   * n'est modifiable, donc rien ne fuit. Le test serait au vert en n'ayant
   * mesuré que sa propre erreur. C'est le même piège que celui qu'il traque
   * dans les policies, un étage plus haut.
   */
  const expected = extractTenant(claims)
  const { rows } = await client.query<{ tenant: string | null }>(
    'select merx.current_tenant_id() as tenant',
  )

  if ((rows[0]?.tenant ?? null) !== expected) {
    throw new Error(
      "L'usurpation n'a pas pris : la base voit le tenant " +
        `${rows[0]?.tenant ?? 'NULL'}, attendu ${expected ?? 'NULL'}.`,
    )
  }
}

/** Le `tenant_id` que le jeton porte réellement — NULL s'il n'en porte pas. */
function extractTenant(claims: Record<string, unknown> | null): string | null {
  const metadata = claims?.['app_metadata']
  if (typeof metadata !== 'object' || metadata === null) return null

  const tenant = (metadata as Record<string, unknown>)['tenant_id']
  return typeof tenant === 'string' && tenant !== '' ? tenant : null
}

/** Le jeton que `merx.custom_access_token()` produit pour un utilisateur. */
export function tokenFor(tenant: string, role: string): Record<string, unknown> {
  return { role: 'authenticated', app_metadata: { tenant_id: tenant, role } }
}

/*
 * Les formes qu'un jeton peut prendre quand le tenant n'y est pas — compte sans
 * fiche `app_user`, fiche désactivée, jeton émis avant la pose du hook, ou
 * simplement forgé par quelqu'un qui essaie.
 *
 * Aucune ne doit ouvrir quoi que ce soit. C'est le mode de défaillance qui
 * compte : une policy présente mais permissive parce que l'expression compare
 * quelque chose à NULL avec la mauvaise opération se lit exactement comme une
 * policy correcte, et laisse tout sortir.
 */
export const EMPTY_CLAIMS: ReadonlyArray<{ label: string; claims: Record<string, unknown> | null }> =
  [
    { label: 'aucun claim', claims: null },
    { label: 'sans app_metadata', claims: { role: 'authenticated' } },
    { label: 'app_metadata vide', claims: { role: 'authenticated', app_metadata: {} } },
    {
      label: 'tenant_id null',
      claims: { role: 'authenticated', app_metadata: { tenant_id: null, role: 'owner' } },
    },
    {
      label: 'tenant_id vide',
      claims: { role: 'authenticated', app_metadata: { tenant_id: '', role: 'owner' } },
    },
    {
      label: 'rôle métier seul, sans tenant',
      claims: { role: 'authenticated', app_metadata: { role: 'owner' } },
    },
    {
      // Le `role` de premier niveau est le rôle Postgres. Le confondre avec le
      // rôle métier donnerait le super-admin à toute session authentifiée.
      label: 'super_admin au premier niveau du jeton',
      claims: { role: 'super_admin', app_metadata: {} },
    },
  ]

/**
 * Exécute une requête en isolant son échec : une erreur SQL avorte la
 * transaction, or le test en enchaîne beaucoup dans une seule.
 */
export async function attempt(
  client: Client,
  sql: string,
): Promise<{ ok: true; rowCount: number } | { ok: false; code: string; message: string }> {
  await client.query('savepoint attempt')
  try {
    const result = await client.query(sql)
    await client.query('release savepoint attempt')
    return { ok: true, rowCount: result.rowCount ?? 0 }
  } catch (error) {
    await client.query('rollback to savepoint attempt')
    const { code, message } = error as { code?: string; message: string }
    return { ok: false, code: code ?? '(sans code)', message }
  }
}

/** Le code SQLSTATE d'un refus par RLS ou par privilège manquant. */
export const INSUFFICIENT_PRIVILEGE = '42501'

/**
 * Le code SQLSTATE du garde des tables dérivées — *object_not_in_prerequisite_
 * state*. Celui d'aucun autre refus du projet, pour qu'un test qui l'assert
 * mesure ce garde-là. RÈGLE M2-1, E3-01.
 */
export const DERIVED_WRITE = '55000'

/**
 * Le code SQLSTATE des gardes des tables figées — *object_in_use*. Celui
 * d'aucun autre refus du projet, pour qu'un test qui l'assert mesure ces
 * gardes-là. RÈGLE M3-3, E4-01.
 */
export const FROZEN_WRITE = '55006'

/**
 * Exécute `body` triggers suspendus (`session_replication_role = replica`),
 * puis les rétablit. À appeler en `postgres` : le réglage est réservé.
 *
 * **Réservé au harnais de test** : peupler ou ranger, hors session, une table
 * que ses triggers défendent — l'ajout seul (E1-04), le journal du prix
 * d'achat (RÈGLE M8-1). Le garde est levé sans être nommé, pour que la routine
 * ne dépende pas de la façon dont il est posé. Une migration ou une fonction
 * applicative qui en aurait besoin signalerait une règle mal posée, pas une
 * règle à écarter : s'arrêter et le dire.
 *
 * Les clés étrangères, elles aussi portées par des triggers, sont suspendues
 * le temps du corps : ne s'en servir que pour des lignes dont on sait déjà
 * qu'elles tiennent. Les policies, elles, restent en vigueur — ce ne sont pas
 * des triggers.
 */
export async function withoutTriggers<T>(client: Client, body: () => Promise<T>): Promise<T> {
  await client.query('set session_replication_role = replica')
  try {
    return await body()
  } finally {
    await client.query('set session_replication_role = origin')
  }
}
