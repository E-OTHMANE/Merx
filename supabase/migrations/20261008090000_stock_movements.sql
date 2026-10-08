-- ============================================================================
-- Merx — mouvements de stock et niveaux
--
-- Référence : docs/SPEC.md § 2.4 (dépôt unique), § 3 / § 3.1 (rôles, matrice,
--             RÈGLE un seul helper), § 4 (conventions, domaines nommés,
--             clés étrangères composites), § 7 M2 (RÈGLES M2-1, M2-2, M2-3),
--             § 11 étape 3 ; docs/BACKLOG.md E3-01.
--
-- Trois lignes à tenir, et chaque garde répond quelque chose qu'aucun autre ne
-- répond — sans quoi le test d'un garde passerait sur le refus d'un voisin
-- (CLAUDE.md, deux gardes sur un même chemin ; E1-01, E1-02, E2-01, E2-03).
--
--   RÈGLE M2-2 — `stock_movement` est immuable.
--     `merx.apply_append_only()`, posé en E1-04 et employé ici pour la
--     première fois. Privilège retiré (`42501`), garde de ligne (`2F004`),
--     garde de TRUNCATE (`2F004`, autre phrase).
--
--   RÈGLE M2-1 — `stock_level` n'est jamais écrit directement.
--     Mécanisme neuf : le registre des tables dérivées, ci-dessous. Garde de
--     ligne (`55000`), garde de TRUNCATE (`55000`, autre phrase), et une règle
--     de `conventions.ts` qui refuse qu'une autre fonction que l'écrivain
--     déclaré y écrive.
--
--   SPEC § 3.1 — qui peut écrire un mouvement.
--     Fermé par défaut, ouvert type par type. Aucun type n'est ouvert
--     aujourd'hui : aucun écran n'écrit de mouvement, donc personne n'a besoin
--     d'en écrire un, et laisser la porte ouverte deux stories durant
--     laisserait un employé poster un `adjustment` de −1000 par PostgREST.
--     E3-03 ouvrira `adjustment`, E3-04 `inventory`, E4 `sale` et `return`,
--     E8 `receipt`. Chaque story ouvre son type, et seulement le sien.
--
-- Ce qui n'est **pas** ici : `inventory_session` et `inventory_line` (E3-04,
-- étape 9), l'ajustement manuel (E3-03), la consultation (E3-02). Rien dans
-- `src/` — la story est entièrement schéma et tests.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- La cible manquante des clés composites
--
-- SPEC § 4, RÈGLE des clés étrangères composites : la table visée porte une
-- unicité sur `(tenant_id, id)`. `app_user`, `category`, `product` et `variant`
-- l'ont reçue en E2-01 ; `warehouse` ne l'avait pas, parce qu'aucune table ne
-- la visait encore. `stock_level` et `stock_movement` la visent.
-- ----------------------------------------------------------------------------

alter table public.warehouse
  add constraint warehouse_tenant_id_id_key unique (tenant_id, id);


-- ----------------------------------------------------------------------------
-- Les deux types fermés du § 7
--
-- `movement_type` : la liste du spec, dans son ordre, pour que les deux se
-- relisent en regard.
--
-- `source_type` : les documents d'origine. Aucun n'existe encore —
-- `sale_document` naît en E4-01, `goods_receipt` en E8-02, `inventory_session`
-- en E3-04. Les étiquettes sont posées quand même, geste d'E1-04 pour
-- `audit_action` : une liste fermée arbitrée maintenant est une liste que E4 et
-- E8 emploieront au lieu d'en inventer une, et un enum est lisible par
-- `supabase/tests/isolation.ts`, qui déduit ses valeurs du catalogue Postgres
-- et ne sait pas lire un motif (CLAUDE.md).
-- ----------------------------------------------------------------------------

create type public.stock_movement_type as enum (
  'sale',        -- sortie par une vente              (M3, E4)
  'return',      -- entrée par un retour client       (M3, E4-06)
  'receipt',     -- entrée par une réception          (M5, E8-02)
  'adjustment',  -- correction manuelle               (M2, E3-03)
  'inventory'    -- écart d'inventaire validé         (M2, E3-04)
);

comment on type public.stock_movement_type is
  'Les cinq types de mouvement de SPEC § 7 M2. Chacun n''est écrivable que par '
  'la capacité que merx.movement_type_capability lui associe.';

