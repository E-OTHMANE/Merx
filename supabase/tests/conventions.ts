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

  union all

  select r.table_name,
         format('garde %s désactivé (tgenabled = %L) — il existe toujours au catalogue '
                'et ne refuse plus rien', tg.tgname, tg.tgenabled) as detail
  from registered r
  join pg_trigger tg on tg.tgrelid = r.oid and not tg.tgisinternal
  where tg.tgfoid in ('merx.reject_row_mutation()'::regprocedure,
                      'merx.reject_truncate()'::regprocedure)
    and tg.tgenabled not in ('O', 'A')

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

/*
 * SPEC § 4, RÈGLE des clés étrangères composites (E2-01) — toute clé étrangère
 * entre tables de `public` porte `tenant_id`, à la même position des deux
 * côtés : `(tenant_id, x) references t (tenant_id, id)`.
 *
 * Une clé étrangère ne passe pas par la RLS. Sans `tenant_id` dans la clé, un
 * commerce rattache ses lignes à celles du voisin — et une cascade chez le
 * voisin détruit ses données, ou une clé sans cascade l'empêche de supprimer
 * les siennes. Le balayage lit toutes les tables, enregistrées ou non : la clé
 * fautive est justement celle qu'on a écrite à la main.
 *
 * Seule exception, par nature : l'ancre `tenant_id → tenant (id)`.
 */
const TENANT_SCOPED_FOREIGN_KEYS = `
  select c.relname as table_name,
         format('clé étrangère %s vers %s sans tenant_id des deux côtés — '
                'SPEC § 4 : (tenant_id, x) references t (tenant_id, id)',
                k.conname, k.confrelid::regclass) as detail
  from pg_constraint k
  join pg_class c on c.oid = k.conrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_class cf on cf.oid = k.confrelid
  join pg_namespace nf on nf.oid = cf.relnamespace and nf.nspname = 'public'
  left join pg_attribute src
    on src.attrelid = k.conrelid and src.attname = 'tenant_id' and not src.attisdropped
  left join pg_attribute dst
    on dst.attrelid = k.confrelid and dst.attname = 'tenant_id' and not dst.attisdropped
  where k.contype = 'f'
    -- L'ancre : la colonne tenant_id seule, vers le commerce.
    and not (k.conkey = array[src.attnum] and cf.relname = 'tenant')
    and not (
      array_length(k.conkey, 1) >= 2
      and exists (
        select 1
        from generate_subscripts(k.conkey, 1) as i
        where k.conkey[i] = src.attnum and k.confkey[i] = dst.attnum
      )
    )
  order by 1, 2
`

/*
 * SPEC § 2.3, RÈGLE — le stock, les prix et les lignes de vente pointent sur
 * `variant_id`, jamais sur `product_id`. E2-01 : « aucune table ne référence
 * `product_id` pour du stock ou du prix ».
 *
 * La règle vise ce qui n'existe pas encore : `stock_level` (E3), `sale_line`
 * (E4), `goods_receipt_line` (E8). Le jour où l'une d'elles pointe sur un
 * produit, le pack de déclinaisons devient une migration de tout le stock —
 * et rien de visible ne le signale. Ici, le test échoue en nommant la table.
 *
 * Deux formes sont attrapées : la clé étrangère vers `product`, et la colonne
 * `product_id` sans clé — la seconde est la plus sournoise, elle échappe à
 * tout contrôle de contrainte.
 *
 * `variant` est la seule exception, et elle est écrite ici plutôt que déduite :
 * une autre table qui aurait une raison de viser le produit (un pack, SPEC
 * § 2.2) s'ajoute à cette liste par une décision, jamais par un motif.
 */
