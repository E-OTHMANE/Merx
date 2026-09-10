-- ============================================================================
-- Merx — création d'un commerce : dépôt, appareil, et la fonction qui monte
--        l'ensemble d'un seul geste.
--
-- Référence : docs/SPEC.md § 2.4 (dépôt unique, RÈGLE), § 2.5 (RÈGLE
--             numérotation, préfixe d'appareil), § 3 (rôles), § 7 M2
--             (`warehouse`), § 9 M8 (`tenant`, `app_user`, `device`),
--             docs/BACKLOG.md E1-01.
--
-- Deux tables et une fonction. Les tables sont celles que SPEC § 7 M2 et § 9 M8
-- définissent, sans une colonne de plus : E3-01 leur ajoutera `stock_level` et
-- `stock_movement`, E1-03 l'attribution des préfixes suivants et l'écran. Elles
-- naissent ici parce que E1-01 ne peut pas être terminée sans elles — un
-- commerce sans dépôt n'a nulle part où poser son stock, et un commerce sans
-- appareil ne peut numéroter aucun bon.
--
-- La fonction, elle, existe pour une raison précise : un commerce à moitié créé
-- est un commerce dont le patron ne peut pas se connecter. Quatre insertions,
-- une transaction, et un seul point d'entrée.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- `warehouse` — le dépôt, constante invisible
--
-- SPEC § 2.4, RÈGLE : « `stock_level` et `stock_movement` portent néanmoins
-- `warehouse_id`, pointant sur une ligne `warehouse` unique créée à
-- l'inscription du commerce. Jamais affichée, jamais modifiable, jamais
-- choisie. » La colonne est là pour ne pas avoir à réécrire l'historique de
-- stock de tous les commerces installés le jour où l'un d'eux se révélerait
-- avoir un dépôt séparé.
--
-- L'unicité porte donc sur le dépôt *par défaut*, pas sur le dépôt tout court.
-- C'est ce que la RÈGLE demande et rien de plus : elle garantit qu'à tout
-- moment un commerce a exactement un dépôt vers lequel la colonne constante se
-- résout, sans interdire qu'un second dépôt, non par défaut, apparaisse un jour.
-- Une unicité sur `tenant_id` seul aurait fermé la porte que § 2.4 laisse
-- ouverte, et il aurait fallu une migration pour la rouvrir.
-- ----------------------------------------------------------------------------

create table public.warehouse (
  id         uuid    primary key default gen_random_uuid(),
  name       text    not null,
  is_default boolean not null default true
);

comment on table public.warehouse is
  'Dépôt. Une ligne par commerce, créée automatiquement, jamais exposée. '
  'SPEC § 2.4, § 7 M2.';

select merx.apply_reference_conventions('public.warehouse');

create unique index warehouse_one_default_per_tenant
  on public.warehouse (tenant_id)
  where is_default and deleted_at is null;


-- ----------------------------------------------------------------------------
-- `device` — l'appareil, et son préfixe de numérotation
--
-- SPEC § 9 M8 : `label`, `prefix`, `last_sync_at`, `is_active`. SPEC § 2.5,
-- RÈGLE numérotation : les numéros sont attribués localement, avec un préfixe
-- d'appareil — `BL-A-0001`, `BL-B-0001`. Sans préfixe unique par commerce, deux
-- appareils hors-ligne produisent le même numéro et personne ne s'en aperçoit
-- avant la synchronisation.
--
-- L'unicité est donc une contrainte de base, pas une convention d'écriture : ce
-- qu'elle protège se produit précisément quand le réseau est absent, c'est-à-
-- dire quand aucune vérification côté serveur n'est possible.
--
-- E1-01 pose le premier appareil, préfixe « A ». L'attribution des suivants
-- (B, C…) et l'enregistrement d'un appareil à sa première connexion sont E1-03.
-- ----------------------------------------------------------------------------

-- Le préfixe est un type, pas une contrainte de forme sur du texte. Trois
-- raisons, dans l'ordre où elles comptent :
--
--   — c'est ce qu'il est. Vingt-six valeurs, closes, connues d'avance. Un
--     `check (prefix ~ '^[A-Z]$')` décrit la même chose en la laissant passer
--     pour du texte libre contraint après coup ;
--   — E1-03 doit attribuer « le prochain préfixe non pris ». Avec un type,
--     cela s'écrit `enum_range(null::device_prefix)` moins ce qui est déjà
--     utilisé ; avec une expression régulière, il faudrait réécrire
--     l'alphabet en SQL, à côté de la contrainte qui le décrit déjà ;
--   — le générateur de lignes de `supabase/tests/isolation.ts` déduit ses
--     valeurs du catalogue. Il sait lire un enum ; aucune contrainte de forme
--     ne lui est lisible. Un type garde la table dans le balayage
--     d'isolation, une contrainte de forme l'en aurait fait tomber.
create type public.device_prefix as enum (
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
);

comment on type public.device_prefix is
  'Lettre de numérotation d''un appareil. SPEC § 2.5, RÈGLE numérotation.';

create table public.device (
  id           uuid    primary key default gen_random_uuid(),
  label        text    not null,
  prefix       public.device_prefix not null,
  last_sync_at timestamptz,
  is_active    boolean not null default true
);

comment on table public.device is
  'Appareil d''un commerce. `prefix` sert la numérotation hors-ligne. '
  'SPEC § 2.5, § 9 M8.';

comment on column public.device.prefix is
  'Lettre unique par commerce, employée dans les numéros de document '
  '(BL-A-0001). SPEC § 2.5, RÈGLE numérotation.';

select merx.apply_reference_conventions('public.device');

create unique index device_prefix_per_tenant
  on public.device (tenant_id, prefix)
  where deleted_at is null;


-- ----------------------------------------------------------------------------
-- `public.create_tenant()` — le commerce entier, ou rien
--
-- E1-01 : « Crée le `tenant`, le premier `app_user` en `owner`, et un `device`
-- par défaut » et « Crée automatiquement l'unique `warehouse` ». Quatre lignes
-- dans quatre tables, et aucun état intermédiaire acceptable : un commerce sans
-- `app_user` est un commerce où personne ne peut entrer, un `app_user` sans
-- commerce est un compte que `merx.custom_access_token()` laissera sans claim.
-- Une fonction, donc une transaction.
--
-- Le compte d'authentification n'est pas créé ici, et c'est délibéré. L'écrire
-- en SQL demanderait d'insérer à la main dans `auth.users` et `auth.identities`
-- — le schéma interne de GoTrue, qui n'est pas une API publique et change entre
-- versions. Une mise à jour de Supabase casserait la création de commerce en
-- production, et le symptôme ressemblerait à une panne d'authentification. Le
-- compte est donc créé par l'API Admin, depuis la fonction Edge
-- `create-tenant`, qui appelle ensuite celle-ci et lui passe l'identifiant
-- obtenu.
--
-- `security definer` : les trois tables filles n'acceptent une écriture que
-- sous le `tenant_id` du jeton (policy `tenant_isolation`), or ce `tenant_id`
-- n'existe pas encore au moment où on l'écrit. La fonction crée le commerce
-- *et* sa première population : elle est nécessairement en amont de la
-- frontière qu'elle installe.
--
-- D'où la première ligne du corps. `merx.is_super_admin()` plutôt que
-- `merx.can()` : créer un commerce n'est pas une case de la matrice § 3.1, qui
-- n'a que les colonnes `owner` et `worker`. L'éditeur est traité en amont du
-- helper, exactement comme il l'est par la policy `super_admin_all` et par
-- `merx.can()` lui-même (SPEC § 3, RÈGLE un seul helper). Le droit se lit à un
-- seul endroit, et ce n'est pas un droit que la matrice gouverne.
--
-- Le contrôle est ici, pas dans la fonction Edge : celle-ci vérifie le rôle
-- pour ne pas créer un compte d'authentification inutile, mais l'autorité reste
-- à la base, qui relit le jeton signé. Un appel direct à la RPC, en contournant
-- la fonction Edge, bute sur la même ligne.
-- ----------------------------------------------------------------------------

create function public.create_tenant(
  business_name text,
  owner_name    text,
  phone         text,
  city          text,
  auth_user_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  new_tenant uuid;
begin
  -- Le libellé n'est pas celui du pré-contrôle de la fonction Edge, et la
  -- différence est délibérée. Les deux gardes rendent un 403 au client ; s'ils
  -- disaient la même phrase, rien ne distinguerait celui qui a refusé, et le
  -- test du pré-contrôle resterait vert le pré-contrôle retiré — la RPC
  -- reprenant le refus à son compte sous une réponse identique. Constaté par
  -- sabotage en E1-02, sur la fonction jumelle : 0 test sur 180 tombait.
  --
  -- Ce message-ci n'est vu que lorsqu'on est arrivé jusqu'à la base sans passer
  -- par le pré-contrôle : appel direct à la RPC, ou pré-contrôle défaillant.
  if not merx.is_super_admin() then
    raise exception 'Ce compte n''a pas le droit de créer un commerce.'
      using errcode = '42501';
  end if;

  -- SPEC § 2.6 ne s'applique pas ici : ce n'est ni un produit ni un client,
  -- c'est l'installation d'un commerce par l'éditeur, et un commerce sans nom
  -- de patron ni téléphone n'a pas de titulaire joignable. Les deux champs
  -- facultatifs de E1-01 — la ville, et rien d'autre — le restent.
  if coalesce(btrim(business_name), '') = '' then
    raise exception 'Le nom du commerce est obligatoire.' using errcode = '23514';
  end if;

  if coalesce(btrim(owner_name), '') = '' then
    raise exception 'Le nom du patron est obligatoire.' using errcode = '23514';
  end if;

  if coalesce(btrim(phone), '') = '' then
    raise exception 'Le téléphone du patron est obligatoire.' using errcode = '23514';
  end if;

  if auth_user_id is null then
    raise exception 'Aucun compte d''authentification fourni.' using errcode = '23514';
  end if;

  -- `tenant_id` n'est pas renseigné : le trigger `tenant_self_reference`
  -- (E0-03) l'aligne sur `id` avant que la contrainte NOT NULL ne s'évalue.
  -- Lui passer une valeur ici la ferait écraser, et donnerait à lire un choix
  -- qui n'en est pas un.
  insert into public.tenant (business_name, owner_name, phone, city)
  values (
    btrim(business_name),
    btrim(owner_name),
    btrim(phone),
    nullif(btrim(coalesce(city, '')), '')
  )
  returning id into new_tenant;

  -- Le dépôt. Son nom n'apparaît nulle part (SPEC § 2.4) ; la colonne est
  -- NOT NULL, il faut bien y écrire quelque chose.
  insert into public.warehouse (tenant_id, name, is_default)
  values (new_tenant, 'Dépôt', true);

  -- Le premier appareil prend « A ». Les suivants sont E1-03.
  insert into public.device (tenant_id, label, prefix)
  values (new_tenant, 'Comptoir', 'A');

  -- `created_by` reste nul : le créateur est l'éditeur, qui n'a pas de fiche
  -- `app_user` dans ce commerce — et ne doit pas en avoir une, sinon il compte
  -- comme un utilisateur du commerce.
  insert into public.app_user (tenant_id, auth_user_id, full_name, phone, role)
  values (
    new_tenant,
    auth_user_id,
    btrim(owner_name),
    btrim(phone),
    'owner'
  );

  return new_tenant;
end;
$function$;

comment on function public.create_tenant(text, text, text, text, uuid) is
  'Crée un commerce et sa population initiale — dépôt, appareil, patron — en '
  'une transaction. Réservée à super_admin. E1-01, SPEC § 2.4, § 9 M8.';

-- PostgREST expose toute fonction de `public`, et les ACL par défaut de
-- Supabase l'accordent à `anon`. Le garde de la première ligne suffirait — un
-- appelant anonyme n'est pas super-admin — mais un privilège qu'aucune
-- vérification ne rattrape est un accident qui attend une modification.
revoke execute on function public.create_tenant(text, text, text, text, uuid) from public, anon;
grant  execute on function public.create_tenant(text, text, text, text, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- `public.can_create_tenant()` — la même question, posée avant d'agir
--
-- La fonction Edge doit savoir si l'appelant a le droit *avant* de créer son
-- compte d'authentification : sinon un `owner` qui tente sa chance fait naître
-- un compte que l'étape suivante refusera, et qu'il faudra supprimer.
--
-- Elle ne peut pas lire ce droit dans le jeton elle-même. Le rôle métier est
-- déposé dans les claims par `merx.custom_access_token()`, et les bibliothèques
-- clientes ne les rendent pas de façon stable : pour un jeton HS256, elles
-- retombent sur le serveur d'auth, qui rend l'`app_metadata` *stocké* sur
-- `auth.users` — où le rôle métier ne figure pas. Le pré-contrôle refusait donc
-- tout le monde, éditeur compris. Le mode de défaillance aurait pu être
-- l'inverse.
--
-- La question est donc posée à qui connaît la réponse. Trois lignes, aucune
-- interprétation : la fonction ne décide rien, elle rend ce que
-- `merx.is_super_admin()` décide — la même expression, exactement, que le garde
-- en tête de `create_tenant()`. Les deux ne peuvent pas diverger, et la RÈGLE
-- « un seul helper » (SPEC § 3) est tenue : le droit se lit toujours à un seul
-- endroit, celui-ci n'est qu'un guichet.
-- ----------------------------------------------------------------------------

create function public.can_create_tenant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select merx.is_super_admin()
$function$;

comment on function public.can_create_tenant() is
  'Guichet PostgREST du garde de create_tenant(). Ne décide rien : rend '
  'merx.is_super_admin(). E1-01.';

revoke execute on function public.can_create_tenant() from public, anon;
grant  execute on function public.can_create_tenant() to authenticated;


-- ----------------------------------------------------------------------------
-- Dernière activité
--
-- E1-01 : « Liste des commerces avec date de création et dernière activité. »
-- `app_user.last_seen_at` existe depuis E0-03 et rien ne l'écrivait : la
-- colonne serait restée nulle, et la colonne « dernière activité » aurait
-- affiché un tiret pour tout le monde.
--
-- L'estampille est posée dans le hook d'émission de jeton, et pas ailleurs.
-- C'est le seul point que *tout* accès traverse — connexion comme
-- rafraîchissement — y compris le rafraîchissement qui suit plusieurs jours
-- hors-ligne (SPEC § 2.5). Le poser dans l'applicatif aurait demandé de
-- l'appeler depuis chaque écran, et d'y penser à chaque écran suivant.
--
-- La fonction passe de `stable` à `volatile` : elle écrit désormais. Le reste
-- est inchangé, et l'ordre importe — l'estampille est posée avant la lecture,
-- de sorte que le jeton en cours d'émission reflète l'activité qu'il constitue.
-- ----------------------------------------------------------------------------

create or replace function merx.custom_access_token(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  found_tenant uuid;
  found_role   public.user_role;
  claims       jsonb;
  metadata     jsonb;
begin
  -- E1-01 : la dernière activité d'un commerce, alimentée par le seul chemin
  -- que tout accès emprunte. Une fiche absente ou désactivée ne met rien à
  -- jour : `where` ne trouve rien, et c'est le comportement voulu — un compte
  -- qu'on a coupé ne doit pas continuer à faire vivre le commerce.
  update public.app_user u
  set last_seen_at = now()
  where u.auth_user_id = (event ->> 'user_id')::uuid
    and u.is_active
    and u.deleted_at is null;

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
  'Hook Supabase Auth : estampille `last_seen_at`, puis dépose tenant_id et '
  'role dans app_metadata. SPEC § 2.1, E0-03, E1-01.';