create type public.stock_source_type as enum (
  'sale_document',     -- public.sale_document      (E4-01)
  'goods_receipt',     -- public.goods_receipt      (E8-02)
  'inventory_session'  -- public.inventory_session  (E3-04)
);

comment on type public.stock_source_type is
  'Le document dont un mouvement découle. Aucune de ces tables n''existe en '
  'E3-01 : les étiquettes sont posées d''avance, comme audit_action en E1-04.';


-- ============================================================================
-- Mécanisme — les tables dérivées
--
-- `stock_level` est un agrégat : sa valeur n'est pas une donnée saisie, c'est
-- la somme des mouvements. Elle n'a donc **aucun** écrivain applicatif, ce que
-- ni le registre d'ajout seul ni celui d'audit ne savent dire :
--
--   ajout seul — une ligne écrite ne se modifie plus. Faux ici : le trigger
--                d'agrégat met la ligne à jour à chaque mouvement.
--   audité     — chaque écriture laisse une trace. Vrai, mais sans rapport
--                avec la question de savoir *qui* écrit.
--
-- D'où un troisième registre, de même forme que les deux autres, et pour la
-- même raison : c'est lui que lit le harnais de test pour savoir qu'il doit
-- **inverser** son contrôle positif sur cette table-là. Sans inscription,
-- `isolation.test.ts` continuerait d'exiger qu'un `owner` modifie sa propre
-- ligne de `stock_level`, et le désaccord se lirait comme une régression de
-- policy au lieu de la propriété recherchée.
--
-- Le registre porte **la fonction d'écriture**, pas seulement la table source.
-- `pg_trigger_depth()` dit « écrit par un trigger », il ne dit pas « écrit par
-- le trigger d'agrégat » : le jour où un autre trigger, sur une autre table,
-- écrira dans `stock_level`, le garde le laissera passer. C'est
-- `conventions.ts` qui ferme cette porte — il balaie `pg_proc` et signale toute
-- fonction qui écrit dans une table dérivée sans en être l'écrivain déclaré,
-- exactement comme il le fait depuis E1-04 pour `audit_log`.
-- ============================================================================

create table merx.derived_registry (
  table_name      text primary key,
  source_table    text not null,
  writer_function text not null
);

comment on table merx.derived_registry is
  'Tables agrégées : jamais écrites par l''application, maintenues par un '
  'trigger sur leur table source. SPEC RÈGLE M2-1 ; E3-01.';

comment on column merx.derived_registry.writer_function is
  'Le seul écrivain admis, dans merx. conventions.ts refuse toute autre '
  'fonction qui écrit dans la table — pg_trigger_depth() ne saurait pas les '
  'distinguer.';


