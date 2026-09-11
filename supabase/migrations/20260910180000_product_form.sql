-- ============================================================================
-- Merx — créer et modifier un produit
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant), § 2.6 (RÈGLE de la
--             charge de saisie), § 3.1 (`manage_product`), § 4 (conventions),
--             § 6 M1, docs/BACKLOG.md E2-02.
--
-- Le premier écran métier du projet. Ce fichier ne livre que ce que l'écran ne
-- peut pas faire seul :
--
--   1. `tenant_id` pris dans le jeton par défaut, sur toutes les tables — la
--      note laissée en tête de E2-02, tranchée ;
--   2. le registre des formulaires de création, qui rend vérifiable par
--      machine la RÈGLE § 2.6 : le seul champ obligatoire est le nom ;
--   3. le SKU de la variante par défaut suit la référence du produit — la
--      question laissée ouverte par E2-01 ;
--   4. le rangement des photos de produit, et qui peut les lire et les écrire.
--
-- Rien de E2-03 à E2-06 : ni grille de prix, ni recherche, ni import, ni
-- étiquette.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. `tenant_id` par défaut : le commerce du jeton
--
-- Avant cette migration, toute insertion devait envoyer `tenant_id` : la
-- colonne est NOT NULL, et rien ne la tirait du jeton. Chaque écran d'insertion
-- aurait répété le geste — produit, client, fournisseur, bon — et un oubli se
-- serait lu comme une erreur `23502`, loin de sa cause.
--
-- Le défaut ne change rien à la sécurité. La valeur vient du jeton signé, comme
-- celle que la policy `tenant_isolation` compare ; et une valeur étrangère
-- envoyée explicitement reste refusée par son `with check`. Ce n'est pas non
-- plus un filtre écrit à la main (SPEC § 2.1) : l'application n'écrit plus
-- aucun `tenant_id`, nulle part.
--
-- Hors session (`postgres`, une migration, un test qui peuple la base), le
-- défaut vaut NULL et la contrainte NOT NULL refuse : ces chemins-là doivent
-- toujours dire de quel commerce il s'agit. `supabase/tests/isolation.ts` pose
-- donc `tenant_id` lui-même, défaut ou pas.
--
-- `tenant` reçoit le même défaut, sans effet : son trigger aligne `tenant_id`
-- sur `id` avant l'insertion. Une exception écrite ici serait une table de plus
-- que la règle de `conventions.ts` devrait connaître par son nom.
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
      add column tenant_id  uuid        not null default merx.current_tenant_id(),
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
  -- commerce de la ligne.
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
  'Colonnes standard — tenant_id tiré du jeton par défaut —, index tenant, '
  'trigger updated_at, clés étrangères composites sur tenant_id, isolation RLS. '
  'SPEC § 4, § 2.1.';

-- Les tables existantes, énumérées par le registre : aucune n'est nommée ici.
do $migration$
declare
  t text;
begin
  for t in select table_name from merx.convention_registry order by table_name loop
    execute format(
      'alter table public.%I alter column tenant_id set default merx.current_tenant_id()', t);
  end loop;
end;
$migration$;


-- ----------------------------------------------------------------------------
-- 2. Le registre des formulaires de création
--
-- SPEC § 2.6, RÈGLE — principe directeur : « le seul champ obligatoire à la
-- création d'un produit est le nom. Le seul champ obligatoire à la création
-- d'un client est le nom. »
--
-- Un écran peut ne rien réclamer et la base refuser quand même : il suffit
-- qu'une colonne passe NOT NULL dans une migration, pour une bonne raison, un
-- jour. L'écran continue d'afficher un formulaire sans reproche, et
-- l'enregistrement échoue sur un `23502` que le commerçant ne comprendra pas.
--
-- Le registre dit quelles tables reçoivent un formulaire de création, et quelle
-- est leur colonne de nom. `supabase/tests/conventions.ts` en déduit la règle
-- sans nommer aucune table : toute autre colonne doit accepter d'être absente —
-- nullable, ou pourvue d'un défaut. `product` s'inscrit ici ; `client` (E6) et
-- `supplier` (E8) s'inscriront de la même façon, par une ligne.
-- ----------------------------------------------------------------------------

