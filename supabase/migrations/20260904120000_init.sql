-- ============================================================================
-- Merx — migration initiale : conventions de schéma
--
-- Référence : docs/SPEC.md § 4 (Conventions), § 2.1 (multi-tenant),
--             § 2.5 (hors-ligne, appareil), docs/BACKLOG.md E0-02.
--
-- Cette migration ne crée aucune table métier. Elle installe les types et le
-- mécanisme qui rendent les conventions applicables — et vérifiables — dès la
-- première table, pour ne pas avoir à les rétro-corriger sur trente.
--
-- Les tables métier arrivent à partir de E0-03 (`tenant`, `app_user`).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Schéma technique
--
-- La machinerie de convention vit hors de `public` : elle n'est pas du métier
-- et ne doit pas être exposée par l'API (config.toml : schemas = public,
-- graphql_public).
-- ----------------------------------------------------------------------------

create schema if not exists merx;

comment on schema merx is
  'Machinerie interne : conventions de schéma. Jamais exposé par l''API.';


-- ----------------------------------------------------------------------------
-- Domaines numériques
--
-- SPEC § 4 : montants en numeric(12,2), quantités en numeric(12,3), jamais de
-- flottant. Les domaines donnent un nom à la règle : une colonne mal typée se
-- voit en relecture, et le contrôle automatisé porte sur le domaine plutôt que
-- sur une précision recopiée à la main.
--
-- PostgREST et PowerSync voient le type de base — rien ne change côté client.
-- ----------------------------------------------------------------------------

create domain public.money_amount as numeric(12, 2);

comment on domain public.money_amount is
  'Montant monétaire, MAD. numeric(12,2). SPEC § 4.';

create domain public.quantity as numeric(12, 3);

comment on domain public.quantity is
  'Quantité. numeric(12,3). SPEC § 4.';


-- ----------------------------------------------------------------------------
-- Registre des conventions
--
-- Toute table de `public` doit être déclarée ici, par l'un des deux appels
-- `merx.apply_*_conventions()`. Une table absente du registre est une table
-- créée en oubliant les conventions : le test la signale.
--
--   business  — documents, mouvements, écritures. Jamais supprimés (SPEC § 4).
--   reference — produits, clients, prix. Suppression douce via `deleted_at`.
-- ----------------------------------------------------------------------------

create table merx.convention_registry (
  table_name text primary key,
  kind       text not null check (kind in ('business', 'reference'))
);

comment on table merx.convention_registry is
  'Tables de `public` placées sous convention, et leur nature.';


-- ----------------------------------------------------------------------------
-- Trigger `updated_at`
--
-- Maintenu par la base, jamais par l'applicatif : un client hors-ligne depuis
-- trois jours n'a pas d'horloge de confiance, et une écriture qui oublie le
-- champ fausserait la réconciliation.
-- ----------------------------------------------------------------------------

create function merx.set_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

comment on function merx.set_updated_at() is
  'Trigger BEFORE UPDATE : positionne `updated_at` à now(). SPEC § 4.';


-- ----------------------------------------------------------------------------
-- Colonnes standard
--
-- SPEC § 4 : toute table porte `tenant_id`, `created_at`, `updated_at`,
-- `created_by`, `device_id`. Une seule définition, appelée par chaque table.
--
-- `created_by` et `device_id` sont nullables : une ligne peut naître d'une
-- migration ou d'un import, sans utilisateur ni appareil. Leurs clés
-- étrangères sont posées quand `app_user` et `device` existent — E0-03 et
-- l'étape hors-ligne. `device_id` est un uuid comme toute entité du projet ;
-- le préfixe de numérotation (« A » dans BL-A-0001, SPEC § 2.5) est un
-- attribut de l'appareil, pas son identifiant.
--
-- L'index sur `tenant_id` est systématique : toute lecture est filtrée par
-- tenant, via RLS (SPEC § 2.1).
-- ----------------------------------------------------------------------------

create function merx.apply_business_conventions(target regclass)
returns void
language plpgsql
as $function$
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

  insert into merx.convention_registry (table_name, kind)
  select c.relname, 'business'
  from pg_class c
  where c.oid = target;
end;
$function$;

comment on function merx.apply_business_conventions(regclass) is
  'Ajoute les colonnes standard, l''index tenant et le trigger updated_at.';


create function merx.apply_reference_conventions(target regclass)
returns void
language plpgsql
as $function$
begin
  perform merx.apply_business_conventions(target);

  -- SPEC § 4 : suppression douce sur les tables de référence. Les documents
  -- et les mouvements ne sont jamais supprimés, seulement annulés.
  execute format('alter table %s add column deleted_at timestamptz', target);

  update merx.convention_registry
  set kind = 'reference'
  where table_name = (select c.relname from pg_class c where c.oid = target);
end;
$function$;

comment on function merx.apply_reference_conventions(regclass) is
  'Conventions métier, plus `deleted_at` pour la suppression douce.';