-- ----------------------------------------------------------------------------
-- Garde de ligne
--
-- `pg_trigger_depth() < 2` : la profondeur vaut 1 quand ce trigger-ci est le
-- seul en cours, c'est-à-dire quand l'écriture vient d'une instruction directe
-- — PostgREST, `psql`, une migration. Elle vaut 2 ou plus quand l'écriture
-- vient d'un trigger, donc du trigger d'agrégat.
--
-- Pourquoi la profondeur et non un drapeau posé par l'agrégat : un drapeau de
-- session est forgeable par qui peut appeler `set_config()`, et la première RPC
-- qui le permettrait ouvrirait la table sans que personne le voie. La
-- profondeur ne se forge pas depuis une requête.
--
-- Pourquoi la profondeur et non un `revoke` des privilèges d'écriture :
-- retirer INSERT et UPDATE à `authenticated` obligerait l'agrégat à être
-- `security definer`, donc à tourner sous `postgres` qui porte BYPASSRLS, et
-- l'isolation de la ligne dérivée ne tiendrait plus qu'au corps de la fonction
-- — le filtre à la main que SPEC § 2.1 n'admet qu'en exception nommée. En
-- invoker, la RLS gouverne `stock_level` comme n'importe quelle autre table.
-- Le privilège reste donc nécessairement ouvert, et c'est pour cela que ce
-- garde porte toute la ligne, et que `conventions.ts` interdit tout autre
-- écrivain.
--
-- SQLSTATE `55000` — *object_not_in_prerequisite_state*. Le code n'est celui
-- d'aucun autre refus du projet : `2F004` est l'ajout seul, `42501`
-- l'autorisation, `23505` une unicité, `23514` une contrainte, `54000` la
-- limite d'E1-03, `P0002` une ligne introuvable. Un test qui assert `55000`
-- mesure ce garde-ci et rien d'autre.
--
-- INSERT est gardé **AFTER**, UPDATE et DELETE **BEFORE**. Ce n'est pas une
-- coquetterie : la RLS d'une insertion est vérifiée après les triggers BEFORE
-- et avant les AFTER. Un garde BEFORE INSERT refuserait donc avant la RLS, et
-- l'assertion « une ligne destinée au commerce du voisin est refusée » du
-- balayage d'isolation serait satisfaite par ce garde-ci au lieu de l'être par
-- la policy — retirer `tenant_isolation` laisserait la suite au vert
-- (CLAUDE.md, un trigger qui refuse à la place de la policy d'à côté). En
-- AFTER, la RLS refuse d'abord, et le garde ne voit que ce qui a franchi la
-- frontière. Sur UPDATE et DELETE la question ne se pose pas : une ligne du
-- voisin n'est pas visible, donc aucune ligne n'est touchée et aucun trigger ne
-- s'exécute.
-- ----------------------------------------------------------------------------

-- `security definer` : la fonction lit le registre pour nommer la table source
-- dans son message, et `authenticated` n'a aucun privilège sur `merx`. En
-- invoker, le garde refusait bien — mais en `42501`, « permission denied for
-- table derived_registry », au lieu de son propre code et de sa propre phrase.
-- Un refus qui ne dit pas qui refuse n'est pas testable, et celui-là se serait
-- confondu avec un refus de privilège.
create function merx.reject_derived_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source text;
begin
  if pg_catalog.pg_trigger_depth() >= 2 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select r.source_table into source
  from merx.derived_registry r
  where r.table_name = tg_table_name;

  raise exception
    '% est un agrégat : il ne s''écrit pas à la main. Écrire dans %, le trigger s''en charge.',
    tg_table_name, coalesce(source, 'sa table source')
    using errcode = '55000';
end;
$function$;

comment on function merx.reject_derived_write() is
  'Trigger : refuse toute écriture sur une table dérivée qui ne vient pas d''un '
  'trigger. AFTER INSERT, BEFORE UPDATE OR DELETE. RÈGLE M2-1, E3-01.';


-- ----------------------------------------------------------------------------
-- Garde d'instruction — TRUNCATE
--
-- Même raison qu'en E1-04 : un trigger de ligne ne voit pas passer TRUNCATE,
-- l'instruction ne produit aucune ligne. Sans ce second garde, la table entière
-- s'efface par la porte de derrière pendant que le premier reste vert.
--
-- Sa propre phrase, pour qu'un test puisse dire lequel des deux a refusé. Un
-- agrégat vidé est récupérable — il se recalcule depuis ses mouvements — ce que
-- le message dit, parce que c'est la vraie question de celui qui le lit.
-- ----------------------------------------------------------------------------

create function merx.reject_derived_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source text;
begin
  select r.source_table into source
  from merx.derived_registry r
  where r.table_name = tg_table_name;

  raise exception
    '% est un agrégat : la table ne se vide pas d''un coup. Elle se recalcule depuis %.',
    tg_table_name, coalesce(source, 'sa table source')
    using errcode = '55000';
end;
$function$;

comment on function merx.reject_derived_truncate() is
  'Trigger BEFORE TRUNCATE : TRUNCATE ne déclenche aucun trigger de ligne, '
  'donc échapperait à merx.reject_derived_write(). E3-01.';


-- ----------------------------------------------------------------------------
-- `merx.apply_derived_from()` — pose les gardes et inscrit
--
-- Les deux validations ne sont pas décoratives. Une fonction d'écriture
-- inexistante, et le registre nomme un écrivain que `conventions.ts`
-- chercherait en vain — la règle qui refuse les autres écrivains deviendrait
-- une règle qui refuse tout le monde. Une table source hors du registre de
-- conventions, et les deux gardes parleraient d'une table qui n'existe pas.
-- ----------------------------------------------------------------------------

create function merx.apply_derived_from(
  target          regclass,
  source          text,
  writer_function text
)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'merx'
    where p.proname = writer_function
  ) then
    raise exception
      'Écrivain inconnu : merx.%(). Une table dérivée nomme la fonction qui la maintient.',
      writer_function;
  end if;

  if not exists (
    select 1 from merx.convention_registry r where r.table_name = source
  ) then
    raise exception
      'Table source inconnue : %. Elle doit figurer dans merx.convention_registry.',
      source;
  end if;

  -- TRUNCATE seul : INSERT, UPDATE et DELETE doivent rester accordés à
  -- `authenticated`, sans quoi le trigger d'agrégat — qui tourne sous
  -- l'appelant, par choix (voir le garde de ligne) — ne pourrait plus écrire.
  execute format('revoke truncate on %s from authenticated', target);

  execute format(
    'create trigger reject_derived_insert after insert on %s'
    ' for each row execute function merx.reject_derived_write()',
    target);

  execute format(
    'create trigger reject_derived_write before update or delete on %s'
    ' for each row execute function merx.reject_derived_write()',
    target);

  execute format(
    'create trigger reject_derived_truncate before truncate on %s'
    ' for each statement execute function merx.reject_derived_truncate()',
    target);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.derived_registry (table_name, source_table, writer_function)
  values (table_name, source, writer_function);
