-- ============================================================================
-- Merx — le modèle produit / variante
--
-- Référence : docs/SPEC.md § 2.3 (RÈGLES product/variant), § 2.5 (hors-ligne),
--             § 3 + § 3.1 (RÈGLE de placement des coûts, `manage_product`,
--             `manage_price_list`), § 4 (conventions, RÈGLE des clés
--             étrangères composites), § 6 M1 (entités, RÈGLE M1-1),
--             docs/BACKLOG.md E2-01.
--
-- La décision la plus structurante du schéma, et elle tient en une phrase :
-- **le stock, les prix et les lignes de vente pointent sur une variante, jamais
-- sur un produit** (SPEC § 2.3). Tout produit en a donc toujours une, y compris
-- sans le pack de déclinaisons. Sans cela, le jour où un commerce veut vendre
-- une teinte ou une contenance, il faut migrer son stock et tout son
-- historique — en production, chez lui.
--
-- Ce fichier livre quatre tables et les gardes qui rendent la règle
-- structurelle plutôt que conventionnelle :
--
--   1. la variante par défaut, créée par la base à la création du produit ;
--   2. aucune suppression ne laisse un produit sans variante, et une variante
--      ne change jamais de produit ;
--   3. aucune autre table ne référence `product` — contrôlé par
--      `supabase/tests/conventions.ts`, pour E3, E4 et E8 qui ne sont pas
--      écrits ;
--   4. aucune référence ne franchit la frontière entre deux commerces : toute
--      clé étrangère entre tables métier est composite sur `tenant_id` (SPEC
--      § 4, RÈGLE posée avec cette story). Les clés existantes — `created_by`
--      partout, `audit_log.user_id` — y sont ramenées ici.
--
-- Rien de E2-02 à E2-06 n'est construit : pas de ligne `min_qty = 1` par
-- défaut ni de résolution de prix (E2-03), pas de `variant_cost` (E2-03 —
-- `variant` ne porte simplement pas de `cost_price`, et le balayage de
-- conventions refuserait qu'on l'y pose), pas d'unicité de `barcode` (E2-06),
-- pas d'index de recherche (E2-04).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- La RÈGLE des clés étrangères composites
--
-- Une clé étrangère ne passe pas par la RLS. Postgres vérifie l'existence de la
-- ligne cible sous le propriétaire de la table, sans policy : un commerce qui
-- connaît l'identifiant d'une ligne du voisin peut y rattacher les siennes.
-- Les conséquences ne sont pas théoriques :
--
--   — une cascade chez le voisin détruit les données du commerce : B supprime
--     son produit, et la variante que A y avait rattachée part avec ;
--   — une clé sans cascade bloque le voisin : B ne peut plus supprimer sa
--     ligne, parce que A la référence, et il ne peut pas voir pourquoi ;
--   — la réussite ou l'échec de l'insertion dit à A si un identifiant existe
--     chez quelqu'un d'autre.
--
-- La parade est structurelle : la clé porte `tenant_id` des deux côtés,
-- `(tenant_id, x) references t (tenant_id, id)`. La ligne cible doit alors
-- appartenir au même commerce que la ligne qui la vise, et ce n'est plus une
-- vérification qu'on peut oublier — c'est la contrainte elle-même.
--
-- Seule exception, par nature : `tenant_id → tenant (id)`, qui est l'ancre du
-- commerce. `supabase/tests/conventions.ts` refuse toute autre clé étrangère
-- entre tables de `public` qui ne porte pas `tenant_id` à la même position des
-- deux côtés.
--
-- Une clé composite exige une unicité sur `(tenant_id, id)` côté cible. Elle
-- est redondante avec la clé primaire, et c'est son seul rôle : servir de cible.
-- ----------------------------------------------------------------------------

alter table public.app_user
  add constraint app_user_tenant_id_id_key unique (tenant_id, id);


