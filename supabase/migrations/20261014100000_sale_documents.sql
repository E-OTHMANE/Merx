-- ============================================================================
-- Merx — le modèle document : sale_document, sale_line, document_sequence
--
-- Référence : docs/SPEC.md § 2.3 (variant_id, jamais product_id), § 2.6, § 3 /
--             § 3.1 (matrice, RÈGLE un seul helper), § 4 (conventions, clés
--             composites, domaines nommés), § 7 M2 (RÈGLES M2-2, M2-5),
--             § 8 (RÈGLES M3-1, M3-3), § 9 (RÈGLE M8-1) ;
--             docs/BACKLOG.md E4-01.
--
-- Trois choses à tenir, et chacune son garde — aucun ne refuse comme un autre,
-- sans quoi le test de l'un passerait sur le refus du voisin (CLAUDE.md ;
-- E1-01, E1-02, E2-01, E3-01) :
--
--   RÈGLE M3-3 — un document confirmé n'est ni modifié ni supprimé.
--     **Mécanisme neuf**, le registre des tables figées ci-dessous.
--     `merx.apply_append_only()` ne s'y prête pas, et on ne le plie pas : il
--     vaut pour toute la table (privilèges UPDATE/DELETE retirés, garde de
--     ligne sans condition), alors qu'un brouillon doit rester modifiable et
--     que `confirmed → cancelled` est un UPDATE. Et son registre est ce que
--     `isolation.ts` lit pour inverser son contrôle positif : y inscrire
--     `sale_document` ferait attendre « UPDATE refusé » sur des brouillons.
--
--   RÈGLE M3-3, seconde moitié — l'annulation génère les mouvements inverses.
--     Un trigger, en `security invoker` : la RLS et `merx.can()` s'appliquent à
--     l'écriture des mouvements comme à n'importe quelle autre. Le type du
--     mouvement, `sale_cancellation`, est ouvert sur `cancel_document` — et lui
--     seul des cinq autres types reste fermé.
--
--   RÈGLE M8-1 — l'annulation est tracée sous `document_cancellation`.
--     `merx.apply_audit()` y gagne un paramètre : les événements explicites.
--
-- ----------------------------------------------------------------------------
-- Ce qui n'est pas ici, et pourquoi
--
--   — **`client_id`.** SPEC § 8 le liste sur `sale_document`, mais la table
--     `client` naît en E6-01. Une colonne posée sans clé laisserait passer
--     l'identifiant d'un autre commerce, ce que la RÈGLE de § 4 existe pour
--     empêcher. E6-01 ajoute la colonne avec sa clé composite, dans le même
--     geste (BACKLOG E6-01).
--
--   — **Le numéro.** `doc_number` est nul tant que le document est un
--     brouillon ; l'attribuer est E4-02. Aucune unicité n'est posée dessus :
--     `BL-A-0001` ne porte pas l'année alors que la séquence est annuelle, et
--     E4-02 doit trancher avant (BACKLOG E4-02).
--
--   — **La cohérence des totaux.** Aucune contrainte `total = subtotal -
--     discount_total`, ni `line_total = quantity × unit_price - line_discount` :
--     la règle d'arrondi d'une quantité à trois décimales par un prix à deux
--     n'est écrite nulle part (BACKLOG E4-04). Seule la non-négativité est
--     tenue, qui ne dépend d'aucun arrondi.
--
--   — **Les mouvements `sale`.** La confirmation d'un bon de livraison qui
--     décrémente le stock est E4-05 (RÈGLE M3-5). L'annulation inverse donc les
--     mouvements `sale` qui existent pour le document — et n'en crée aucun s'il
--     n'y en a pas, ce qui est le cas d'un devis ou d'une commande.
-- ============================================================================


-- ============================================================================
-- Mécanisme — les tables figées
--
-- Une table est figée quand ses lignes ne se modifient plus à partir d'un
-- certain statut. Trois registres de la base disent « cette ligne ne bouge
-- pas », et celui-ci se distingue des autres par ce qu'il laisse passer :
--
--   ajout seul — jamais de UPDATE ni de DELETE, **par le privilège** ;
--   dérivée    — jamais écrite à la main, mais par son trigger d'agrégat ;
--   figée      — libre tant que le statut est « ouvert » (le brouillon), puis
--                plus rien ne change **sauf le statut**, le long de
--                transitions déclarées en données.
--
-- Lecture de la RÈGLE M3-3, écrite ici et à SPEC § 8 pour qu'on ne la
-- réinterprète pas : « un document confirmé n'est jamais modifié » veut dire
-- **le contenu est figé, le statut avance**. `confirmed → delivered` et
-- `confirmed → cancelled` sont des changements de statut, pas de contenu ; la
-- RÈGLE ne les interdit pas, elle interdit de toucher à ce qui a été
-- confirmé — lignes, montants, client, notes.
--
-- Cinq gardes, un par façon de manquer, chacun sa phrase et son test :
--
--   naissance  BEFORE INSERT      une ligne naît au statut ouvert, jamais
--                                 déjà confirmée (sans quoi ses lignes ne
--                                 pourraient jamais être écrites).
--   mise à jour BEFORE UPDATE     trois refus : transition non déclarée,
--                                 contenu changé sous un statut figé, colonne
--                                 étrangère à la transition.
--   suppression BEFORE DELETE     seul le statut ouvert se supprime.
--   TRUNCATE    BEFORE TRUNCATE   jamais ; le privilège est aussi retiré.
--   enfant      BEFORE I/U/D      une ligne dont le parent n'est plus ouvert
--                                 ne s'écrit plus (`sale_line`).
--
-- SQLSTATE `55006` — *object_in_use*, qu'aucun autre refus du projet n'emploie :
-- `2F004` est l'ajout seul, `55000` l'agrégat, `42501` l'autorisation, `23514`
-- une contrainte. Un test qui assert `55006` mesure ces gardes-ci et rien
-- d'autre.
--
-- Les gardes de la table figée sont `security definer` pour lire le registre,
-- sur lequel `authenticated` n'a aucun privilège — même raison et même forme
-- que `merx.reject_derived_write()`. Ils ne lisent aucune table métier. Le
-- garde de l'enfant, lui, lit le parent : il est `security invoker`, donc la
-- RLS s'y applique, et reçoit sa configuration en arguments de trigger plutôt
-- que du registre.
-- ============================================================================