const PRODUCT_REFERENCES = `
  with allowed(table_name) as (values ('variant'))
  select c.relname as table_name,
         format('%s — SPEC § 2.3 : stock, prix et ventes pointent sur variant_id, '
                'jamais sur product_id', what) as detail
  from (
    select k.conrelid as relid,
           format('clé étrangère %s vers product', k.conname) as what
    from pg_constraint k
    where k.contype = 'f' and k.confrelid = 'public.product'::regclass
    union
    select a.attrelid,
           'colonne product_id'
    from pg_attribute a
    where a.attname = 'product_id' and a.attnum > 0 and not a.attisdropped
  ) ref
  join pg_class c on c.oid = ref.relid and c.relkind = 'r'
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relname not in (select table_name from allowed)
  order by 1, 2
`

/*
 * E2-02 — `tenant_id` a pour défaut le commerce du jeton, sur toute table
 * conventionnée. L'application n'écrit aucun `tenant_id` ; une table qui
 * perdrait ce défaut ferait échouer en `23502` chaque écran qui y insère, et le
 * symptôme se lirait comme un champ manquant.
 *
 * `left join` sur la colonne : une table sans `tenant_id` est aussi signalée
 * ici, et pas seulement par la règle des colonnes standard.
 */
const TENANT_DEFAULT = `
  select c.relname as table_name,
         format('tenant_id : défaut %s, attendu merx.current_tenant_id() — E2-02',
                coalesce(pg_get_expr(d.adbin, d.adrelid), '(aucun)')) as detail
  from merx.convention_registry r
  join pg_class c on c.relname = r.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_attribute a
    on a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where coalesce(pg_get_expr(d.adbin, d.adrelid), '') <> 'merx.current_tenant_id()'
  order by 1
`

/*
 * SPEC § 2.6, RÈGLE — principe directeur : le seul champ obligatoire d'un
 * formulaire de création est le nom. E2-02, E11-03.
 *
 * Ce contrôle ne vérifie pas un écran. Il vérifie qu'aucune colonne ne peut
 * devenir obligatoire sans qu'on le voie : l'écran le plus accommodant du monde
 * échoue quand même si la base réclame ce qu'il n'envoie pas. Il vaut pour
 * toute table inscrite par `merx.register_creation_form()` — `product`
 * aujourd'hui, `client` (E6) et `supplier` (E8) demain — sans en nommer aucune.
 *
 * Trois façons de rendre une colonne obligatoire, trois volets :
 *   — NOT NULL sans défaut. Un défaut littéralement NULL n'en est pas un ;
 *   — une contrainte `check` qui exige `IS NOT NULL` : elle refuse l'absence
 *     aussi sûrement que NOT NULL, et elle ne se voit pas dans `attnotnull` ;
 *   — la colonne de nom elle-même absente, ou nullable : le registre
 *     parlerait alors d'une règle que la table n'applique plus.
 */
const CREATION_FORM_REQUIRED = `
  with form as (
    select f.table_name, f.name_column, c.oid
    from merx.creation_form_registry f
    left join pg_namespace n on n.nspname = 'public'
    left join pg_class c on c.relname = f.table_name and c.relnamespace = n.oid and c.relkind = 'r'
  )
  select f.table_name,
         format('%s : obligatoire sans défaut — SPEC § 2.6, seul le nom (%s) peut l''être',
                a.attname, f.name_column) as detail
  from form f
  join pg_attribute a on a.attrelid = f.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = f.oid and d.adnum = a.attnum
  where a.attnotnull
    and a.attgenerated = ''
    and a.attname <> f.name_column
    and coalesce(pg_get_expr(d.adbin, d.adrelid), 'NULL') ~* '^\\(?null\\)?(::.*)?$'
  union all
  select f.table_name,
         format('contrainte %s : %s — SPEC § 2.6, seul le nom (%s) peut être exigé',
                k.conname, pg_get_constraintdef(k.oid), f.name_column)
  from form f
  join pg_constraint k on k.conrelid = f.oid and k.contype = 'c'
  where pg_get_constraintdef(k.oid) ~* 'is not null'
  union all
  select f.table_name,
         format('colonne de nom %s absente ou nullable', f.name_column)
  from form f
  where not exists (
    select 1 from pg_attribute a
    where a.attrelid = f.oid and a.attname = f.name_column
      and a.attnum > 0 and not a.attisdropped and a.attnotnull
  )
  order by 1, 2
`

