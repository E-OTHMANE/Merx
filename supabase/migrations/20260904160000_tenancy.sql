-- ============================================================================
-- Merx — multi-tenant et Row-Level Security
--
-- Référence : docs/SPEC.md § 2.1 (multi-tenant), § 3 (rôles), § 4 (placement
--             des schémas), § 9 M8 (tenant, app_user), docs/BACKLOG.md E0-03.
--
-- Les deux premières tables métier, et surtout le mécanisme qui garantit
-- qu'aucune ligne ne franchit la frontière entre deux commerces. L'isolation
-- n'est pas écrite table par table : elle est appliquée par une fonction,
-- elle-même appelée depuis les conventions. Une table créée en oubliant la RLS
-- devient impossible ; `supabase/tests/isolation.test.ts` le vérifie sur le
-- catalogue Postgres réel, sans énumérer aucune table à la main.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Rôles
--
-- SPEC § 3 : trois rôles, pas davantage. L'enum arrive ici et non en E0-05
-- parce que la policy `super_admin` ci-dessous doit tester un rôle : une
-- colonne texte convertie plus tard serait une réécriture de schéma. E0-05
-- apporte la substance — matrice § 3.1, helper de droits, filtrage de
-- `cost_price` — pas le type.
-- ----------------------------------------------------------------------------

create type public.user_role as enum ('super_admin', 'owner', 'worker');

comment on type public.user_role is
  'Rôle d''un utilisateur. SPEC § 3.';


-- ----------------------------------------------------------------------------
-- Lecture du tenant courant
--
-- SPEC § 2.1 : l'isolation vient de la base, pas de filtres applicatifs. La
-- source du tenant est le jeton signé, jamais un paramètre transmis par le
-- client — un client peut choisir ce qu'il envoie, il ne peut pas forger une
-- signature.
--
-- Le claim vit sous `app_metadata` : c'est la partie du jeton que l'utilisateur
-- ne peut pas modifier lui-même. `merx.custom_access_token()`, plus bas, l'y
-- dépose à chaque émission de jeton.
--
-- `role` au premier niveau du JWT est le rôle Postgres (`authenticated`) ; le
-- rôle métier est celui de `app_metadata`. Les confondre donnerait le
-- super-admin à tout le monde.
-- ----------------------------------------------------------------------------

create function merx.current_tenant_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$function$;

comment on function merx.current_tenant_id() is
  'Tenant de l''appelant, lu depuis le JWT signé. NULL hors session. SPEC § 2.1.';


create function merx.is_super_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin'
$function$;

comment on function merx.is_super_admin() is
  'Vrai si le JWT porte le rôle métier super_admin. SPEC § 3.';


-- Les policies s'évaluent avec les droits de l'appelant : `authenticated` doit
-- pouvoir exécuter ces deux fonctions. Rien d'autre de `merx` ne lui est
-- ouvert, et le schéma reste hors de l'API (config.toml : schemas = public,
-- graphql_public).
grant usage on schema merx to authenticated;
grant execute on function merx.current_tenant_id() to authenticated;
grant execute on function merx.is_super_admin() to authenticated;


-- ----------------------------------------------------------------------------
-- Isolation, appliquée par une fonction
--
-- Deux policies permissives, donc combinées par OU :
--
--   tenant_isolation — l'utilisateur ne voit et n'écrit que son commerce.
--   super_admin_all  — l'éditeur voit tout. Policy distincte et explicite,
--                      exigée telle quelle par E0-03 : le privilège doit se
--                      lire dans le catalogue, pas se déduire d'un OR noyé
--                      dans une expression commune.
--
-- `for all` couvre select, insert, update et delete. `with check` est aussi
-- important que `using` : sans lui, on lit son commerce mais on écrit dans
-- celui du voisin.
--
-- `force row level security` soumet aussi le propriétaire de la table à ses
-- propres policies. Sans effet tant que `postgres` porte BYPASSRLS, mais la
-- protection reste posée si la propriété change un jour.
--
-- Le `revoke` sur `anon` n'est pas de la ceinture et des bretelles : les ACL
-- par défaut de Supabase accordent tout à `anon` sur chaque nouvelle table de
-- `public`. Aucune policy ne le vise, donc il ne lit rien — mais un privilège
-- accordé qu'aucune policy ne rattrape est un accident qui attend une
-- policy trop large. Tout l'applicatif est derrière authentification (SPEC
-- § 2.7) : `anon` n'a rien à faire sur une table métier.
-- ----------------------------------------------------------------------------