create table merx.frozen_registry (
  table_name    text primary key,
  kind          text not null check (kind in ('root', 'child')),
  -- Pour une table figée par son propre statut :
  status_column text,
  open_status   text,
  -- Pour une table figée par celui de son parent :
  parent_table  text,
  parent_column text,

  constraint frozen_registry_shape check (
    (kind = 'root'  and status_column is not null and open_status is not null
                    and parent_table is null and parent_column is null)
    or
    (kind = 'child' and parent_table is not null and parent_column is not null
                    and status_column is null and open_status is null)
  )
);

comment on table merx.frozen_registry is
  'Tables dont les lignes se figent à partir d''un statut (root), et tables '
  'dont les lignes se figent avec leur parent (child). RÈGLE M3-3, E4-01. '
  'Lu par conventions.ts et par les gardes.';

create table merx.frozen_transition (
  table_name      text not null references merx.frozen_registry (table_name),
  from_status     text not null,
  to_status       text not null,
  -- Les colonnes qu'une ligne déjà figée a le droit de changer le long de
  -- cette transition, en plus du statut et de updated_at. Sans objet quand
  -- la transition part du statut ouvert : le brouillon est libre.
  mutable_columns text[] not null default '{}',
  primary key (table_name, from_status, to_status),
  check (from_status <> to_status)
);

comment on table merx.frozen_transition is
  'Les changements de statut admis sur une table figée, en données et non en '
  'code : ce qui n''est pas listé est refusé. RÈGLE M3-3, E4-01.';


-- ----------------------------------------------------------------------------
-- Naissance
-- ----------------------------------------------------------------------------

create function merx.reject_frozen_birth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reg    merx.frozen_registry%rowtype;
  status text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  status := pg_catalog.to_jsonb(new) ->> reg.status_column;

  if status <> reg.open_status then
    raise exception
      '% naît au statut « % », et à aucun autre : l''enregistrement demandait « % ». '
      'Le statut avance ensuite par UPDATE, le long des transitions déclarées.',
      tg_table_name, reg.open_status, status
      using errcode = '55006';
  end if;

  return new;
end;
$function$;

comment on function merx.reject_frozen_birth() is
  'Trigger BEFORE INSERT : une ligne figeable naît au statut ouvert. Sans '
  'cela un document pourrait naître confirmé, et ses lignes ne s''écriraient '
  'jamais. RÈGLE M3-3, E4-01.';


-- ----------------------------------------------------------------------------
-- Mise à jour
--
-- Quatre cas, dans cet ordre :
--
--   1. le statut ne change pas
--        ouvert  → tout passe ;
--        figé    → rien ne passe que `updated_at` (« set updated_at =
--                  updated_at » est un no-op, pas une modification) ;
--   2. le statut change
--        absent de merx.frozen_transition → refusé ;
--        part du statut ouvert            → tout passe (le brouillon qui se
--                                           confirme peut recevoir son numéro,
--                                           sa date, ses totaux) ;
--        sinon                            → seules les colonnes déclarées pour
--                                           cette transition passent.
--
-- Les colonnes qui ont changé sont calculées sur `to_jsonb(new)` contre
-- `to_jsonb(old)` : la fonction ne connaît le nom d'aucune colonne, donc une
-- colonne ajoutée plus tard — `client_id` en E6-01 — est figée d'office. Le
-- garde ne se périme pas quand la table grossit.
-- ----------------------------------------------------------------------------

create function merx.reject_frozen_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reg        merx.frozen_registry%rowtype;
  old_status text;
  new_status text;
  allowed    text[];
  changed    text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  old_status := pg_catalog.to_jsonb(old) ->> reg.status_column;
  new_status := pg_catalog.to_jsonb(new) ->> reg.status_column;

  if old_status = new_status then
    if old_status = reg.open_status then
      return new;
    end if;

    select pg_catalog.string_agg(n.key, ', ' order by n.key) into changed
    from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as n
    where n.key <> 'updated_at'
      and (pg_catalog.to_jsonb(old) -> n.key) is distinct from n.value;

    if changed is not null then
      raise exception
        'Un enregistrement de % au statut « % » ne se modifie plus (RÈGLE M3-3) : '
        'colonne(s) changée(s) — %. Seul son statut avance.',
        tg_table_name, old_status, changed
        using errcode = '55006';
    end if;

    return new;
  end if;

  select t.mutable_columns into allowed
  from merx.frozen_transition t
  where t.table_name = tg_table_name
    and t.from_status = old_status
    and t.to_status = new_status;

  if not found then
    raise exception
      'Transition de statut refusée sur % : « % » → « % ». Seules les transitions '
      'déclarées à merx.frozen_transition sont admises.',
      tg_table_name, old_status, new_status
      using errcode = '55006';
  end if;

  if old_status = reg.open_status then
    return new;
  end if;

  select pg_catalog.string_agg(n.key, ', ' order by n.key) into changed
  from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as n
  where n.key <> all (array['updated_at', reg.status_column] || allowed)
    and (pg_catalog.to_jsonb(old) -> n.key) is distinct from n.value;

  if changed is not null then
    raise exception
      'La transition « % » → « % » de % ne change que le statut%, et a changé aussi : % '
      '(RÈGLE M3-3).',
      old_status, new_status, tg_table_name,
      case when pg_catalog.cardinality(allowed) = 0 then ''
           else ' et ' || pg_catalog.array_to_string(allowed, ', ') end,
      changed
      using errcode = '55006';
  end if;

  return new;