/*
 * SPEC § 2.1, exception nommée (E2-04) — une fonction `security definer`
 * s'exécute sous `postgres`, qui porte BYPASSRLS : tout ce qu'elle lit ou
 * écrit dans une table métier n'est borné au commerce que par son propre
 * corps. C'est le filtre à la main que la RÈGLE refuse ; il n'est admis
 * qu'inscrit à `merx.rls_exception_registry`, avec le garde qui le tient.
 *
 * Trois volets, un par façon de manquer :
 *   — non inscrite : la fonction est nommée, avec les tables qu'elle touche ;
 *   — inscrite en `current_tenant`, sans `merx.current_tenant_id()` dans le
 *     corps ;
 *   — inscrite en `super_admin`, sans `merx.is_super_admin()` dans le corps.
 *     La valeur du registre ne suffit pas : `super_admin` ne doit pas devenir
 *     la case qu'on coche quand le filtre par commerce est gênant à écrire.
 *
 * « Touche une table métier » : le corps nomme `public.<table du registre de
 * conventions>` après `from`, `join`, `update` ou `into`. Grossier comme le
 * contrôle d'`audit_log` plus haut, et pour la même raison : il attrape la
 * faute au moment où elle s'écrit, dans E4 ou E2-05. Les fonctions de `public`
 * sont toutes en `search_path = ''`, donc toute table y est qualifiée.
 */
const RLS_EXCEPTIONS = `
  with definer as (
    select p.proname,
           p.prosrc,
           (select string_agg(r.table_name, ', ' order by r.table_name)
              from merx.convention_registry r
             where p.prosrc ~* ('(from|join|update|into)\\s+public\\."?' || r.table_name || '"?\\M'))
             as tables
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  )
  select 'public.' || d.proname as table_name,
         format('security definer, touche %s hors RLS, absente de merx.rls_exception_registry '
                '— SPEC § 2.1', d.tables) as detail
  from definer d
  where d.tables is not null
    and not exists (select 1 from merx.rls_exception_registry e where e.function_name = d.proname)

  union all

  select 'public.' || d.proname as table_name,
         'inscrite en current_tenant, mais son corps n''appelle pas merx.current_tenant_id() '
         '— SPEC § 2.1' as detail
  from definer d
  join merx.rls_exception_registry e on e.function_name = d.proname
  where e.guard = 'current_tenant' and d.prosrc !~ 'merx\\.current_tenant_id\\(\\)'

  union all

  select 'public.' || d.proname as table_name,
         'inscrite en super_admin, mais son corps n''appelle pas merx.is_super_admin() '
         '— SPEC § 2.1' as detail
  from definer d
  join merx.rls_exception_registry e on e.function_name = d.proname
  where e.guard = 'super_admin' and d.prosrc !~ 'merx\\.is_super_admin\\(\\)'

  order by 1, 2
`

/*
 * L'inverse, et la justification. Une entrée dont la fonction a disparu, ou
 * n'est plus `security definer`, parle d'une exception qui n'existe plus — et
 * masquerait la prochaine fonction du même nom. Une justification vide est
 * refusée par la contrainte `rls_exception_justified` ; ce volet tient le jour
 * où la contrainte tomberait.
 */
const RLS_EXCEPTION_REGISTRY = `
  select 'public.' || e.function_name as table_name,
         'inscrite au registre des exceptions RLS, mais absente de public ou plus '
         'security definer' as detail
  from merx.rls_exception_registry e
  where not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = e.function_name and p.prosecdef
  )

  union all

  select 'public.' || e.function_name as table_name,
         'justification vide au registre des exceptions RLS — SPEC § 2.1' as detail
  from merx.rls_exception_registry e
  where btrim(coalesce(e.justification, '')) = ''

  order by 1, 2
`