-- `created_by`, pour les tables à venir. La fonction est reprise de E0-03 à
-- l'identique, à la clé étrangère de `created_by` près.
--
-- `match simple`, le défaut : une clé dont une colonne est nulle n'est pas
-- vérifiée. `created_by` reste donc facultatif (une ligne née d'une migration
-- ou d'un import n'a pas d'auteur), et `tenant_id`, lui, n'est jamais nul.
create or replace function merx.apply_business_conventions(target regclass)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  execute format($ddl$
    alter table %s
      add column tenant_id  uuid        not null,
      add column created_at timestamptz not null default now(),
      add column updated_at timestamptz not null default now(),
      add column created_by uuid,
      add column device_id  uuid
  $ddl$, target);

  execute format(
    'create index on %s (tenant_id)',
    target);

  execute format(
    'create trigger set_updated_at before update on %s'
    ' for each row execute function merx.set_updated_at()',
    target);

  select c.relname into table_name from pg_class c where c.oid = target;

  execute format(
    'alter table %s add constraint %I foreign key (tenant_id)'
    ' references public.tenant (id)',
    target, table_name || '_tenant_id_fkey');

  -- SPEC § 4, RÈGLE des clés étrangères composites : l'auteur appartient au
  -- commerce de la ligne. Sans `tenant_id` dans la clé, A signerait ses lignes
  -- du nom d'un employé de B — et B ne pourrait plus supprimer cet employé.
  execute format(
    'alter table %s add constraint %I foreign key (tenant_id, created_by)'
    ' references public.app_user (tenant_id, id)',
    target, table_name || '_created_by_fkey');

  perform merx.apply_tenant_isolation(target);

  insert into merx.convention_registry (table_name, kind)
  values (table_name, 'business');
end;
$function$;

comment on function merx.apply_business_conventions(regclass) is
  'Colonnes standard, index tenant, trigger updated_at, clés étrangères — '
  'composites sur tenant_id — et isolation RLS. SPEC § 4, § 2.1.';


-- `created_by`, pour les tables existantes. Le registre de conventions les
-- énumère toutes : aucune n'est oubliée, et aucune n'est nommée ici.
do $migration$
declare
  t text;
begin
  for t in select table_name from merx.convention_registry order by table_name loop
    execute format('alter table public.%I drop constraint %I', t, t || '_created_by_fkey');
    execute format(
      'alter table public.%I add constraint %I foreign key (tenant_id, created_by)'
      ' references public.app_user (tenant_id, id)',
      t, t || '_created_by_fkey');
  end loop;
end;
$migration$;


-- `audit_log.user_id` (E1-04). `merx.log_audit()` prend déjà l'auteur et le
-- commerce dans le même jeton ; la clé le garantit désormais pour toute ligne,
-- quel que soit le chemin qui l'écrit.
alter table public.audit_log drop constraint audit_log_user_id_fkey;

alter table public.audit_log
  add constraint audit_log_user_id_fkey
  foreign key (tenant_id, user_id) references public.app_user (tenant_id, id);


-- ----------------------------------------------------------------------------
-- `category`
--
-- SPEC § 6 : `name_fr, name_ar, parent_id, sort_order`. Le nom français est le
-- seul obligatoire, comme pour le produit (SPEC § 2.6).
--
-- Supprimer une catégorie ne supprime rien d'autre : ses produits et ses
-- sous-catégories perdent leur rattachement, ils ne disparaissent pas.
-- `set null (parent_id)` et non `set null` tout court — sur une clé composite,
-- ce dernier annulerait aussi `tenant_id`, qui est NOT NULL.
-- ----------------------------------------------------------------------------

create table public.category (
  id         uuid    primary key default gen_random_uuid(),
  name_fr    text    not null,
  name_ar    text,
  parent_id  uuid,
  sort_order integer not null default 0
);

select merx.apply_reference_conventions('public.category');

comment on table public.category is
  'Catégorie de produits, arborescente. SPEC § 6 M1.';

alter table public.category
  add constraint category_tenant_id_id_key unique (tenant_id, id);

alter table public.category
  add constraint category_parent_id_fkey
  foreign key (tenant_id, parent_id) references public.category (tenant_id, id)
  on delete set null (parent_id);

create index category_parent on public.category (tenant_id, parent_id);


-- ----------------------------------------------------------------------------
-- `product`
--
-- SPEC § 6. Le nom est le seul champ obligatoire (SPEC § 2.6, RÈGLE) : tout le
-- reste est nullable, sans défaut réclamé.
--
-- Le produit ne porte aucun prix, aucun stock, aucun code-barres : ils sont sur
-- la variante (SPEC § 2.3). C'est ce qui permettra au pack de déclinaisons
-- d'exister sans toucher à ce qui est déjà vendu.
-- ----------------------------------------------------------------------------

create table public.product (
  id                uuid    primary key default gen_random_uuid(),
  code              text,
  name_fr           text    not null,
  name_ar           text,
  category_id       uuid,
  brand             text,
  photo_url         text,
  unit_label        text,
  pieces_per_carton integer check (pieces_per_carton > 0),
  is_active         boolean not null default true
);

select merx.apply_reference_conventions('public.product');

comment on table public.product is
  'Produit. Ne porte ni prix, ni stock, ni code-barres : tout cela est sur la '
  'variante, dont il a toujours au moins une. SPEC § 2.3, § 6 M1.';

comment on column public.product.code is
  'Référence interne, saisie libre, facultative. Unique par commerce, sans '
  'égard à la casse ni aux espaces de bord, parmi les produits non supprimés.';

comment on column public.product.pieces_per_carton is
  'Réception et inventaire seulement, jamais à l''écran de vente. SPEC § 6.';

alter table public.product
  add constraint product_tenant_id_id_key unique (tenant_id, id);

alter table public.product
  add constraint product_category_id_fkey
  foreign key (tenant_id, category_id) references public.category (tenant_id, id)
  on delete set null (category_id);

create index product_category on public.product (tenant_id, category_id);

/*
 * L'unicité de la référence.
 *
 * Insensible à la casse : « LOR-12 » et « lor-12 » sont la même référence pour
 * un commerçant, et deux fiches pour un seul produit, c'est deux stocks faux.
 *
 * Parmi les produits non supprimés seulement : un produit supprimé par erreur
 * doit pouvoir être recréé sous sa référence, sans qu'une fiche invisible la
 * tienne en otage. La suppression est douce (SPEC § 4) ; l'historique garde la
 * ligne, il ne garde pas le code réservé.
 */
create unique index product_code_per_tenant
  on public.product (tenant_id, lower(code))
  where deleted_at is null and code is not null;


-- ----------------------------------------------------------------------------
-- Les références saisies : espaces de bord retirés, vide ramené à NULL
--
-- Une référence tapée « 4512 » et une autre « 4512  » sont la même, et une
-- référence vide n'en est pas une : deux produits sans code ne doivent pas se
-- disputer la chaîne vide. La normalisation est faite par la base, une fois,
-- pour tous les chemins — écran, import (E2-05), synchronisation (E9).
--
-- Un trigger et non une contrainte `check` : la contrainte refuserait la
-- saisie, le trigger la corrige. SPEC § 2.6 — l'outil ne réclame rien.
-- ----------------------------------------------------------------------------

create function merx.normalize_product_code()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.code := nullif(pg_catalog.btrim(new.code), '');
  return new;
end;
$function$;

create trigger normalize_code
  before insert or update of code on public.product
  for each row execute function merx.normalize_product_code();


-- ----------------------------------------------------------------------------
-- `variant`
--
-- SPEC § 6. `attributes` vaut `{}` en V1 : aucun pack. `floor_price` est un prix
-- de vente plancher, lisible par tous — ce n'est pas un coût.
--
-- **Aucune colonne de coût.** SPEC § 3, RÈGLE de placement des coûts : le prix
-- d'achat vivra sur `variant_cost` (E2-03), relation restreinte par
-- `view_cost`. Une colonne `cost_price` posée ici sortirait dans la réponse
-- rendue à un employé ; `conventions.test.ts` la refuserait en la nommant.
--
-- `sku` est nullable : il est dérivé du code du produit, et le code est
-- facultatif. La génération d'un SKU pour un produit sans référence appartient
-- à E2-06, qui en a besoin pour l'étiquette Code 128 — générer un code sans
-- serveur suppose une séquence par appareil, que cette story n'a pas.
-- ----------------------------------------------------------------------------

create table public.variant (
  id          uuid    primary key default gen_random_uuid(),
  product_id  uuid    not null,
  sku         text,
  barcode     text,
  attributes  jsonb   not null default '{}'::jsonb,
  floor_price public.money_amount,
  is_default  boolean not null default false,
  is_active   boolean not null default true
);

select merx.apply_reference_conventions('public.variant');

comment on table public.variant is
  'Ce qui se stocke, se prix et se vend. Tout produit en a au moins une ; la '
  'variante par défaut porte l''identifiant de son produit. SPEC § 2.3, § 6.';

comment on column public.variant.floor_price is
  'Prix de vente plancher sous lequel un worker ne peut descendre. Ce n''est '
  'pas un coût : lisible par tous. SPEC § 6, § 3.1.';

alter table public.variant
  add constraint variant_tenant_id_id_key unique (tenant_id, id);

/*
 * `on delete cascade` : un produit supprimé pour de bon emporte ses variantes.
 * La suppression applicative est douce (SPEC § 4) ; ce chemin-ci ne sert qu'à
 * la purge d'un produit qui n'a jamais servi. Dès qu'une variante sera
 * référencée par du stock ou une vente (E3, E4), ces clés-là refuseront, et la
 * cascade s'arrêtera d'elle-même — l'historique ne se purge pas.
 */
alter table public.variant
  add constraint variant_product_id_fkey
  foreign key (tenant_id, product_id) references public.product (tenant_id, id)
  on delete cascade;

create index variant_product on public.variant (tenant_id, product_id);

-- Une variante par défaut au plus par produit. La création en pose une, et une
-- seule (trigger plus bas) ; l'index empêche qu'une seconde s'y ajoute.
create unique index variant_one_default_per_product
  on public.variant (product_id)
  where is_default;

-- Même portée que la référence du produit, dont le SKU dérive : insensible à la
-- casse, parmi les variantes non supprimées.
create unique index variant_sku_per_tenant
  on public.variant (tenant_id, lower(sku))
  where deleted_at is null and sku is not null;

create function merx.normalize_variant_sku()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.sku := nullif(pg_catalog.btrim(new.sku), '');
  return new;
end;
$function$;

create trigger normalize_sku
  before insert or update of sku on public.variant
  for each row execute function merx.normalize_variant_sku();


-- ----------------------------------------------------------------------------
-- RÈGLE M1-1 — créer un produit crée sa variante par défaut
--
-- Par la base, pas par l'application : un produit qui arrive par l'écran, par
-- l'import (E2-05) ou par la synchronisation (E9) passe par ici. Un produit
-- sans variante est un produit qu'on ne peut ni stocker, ni prix, ni vendre.
--
-- **La variante par défaut porte le même identifiant que son produit.** C'est
-- pour E9, et c'est maintenant qu'il faut le décider. Une tablette hors-ligne
-- qui crée un produit doit aussi créer sa variante en local, sinon elle ne peut
-- pas le vendre avant le retour du réseau. Si le serveur tirait un identifiant
-- au hasard, il existerait deux variantes par défaut au retour — la sienne et
-- celle de la tablette — et l'index ci-dessus bloquerait la file de
-- synchronisation. Avec la règle `variant.id = product.id`, la tablette et le
-- serveur fabriquent la même ligne sans se parler. Changer d'avis plus tard
-- demanderait de réécrire des `variant_id` déjà référencés par le stock et les
-- ventes, c'est-à-dire la migration que cette story existe pour éviter.
--
-- Le SKU dérive de la référence du produit, à la création seulement : il sera
-- imprimé sur des étiquettes (E2-06), et le changer après coup rendrait
-- illisibles celles qui sont déjà collées. Ce que devient le SKU quand le
-- patron corrige la référence se décide en E2-02.
--
-- `security invoker` : l'insertion de la variante est soumise aux policies de
-- `variant`, sous l'identité de celui qui crée le produit. Le trigger ne peut
-- donc rien écrire que l'appelant ne pourrait écrire lui-même. Conséquence pour
-- les tests : deux policies — celle de `product`, puis celle de `variant` —
-- refusent le même employé avec le même code `42501`. Seul le nom de la table,
-- dans le message, dit laquelle a refusé ; `catalogue.test.ts` l'assert.
-- ----------------------------------------------------------------------------

create function merx.create_default_variant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  insert into public.variant (id, tenant_id, product_id, sku, is_default, created_by, device_id)
  values (new.id, new.tenant_id, new.id, new.code, true, new.created_by, new.device_id);
  return null;
end;
$function$;

comment on function merx.create_default_variant() is
  'Trigger AFTER INSERT sur product : crée la variante par défaut, sous '
  'l''identifiant du produit. RÈGLE M1-1, SPEC § 2.3.';

create trigger create_default_variant
  after insert on public.product
  for each row execute function merx.create_default_variant();


-- ----------------------------------------------------------------------------
-- SPEC § 2.3 — « tout produit possède **toujours** au moins une variante »
--
-- Toujours, pas seulement à la création. Deux chemins pouvaient laisser un
-- produit sans variante, et chacun a son garde, avec son propre message : les
-- deux répondent `23514`, et un test qui ne lirait que le code ne saurait pas
-- lequel a refusé (CLAUDE.md, E1-02).
--
--   1. Supprimer sa dernière variante. Refusé tant que le produit existe.
--      Supprimer le produit reste possible : la cascade retire les variantes
--      après le produit, et le garde voit alors un produit disparu.
--
--      Le garde compte aussi les variantes supprimées en douceur : il protège
--      contre la suppression définitive, la seule qui fasse disparaître une
--      ligne. La suppression douce, elle, se propage du produit à ses
--      variantes (plus bas).
--
--   2. Déplacer une variante vers un autre produit. Refusé toujours : une
--      variante est une déclinaison de *son* produit, et le stock et les ventes
--      qui la référencent ont été enregistrés à ce titre.
--
-- `security invoker` : l'appelant ne voit que son commerce, et la clé
-- composite garantit que le produit et ses variantes y sont tous.
-- ----------------------------------------------------------------------------

create function merx.keep_one_variant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if exists (select 1 from public.product p where p.id = old.product_id)
     and not exists (
       select 1 from public.variant v
       where v.product_id = old.product_id and v.id <> old.id
     )
  then
    raise exception 'Un produit garde toujours au moins une variante : celle-ci est la dernière.'
      using errcode = '23514';
  end if;
  return old;
end;
$function$;

comment on function merx.keep_one_variant() is
  'Trigger BEFORE DELETE sur variant : refuse de retirer la dernière variante '
  'd''un produit qui existe encore. SPEC § 2.3.';

create trigger keep_one_variant
  before delete on public.variant
  for each row execute function merx.keep_one_variant();


create function merx.pin_variant_product()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.product_id is distinct from old.product_id then
    raise exception 'Une variante ne change pas de produit.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

comment on function merx.pin_variant_product() is
  'Trigger BEFORE UPDATE OF product_id sur variant : une variante ne change '
  'jamais de produit. SPEC § 2.3.';

create trigger pin_variant_product
  before update of product_id on public.variant
  for each row execute function merx.pin_variant_product();


-- ----------------------------------------------------------------------------
-- La suppression douce du produit se propage à ses variantes
--
-- Sans elle, un produit supprimé laisse derrière lui des variantes vivantes :
-- elles restent vendables, et elles gardent leur SKU — dérivé de la référence
-- du produit. Recréer un produit sous cette référence butait alors sur
-- l'unicité des SKU, alors que celle des références l'autorisait (constaté par
-- `catalogue.test.ts` en E2-01). La promesse « un produit supprimé libère sa
-- référence » n'était vraie qu'à moitié.
--
-- Une seule instruction couvre les deux sens, parce que la date fait le lien :
--
--   — suppression : les variantes encore vivantes (`deleted_at` nul, l'ancienne
--     valeur du produit) prennent la date du produit, exactement ;
--   — restauration : les variantes qui portent exactement l'ancienne date du
--     produit redeviennent vivantes. Une variante supprimée pour elle-même, à
--     une autre date, reste supprimée : ce n'est pas la restauration du produit
--     qui doit la ramener.
--
-- Le même motif couvre un changement de date sur un produit déjà supprimé : les
-- variantes suivent, et une restauration ultérieure les retrouve.
--
-- `security invoker` : la mise à jour des variantes passe par leurs policies,
-- sous l'identité de celui qui supprime le produit — qui a déjà dû passer
-- `manage_product` pour modifier le produit lui-même.
-- ----------------------------------------------------------------------------

create function merx.propagate_product_deletion()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.variant v
  set deleted_at = new.deleted_at
  where v.product_id = new.id
    and v.deleted_at is not distinct from old.deleted_at;
  return null;
end;
$function$;

comment on function merx.propagate_product_deletion() is
  'Trigger AFTER UPDATE OF deleted_at sur product : les variantes suivent la '
  'suppression douce du produit, et sa restauration rétablit celles qui portent '
  'la même date. E2-01.';

create trigger propagate_deletion
  after update of deleted_at on public.product
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function merx.propagate_product_deletion();


-- ----------------------------------------------------------------------------
-- `price_break`
--
-- SPEC § 6, RÈGLE M1-2 : la grille par palier, par variante — jamais par
-- produit (SPEC § 2.3). La table naît ici ; la ligne `min_qty = 1` obligatoire
-- et la résolution du prix sont E2-03.
--
-- Un palier par quantité et par variante, parmi les lignes non supprimées :
-- deux prix pour le même seuil, et la résolution de E2-03 n'aurait plus de
-- réponse.
-- ----------------------------------------------------------------------------

create table public.price_break (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null,
  min_qty    public.quantity     not null check (min_qty > 0),
  unit_price public.money_amount not null check (unit_price >= 0)
);

select merx.apply_reference_conventions('public.price_break');

comment on table public.price_break is
  'Grille de prix par palier d''une variante. RÈGLE M1-2, SPEC § 6.';

alter table public.price_break
  add constraint price_break_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id)
  on delete cascade;