end;
$function$;

comment on function merx.reject_frozen_update() is
  'Trigger BEFORE UPDATE : le contenu d''une ligne figée ne bouge plus, son '
  'statut avance le long des transitions déclarées. RÈGLE M3-3, E4-01.';


-- ----------------------------------------------------------------------------
-- Suppression, TRUNCATE
--
-- Le premier refuse une ligne dont le statut n'est pas ouvert. Le second refuse
-- tout : TRUNCATE ne produit aucune ligne, le garde de ligne ne le voit pas
-- passer (même raison qu'en E1-04 et E3-01). Sa phrase est la sienne.
-- ----------------------------------------------------------------------------

create function merx.reject_frozen_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reg    merx.frozen_registry%rowtype;
  status text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  status := pg_catalog.to_jsonb(old) ->> reg.status_column;

  if status <> reg.open_status then
    raise exception
      'Un enregistrement de % au statut « % » ne se supprime pas (RÈGLE M3-3) : '
      'seul le statut « % » peut l''être. Un document confirmé s''annule.',
      tg_table_name, status, reg.open_status
      using errcode = '55006';
  end if;

  return old;
end;
$function$;

comment on function merx.reject_frozen_delete() is
  'Trigger BEFORE DELETE : seule une ligne au statut ouvert se supprime. '
  'RÈGLE M3-3, E4-01.';

create function merx.reject_frozen_truncate()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception
    '% ne se vide pas d''un coup : ses lignes figées ne se suppriment jamais '
    '(RÈGLE M3-3).', tg_table_name
    using errcode = '55006';
end;
$function$;

comment on function merx.reject_frozen_truncate() is
  'Trigger BEFORE TRUNCATE : TRUNCATE ne déclenche aucun trigger de ligne, '
  'donc échapperait aux gardes de suppression. E4-01.';


-- ----------------------------------------------------------------------------
-- L'enfant
--
-- `security invoker`, donc la RLS gouverne la lecture du parent. Deux
-- conséquences voulues :
--
--   — un parent qu'on ne voit pas — celui d'un autre commerce — ne se lit pas,
--     le garde laisse passer, et c'est la RLS puis la clé composite qui
--     refusent. Un refus d'ici masquerait `tenant_isolation` (la leçon d'E3-01 :
--     un garde BEFORE qui refuse avant la policy fait passer son test à sa
--     place) ;
--   — un parent déjà supprimé, comme pendant la cascade d'un brouillon, ne se
--     lit pas non plus : la suppression des lignes d'un brouillon passe.
--
-- `for share` : une confirmation concurrente attend la fin de l'écriture de la
-- ligne au lieu de la croiser. Sans lui, une ligne pourrait entrer sous un
-- document que l'autre transaction vient de confirmer.
--
-- Configuration en arguments : (parent, colonne de clé, colonne de statut du
-- parent, statut ouvert). L'invoker ne peut pas lire le registre.
-- ----------------------------------------------------------------------------

create function merx.reject_frozen_child_write()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  parent_table  text := tg_argv[0];
  parent_column text := tg_argv[1];
  status_column text := tg_argv[2];
  open_status   text := tg_argv[3];
  parent_id     uuid;
  status        text;
begin
  for parent_id in
    select distinct v
    from (
      select case when tg_op <> 'INSERT'
                  then (pg_catalog.to_jsonb(old) ->> parent_column)::uuid end as v
      union all
      select case when tg_op <> 'DELETE'
                  then (pg_catalog.to_jsonb(new) ->> parent_column)::uuid end
    ) s
    where v is not null
  loop
    execute pg_catalog.format(
      'select %I::text from public.%I where tenant_id = $1 and id = $2 for share',
      status_column, parent_table)
      into status
      using coalesce(
        case when tg_op <> 'INSERT' then (pg_catalog.to_jsonb(old) ->> 'tenant_id')::uuid end,
        (pg_catalog.to_jsonb(new) ->> 'tenant_id')::uuid),
        parent_id;

    if status is not null and status <> open_status then
      raise exception
        'Les lignes de % ne se modifient plus : son document est au statut « % » '
        '(RÈGLE M3-3). Seul un brouillon reçoit, change ou perd des lignes.',
        tg_table_name, status
        using errcode = '55006';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

comment on function merx.reject_frozen_child_write() is
  'Trigger BEFORE INSERT OR UPDATE OR DELETE sur l''enfant d''une table '
  'figée : refuse si le parent n''est plus au statut ouvert. Invoker : la RLS '
  's''applique à la lecture du parent. RÈGLE M3-3, E4-01.';