/*
 * RÈGLE M8-1, addendum E2-03 — une table inscrite à `merx.audited_registry`
 * porte son trigger `merx.audit_row_change()`, AFTER, pour chaque ligne, sur
 * INSERT, UPDATE et DELETE. Et l'inverse : un trigger posé à la main, hors de
 * `merx.apply_audit()`, échapperait au registre que le harnais de test lit —
 * même raison que pour l'ajout seul.
 */
const AUDITED_TRIGGERS = `
  with registered as (
    select r.table_name, c.oid
    from merx.audited_registry r
    left join pg_class c
      on c.relname = r.table_name and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  ),
  guarded as (
    select tg.tgrelid
    from pg_trigger tg
    where not tg.tgisinternal
      and tg.tgfoid = 'merx.audit_row_change()'::regprocedure
      and (tg.tgtype & 1) <> 0
      and (tg.tgtype & 2) = 0
      and (tg.tgtype & 64) = 0
      and (tg.tgtype & 4) <> 0
      and (tg.tgtype & 8) <> 0
      and (tg.tgtype & 16) <> 0
  )
  select r.table_name,
         'inscrite au registre d''audit sans trigger merx.audit_row_change() AFTER INSERT, '
         'UPDATE, DELETE — ses écritures échappent au journal, RÈGLE M8-1' as detail
  from registered r
  where r.oid is null or r.oid not in (select tgrelid from guarded)

  union all

  select c.relname as table_name,
         'trigger merx.audit_row_change() sans inscription au registre — passer par '
         'merx.apply_audit()' as detail
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  where not tg.tgisinternal
    and tg.tgfoid = 'merx.audit_row_change()'::regprocedure
    and not exists (select 1 from merx.audited_registry r where r.table_name = c.relname)

  order by 1, 2
`

/*
 * RÈGLE M8-1 — « changement de prix d'achat ». Toute relation restreinte par
 * `view_cost` porte un prix d'achat (SPEC § 3, RÈGLE de placement des coûts) ;
 * chacune doit donc être journalisée sous `purchase_price_change`.
 * `variant_cost` l'est depuis l'addendum E2-03 ; `goods_receipt_line_cost`
 * (E8-03) sera nommée ici le jour où elle naîtra sans l'être.
 */
const AUDITED_COSTS = `
  select c.table_name,
         'relation restreinte par view_cost dont le prix d''achat n''est pas journalisé — '
         'merx.apply_audit(..., ''purchase_price_change'', ...), RÈGLE M8-1' as detail
  from merx.confidential_registry c
  where c.capability = 'view_cost'
    and not exists (
      select 1 from merx.audited_registry a
      where a.table_name = c.table_name and a.action = 'purchase_price_change'
    )
  order by 1
`

/*
 * SPEC RÈGLE M2-1, E3-01 — une table dérivée est un agrégat : elle n'a aucun
 * écrivain applicatif, et ses deux gardes le tiennent. Même forme que les
 * gardes de l'ajout seul, et pour la même raison — le registre est ce que lit
 * `isolation.test.ts` pour savoir qu'il doit inverser son contrôle positif.
 *
 * Quatre volets, un par façon de manquer :
 *   — la table du registre n'existe pas dans `public` ;
 *   — l'un des trois triggers manque. Le garde d'INSERT est **AFTER** et ceux
 *     d'UPDATE et DELETE **BEFORE** : en BEFORE INSERT, le garde refuserait
 *     avant la RLS et tiendrait lieu d'isolation, ce que le balayage ne
 *     saurait pas distinguer (CLAUDE.md). Le contrôle vérifie donc le moment,
 *     pas seulement la présence ;
 *   — `authenticated` détient TRUNCATE. INSERT, UPDATE et DELETE, eux, doivent
 *     rester accordés : le trigger d'agrégat tourne sous l'appelant ;
 *   — l'écrivain déclaré ou la table source n'existent pas, donc le registre
 *     nomme ce que la règle suivante chercherait en vain.
 */
