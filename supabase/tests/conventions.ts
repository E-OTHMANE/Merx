/*
 * Contrôles de convention de schéma — docs/SPEC.md § 4, docs/BACKLOG.md E0-02.
 *
 * Chaque règle est une requête qui renvoie les *infractions*. Une règle est
 * respectée quand elle ne renvoie rien. Les requêtes lisent le catalogue
 * Postgres réel, pas une description du schéma écrite à côté.
 */

import type { Client } from 'pg'

/** Une infraction : la table fautive, et de quoi la corriger. */
export interface Violation {
  table_name: string
  detail: string
}

/*
 * Toute table de `public` doit être déclarée par un appel à
 * `merx.apply_*_conventions()`. Une table absente du registre est une table
 * créée en oubliant les conventions.
 */
const UNREGISTERED = `
  select c.relname as table_name, 'absente du registre de conventions' as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not exists (
      select 1 from merx.convention_registry r where r.table_name = c.relname
    )
  order by 1
`

/* L'inverse : une entrée de registre qui ne correspond plus à aucune table. */
const STALE_REGISTRY = `
  select r.table_name, 'enregistrée mais inexistante dans public' as detail
  from merx.convention_registry r
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = r.table_name
  )
  order by 1
`

/* SPEC § 4 : clés primaires en uuid, générées par la base. */
const PRIMARY_KEY = `
  with registered as (
    select c.oid, c.relname
    from merx.convention_registry r
    join pg_class c on c.relname = r.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  ),
  pk as (
    select t.relname,
           array_length(k.conkey, 1) as ncols,
           format_type(a.atttypid, a.atttypmod) as coltype,
           coalesce(pg_get_expr(d.adbin, d.adrelid), '') as coldefault
    from registered t
    join pg_constraint k on k.conrelid = t.oid and k.contype = 'p'
    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.conkey[1]
    left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
  )
  select relname as table_name,
         format('clé primaire %s défaut %s', coltype, coalesce(nullif(coldefault, ''), '(aucun)')) as detail
  from pk
  where ncols <> 1
     or coltype <> 'uuid'
     or coldefault not like '%gen_random_uuid()%'
  union all
  select t.relname, 'aucune clé primaire'
  from registered t
  where not exists (
    select 1 from pg_constraint k where k.conrelid = t.oid and k.contype = 'p'
  )
  order by 1
`

/* SPEC § 4 : toute table porte tenant_id, created_at, updated_at, created_by, device_id. */
const STANDARD_COLUMNS = `
  with expected(column_name, coltype, must_be_not_null) as (values
    ('tenant_id',  'uuid',                        true),
    ('created_at', 'timestamp with time zone',    true),
    ('updated_at', 'timestamp with time zone',    true),
    ('created_by', 'uuid',                        false),
    ('device_id',  'uuid',                        false)
  ),
  registered as (
    select c.oid, c.relname
    from merx.convention_registry r
    join pg_class c on c.relname = r.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  )
  select t.relname as table_name,
         format('%s : %s', e.column_name,
                case
                  when a.attname is null then 'absente'
                  when format_type(a.atttypid, a.atttypmod) <> e.coltype
                    then format('typée %s', format_type(a.atttypid, a.atttypmod))
                  else 'nullable, attendue NOT NULL'
                end) as detail
  from registered t
  cross join expected e
  left join pg_attribute a
    on a.attrelid = t.oid and a.attname = e.column_name
   and a.attnum > 0 and not a.attisdropped
  where a.attname is null
     or format_type(a.atttypid, a.atttypmod) <> e.coltype
     or (e.must_be_not_null and not a.attnotnull)
  order by 1, 2
`