end;
$function$;

comment on function merx.apply_derived_from(regclass, text, text) is
  'Rend une table dérivée : gardes de ligne et de TRUNCATE, TRUNCATE retiré à '
  'authenticated, inscription au registre. RÈGLE M2-1, E3-01.';


-- ============================================================================
-- Mécanisme — l'écriture ouverte type par type
--
-- E1-04 avait prévu deux chemins d'écriture pour une table en ajout seul :
-- `application` (l'application insère sous `authenticated`) et `helper` (seule
-- une fonction `security definer` insère). `stock_movement` n'est ni l'un ni
-- l'autre : l'application est bien l'écrivain, mais chaque insertion est
-- qualifiée **par une colonne de la ligne** — le type de mouvement — et
-- aujourd'hui aucun type n'est ouvert, donc aucune insertion ne passe.
--
-- Un troisième chemin, `restricted`, dit exactement cela : le harnais de test
-- ne sait pas fabriquer une ligne légitime, donc son contrôle positif reste la
-- lecture, comme pour `helper`. Le jour où E4 ouvrira `sale` — la première
-- étiquette de l'enum, celle que le générateur de lignes emploie — l'insertion
-- chez soi redeviendra possible et le chemin devra passer à `application` :
-- `isolation.test.ts` le dira en rougissant sur l'assertion « insert refusée »,
-- ce qui est la bonne façon de l'apprendre.
-- ============================================================================

alter table merx.append_only_registry
  drop constraint append_only_registry_write_path_check;

alter table merx.append_only_registry
  add constraint append_only_registry_write_path_check
  check (write_path in ('application', 'helper', 'restricted'));

create or replace function merx.apply_append_only(target regclass, write_path text)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  if write_path not in ('application', 'helper', 'restricted') then
    raise exception
      'Chemin d''écriture inconnu : %. Attendu « application », « helper » ou « restricted ».',
      write_path;
  end if;

  execute format('revoke update, delete, truncate on %s from authenticated', target);

  -- `restricted` garde INSERT : c'est une policy, et non le privilège, qui
  -- qualifie l'insertion ligne par ligne.
  if write_path = 'helper' then
    execute format('revoke insert on %s from authenticated', target);
  end if;

  execute format(
    'create trigger reject_row_mutation before update or delete on %s'
    ' for each row execute function merx.reject_row_mutation()',
    target);

  execute format(
    'create trigger reject_truncate before truncate on %s'
    ' for each statement execute function merx.reject_truncate()',
    target);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.append_only_registry (table_name, write_path)
  values (table_name, write_path);
end;
$function$;

comment on function merx.apply_append_only(regclass, text) is
  'Rend une table en ajout seul : privilèges retirés, garde de ligne, garde de '
  'TRUNCATE, inscription au registre. E1-04 ; chemin « restricted » E3-01.';


-- ----------------------------------------------------------------------------
-- Une policy d'insertion qualifiée par une colonne
--
-- `merx.apply_write_capability_restriction()` (E1-05) réserve l'écriture d'une
-- table à **une** capacité, la même pour toutes ses lignes. Ici la capacité
-- dépend de la ligne. Le mécanisme est donc son propre helper, avec son
-- registre — et le registre n'est pas décoratif : `isolation.ts` compare le jeu
-- de policies de chaque table au jeu **attendu**, construit depuis les
-- registres. Une policy écrite à la main serait signalée « inattendue ».
--
-- Le résolveur est une fonction de `merx` prenant la valeur de la colonne et
-- rendant un booléen. Elle doit passer par `merx.can()` — SPEC § 3, RÈGLE un
-- seul helper : un droit vérifié ailleurs est un droit que la matrice ne
-- gouverne pas.
-- ----------------------------------------------------------------------------