create table merx.creation_form_registry (
  table_name  text primary key,
  name_column text not null
);

comment on table merx.creation_form_registry is
  'Tables qui reçoivent un formulaire de création, et leur seule colonne '
  'obligatoire : le nom. SPEC § 2.6. Contrôlé par supabase/tests/conventions.ts.';

create function merx.register_creation_form(target regclass, name_column text)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  select c.relname into table_name from pg_class c where c.oid = target;

  -- Une colonne de nom mal orthographiée ferait passer la table pour conforme
  -- à une règle qui ne la voit plus. Mieux vaut refuser la migration.
  if not exists (
    select 1 from pg_attribute a
    where a.attrelid = target and a.attname = name_column
      and a.attnum > 0 and not a.attisdropped
  ) then
    raise exception 'Colonne de nom inconnue : %.%', table_name, name_column;
  end if;

  insert into merx.creation_form_registry (table_name, name_column)
  values (table_name, name_column);
end;
$function$;

comment on function merx.register_creation_form(regclass, text) is
  'Inscrit une table au registre des formulaires de création. SPEC § 2.6.';

select merx.register_creation_form('public.product', 'name_fr');


-- ----------------------------------------------------------------------------
-- 3. Le SKU de la variante par défaut suit la référence
--
-- E2-01 dérivait le SKU de la référence à la création seulement, et laissait à
-- cette story ce qu'il devient quand le patron corrige la référence.
--
-- Il la suit, tant qu'il n'en a pas divergé. Sans cela, on retombe sur le
-- défaut que E2-01 a corrigé pour la suppression : le patron renomme la
-- référence A en B, puis crée un produit sous A — la référence est libre,
-- l'index de `product` l'accepte, mais le SKU de l'ancienne variante vaut
-- toujours A et `variant_sku_per_tenant` refuse. « Une référence libérée est
-- libre » ne serait vrai qu'à moitié.
--
-- « Tant qu'il n'en a pas divergé » : un SKU égal à l'ancienne référence —
-- NULL compris, pour un produit qui n'en avait pas — est un SKU dérivé, il
-- suit. Un SKU posé autrement reste où il est. Aucune étiquette n'existe avant
-- E2-06 ; c'est elle qui décidera si l'impression fige le SKU.
--
-- La variante par défaut seulement : c'est la seule dont le SKU dérive de la
-- référence (E2-01, « s'il n'y a qu'une variante »).
--
-- `security invoker` : la variante est modifiée sous l'identité de celui qui
-- modifie le produit, donc sous la policy d'écriture de `variant`.
-- ----------------------------------------------------------------------------

create function merx.follow_product_code()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.variant v
  set sku = new.code
  where v.product_id = new.id
    and v.is_default
    and v.sku is not distinct from old.code;
  return null;
end;
$function$;

comment on function merx.follow_product_code() is
  'Trigger AFTER UPDATE OF code sur product : le SKU de la variante par défaut '
  'suit la référence, tant qu''il n''en a pas divergé. E2-02.';

create trigger follow_code
  after update of code on public.product
  for each row
  when (new.code is distinct from old.code)
  execute function merx.follow_product_code();


-- ----------------------------------------------------------------------------
-- 4. Les photos de produit
--
-- BACKLOG E2-02 : « photo prise directement depuis l'appareil, redimensionnée
-- avant envoi ». Le redimensionnement est fait par l'appareil (800 px au plus
-- grand côté, JPEG) ; la base ne reçoit que le résultat.
--
-- Un compartiment Storage **privé**. Le catalogue d'un commerce est une
-- information commerciale : il ne se consulte pas par une URL publique, il se
-- lit sous session, comme les tables. L'affichage passe par des URL signées.
--
-- Rangement : `{product_id}/{uuid}.jpg`. Chaque photo a son propre nom — en
-- changer n'écrase rien, et un cache qui garde l'ancienne ne la confond jamais
-- avec la nouvelle. `product.photo_url` porte ce chemin, pas une URL : une URL
-- signée expire, un chemin non.
--
-- **Aucun commerce dans le chemin.** L'isolation passe par le produit : un
-- objet n'est lisible que si le produit de son dossier l'est, et c'est la RLS
-- de `product` qui en décide, sous le jeton de l'appelant. L'application n'a
-- donc aucun `tenant_id` à écrire ici non plus.
--
-- Deux conditions, et chacune a son test qui ne peut tomber que par elle
-- (`supabase/tests/product-form.test.ts`) :
--   — le produit du dossier est visible : isolation entre commerces, posée sur
--     la lecture et le dépôt ; le retrait en hérite par la lecture (plus bas) ;
--   — `merx.can('manage_product')` pour déposer ou retirer : SPEC § 3.1.
--
-- Pas de policy d'UPDATE : une photo ne se remplace pas, elle s'ajoute sous un
-- nouveau nom et l'ancienne se retire.
--
-- Le compartiment et ses policies sont posés par l'interface documentée de
-- Supabase Storage — `storage.buckets` et les policies de `storage.objects` —
-- qui est son contrat public de contrôle d'accès, pas un schéma interne.
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photo', 'product-photo', false, 1048576, array['image/jpeg']);