/* SPEC § 4 : `updated_at` maintenu par trigger, pas par l'applicatif. */
const UPDATED_AT_TRIGGER = `
  select c.relname as table_name, 'aucun trigger BEFORE UPDATE merx.set_updated_at' as detail
  from merx.convention_registry r
  join pg_class c on c.relname = r.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where not exists (
    select 1
    from pg_trigger tg
    where tg.tgrelid = c.oid
      and not tg.tgisinternal
      and tg.tgfoid = 'merx.set_updated_at()'::regprocedure
      and (tg.tgtype & 2) <> 0    -- BEFORE
      and (tg.tgtype & 16) <> 0   -- UPDATE
  )
  order by 1
`

/* SPEC § 4 : suppression douce sur les tables de référence. */
const REFERENCE_DELETED_AT = `
  select c.relname as table_name, 'table de référence sans deleted_at timestamptz' as detail
  from merx.convention_registry r
  join pg_class c on c.relname = r.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where r.kind = 'reference'
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'deleted_at'
        and a.attnum > 0 and not a.attisdropped
        and format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
    )
  order by 1
`

/*
 * SPEC § 4 : jamais de flottant, nulle part. Le contrôle porte sur *toutes*
 * les tables de `public`, enregistrées ou non — c'est la règle la plus dure
 * du projet, elle ne dépend pas du registre.
 */
const FLOATING_POINT = `
  select c.relname as table_name,
         format('%s est de type %s', a.attname, format_type(a.atttypid, a.atttypmod)) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'r'
    and a.atttypid in ('float4'::regtype, 'float8'::regtype, 'money'::regtype)
  order by 1, 2
`

/*
 * Un `numeric` nu n'est ni un montant ni une quantité déclarés : il faut
 * passer par `money_amount` ou `quantity`, pour que la précision ne dépende
 * pas d'une recopie à la main.
 */
const BARE_NUMERIC = `
  select c.relname as table_name,
         format('%s est un numeric nu — utiliser money_amount ou quantity', a.attname) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'r'
    and a.atttypid = 'numeric'::regtype
  order by 1, 2
`

/* SPEC § 4 : dates en timestamptz, UTC en base. */
const NAIVE_TIMESTAMP = `
  select c.relname as table_name,
         format('%s est de type %s', a.attname, format_type(a.atttypid, a.atttypmod)) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'r'
    and a.atttypid in ('timestamp'::regtype, 'time'::regtype)
  order by 1, 2
`

/*
 * SPEC § 3, RÈGLE de placement des coûts — une colonne de coût ou de marge vit
 * sur une relation restreinte par `view_cost`, jamais sur une table ordinaire.
 *
 * C'est la règle qui fait tenir E0-05 dans le temps. Le mécanisme est livré
 * aujourd'hui, mais aucune colonne de coût n'existe encore : elles arrivent
 * avec le catalogue (E2) et la réception (E8). Sans ce balayage, la règle
 * s'oublierait entre les deux, et personne ne le verrait — un `cost_price`
 * posé sur `variant` ne casse rien de visible, il sort simplement dans la
 * réponse d'un employé. Ici, il fait échouer le test en se nommant.
 *
 * `unit_cost` y figure au même titre que `cost_price`, par arbitrage rendu
 * pendant E0-05 (SPEC § 3.1, note **) : sans lui, un employé qui lit les lignes
 * de réception recalcule le coût moyen pondéré et la protection de
 * `variant_cost` ne vaut plus rien. Protéger un résultat en laissant fuir ses
 * composants ne protège pas. La colonne n'existe pas encore — elle arrive en
 * E8 — et c'est justement pourquoi elle est listée ici dès maintenant.
 *
 * La liste reste explicite plutôt qu'un motif large sur `%_cost` : une colonne
 * de coût qui devrait rester lisible par tous se traiterait en n'y figurant
 * pas, décision par décision, jamais par un motif qui tranche à la place de
 * celui qui écrit la table.
 */