create function merx.apply_tenant_isolation(target regclass)
returns void
language plpgsql
as $function$
begin
  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);

  execute format($ddl$
    create policy tenant_isolation on %s
      as permissive for all to authenticated
      using (tenant_id = merx.current_tenant_id())
      with check (tenant_id = merx.current_tenant_id())
  $ddl$, target);

  execute format($ddl$
    create policy super_admin_all on %s
      as permissive for all to authenticated
      using (merx.is_super_admin())
      with check (merx.is_super_admin())
  $ddl$, target);

  execute format('revoke all on %s from anon', target);
end;
$function$;

comment on function merx.apply_tenant_isolation(regclass) is
  'Active la RLS et pose les deux policies d''isolation. SPEC § 2.1, E0-03.';


-- ----------------------------------------------------------------------------
-- `tenant` — le commerce
--
-- SPEC § 9, M8.
--
-- La table porte `tenant_id` comme toute table de `public`, et ce `tenant_id`
-- est son propre `id`. Ce n'est pas une redondance décorative : c'est ce qui
-- permet à `tenant` de tomber sous *la même* policy que les trente autres
-- tables, donc sous le même balayage de test. Une table qui échappe au motif
-- général est une table que le test ne protège pas.
--
-- Conséquence voulue : personne ne crée un commerce depuis l'application. Le
-- `tenant_id` d'une ligne neuve vaut son propre `id`, jamais celui de
-- l'appelant, donc `with check` refuse — sauf pour `super_admin`. L'éditeur
-- crée les commerces, ce que dit SPEC § 3.
-- ----------------------------------------------------------------------------

create table public.tenant (
  id                  uuid primary key default gen_random_uuid(),
  business_name       text not null,
  owner_name          text,
  phone               text,
  city                text,
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'suspended', 'cancelled')),
  trial_ends_at       timestamptz
);

comment on table public.tenant is
  'Un commerce. Unité d''isolation de toute la base. SPEC § 2.1, § 9 M8.';

select merx.apply_reference_conventions('public.tenant');


create function merx.tenant_is_its_own_tenant()
returns trigger
language plpgsql
as $function$
begin
  new.tenant_id := new.id;
  return new;
end;
$function$;

comment on function merx.tenant_is_its_own_tenant() is
  'Trigger BEFORE INSERT sur `tenant` : aligne tenant_id sur id.';

create trigger tenant_self_reference
  before insert on public.tenant
  for each row execute function merx.tenant_is_its_own_tenant();

alter table public.tenant
  add constraint tenant_id_is_self check (tenant_id = id);


-- ----------------------------------------------------------------------------
-- `app_user` — un utilisateur dans un commerce
--
-- SPEC § 9, M8.
--
-- `auth_user_id` est nullable : la fiche existe avant le compte. Un employé
-- est inscrit par son patron, et rejoint plus tard — E0-04. La contrainte
-- d'unicité vaut quand la colonne est renseignée : un compte d'authentification
-- appartient à un seul commerce en V1.
-- ----------------------------------------------------------------------------

create table public.app_user (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  full_name    text not null,
  phone        text,
  role         public.user_role not null,
  is_active    boolean not null default true,
  last_seen_at timestamptz
);

comment on table public.app_user is
  'Utilisateur d''un commerce. SPEC § 3, § 9 M8.';

select merx.apply_reference_conventions('public.app_user');


-- ----------------------------------------------------------------------------
-- Clés étrangères des colonnes standard
--
-- Annoncé par la migration initiale : `tenant_id` et `created_by` attendaient
-- que leurs cibles existent. C'est fait. À partir d'ici, les deux fonctions de
-- convention les posent d'office (plus bas).
-- ----------------------------------------------------------------------------