create table merx.column_capability_registry (
  table_name        text primary key,
  column_name       text not null,
  resolver_function text not null
);

comment on table merx.column_capability_registry is
  'Tables dont l''insertion exige une capacité qui dépend d''une colonne de la '
  'ligne. SPEC § 3.1 ; E3-01.';

create function merx.apply_column_capability_insert(
  target            regclass,
  column_name       text,
  resolver_function text
)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'merx'
    where p.proname = resolver_function
  ) then
    raise exception 'Résolveur inconnu : merx.%().', resolver_function;
  end if;

  -- INSERT n'a pas de `using` : il n'y a pas de ligne existante à qualifier.
  execute format($ddl$
    create policy column_capability_insert on %s
      as restrictive for insert to authenticated
      with check (merx.%I(%I))
  $ddl$, target, resolver_function, column_name);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.column_capability_registry (table_name, column_name, resolver_function)
  values (table_name, column_name, resolver_function);
end;
$function$;

comment on function merx.apply_column_capability_insert(regclass, text, text) is
  'Réserve l''insertion d''une table à une capacité résolue depuis une de ses '
  'colonnes. Une policy restrictive, et inscription au registre. E3-01.';


-- ----------------------------------------------------------------------------
-- La correspondance type → capacité
--
-- **Vide.** C'est le livrable, pas un oubli : fermé par défaut, ouvert type par
-- type, par la story qui crée l'écran qui en a besoin.
--
--   E3-03  `adjustment`  — correction manuelle, `owner` seul
--   E3-04  `inventory`   — écart validé, `approve_stock_variance`
--   E4     `sale`        — `create_sale`
--   E4-06  `return`      — `create_sale`
--   E8-02  `receipt`     — `receive_goods`
--
-- Les capacités existent déjà dans la matrice § 3.1 : aucune story n'aura à en
-- inventer une, seulement à inscrire une ligne ici.
--
-- Le trigger qui garde cette table est l'équivalent d'une clé étrangère que
-- Postgres ne sait pas écrire : `merx.role_capability` a pour clé primaire
-- `(capability, role)`, donc `capability` seule n'est pas unique et ne peut pas
-- être visée. Sans ce garde, une capacité mal orthographiée en E3-03
-- verrouillerait le type en silence — `merx.can()` d'une capacité absente de la
-- matrice est faux pour tout le monde, et la ligne de registre donnerait
-- l'illusion d'un type ouvert. D'où `23503`, le code d'une clé étrangère
-- violée : c'est ce que c'est.
-- ----------------------------------------------------------------------------

create table merx.movement_type_capability (
  movement_type public.stock_movement_type primary key,
  capability    text not null
);

comment on table merx.movement_type_capability is
  'Quelle capacité § 3.1 ouvre quel type de mouvement. Vide en E3-01 : aucun '
  'écran n''écrit de mouvement, donc aucun type n''est ouvert. E3-01.';

create function merx.require_known_capability()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from merx.role_capability rc where rc.capability = new.capability
  ) then
    raise exception
      'Capacité inconnue : %. Elle doit figurer dans merx.role_capability (SPEC § 3.1).',
      new.capability
      using errcode = '23503';
  end if;

  return new;
end;
$function$;

comment on function merx.require_known_capability() is
  'La clé étrangère que merx.role_capability ne peut pas offrir : sa clé '
  'primaire est (capability, role), donc capability seule n''est pas unique.';

create trigger require_known_capability
  before insert or update on merx.movement_type_capability
  for each row execute function merx.require_known_capability();