const CONFIDENTIAL_COLUMNS = `
  with confidential(column_name) as (values
    ('cost_price'), ('avg_cost'), ('last_cost'), ('unit_cost')
  )
  select c.relname as table_name,
         format('%s est une colonne de coût ou de marge sur une relation non '
                'restreinte — SPEC § 3 : elle vit sur une relation dédiée, '
                'passée à merx.apply_capability_restriction(..., ''view_cost'')',
                a.attname) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'r'
    and (a.attname in (select column_name from confidential) or a.attname like 'margin%')
    and not exists (
      select 1 from merx.confidential_registry r
      where r.table_name = c.relname and r.capability = 'view_cost'
    )
  order by 1, 2
`

/*
 * L'inverse : une relation déclarée confidentielle qui ne porte aucune colonne
 * confidentielle. Ce n'est pas une fuite, c'est un signe — soit la colonne a
 * été déplacée et la déclaration est restée, soit elle a été nommée hors de la
 * liste ci-dessus, et alors c'est la liste qu'il faut compléter. Dans les deux
 * cas, la règle précédente ne protège plus ce qu'on croit.
 */
const EMPTY_CONFIDENTIAL = `
  with confidential(column_name) as (values
    ('cost_price'), ('avg_cost'), ('last_cost'), ('unit_cost')
  )
  select r.table_name,
         'déclarée confidentielle mais ne porte aucune colonne de coût ou de marge' as detail
  from merx.confidential_registry r
  join pg_class c on c.relname = r.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where r.capability = 'view_cost'
    and not exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        and (a.attname in (select column_name from confidential) or a.attname like 'margin%')
    )
  order by 1
`

/*
 * CLAUDE.md, SPEC § 2.5 — mouvements et écritures de journal en ajout seul.
 *
 * Une table du registre d'ajout seul porte trois gardes, et le contrôle les
 * regarde un par un. C'est ce qui les rend retirables séparément : le trigger
 * de ligne ne voit pas passer TRUNCATE, et le privilège retiré n'arrête que
 * l'application. Grouper les trois derrière une seule condition ramènerait le
 * défaut de l'index partiel d'E1-03 — un seul test couvrant deux propriétés,
 * donc une propriété qu'on peut perdre sans que rien ne rougisse.
 *
 * `write_path` décide du seul point qui varie : une table écrite par
 * l'application garde son privilège d'INSERT, une table écrite par un helper
 * `security definer` ne l'a pas.
 */
const APPEND_ONLY_GUARDS = `
  with registered as (
    select r.table_name, r.write_path, c.oid
    from merx.append_only_registry r
    join pg_class c on c.relname = r.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  ),
  guard as (
    select t.table_name,
           bool_or(tg.tgfoid = 'merx.reject_row_mutation()'::regprocedure
                   and (tg.tgtype & 2) <> 0 and (tg.tgtype & 1) <> 0
                   and (tg.tgtype & 16) <> 0) as blocks_update,
           bool_or(tg.tgfoid = 'merx.reject_row_mutation()'::regprocedure
                   and (tg.tgtype & 2) <> 0 and (tg.tgtype & 1) <> 0
                   and (tg.tgtype & 8) <> 0)  as blocks_delete,
           bool_or(tg.tgfoid = 'merx.reject_truncate()'::regprocedure
                   and (tg.tgtype & 2) <> 0 and (tg.tgtype & 1) = 0
                   and (tg.tgtype & 32) <> 0) as blocks_truncate
    from registered t
    left join pg_trigger tg on tg.tgrelid = t.oid and not tg.tgisinternal
    group by 1
  )
  select g.table_name,
         'aucun trigger BEFORE UPDATE merx.reject_row_mutation — une ligne se rature' as detail
  from guard g where not coalesce(g.blocks_update, false)

  union all

  select g.table_name,
         'aucun trigger BEFORE DELETE merx.reject_row_mutation — une ligne se supprime' as detail
  from guard g where not coalesce(g.blocks_delete, false)

  union all

  select g.table_name,
         'aucun trigger BEFORE TRUNCATE merx.reject_truncate — la table se vide d''un coup, '
         'et le garde de ligne ne le voit pas' as detail
  from guard g where not coalesce(g.blocks_truncate, false)

  union all

  select r.table_name,
         format('authenticated détient %s sur une table en ajout seul', g.privilege_type) as detail
  from registered r
  join information_schema.role_table_grants g
    on g.table_schema = 'public' and g.table_name = r.table_name and g.grantee = 'authenticated'
  where g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
     or (r.write_path = 'helper' and g.privilege_type = 'INSERT')

  order by 1, 2
`