/*
 * L'identifiant du produit d'un objet : le premier segment du chemin, s'il a la
 * forme d'un uuid. NULL sinon — un nom malformé ne vise aucun produit, et la
 * policy refuse plutôt que de lever `22P02`. `case` garantit que le cast ne
 * s'évalue qu'après le motif.
 */
create function merx.photo_product_id(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $function$
  select case
    when pg_catalog.split_part(object_name, '/', 1)
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then pg_catalog.split_part(object_name, '/', 1)::uuid
  end
$function$;

comment on function merx.photo_product_id(text) is
  'Produit auquel appartient un objet du compartiment product-photo. E2-02.';

grant execute on function merx.photo_product_id(text) to authenticated;

create policy product_photo_select on storage.objects
  as permissive for select to authenticated
  using (
    bucket_id = 'product-photo'
    and exists (
      select 1 from public.product p where p.id = merx.photo_product_id(name)
    )
  );

create policy product_photo_insert on storage.objects
  as permissive for insert to authenticated
  with check (
    bucket_id = 'product-photo'
    and exists (
      select 1 from public.product p where p.id = merx.photo_product_id(name)
    )
    and merx.can('manage_product')
  );

/*
 * Retirer : la capacité seulement. Pas de terme « produit visible » ici, et ce
 * n'est pas un oubli : Postgres n'autorise un DELETE que sur les lignes que les
 * policies de SELECT laissent voir, et `product_photo_select` exige déjà que le
 * produit soit visible. Le même terme posé ici ne pourrait jamais refuser seul
 * — constaté par sabotage : retiré, aucun test ne bougeait. Un garde qu'aucun
 * test ne peut faire tomber n'existe que pour la forme (CLAUDE.md, E1-02).
 * L'isolation du retrait est donc portée par la policy de lecture, et son test
 * tombe quand on en retire le terme.
 */
create policy product_photo_delete on storage.objects
  as permissive for delete to authenticated
  using (
    bucket_id = 'product-photo'
    and merx.can('manage_product')
  );

comment on column public.product.photo_url is
  'Chemin de l''objet dans le compartiment privé product-photo, '
  '`{product_id}/{uuid}.jpg` — pas une URL : l''affichage signe le chemin. E2-02.';