-- ----------------------------------------------------------------------------
-- Le résolveur
--
-- Deux questions, et une seule est la sienne :
--
--   « ce rôle détient-il la capacité qu'exige ce type ? » — la sienne, et elle
--     passe par `merx.can()`, seul point de vérification des droits (SPEC § 3) ;
--   « ce type est-il ouvert à quiconque ? » — pas la sienne. Elle appartient au
--     trigger `require_open_movement_type` ci-dessous.
--
-- D'où le `true` par défaut, qui se lirait comme une porte ouverte sans cette
-- phrase-ci. Le partage n'est pas une élégance, c'est ce qui rend les deux
-- gardes testables séparément :
--
--   — si ce résolveur refusait les types non inscrits, un type fermé serait
--     refusé par la **policy**, avec le message générique de la RLS, et le
--     message qui nomme le type n'apparaîtrait jamais. Le garde serait mort ;
--   — et comme la policy refuserait alors tout, aujourd'hui, retirer le trigger
--     ne changerait rien d'observable : son test ne pourrait pas tomber.
--
-- Chacun a donc son refus propre, et chacun son test (CLAUDE.md, E1-02).
-- ----------------------------------------------------------------------------

create function merx.can_move_stock(kind public.stock_movement_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select merx.can(m.capability)
     from merx.movement_type_capability m
     where m.movement_type = kind),
    true)
$function$;

comment on function merx.can_move_stock(public.stock_movement_type) is
  'Le rôle du jeton détient-il la capacité qu''exige ce type de mouvement ? '
  'Vrai pour un type non inscrit : l''ouverture du type est gardée à part, par '
  'merx.require_open_movement_type(). SPEC § 3.1, E3-01.';

revoke execute on function merx.can_move_stock(public.stock_movement_type)
  from public, anon;

grant execute on function merx.can_move_stock(public.stock_movement_type)
  to authenticated;


-- ----------------------------------------------------------------------------
-- Le garde du fermé par défaut
--
-- AFTER, pour la même raison que le garde des tables dérivées : la RLS d'une
-- insertion est vérifiée entre les triggers BEFORE et les AFTER. En BEFORE, ce
-- garde refuserait une ligne destinée au commerce du voisin avant que
-- `tenant_isolation` ait à se prononcer, et l'assertion d'isolation du balayage
-- serait satisfaite par lui — retirer la policy laisserait la suite au vert.
--
-- `42501`, comme la policy : les deux refusent pour défaut de droit, et leurs
-- phrases n'ont rien en commun. C'est la phrase que le test assert, et c'est
-- elle que lit le patron — « aucune capacité n'ouvre les mouvements de type
-- adjustment » se comprend, « new row violates row-level security policy » non.
-- ----------------------------------------------------------------------------

-- `security definer`, comme le garde des tables dérivées et pour la même
-- raison : la fonction lit `merx.movement_type_capability`, sur quoi
-- `authenticated` n'a aucun privilège. En invoker, le refus arrivait quand même
-- — en « permission denied for table movement_type_capability », donc sans
-- nommer le type, et impossible à distinguer d'un refus de privilège.
create function merx.require_open_movement_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from merx.movement_type_capability m
    where m.movement_type = new.movement_type
  ) then
    raise exception
      'Aucune capacité n''ouvre les mouvements de type « % » : personne ne peut en écrire.',
      new.movement_type
      using errcode = '42501',
            hint = 'La story qui ouvre ce type l''inscrit à merx.movement_type_capability.';
  end if;

  return null;
end;
$function$;

comment on function merx.require_open_movement_type() is
  'Trigger AFTER INSERT : un type de mouvement sans capacité inscrite est '
  'refusé, et le message le nomme. Fermé par défaut, SPEC § 3.1 ; E3-01.';


-- ============================================================================
-- `public.stock_movement`
--
-- Les colonnes du spec § 7 M2, et rien de plus. Les conventions apportent `id`,
-- `tenant_id` et son défaut, `created_at`, `updated_at`, `created_by`,
-- `device_id`, la RLS et ses deux policies (SPEC § 4, § 2.1).
--
-- Conventions **métier** et non référence : un mouvement n'a pas de
-- `deleted_at`. SPEC § 4 — « documents et mouvements jamais supprimés ».
--
-- `quantity` est signée, négative en sortie, et `<> 0` : un mouvement de zéro
-- ne dit rien et encombrerait l'historique qu'on relit pour comprendre un
-- écart. Le domaine `public.quantity` — jamais un `numeric` nu, jamais un
-- flottant (SPEC § 4, RÈGLE des domaines nommés).
--
-- **Aucune contrainte de signe sur le résultat.** RÈGLE M2-3 : le stock négatif
-- est autorisé. Un grossiste vend ce qui est encore sur le camion. Il est
-- signalé à l'écran (E3-02), jamais refusé en base — un `check` ici rendrait la
-- RÈGLE inapplicable, et la découverte se ferait au comptoir.
--
-- `source_type` et `source_id` vont par deux, ou pas du tout : un mouvement
-- découle d'un document ou n'en découle pas, et un identifiant sans type ne se
-- résout nulle part. Le couple est nullable, parce que l'ajustement manuel
-- d'E3-03 n'a pas de document — son motif vit dans `note`.
--
-- Pas de clé étrangère sur `source_id` : une clé polymorphe ne s'écrit pas, et
-- les trois tables visées n'existent pas. Même contrepartie assumée qu'en
-- E1-04 pour `audit_log.entity_id`, et elle reste théorique — un document ne se
-- supprime pas (SPEC § 4).
-- ============================================================================