/*
 * L'inverse : une table gardée sans être inscrite. Le registre n'est pas une
 * étiquette, c'est ce que lit `isolation.test.ts` pour savoir qu'il doit
 * *inverser* son contrôle positif sur cette table-là. Une table rendue en ajout
 * seul à la main y échapperait — le balayage continuerait d'exiger qu'un
 * `owner` puisse modifier sa propre ligne, et le désaccord se lirait comme une
 * régression de policy.
 */
const UNREGISTERED_APPEND_ONLY = `
  select c.relname as table_name,
         'gardée en ajout seul sans inscription au registre — passer par '
         'merx.apply_append_only()' as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
  where c.relkind = 'r'
    and tg.tgfoid in ('merx.reject_row_mutation()'::regprocedure,
                      'merx.reject_truncate()'::regprocedure)
    and not exists (
      select 1 from merx.append_only_registry r where r.table_name = c.relname
    )
  group by 1
  order by 1
`

/*
 * SPEC RÈGLE M8-1, E1-04 — « un helper unique, appelé par toutes les actions
 * sensibles ».
 *
 * Le privilège d'INSERT retiré à `authenticated` ferme la porte de
 * l'application ; il ne ferme pas celle d'une fonction `security definer`
 * écrite en E4 ou en E8, qui s'exécute sous le propriétaire et pourrait insérer
 * sa ligne elle-même. Ce serait un second chemin d'écriture, avec son propre
 * `tenant_id` et son propre auteur — c'est-à-dire un journal dont deux endroits
 * décident du contenu.
 *
 * Le balayage lit le corps des fonctions. C'est grossier, et c'est le bon
 * niveau de grossièreté : il attrape la faute au moment où elle s'écrit, dans
 * une story qui n'est pas celle-ci.
 */
const AUDIT_DIRECT_WRITE = `
  select format('%s.%s', n.nspname, p.proname) as table_name,
         'écrit dans audit_log sans passer par merx.log_audit() — SPEC RÈGLE M8-1' as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'merx')
    and p.proname <> 'log_audit'
    and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?"?audit_log"?'
  order by 1
`

export const RULES = {
  'table non enregistrée': UNREGISTERED,
  'registre périmé': STALE_REGISTRY,
  'clé primaire uuid générée': PRIMARY_KEY,
  'colonnes standard': STANDARD_COLUMNS,
  'trigger updated_at': UPDATED_AT_TRIGGER,
  'deleted_at sur les tables de référence': REFERENCE_DELETED_AT,
  'aucun flottant': FLOATING_POINT,
  'aucun numeric nu': BARE_NUMERIC,
  'aucune date sans fuseau': NAIVE_TIMESTAMP,
  'coûts et marges sur relation restreinte': CONFIDENTIAL_COLUMNS,
  'aucune relation confidentielle vide': EMPTY_CONFIDENTIAL,
  'gardes de l\'ajout seul': APPEND_ONLY_GUARDS,
  'aucun ajout seul hors registre': UNREGISTERED_APPEND_ONLY,
  'aucune écriture directe dans audit_log': AUDIT_DIRECT_WRITE,
} as const

export type RuleName = keyof typeof RULES

/** Exécute une règle et renvoie ses infractions. */
export async function violations(client: Client, rule: RuleName): Promise<Violation[]> {
  const result = await client.query<Violation>(RULES[rule])
  return result.rows
}

/** Rend une liste d'infractions lisible dans un message d'échec. */
export function describe(found: readonly Violation[]): string {
  return found.map((v) => `${v.table_name} — ${v.detail}`).join('\n')
}