-- ----------------------------------------------------------------------------
-- Les helpers
--
-- Chacun valide ce qu'il reçoit : un statut qui n'est pas une étiquette de
-- l'enum, ou une colonne qui n'existe pas, se lirait comme une table figée
-- qui ne gèle rien, en silence, pour toujours (même raison que la colonne
-- auditée inconnue d'E2-03).
-- ----------------------------------------------------------------------------

create function merx.apply_frozen_when(
  target        regclass,
  status_column text,
  open_status   text
)
returns void
language plpgsql
as $function$
declare
  table_name text;
  type_oid   oid;
begin
  select c.relname into table_name from pg_class c where c.oid = target;

  select a.atttypid into type_oid
  from pg_attribute a
  where a.attrelid = target and a.attname = status_column
    and a.attnum > 0 and not a.attisdropped;

  if type_oid is null then
    raise exception 'Colonne de statut inconnue sur % : %', table_name, status_column;
  end if;

  if not exists (
    select 1 from pg_enum e where e.enumtypid = type_oid and e.enumlabel = open_status
  ) then
    raise exception
      'Statut ouvert inconnu : « % » n''est pas une étiquette du type de %.%.',
      open_status, table_name, status_column;
  end if;

  -- TRUNCATE seul : les gardes de ligne ne le voient pas passer, et le
  -- privilège est la première porte.
  execute format('revoke truncate on %s from authenticated', target);

  execute format(
    'create trigger reject_frozen_birth before insert on %s'
    ' for each row execute function merx.reject_frozen_birth()', target);
  execute format(
    'create trigger reject_frozen_update before update on %s'
    ' for each row execute function merx.reject_frozen_update()', target);
  execute format(
    'create trigger reject_frozen_delete before delete on %s'
    ' for each row execute function merx.reject_frozen_delete()', target);
  execute format(
    'create trigger reject_frozen_truncate before truncate on %s'
    ' for each statement execute function merx.reject_frozen_truncate()', target);

  insert into merx.frozen_registry (table_name, kind, status_column, open_status)
  values (table_name, 'root', status_column, open_status);
end;
$function$;

comment on function merx.apply_frozen_when(regclass, text, text) is
  'Fige une table à partir de son statut : quatre gardes (naissance, mise à '
  'jour, suppression, TRUNCATE), TRUNCATE retiré à authenticated, inscription '
  'au registre. Les transitions se déclarent par merx.allow_frozen_transition(). '
  'RÈGLE M3-3, E4-01.';

create function merx.allow_frozen_transition(
  target          regclass,
  from_status     text,
  to_status       text,
  mutable_columns text[] default '{}'
)
returns void
language plpgsql
as $function$
declare
  tbl        text;
  reg        merx.frozen_registry%rowtype;
  type_oid   oid;
  label      text;
  col        text;
begin
  select c.relname into tbl from pg_class c where c.oid = target;
  select * into reg from merx.frozen_registry r where r.table_name = tbl;

  if reg.kind is distinct from 'root' then
    raise exception '% n''est pas une table figée par son statut (merx.apply_frozen_when).', tbl;
  end if;

  select a.atttypid into type_oid
  from pg_attribute a where a.attrelid = target and a.attname = reg.status_column;

  foreach label in array array[from_status, to_status] loop
    if not exists (select 1 from pg_enum e where e.enumtypid = type_oid and e.enumlabel = label) then
      raise exception 'Statut inconnu : « % » n''est pas une étiquette du type de %.%.',
        label, tbl, reg.status_column;
    end if;
  end loop;

  foreach col in array mutable_columns loop
    if not exists (
      select 1 from pg_attribute a
      where a.attrelid = target and a.attname = col and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception 'Colonne inconnue sur % : %', tbl, col;
    end if;
  end loop;

  insert into merx.frozen_transition (table_name, from_status, to_status, mutable_columns)
  values (tbl, from_status, to_status, mutable_columns);
end;
$function$;

comment on function merx.allow_frozen_transition(regclass, text, text, text[]) is
  'Déclare un changement de statut admis sur une table figée, et les colonnes '
  'qu''il a le droit de changer en plus du statut. RÈGLE M3-3, E4-01.';

create function merx.apply_frozen_child(
  target        regclass,
  parent        regclass,
  parent_column text
)
returns void
language plpgsql
as $function$
declare
  table_name  text;
  parent_name text;
  reg         merx.frozen_registry%rowtype;
begin
  select c.relname into table_name  from pg_class c where c.oid = target;
  select c.relname into parent_name from pg_class c where c.oid = parent;
  select * into reg from merx.frozen_registry r where r.table_name = parent_name;

  if reg.kind is distinct from 'root' then
    raise exception
      '% n''est pas une table figée par son statut : son enfant ne peut pas la suivre.',
      parent_name;
  end if;

  if not exists (
    select 1 from pg_attribute a
    where a.attrelid = target and a.attname = parent_column
      and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'Colonne de clé inconnue sur % : %', table_name, parent_column;
  end if;

  execute format('revoke truncate on %s from authenticated', target);

  execute format(
    'create trigger reject_frozen_child_write before insert or update or delete on %s'
    ' for each row execute function merx.reject_frozen_child_write(%L, %L, %L, %L)',
    target, parent_name, parent_column, reg.status_column, reg.open_status);

  execute format(
    'create trigger reject_frozen_truncate before truncate on %s'
    ' for each statement execute function merx.reject_frozen_truncate()', target);

  insert into merx.frozen_registry (table_name, kind, parent_table, parent_column)
  values (table_name, 'child', parent_name, parent_column);
end;
$function$;

comment on function merx.apply_frozen_child(regclass, regclass, text) is
  'Fige les lignes d''une table avec leur parent : écriture refusée quand le '
  'parent n''est plus au statut ouvert. RÈGLE M3-3, E4-01.';


-- ============================================================================
-- Les types fermés du § 8
-- ============================================================================

create type public.sale_doc_type as enum (
  'quote',          -- devis
  'order',          -- commande
  'delivery_note'   -- bon de livraison : le document par défaut, RÈGLE M3-1
);

comment on type public.sale_doc_type is
  'Les trois types de document de vente. Aucune facture fiscale en V1 — '
  'RÈGLE M3-1. SPEC § 8.';

-- `draft` en premier : `supabase/tests/isolation.ts` prend la première
-- étiquette pour peupler une colonne enum, et une ligne de peuplement doit
-- être un brouillon — la seule chose qu'une ligne ordinaire puisse être.
create type public.sale_doc_status as enum (
  'draft',
  'confirmed',
  'delivered',
  'cancelled'
);

comment on type public.sale_doc_status is
  'Le cycle d''un document : draft (libre), puis confirmed, delivered, '
  'cancelled — contenu figé, statut qui avance. RÈGLE M3-3. SPEC § 8.';

create type public.price_source as enum (
  'auto',    -- résolu depuis la grille de prix (E4-04)
  'manual'   -- forcé à la ligne, tracé (RÈGLE M8-1)
);

comment on type public.price_source is
  'D''où vient le prix d''une ligne de vente. SPEC § 8.';


-- ============================================================================
-- public.sale_document
--
-- Les colonnes du § 8, moins `client_id` (voir l'en-tête). Les conventions
-- apportent `id`, `tenant_id` et son défaut, `created_at`, `updated_at`,
-- `created_by`, `device_id`, la RLS et ses deux policies.
--
-- Conventions **métier** : un document n'a pas de `deleted_at`. SPEC § 4 —
-- « documents et mouvements jamais supprimés, seulement annulés » ; la seule
-- suppression admise est celle d'un brouillon (SPEC § 4, corrigé en E4-01).
--
-- `doc_number` et `issued_at` sont nuls : un brouillon n'a ni numéro (attribué
-- à la confirmation, RÈGLE M3-2) ni date d'émission.
--
-- `warehouse_id` pointe sur l'unique dépôt du commerce (SPEC § 2.4) ; l'écran
-- le lit comme il lit celui des mouvements, il ne le choisit pas.
-- ============================================================================

create table public.sale_document (
  id                  uuid                  primary key default gen_random_uuid(),
  doc_type            public.sale_doc_type  not null,
  doc_number          text,
  warehouse_id        uuid                  not null,
  status              public.sale_doc_status not null default 'draft',
  subtotal            public.money_amount   not null default 0,
  discount_total      public.money_amount   not null default 0,
  total               public.money_amount   not null default 0,
  notes               text,
  issued_at           timestamptz,
  cancellation_reason text,

  constraint sale_document_amounts_not_negative
    check (subtotal >= 0 and discount_total >= 0 and total >= 0),

  -- Le motif est le contenu de l'acte d'annuler, comme celui d'un ajustement
  -- (E3-03) : sans lui une annulation par l'API serait anonyme. En base, pas
  -- seulement à l'écran. § 2.6 ne s'y applique pas — elle vise les
  -- formulaires de création d'entités de référence.
  constraint sale_document_cancellation_reason
    check (status <> 'cancelled' or btrim(coalesce(cancellation_reason, '')) <> '')
);

select merx.apply_business_conventions('public.sale_document');

comment on table public.sale_document is
  'Devis, commande ou bon de livraison. Libre tant que brouillon ; une fois '
  'confirmé, le contenu est figé et seul le statut avance. SPEC § 8, '
  'RÈGLES M3-1, M3-3 ; E4-01.';

comment on column public.sale_document.doc_number is
  'Nul tant que brouillon. Attribué localement à la confirmation — RÈGLE M3-2, '
  'E4-02. Aucune unicité avant que E4-02 ait tranché le format.';

comment on column public.sale_document.cancellation_reason is
  'Le motif de l''annulation, obligatoire dès que le statut est cancelled — '
  'contrainte sale_document_cancellation_reason. Retenu par le journal d''audit '
  '(document_cancellation). E4-01.';

-- Le jeton ne porte pas l'identifiant `app_user` : l'écran ne peut pas remplir
-- `created_by` lui-même. Même arbitrage qu'en E3-03 pour les mouvements.
alter table public.sale_document
  alter column created_by set default merx.current_app_user();

alter table public.sale_document
  add constraint sale_document_tenant_id_id_key unique (tenant_id, id);

alter table public.sale_document
  add constraint sale_document_warehouse_id_fkey
  foreign key (tenant_id, warehouse_id) references public.warehouse (tenant_id, id);


-- ============================================================================
-- public.sale_line
--
-- **`variant_id`, jamais `product_id`** — SPEC § 2.3. Clé composite sans
-- cascade : une variante vendue ne se supprime pas. La clé vers le document
-- cascade, parce que la suppression d'un brouillon emporte ses lignes — et que
-- seul un brouillon se supprime.
--
-- `quantity > 0` : une ligne de vente vend ; un retour est une autre table
-- (E4-06). Les montants ne sont pas négatifs — aucune contrainte de cohérence
-- entre eux, voir l'en-tête.
-- ============================================================================

create table public.sale_line (
  id               uuid                primary key default gen_random_uuid(),
  sale_document_id uuid                not null,
  variant_id       uuid                not null,
  quantity         public.quantity     not null,
  unit_price       public.money_amount not null,
  price_source     public.price_source not null default 'auto',
  line_discount    public.money_amount not null default 0,
  line_total       public.money_amount not null,

  constraint sale_line_quantity_positive check (quantity > 0),
  constraint sale_line_amounts_not_negative
    check (unit_price >= 0 and line_discount >= 0 and line_total >= 0)
);

select merx.apply_business_conventions('public.sale_line');

comment on table public.sale_line is
  'Une ligne de vente. Pointe sur une variante, jamais sur un produit — SPEC '
  '§ 2.3. Figée avec son document : seul un brouillon reçoit, change ou perd '
  'des lignes. RÈGLE M3-3 ; E4-01.';

alter table public.sale_line
  alter column created_by set default merx.current_app_user();

alter table public.sale_line
  add constraint sale_line_sale_document_id_fkey
  foreign key (tenant_id, sale_document_id)
  references public.sale_document (tenant_id, id) on delete cascade;

alter table public.sale_line
  add constraint sale_line_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id);

-- Lire les lignes d'un document, et laisser la cascade et le garde les trouver.
create index sale_line_document on public.sale_line (tenant_id, sale_document_id);


-- ============================================================================
-- public.document_sequence
--
-- Le compteur de la numérotation locale (RÈGLE M3-2) : une ligne par
-- `(commerce, appareil, type, année)`. **Aucune fonction, aucun trigger** : le
-- serveur n'attribue rien, et l'attribution à la confirmation est E4-02.
-- Cette story pose la table et son unicité, rien d'autre.
--
-- `device_id` est ici la clé de la séquence et non seulement l'appareil qui a
-- écrit la ligne : il passe NOT NULL, sans quoi l'unicité laisserait passer
-- autant de doublons que de lignes nulles. Et il porte une clé composite vers
-- `device` — un compteur d'appareil inexistant n'a pas de sens.
-- ============================================================================

create table public.document_sequence (
  id          uuid                 primary key default gen_random_uuid(),
  doc_type    public.sale_doc_type not null,
  year        smallint             not null check (year > 0),
  last_number integer              not null default 0 check (last_number >= 0)
);

select merx.apply_business_conventions('public.document_sequence');

comment on table public.document_sequence is
  'Dernier numéro attribué par (commerce, appareil, type, année). Écrit par '
  'l''appareil, jamais par le serveur — RÈGLE M3-2. SPEC § 8 ; table posée en '
  'E4-01, attribution en E4-02.';

alter table public.document_sequence
  alter column device_id set not null;

alter table public.device
  add constraint device_tenant_id_id_key unique (tenant_id, id);

alter table public.document_sequence
  add constraint document_sequence_device_id_fkey
  foreign key (tenant_id, device_id) references public.device (tenant_id, id);

create unique index document_sequence_per_device_type_year
  on public.document_sequence (tenant_id, device_id, doc_type, year);


-- ============================================================================
-- RÈGLE M3-3 — le branchement
--
-- Les transitions admises, en données. `draft → confirmed` est libre pour la
-- ligne entière (le brouillon reçoit son numéro, sa date, ses totaux à ce
-- moment) ; les autres ne changent que le statut, plus le motif quand la cible
-- est `cancelled`. `cancelled` est terminal : aucune transition n'en part.
-- Pas de `draft → delivered` ni de `draft → cancelled` : un brouillon se
-- supprime, il ne s'annule pas.
-- ============================================================================

select merx.apply_frozen_when('public.sale_document', 'status', 'draft');

select merx.allow_frozen_transition('public.sale_document', 'draft',     'confirmed');
select merx.allow_frozen_transition('public.sale_document', 'confirmed',  'delivered');
select merx.allow_frozen_transition('public.sale_document', 'confirmed',  'cancelled',
                                    array['cancellation_reason']);
select merx.allow_frozen_transition('public.sale_document', 'delivered',  'cancelled',
                                    array['cancellation_reason']);

select merx.apply_frozen_child('public.sale_line', 'public.sale_document', 'sale_document_id');


-- ============================================================================
-- L'annulation
--
-- Deux triggers sur la transition vers `cancelled`, chacun avec son refus :
--
--   1. `require_cancel_capability` — BEFORE. Le droit d'annuler est la
--      capacité `cancel_document` de la matrice § 3.1, lue par `merx.can()`
--      (SPEC § 3, RÈGLE un seul helper). Il est vérifié **sur la transition
--      elle-même**, et pas seulement par le type de mouvement qu'elle écrit :
--      un devis n'a aucun mouvement `sale` à inverser, et sans ce garde un
--      employé l'annulerait sans qu'aucune policy de mouvement ait à se
--      prononcer.
--
--   2. `reverse_sale_movements` — AFTER. Le mouvement inverse de chaque
--      mouvement `sale` du document : même variante, même dépôt, même
--      document, quantité opposée. On inverse les mouvements **écrits**, pas
--      un recalcul depuis les lignes — c'est l'inverse de ce qui a bougé.
--      `security invoker` : l'insertion passe par `column_capability_insert`
--      et par `require_open_movement_type` comme toute autre ; elle n'est pas
--      une exception à la RLS (§ 2.1) et ne s'inscrit à aucun registre.
--      Une annulation qui ne peut pas écrire ses mouvements échoue entière.
--
-- `cancelled` est terminal (aucune transition n'en part), donc un document ne
-- s'inverse qu'une fois.
-- ============================================================================

create function merx.require_cancel_capability()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not merx.can('cancel_document') then
    raise exception
      'Annuler un document exige la capacité cancel_document, réservée au patron.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

comment on function merx.require_cancel_capability() is
  'Trigger BEFORE UPDATE sur la transition vers cancelled : exige '
  'cancel_document, par merx.can(). SPEC § 3.1 ; E4-01.';

create trigger require_cancel_capability
  before update on public.sale_document
  for each row
  when (old.status is distinct from new.status and new.status = 'cancelled')
  execute function merx.require_cancel_capability();

create function merx.reverse_sale_movements()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.stock_movement (
    tenant_id, variant_id, warehouse_id, movement_type, quantity,
    source_type, source_id, note
  )
  select m.tenant_id, m.variant_id, m.warehouse_id,
         'sale_cancellation'::public.stock_movement_type,
         - m.quantity,
         m.source_type, m.source_id,
         'Annulation de ' || coalesce(new.doc_number, 'ce document')
           || ' : ' || new.cancellation_reason
  from public.stock_movement m
  where m.tenant_id = new.tenant_id
    and m.source_type = 'sale_document'
    and m.source_id = new.id
    and m.movement_type = 'sale';

  return null;
end;
$function$;

comment on function merx.reverse_sale_movements() is
  'Trigger AFTER UPDATE sur la transition vers cancelled : écrit l''inverse de '
  'chaque mouvement sale du document. Invoker — la RLS et la capacité du type '
  's''appliquent. RÈGLE M3-3, E4-01.';

create trigger reverse_sale_movements
  after update on public.sale_document
  for each row
  when (old.status is distinct from new.status and new.status = 'cancelled')
  execute function merx.reverse_sale_movements();

-- ----------------------------------------------------------------------------
-- Le mouvement d'annulation ne s'écrit pas à la main
--
-- Le type est ouvert au patron, et c'est assez pour la porte : mais une porte
-- ouverte à `cancel_document` laisserait le patron poster un `sale_cancellation`
-- de n'importe quelle quantité, sans document, sans motif — et, contrairement à
-- l'`adjustment`, **sans entrée de journal** (RÈGLE M8-1 n'audite que
-- l'ajustement et l'annulation). Un second chemin vers une correction de stock
-- silencieuse, ce que la trace d'E3-03 existe pour empêcher.
--
-- Même mécanisme que `merx.reject_derived_write()` (E3-01), pour la même
-- raison : `pg_trigger_depth()` vaut 1 pour une insertion directe — PostgREST,
-- `psql` — et 2 pour celle que fait `reverse_sale_movements()`. La profondeur
-- ne se forge pas depuis une requête, un drapeau de session si.
--
-- AFTER, et pas BEFORE : la RLS d'une insertion est vérifiée entre les deux, et
-- un garde BEFORE refuserait avant elle, ce qui ferait passer le test de la
-- policy sur son refus à lui (E3-01). `42501` comme la policy, phrase propre :
-- c'est la phrase que les tests assertent.
-- ----------------------------------------------------------------------------

create function merx.require_cancellation_origin()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception
      'Un mouvement de type sale_cancellation ne s''écrit pas à la main : il naît de '
      'l''annulation de son document.'
      using errcode = '42501',
            hint = 'Passer le statut du document à cancelled, avec un motif.';
  end if;

  return null;
end;
$function$;

comment on function merx.require_cancellation_origin() is
  'Trigger AFTER INSERT sur un mouvement sale_cancellation : refuse toute '
  'insertion directe. Sans lui, le patron corrigerait un stock sans entrée de '
  'journal. pg_trigger_depth(), comme merx.reject_derived_write(). E4-01.';

create trigger require_cancellation_origin
  after insert on public.stock_movement
  for each row
  when (new.movement_type = 'sale_cancellation')
  execute function merx.require_cancellation_origin();

-- Retrouver les mouvements d'un document sans lire ceux de tout le commerce.
create index stock_movement_source
  on public.stock_movement (tenant_id, source_id)
  where source_id is not null;


-- ----------------------------------------------------------------------------
-- Le type de mouvement ouvert : `sale_cancellation`, sur `cancel_document`
--
-- Après la capacité, qui existe depuis E1 : `merx.require_known_capability()`
-- refuse en `23503` une capacité absente de la matrice. Aucune capacité n'est
-- ajoutée — `cancel_document` est à § 3.1 depuis le début —, donc les quatre
-- copies de la matrice ne bougent pas.
--
-- `sale`, `return`, `receipt` et `inventory` restent fermés (RÈGLE M2-5).
-- ----------------------------------------------------------------------------

insert into merx.movement_type_capability (movement_type, capability) values
  ('sale_cancellation', 'cancel_document');


-- ============================================================================
-- RÈGLE M8-1 — l'annulation est tracée
--
-- `merx.apply_audit()` d'E3-03 refusait une condition de ligne sur une table qui
-- n'est pas en ajout seul : ses événements se dérivaient du seul registre
-- d'ajout seul, et un `when (new....)` ne se pose pas sur un trigger DELETE.
-- `sale_document` n'est pas en ajout seul, et ne doit journaliser que la
-- transition vers `cancelled` — ni la création d'un brouillon, ni sa
-- confirmation, ni sa livraison.
--
-- Le helper gagne donc **des événements explicites**. `drop` puis `create`, et
-- non un `create or replace` : la signature change, et un `replace` laisserait
-- une surcharge à quatre paramètres derrière lui. Le corps est celui de la
-- dernière migration qui touche la fonction (`20261013130000`, E3-03), augmenté
-- et non réécrit (CLAUDE.md, un `create or replace` part de la dernière
-- définition).
--
-- Règle des événements :
--   — non donnés : dérivés du registre d'ajout seul, comme avant ;
--   — donnés : validés (`insert`, `update`, `delete`), et refusés en ajout seul
--     s'ils nomment autre chose que `insert` — un trigger mort-né ;
--   — une condition de ligne exige que `delete` n'en fasse pas partie.
--
-- Le registre retient les événements posés, que `conventions.ts` compare au
-- trigger réel.
-- ============================================================================

alter table merx.audited_registry
  add column events text;

update merx.audited_registry r
set events = case
  when exists (select 1 from merx.append_only_registry a where a.table_name = r.table_name)
  then 'insert'
  else 'insert or update or delete'
end;

alter table merx.audited_registry
  alter column events set not null;

comment on column merx.audited_registry.events is
  'Les événements du trigger d''audit tels que le helper les a posés, dans '
  'l''ordre insert, update, delete. Dérivés du registre d''ajout seul quand le '
  'helper n''en reçoit pas. conventions.ts les compare au trigger réel. E4-01.';

drop function merx.apply_audit(regclass, public.audit_action, text[], text);

create function merx.apply_audit(
  target          regclass,
  audited_action  public.audit_action,
  audited_columns text[],
  row_condition   text   default null,
  only_events     text[] default null
)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  audited_table text;
  unknown       text;
  arguments     text;
  append_only   boolean;
  events        text;
  posed         text;
begin
  select c.relname into audited_table from pg_catalog.pg_class c where c.oid = target;

  select pg_catalog.string_agg(col, ', ') into unknown
  from pg_catalog.unnest(audited_columns) as col
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = target and a.attname = col and a.attnum > 0 and not a.attisdropped
  );

  if unknown is not null then
    raise exception 'Colonne auditée inconnue sur % : %', audited_table, unknown;
  end if;

  select pg_catalog.string_agg(pg_catalog.quote_literal(arg), ', ' order by ord)
    into arguments
  from pg_catalog.unnest(array[audited_action::text] || audited_columns)
    with ordinality as t(arg, ord);

  select exists (
    select 1 from merx.append_only_registry r where r.table_name = audited_table
  ) into append_only;

  if only_events is null then
    -- Les événements, dérivés du registre d'ajout seul. Une table dont les
    -- lignes ne peuvent ni changer ni disparaître n'a qu'une écriture à
    -- journaliser.
    events := case when append_only then 'insert' else 'insert or update or delete' end;
  else
    if pg_catalog.cardinality(only_events) = 0 or exists (
      select 1 from pg_catalog.unnest(only_events) as e
      where e not in ('insert', 'update', 'delete')
    ) then
      raise exception
        'Événements d''audit inconnus sur % : attendu insert, update, delete.', audited_table;
    end if;

    if append_only and exists (
      select 1 from pg_catalog.unnest(only_events) as e where e <> 'insert'
    ) then
      raise exception
        '% est en ajout seul : un trigger d''audit UPDATE ou DELETE y serait mort-né.',
        audited_table;
    end if;

    select pg_catalog.string_agg(e, ' or ' order by
             case e when 'insert' then 1 when 'update' then 2 else 3 end)
      into events
    from (select distinct e from pg_catalog.unnest(only_events) as e) as s;
  end if;

  if row_condition is not null and events like '%delete%' then
    raise exception
      'Condition de ligne sur %, dont les événements incluent delete : le when '
      'porterait sur new, que Postgres ne définit pas pour un trigger DELETE. '
      'Donner des événements explicites sans delete.', audited_table;
  end if;

  execute pg_catalog.format(
    'create trigger audit_row_change after %s on %s for each row %s'
    ' execute function merx.audit_row_change(%s)',
    events, target,
    case when row_condition is null then ''
         else pg_catalog.format('when (%s)', row_condition) end,
    arguments);

  -- La condition est relue du catalogue, sous la forme que Postgres lui donne :
  -- c'est elle que `conventions.ts` comparera au trigger, et une forme recopiée
  -- à la main aurait divergé du premier coup.
  select (pg_catalog.regexp_match(
            pg_catalog.pg_get_triggerdef(tg.oid), 'WHEN \((.*)\) EXECUTE'))[1]
    into posed
  from pg_catalog.pg_trigger tg
  where tg.tgrelid = target and tg.tgname = 'audit_row_change';

  insert into merx.audited_registry (table_name, action, columns, row_condition, events)
  values (audited_table, audited_action, audited_columns, posed, events);
end;
$function$;

comment on function merx.apply_audit(regclass, public.audit_action, text[], text, text[]) is
  'Journalise les écritures d''une table sous une étiquette de la RÈGLE M8-1 : '
  'trigger merx.audit_row_change(), inscription à merx.audited_registry. '
  'Événements dérivés de merx.append_only_registry, ou explicites ; '
  'row_condition restreint la journalisation à une partie des lignes. Addendum '
  'E2-03, condition de ligne E3-03, événements explicites E4-01 ; servira à '
  'goods_receipt_line_cost en E8-03.';

-- Le commentaire de l'enum disait « arrivent avec leurs modules » : celle-ci
-- arrive avec le sien.
comment on type public.audit_action is
  'Les sept actions qui écrivent obligatoirement dans audit_log. SPEC § 9, '
  'RÈGLE M8-1. purchase_price_change est branchée en E2-03, stock_adjustment '
  'en E3-03, document_cancellation en E4-01 ; les autres arrivent avec leurs '
  'modules.';

-- L'entrée retient ce qu'un patron relit le jour d'un litige : le type, le
-- numéro, le total, et le motif. L'état avant (confirmed ou delivered) et après
-- (cancelled) est dans `status`.
select merx.apply_audit(
  'public.sale_document', 'document_cancellation',
  array['doc_type', 'doc_number', 'status', 'total', 'cancellation_reason'],
  $$old.status is distinct from new.status and new.status = 'cancelled'$$,
  array['update']);
