-- ============================================================================
-- Merx — le dépôt par défaut, garanti par la base
--
-- Référence : docs/SPEC.md § 2.4 (dépôt unique, « créée automatiquement »),
--             § 4 (conventions) ; E1-01, E3-02.
--
-- SPEC § 2.4 dit du dépôt : « Une seule ligne par commerce, créée
-- automatiquement, jamais exposée. » Jusqu'ici « automatiquement » voulait dire
-- « par `create_tenant()` », et rien d'autre ne l'imposait : douze jeux d'essai
-- montaient un commerce à la main, sans dépôt, et personne ne s'en apercevait
-- parce que rien n'en dépendait.
--
-- E3-02 en a fait dépendre quelque chose — la naissance d'une variante ouvre sa
-- ligne de `stock_level` sur le dépôt du commerce — et les douze se sont mis à
-- échouer d'un coup. Les réparer un par un aurait réparé les douze d'aujourd'hui
-- et aucun de ceux de demain.
--
-- L'invariant descend donc dans la base : un trigger sur `tenant`, et
-- `create_tenant()` cesse d'écrire le dépôt lui-même. **Une seule source.**
-- Deux écrivains auraient produit deux lignes, que
-- `warehouse_one_default_per_tenant` aurait refusées — l'ancien `insert` est
-- donc retiré dans la même migration, pas plus tard.
--
-- Même geste qu'en E2-01 pour « tout produit a au moins une variante » : ce que
-- la base garantit n'a pas à être redit par chaque appelant.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Le trigger
--
-- `security definer` : le dépôt doit naître même quand l'appelant ne pourrait
-- pas l'écrire lui-même. `create_tenant()` tourne déjà sous `postgres`, mais un
-- commerce inséré autrement — un jeu d'essai, une reprise de données — ne doit
-- pas dépendre des droits de celui qui l'insère pour obtenir un dépôt. Le corps
-- n'écrit que pour le commerce qui vient de naître : `new.id`, jamais une
-- valeur venue de l'appelant.
--
-- AFTER INSERT, et non BEFORE : `tenant_self_reference` (E0-03) aligne
-- `tenant_id` sur `id` en BEFORE, et la clé étrangère du dépôt vise un commerce
-- qui doit exister.
--
-- `on conflict do nothing` sur l'index partiel : un commerce qui aurait déjà
-- son dépôt — une reprise de données qui les insère ensemble — n'échoue pas. Le
-- trigger garantit *au moins* un dépôt par défaut ; l'index en garantit *au
-- plus* un. Les deux ensemble en font exactement un.
-- ----------------------------------------------------------------------------

create function merx.open_default_warehouse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Son nom n'apparaît nulle part (SPEC § 2.4) ; la colonne est NOT NULL, il
  -- faut bien y écrire quelque chose.
  insert into public.warehouse (tenant_id, name, is_default)
  values (new.id, 'Dépôt', true)
  on conflict do nothing;

  return null;
end;
$function$;

comment on function merx.open_default_warehouse() is
  'Ouvre l''unique dépôt d''un commerce à sa création. SPEC § 2.4, « créée '
  'automatiquement » — pour tout commerce, pas seulement ceux que '
  'create_tenant() installe. E3-02.';

create trigger open_default_warehouse
  after insert on public.tenant
  for each row execute function merx.open_default_warehouse();


-- ----------------------------------------------------------------------------
-- `create_tenant()` cesse d'écrire le dépôt
--
-- Le corps est celui de **la dernière version en date** — celle d'E1-05, qui
-- appelle `merx.seed_tenant_settings()` —, à cette ligne près. Rendu en entier
-- parce qu'une fonction se remplace en entier, et additivement : les migrations
-- d'origine restent le récit de ce qu'elles ont appliqué (CLAUDE.md).
--
-- Repartir du corps d'E1-01 aurait effacé E1-05 sans rien dire : la fonction
-- aurait compilé, créé son commerce, et cessé d'en semer les réglages. Attrapé
-- par `settings.test.ts`, qui lit un réglage après création — pas par la
-- relecture. Toute prochaine reprise de cette fonction part de la plus récente,
-- jamais de la première.
-- ----------------------------------------------------------------------------

create or replace function public.create_tenant(
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

  -- Le dépôt n'est plus créé ici : `merx.open_default_warehouse()`, trigger sur
  -- `tenant`, s'en charge pour **tout** commerce, par quelque chemin qu'il
  -- naisse. Une seule source, pas deux. E3-02.

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

  -- E1-05. Les réglages, dans la même transaction que le reste : l'en-tête du
  -- premier ticket reprend le nom et le téléphone saisis à l'instant.
  perform merx.seed_tenant_settings(new_tenant);

  return new_tenant;
end;
$function$;

comment on function public.create_tenant(text, text, text, text, uuid) is
  'Crée un commerce et sa population initiale — appareil, patron — en une '
  'transaction. Le dépôt naît du trigger open_default_warehouse. Réservée à '
  'super_admin. E1-01, revu en E3-02.';