create index price_break_variant on public.price_break (tenant_id, variant_id);

create unique index price_break_min_qty_per_variant
  on public.price_break (variant_id, min_qty)
  where deleted_at is null;


-- ----------------------------------------------------------------------------
-- Qui écrit le catalogue
--
-- SPEC § 3.1 : « Créer / modifier un produit » (`manage_product`) et « Modifier
-- la grille de prix » (`manage_price_list`), le patron seul. La catégorie
-- relève du premier : elle structure le catalogue, elle ne fixe aucun prix.
--
-- La lecture est ouverte à tout le commerce : « Voir le catalogue et le stock »
-- est accordé aux deux rôles, et l'employé vend ce qu'il lit. Le commentaire
-- posé sur chaque policy le dit, pour que l'absence de restriction de lecture
-- ne passe pas pour un oubli — même geste qu'en E1-05.
-- ----------------------------------------------------------------------------

select merx.apply_write_capability_restriction('public.category',    'manage_product');
select merx.apply_write_capability_restriction('public.product',     'manage_product');
select merx.apply_write_capability_restriction('public.variant',     'manage_product');
select merx.apply_write_capability_restriction('public.price_break', 'manage_price_list');

do $migration$
declare
  t           text;
  policy_name text;
  reason      constant text :=
    'Écrire le catalogue exige la capacité inscrite au registre des écritures '
    'restreintes ; le lire n''exige que d''appartenir au commerce. « Voir le '
    'catalogue » est accordé aux deux rôles (SPEC § 3.1), et l''employé vend ce '
    'qu''il lit. L''absence de capability_restriction ici est une décision, pas '
    'un oubli. Les coûts, eux, vivront sur variant_cost (SPEC § 3).';
begin
  foreach t in array array['category', 'product', 'variant', 'price_break'] loop
    foreach policy_name in array array[
      'write_capability_insert', 'write_capability_update', 'write_capability_delete'
    ] loop
      execute format('comment on policy %I on public.%I is %L', policy_name, t, reason);
    end loop;
  end loop;
end;
$migration$;