create table public.stock_movement (
  id            uuid                       primary key default gen_random_uuid(),
  variant_id    uuid                       not null,
  warehouse_id  uuid                       not null,
  movement_type public.stock_movement_type not null,
  quantity      public.quantity            not null check (quantity <> 0),
  source_type   public.stock_source_type,
  source_id     uuid,
  note          text,

  constraint stock_movement_source_complete
    check ((source_type is null) = (source_id is null))
);

select merx.apply_business_conventions('public.stock_movement');

comment on table public.stock_movement is
  'Tout ce qui fait bouger une quantité. En ajout seul : une erreur se corrige '
  'par un mouvement inverse. SPEC § 7 M2, RÈGLE M2-2 ; E3-01.';

comment on column public.stock_movement.quantity is
  'Signée : négative en sortie, positive en entrée. Le niveau peut passer sous '
  'zéro — RÈGLE M2-3, signalé jamais bloquant.';

comment on column public.stock_movement.source_id is
  'Le document d''origine, sans clé étrangère : la cible dépend de source_type, '
  'et une clé polymorphe ne s''écrit pas.';

/*
 * SPEC § 2.3 : le stock référence `variant_id`, jamais `product_id`. SPEC § 2.4 :
 * `warehouse_id` pointe sur l'unique dépôt du commerce, jamais affiché, jamais
 * choisi — c'est une colonne constante, là pour ne pas avoir à réécrire
 * l'historique de tous les commerces installés le jour où l'un d'eux aurait un
 * dépôt séparé.
 *
 * Clés composites sur `tenant_id` (SPEC § 4), et **sans cascade** : un
 * mouvement ne se supprime pas, donc rien ne doit pouvoir l'emporter. La
 * cascade posée en E2-01 sur `variant → product` s'arrête ici d'elle-même, ce
 * que son commentaire annonçait : « dès qu'une variante sera référencée par du
 * stock, ces clés-là refuseront, et l'historique ne se purge pas ».
 */
alter table public.stock_movement
  add constraint stock_movement_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id);

alter table public.stock_movement
  add constraint stock_movement_warehouse_id_fkey
  foreign key (tenant_id, warehouse_id) references public.warehouse (tenant_id, id);

/*
 * L'index de lecture. E3-02 : « l'historique complet des mouvements, du plus
 * récent au plus ancien », pour une variante, dans un commerce.
 */
create index stock_movement_variant_created_at
  on public.stock_movement (tenant_id, variant_id, created_at desc);

/*
 * RÈGLE M2-2. Chemin d'écriture `restricted` : l'application insère, mais
 * chaque insertion est qualifiée par son type.
 */
select merx.apply_append_only('public.stock_movement', 'restricted');

/*
 * Qui peut écrire quoi. La lecture n'est pas restreinte : « voir le catalogue
 * et le stock » est accordé aux deux rôles (SPEC § 3.1), et l'employé vend ce
 * qu'il lit. L'absence de restriction de lecture est une décision, pas un
 * oubli — même geste qu'en E1-05 et E2-01.
 */
select merx.apply_column_capability_insert(
  'public.stock_movement', 'movement_type', 'can_move_stock');

comment on policy column_capability_insert on public.stock_movement is
  'Écrire un mouvement exige la capacité § 3.1 que la correspondance '
  'type → capacité associe à son type. Un type non inscrit est refusé par le '
  'trigger require_open_movement_type, avec un message qui le nomme.';

create trigger require_open_movement_type
  after insert on public.stock_movement
  for each row execute function merx.require_open_movement_type();