const DERIVED_GUARDS = `
  with registered as (
    select r.table_name, r.source_table, r.writer_function, c.oid
    from merx.derived_registry r
    left join pg_class c
      on c.relname = r.table_name
     and c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
  ),
  guard as (
    select t.table_name,
           bool_or(tg.tgfoid = 'merx.reject_derived_write()'::regprocedure
                   and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) = 0
                   and (tg.tgtype & 4) <> 0)  as blocks_insert,
           bool_or(tg.tgfoid = 'merx.reject_derived_write()'::regprocedure
                   and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) <> 0
                   and (tg.tgtype & 16) <> 0) as blocks_update,
           bool_or(tg.tgfoid = 'merx.reject_derived_write()'::regprocedure
                   and (tg.tgtype & 1) <> 0 and (tg.tgtype & 2) <> 0
                   and (tg.tgtype & 8) <> 0)  as blocks_delete,
           bool_or(tg.tgfoid = 'merx.reject_derived_truncate()'::regprocedure
                   and (tg.tgtype & 1) = 0 and (tg.tgtype & 2) <> 0
                   and (tg.tgtype & 32) <> 0) as blocks_truncate
    from registered t
    left join pg_trigger tg on tg.tgrelid = t.oid and not tg.tgisinternal
    group by 1
  )
  select r.table_name, 'inscrite au registre des tables dérivées, absente de public' as detail
  from registered r where r.oid is null

  union all

  select g.table_name,
         'aucun trigger AFTER INSERT merx.reject_derived_write — une ligne s''écrit à la '
         'main. AFTER et non BEFORE : en BEFORE, le garde refuserait avant la RLS et '
         'tiendrait lieu d''isolation' as detail
  from guard g where not coalesce(g.blocks_insert, false)

  union all

  select g.table_name,
         'aucun trigger BEFORE UPDATE merx.reject_derived_write — un agrégat se rature' as detail
  from guard g where not coalesce(g.blocks_update, false)

  union all

  select g.table_name,
         'aucun trigger BEFORE DELETE merx.reject_derived_write — un agrégat se supprime' as detail
  from guard g where not coalesce(g.blocks_delete, false)

  union all

  select g.table_name,
         'aucun trigger BEFORE TRUNCATE merx.reject_derived_truncate — la table se vide '
         'd''un coup, et le garde de ligne ne le voit pas' as detail
  from guard g where not coalesce(g.blocks_truncate, false)

  union all

  select r.table_name,
         'authenticated détient TRUNCATE sur une table dérivée' as detail
  from registered r
  join information_schema.role_table_grants g
    on g.table_schema = 'public' and g.table_name = r.table_name
   and g.grantee = 'authenticated' and g.privilege_type = 'TRUNCATE'

  union all

  select r.table_name,
         format('écrivain déclaré merx.%s() introuvable — la règle qui refuse les autres '
                'écrivains refuserait tout le monde', r.writer_function) as detail
  from registered r
  where not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'merx'
    where p.proname = r.writer_function
  )

  union all

  select r.table_name,
         format('table source déclarée %s absente du registre de conventions', r.source_table)
           as detail
  from registered r
  where not exists (
    select 1 from merx.convention_registry c where c.table_name = r.source_table
  )

  union all

  /*
   * Un trigger désactivé existe toujours dans pg_trigger : tgfoid et tgtype
   * sont intacts, et les quatre contrôles ci-dessus passaient. Seul tgenabled
   * change — d'où cette branche. E3-02 lève le garde d'insertion le temps d'un
   * rattrapage, dans une migration : le seul endroit du projet, hors harnais,
   * où un garde est baissé, et un enable oublié ne doit pas se lire comme une
   * suite verte. Le message est distinct de « aucun trigger » — absent et
   * désactivé ne se réparent pas de la même façon.
   *
   * Sans accent grave dans ce commentaire : il vit dans un littéral de
   * gabarit, où un accent grave fermerait la chaîne.
   */
  select r.table_name,
         format('garde %s désactivé (tgenabled = %L) — il existe toujours au catalogue '
                'et ne refuse plus rien', tg.tgname, tg.tgenabled) as detail
  from registered r
  join pg_trigger tg on tg.tgrelid = r.oid and not tg.tgisinternal
  where tg.tgfoid in ('merx.reject_derived_write()'::regprocedure,
                      'merx.reject_derived_truncate()'::regprocedure)
    and tg.tgenabled not in ('O', 'A')

  order by 1, 2
`