do $migration$
declare
  t text;
begin
  foreach t in array array['public.tenant', 'public.app_user'] loop
    execute format(
      'alter table %s add constraint %I foreign key (tenant_id)'
      ' references public.tenant (id)',
      t, split_part(t, '.', 2) || '_tenant_id_fkey');

    execute format(
      'alter table %s add constraint %I foreign key (created_by)'
      ' references public.app_user (id)',
      t, split_part(t, '.', 2) || '_created_by_fkey');

    execute format('select merx.apply_tenant_isolation(%L)', t);
  end loop;
end;
$migration$;


-- ----------------------------------------------------------------------------
-- Les conventions prennent l'isolation en charge
--
-- À partir d'ici, créer une table de `public` par les fonctions de convention
-- suffit à lui donner sa RLS, ses policies et ses clés étrangères. Une table
-- métier sans isolation demande de contourner délibérément les conventions —
-- et le test la signale, table par table, sans que personne ait à l'ajouter à
-- une liste.
-- ----------------------------------------------------------------------------

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

  execute format(
    'alter table %s add constraint %I foreign key (created_by)'
    ' references public.app_user (id)',
    target, table_name || '_created_by_fkey');

  perform merx.apply_tenant_isolation(target);

  insert into merx.convention_registry (table_name, kind)
  values (table_name, 'business');
end;
$function$;

comment on function merx.apply_business_conventions(regclass) is
  'Colonnes standard, index tenant, trigger updated_at, clés étrangères et '
  'isolation RLS. SPEC § 4, § 2.1.';


-- ----------------------------------------------------------------------------
-- Claims du jeton
--
-- SPEC § 2.1 : les policies dérivent le tenant du JWT. Encore faut-il que le
-- JWT le porte. Ce hook est appelé par Supabase Auth à chaque émission de
-- jeton et dépose `tenant_id` et `role` dans `app_metadata`.
--
-- `security definer` : la fonction est appelée par `supabase_auth_admin`, qui
-- n'a aucun droit sur les tables métier — et ne doit pas en recevoir. Elle ne
-- rend que les deux claims de l'utilisateur du jeton en cours.
--
-- Un compte sans fiche `app_user`, ou désactivé, ou supprimé, repart sans
-- claim : `merx.current_tenant_id()` vaut alors NULL, et NULL ne s'égale à
-- rien. Aucune policy ne passe, aucune ligne n'est lisible. C'est le
-- comportement voulu — l'absence de droit se traduit par l'absence de donnée,
-- pas par une exception qu'il faudrait penser à attraper.
-- ----------------------------------------------------------------------------

create function merx.custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_tenant uuid;
  found_role   public.user_role;
  claims       jsonb;
  metadata     jsonb;
begin
  select u.tenant_id, u.role
    into found_tenant, found_role
  from public.app_user u
  where u.auth_user_id = (event ->> 'user_id')::uuid
    and u.is_active
    and u.deleted_at is null;

  claims   := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  -- Retirées d'abord, systématiquement : un jeton renouvelé ne doit jamais
  -- conserver le tenant d'une fiche entre-temps supprimée ou désactivée.
  metadata := metadata - 'tenant_id' - 'role';

  if found_tenant is not null then
    metadata := metadata || jsonb_build_object(
      'tenant_id', found_tenant,
      'role',      found_role);
  end if;

  -- `claims` est réinjecté avant d'écrire dans `{claims,app_metadata}` :
  -- jsonb_set ne crée pas de niveau intermédiaire manquant.
  return jsonb_set(
    event || jsonb_build_object('claims', claims),
    '{claims,app_metadata}',
    metadata);
end;
$function$;

comment on function merx.custom_access_token(jsonb) is
  'Hook Supabase Auth : dépose tenant_id et role dans app_metadata. SPEC § 2.1.';

revoke execute on function merx.custom_access_token(jsonb) from public;
grant usage on schema merx to supabase_auth_admin;
grant execute on function merx.custom_access_token(jsonb) to supabase_auth_admin;