-- ============================================================================
-- `public.stock_level`
--
-- SPEC § 7 M2 : `variant_id, warehouse_id, quantity`, unicité sur
-- `(variant_id, warehouse_id)`. L'unicité ne porte pas `tenant_id` et n'en a
-- pas besoin : `variant_id` est déjà borné à un commerce par sa clé composite,
-- donc deux commerces ne peuvent pas désigner la même paire. L'unicité du spec
-- est prise au mot.
--
-- `quantity` a pour défaut 0 : la ligne naît au premier mouvement, et le
-- trigger lui ajoute ce mouvement-là. Aucune contrainte de signe — RÈGLE M2-3.
-- ============================================================================

create table public.stock_level (
  id           uuid            primary key default gen_random_uuid(),
  variant_id   uuid            not null,
  warehouse_id uuid            not null,
  quantity     public.quantity not null default 0
);

select merx.apply_business_conventions('public.stock_level');

comment on table public.stock_level is
  'La quantité en stock d''une variante, agrégat des mouvements. Jamais écrit '
  'directement — RÈGLE M2-1. SPEC § 7 M2 ; E3-01.';

comment on column public.stock_level.quantity is
  'Somme des quantités signées des mouvements. Peut être négative — RÈGLE M2-3.';

alter table public.stock_level
  add constraint stock_level_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id);

alter table public.stock_level
  add constraint stock_level_warehouse_id_fkey
  foreign key (tenant_id, warehouse_id) references public.warehouse (tenant_id, id);

create unique index stock_level_variant_warehouse
  on public.stock_level (variant_id, warehouse_id);


-- ----------------------------------------------------------------------------
-- Le trigger d'agrégat — le seul écrivain de `stock_level`
--
-- RÈGLE M2-1 : « `stock_level` est un agrégat maintenu par trigger. »
--
-- AFTER INSERT : le mouvement est écrit, donc la RLS et les deux gardes du type
-- ont déjà tranché. Un mouvement refusé ne bouge aucun niveau.
--
-- `on conflict ... do update` et non un `update` suivi d'un `insert` : la
-- première ligne et la millième passent par le même chemin, et l'unicité
-- `(variant_id, warehouse_id)` est l'arbitre. Un « si elle existe, modifier,
-- sinon insérer » aurait une fenêtre entre les deux, et deux ventes
-- simultanées de la même variante y tiennent.
--
-- `security invoker` — le défaut, et il est voulu : la RLS gouverne la ligne
-- dérivée comme n'importe quelle autre, et le `tenant_id` écrit est celui du
-- mouvement, qui a lui-même franchi `tenant_isolation`. En `security definer`,
-- la fonction tournerait sous `postgres` qui porte BYPASSRLS, et l'isolation de
-- `stock_level` ne tiendrait plus qu'à ce corps-ci (SPEC § 2.1).
--
-- `created_by` et `device_id` sont repris du mouvement : la ligne d'agrégat
-- porte l'auteur et l'appareil du mouvement qui l'a créée. C'est faux dès le
-- deuxième mouvement, et sans importance — personne ne lit l'auteur d'un
-- agrégat, l'historique est dans `stock_movement`. Les colonnes existent par
-- convention § 4 ; les laisser nulles aurait demandé une exception.
-- ----------------------------------------------------------------------------

create function merx.apply_stock_movement()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.stock_level (
    tenant_id, variant_id, warehouse_id, quantity, created_by, device_id
  )
  values (
    new.tenant_id, new.variant_id, new.warehouse_id, new.quantity,
    new.created_by, new.device_id
  )
  on conflict (variant_id, warehouse_id) do update
    set quantity = stock_level.quantity + excluded.quantity;

  return null;
end;
$function$;

comment on function merx.apply_stock_movement() is
  'Le seul écrivain de stock_level : ajoute la quantité signée du mouvement au '
  'niveau de la paire (variante, dépôt). RÈGLE M2-1 ; E3-01.';

create trigger apply_stock_movement
  after insert on public.stock_movement
  for each row execute function merx.apply_stock_movement();

/*
 * Et les gardes, maintenant que l'écrivain existe : il est nommé au registre,
 * et `conventions.ts` refusera toute autre fonction qui écrirait dans
 * `stock_level`.
 */
select merx.apply_derived_from(
  'public.stock_level', 'stock_movement', 'apply_stock_movement');