/*
 * L'inverse : une table gardée sans être inscrite. Même raisonnement qu'en
 * E1-04 pour l'ajout seul — le registre n'est pas une étiquette, c'est ce que
 * lit le harnais de test pour savoir ce qu'il doit attendre de cette table.
 */
const UNREGISTERED_DERIVED = `
  select c.relname as table_name,
         'gardée comme table dérivée sans inscription au registre — passer par '
         'merx.apply_derived_from()' as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_trigger tg on tg.tgrelid = c.oid and not tg.tgisinternal
  where c.relkind = 'r'
    and tg.tgfoid in ('merx.reject_derived_write()'::regprocedure,
                      'merx.reject_derived_truncate()'::regprocedure)
    and not exists (
      select 1 from merx.derived_registry r where r.table_name = c.relname
    )
  group by 1
  order by 1
`

/*
 * SPEC RÈGLE M2-1, E3-01 — « stock_level est un agrégat maintenu par trigger ».
 *
 * Le garde de ligne repose sur `pg_trigger_depth()`, qui dit « écrit par un
 * trigger » et non « écrit par le trigger d'agrégat ». Le jour où une autre
 * fonction écrira dans une table dérivée depuis un trigger — sur `sale_line`
 * en E4, sur `goods_receipt_line` en E8 — le garde la laissera passer, et deux
 * endroits décideraient de la valeur d'un agrégat.
 *
 * Le registre nomme donc l'écrivain, et ce balayage refuse tous les autres. Il
 * lit le corps des fonctions de `public` et de `merx` : grossier, et c'est le
 * bon niveau de grossièreté — il attrape la faute au moment où elle s'écrit,
 * dans une story qui n'est pas celle-ci. Même procédé que le contrôle
 * d'`audit_log` plus haut (E1-04).
 */
const DERIVED_DIRECT_WRITE = `
  with writers as (
    select format('%s.%s', n.nspname, p.proname) as qualified, p.proname, p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'merx')
  )
  select w.qualified as table_name,
         format('écrit dans %s, dont le seul écrivain déclaré est merx.%s() — RÈGLE M2-1',
                r.table_name, r.writer_function) as detail
  from writers w
  join merx.derived_registry r
    on w.prosrc ~* ('(insert\\s+into|update|delete\\s+from)\\s+public\\."?'
                    || r.table_name || '"?\\M')
  where w.proname <> r.writer_function
  order by 1, 2
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
  'gardes des tables dérivées': DERIVED_GUARDS,
  'aucune table dérivée hors registre': UNREGISTERED_DERIVED,
  'aucun autre écrivain d\'une table dérivée': DERIVED_DIRECT_WRITE,
  'aucune écriture directe dans audit_log': AUDIT_DIRECT_WRITE,
  'clés étrangères composites sur tenant_id': TENANT_SCOPED_FOREIGN_KEYS,
  'aucune référence à product hors de variant': PRODUCT_REFERENCES,
  'tenant_id par défaut du jeton': TENANT_DEFAULT,
  'seul le nom est obligatoire à la création': CREATION_FORM_REQUIRED,
  'security definer inscrite et gardée': RLS_EXCEPTIONS,
  'registre des exceptions RLS tenu': RLS_EXCEPTION_REGISTRY,
  'tables auditées gardées': AUDITED_TRIGGERS,
  'prix d\'achat journalisés': AUDITED_COSTS,
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
