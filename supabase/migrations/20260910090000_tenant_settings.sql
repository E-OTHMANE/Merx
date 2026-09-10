-- ============================================================================
-- Merx — les réglages du commerce, et leurs défauts
--
-- Référence : docs/SPEC.md § 2.1 (RLS), § 2.6 (aucun champ imposé), § 2.8
--             (langues), § 3 + § 3.1 (matrice, capacité `manage_settings`,
--             RÈGLE un seul helper), § 4 (conventions, placement des schémas),
--             § 9 M8 (`tenant_setting`), docs/BACKLOG.md E1-05, E5-01, E11-01.
--
-- Le critère qui porte la story n'est pas la table : c'est que l'application
-- fonctionne sans que personne n'ouvre cet écran. Un commerçant qui vend toute
-- l'année sans jamais aller dans les paramètres doit imprimer ses bons et lire
-- son interface comme si quelqu'un les avait réglés pour lui.
--
-- Donc la question centrale est celle des défauts, et surtout celle de leur
-- emplacement : deux sources de vérité pour un même défaut divergent, toujours,
-- et la divergence se lit comme un réglage qu'on n'a pas fait.
--
-- La réponse tient en trois pièces :
--
--   1. `merx.setting_default` — une ligne par clé. C'est **la** source, et il
--      n'y en a pas d'autre. Le code applicatif ne porte aucune valeur de
--      repli : `src/modules/admin/settings.ts` lit des lignes, il n'en invente
--      aucune.
--
--   2. `merx.seed_tenant_settings()` — lit ce registre et matérialise les
--      lignes manquantes d'un commerce. Appelée à la création du commerce, et
--      en rattrapage plus bas sur ceux qui existent déjà.
--
--   3. L'invariant qui en découle : **tout commerce a une ligne pour chaque
--      clé, dès sa création**. Rien n'est donc jamais à combler à la lecture,
--      et l'application n'écrit que des UPDATE sur des lignes existantes —
--      elle n'a même pas à connaître son `tenant_id` (SPEC § 2.1).
--
-- Conséquence pour la suite, et elle est écrite ici parce qu'elle sera oubliée
-- ailleurs : **toute migration qui ajoute une clé à `public.setting_key` ajoute
-- sa ligne à `merx.setting_default` et rappelle `merx.seed_tenant_settings()`
-- sur tous les commerces.** Sans ce rattrapage, la clé neuve n'existe que pour
-- les commerces créés après elle, et l'application se met à rencontrer une
-- absence qu'elle ne rencontrait jamais — c'est-à-dire le cas qu'aucun écran
-- ne sait traiter.
--
-- Ni E5 (impression) ni E11 (langues) ne sont construits ici. Les réglages sont
-- stockés, modifiables, et déjà bons par défaut ; les lire pour imprimer un
-- ticket ou basculer une interface appartient à ces étapes-là.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Les clés de la V1, en type
--
-- SPEC § 9 M8 donne la forme — `key`, `value jsonb` — et E1-05 la liste :
-- « nom et coordonnées à imprimer, langue par défaut, adresse de l'imprimante
-- réseau ». Trois clés, closes, connues d'avance.
--
-- Un enum, et pas du texte libre, pour la raison de CLAUDE.md : le générateur
-- de lignes de `supabase/tests/isolation.ts` déduit ses valeurs du catalogue
-- Postgres. Il sait lire les étiquettes d'un enum ; une contrainte de forme lui
-- est opaque, et la table sortirait du balayage d'isolation en silence — le
-- pire des deux mondes, une table métier que plus rien ne vérifie.
--
-- L'en-tête d'impression est **une** clé et non trois : le nom, le téléphone et
-- l'adresse forment un seul bloc, s'éditent ensemble et s'impriment ensemble
-- (E5-01). Trois clés, ce serait trois lignes à tenir cohérentes pour un seul
-- pavé de papier.
-- ----------------------------------------------------------------------------

create type public.setting_key as enum (
  'print_header',      -- nom et coordonnées imprimés en tête du bon   (E5-01)
  'default_language',  -- langue du commerce, 'fr' ou 'ar'             (E11-01)
  'printer_address'    -- imprimante thermique réseau, hôte:port       (E5-01)
);

comment on type public.setting_key is
  'Les réglages du commerce, SPEC § 9 M8 et E1-05. Une clé ajoutée ici exige '
  'sa ligne dans merx.setting_default et un rappel de '
  'merx.seed_tenant_settings() sur tous les commerces.';


-- ----------------------------------------------------------------------------
-- Écriture restreinte par capacité — le mécanisme, réutilisable
--
-- `merx.apply_capability_restriction()` (E0-05) restreint les **quatre**
-- opérations : c'est ce qu'il faut pour un coût, que personne ne doit lire.
-- Ici la situation est l'inverse, et c'est la première fois qu'elle se présente
-- dans le projet : la lecture est ouverte à tout le commerce, seule l'écriture
-- est réservée. Poser `apply_capability_restriction()` fermerait les deux.
--
-- Le mécanisme est donc écrit une fois, avec son registre, comme
-- `merx.apply_append_only()` en E1-04 — et pour la même raison : ce n'est pas
-- la dernière table du projet dont un employé lira les valeurs sans pouvoir les
-- changer. Les prix de vente (E2-03, `manage_price_list`) et les plafonds de
-- crédit (E6, `set_credit_limit`) ont exactement cette forme.
--
-- Le registre n'est pas décoratif : `supabase/tests/isolation.ts` en dérive les
-- policies qu'il exige, et `supabase/tests/settings.test.ts` en dérive le
-- balayage de comportement. Une table qui s'y inscrit est vérifiée des deux
-- façons sans qu'une ligne de test change.
--
-- **Trois** policies et non une seule, parce qu'une policy porte une seule
-- commande. La tentation serait d'écrire une restrictive `for all` avec
-- `using (true)` et `with check (merx.can(...))` : elle laisserait passer le
-- DELETE, qui n'a pas de `with check`. Une porte sur trois, silencieuse.
--
-- Restrictives, donc combinées en ET avec les permissives d'isolation : elles
-- ne peuvent qu'ajouter une condition, jamais élargir ce que `tenant_isolation`
-- laisse passer. Une permissive de plus aurait été un OU.
--
-- Pas de trigger en doublon de ces policies, et c'est délibéré : un trigger qui
-- interroge `merx.can()` se déclencherait aussi pour `postgres`, qui peuple les
-- deux commerces du balayage d'isolation sans jeton — la suite échouerait sur
-- une cause sans rapport avec ce qu'elle mesure. Les policies, elles, ne
-- s'appliquent pas à un rôle BYPASSRLS.
-- ----------------------------------------------------------------------------

create table merx.write_capability_registry (
  table_name text primary key,
  capability text not null
);

comment on table merx.write_capability_registry is
  'Tables lisibles par tout le commerce mais dont l''écriture exige une '
  'capacité, et laquelle. SPEC § 3.1 ; E1-05.';


create function merx.apply_write_capability_restriction(
  target regclass,
  required_capability text
)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  -- Même précaution qu'en E0-05 : une policy qui interroge une capacité
  -- inexistante est toujours fausse, donc verrouille la table en silence.
  -- Mieux vaut refuser la migration.
  if not exists (
    select 1 from merx.role_capability rc where rc.capability = required_capability
  ) then
    raise exception
      'Capacité inconnue : %. Elle doit figurer dans merx.role_capability (SPEC § 3.1).',
      required_capability;
  end if;

  -- INSERT n'a pas de `using` : il n'y a pas de ligne existante à qualifier.
  execute format($ddl$
    create policy write_capability_insert on %s
      as restrictive for insert to authenticated
      with check (merx.can(%L))
  $ddl$, target, required_capability);

  -- UPDATE en a deux, et les deux comptent : `using` décide quelles lignes sont
  -- modifiables, `with check` ce qu'elles peuvent devenir.
  execute format($ddl$
    create policy write_capability_update on %s
      as restrictive for update to authenticated
      using (merx.can(%L))
      with check (merx.can(%L))
  $ddl$, target, required_capability, required_capability);

  -- DELETE n'a pas de `with check` : il ne produit aucune ligne.
  execute format($ddl$
    create policy write_capability_delete on %s
      as restrictive for delete to authenticated
      using (merx.can(%L))
  $ddl$, target, required_capability);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.write_capability_registry (table_name, capability)
  values (table_name, required_capability);
end;
$function$;

comment on function merx.apply_write_capability_restriction(regclass, text) is
  'Réserve l''écriture d''une table à une capacité, sans toucher à sa lecture. '
  'Trois policies restrictives — insert, update, delete — et inscription au '
  'registre. SPEC § 3.1, E1-05.';


-- ----------------------------------------------------------------------------
-- La capacité de réglage
--
-- E1-05 : « En tant que patron, je veux régler ce qui est propre à mon
-- commerce. » Une ligne de plus dans la matrice § 3.1, ajoutée au spec avec
-- cette story — même procédé qu'`manage_devices` (E1-03) et `view_audit_log`
-- (E1-04). Le droit reste gouverné par la matrice (SPEC § 3, RÈGLE un seul
-- helper), et `permissions.test.ts` compare la ligne à sa copie de
-- `src/lib/auth/permissions.ts`.
-- ----------------------------------------------------------------------------

insert into merx.role_capability (capability, role) values
  -- Régler les paramètres du commerce
  ('manage_settings', 'owner');


-- ----------------------------------------------------------------------------
-- `public.tenant_setting`
--
-- Les colonnes du spec § 9 M8, et rien de plus. Les conventions apportent
-- `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `device_id`, la
-- RLS et ses deux policies (SPEC § 4, § 2.1).
--
-- Conventions **métier** et non « référence » : pas de `deleted_at`. Un réglage
-- ne se supprime pas en douceur, il se change — et une clé absente n'est pas un
-- état que l'application doit savoir lire (voir l'invariant en tête de
-- fichier).
--
-- **Aucune contrainte croisée entre `key` et `value`** — ni `check`, ni
-- trigger. C'est le piège de CLAUDE.md, dans sa version la plus discrète : le
-- générateur de lignes du balayage d'isolation écrit `'{}'::jsonb` dans toute
-- colonne jsonb, et une contrainte de forme le ferait échouer — ou, si on
-- « corrigeait » en sortant la table du balayage, laisserait `tenant_setting`
-- sans vérification d'isolation du tout. La contrepartie est assumée et
-- compensée côté lecture : un réglage illisible désactive sa fonction en
-- silence (SPEC § 2.6), il ne casse rien et ne réclame rien.
-- ----------------------------------------------------------------------------

create table public.tenant_setting (
  id    uuid primary key default gen_random_uuid(),
  key   public.setting_key not null,
  value jsonb not null
);

select merx.apply_business_conventions('public.tenant_setting');

comment on table public.tenant_setting is
  'Les réglages d''un commerce, une ligne par clé, toujours toutes présentes. '
  'Lue par tout le commerce, écrite par le patron seul. SPEC § 9 M8 ; E1-05.';

comment on column public.tenant_setting.value is
  'La valeur, en jsonb. Aucune contrainte de forme : elle sortirait la table du '
  'balayage d''isolation, dont le générateur de lignes écrit {}. Un réglage '
  'illisible désactive sa fonction en silence (SPEC § 2.6).';

-- Une clé au plus par commerce. C'est aussi ce qui rend
-- `merx.seed_tenant_settings()` idempotente : son `on conflict` s'appuie
-- dessus.
create unique index tenant_setting_key_per_tenant
  on public.tenant_setting (tenant_id, key);

/*
 * L'écriture exige `manage_settings`. La lecture n'exige rien de plus que
 * d'appartenir au commerce — voir le commentaire posé sur les policies
 * ci-dessous, qui est là pour que personne ne prenne cette ouverture pour un
 * oubli.
 */
select merx.apply_write_capability_restriction('public.tenant_setting', 'manage_settings');

/*
 * Pourquoi l'employé lit ce que seul le patron écrit.
 *
 * C'est la première table du projet dans ce cas : `device` et `audit_log` sont
 * fermées à la lecture d'un `worker`, les relations de coût le seront aussi
 * (E2, E8). Sans ce commentaire, l'absence de `capability_restriction` ici se
 * lirait comme une restriction qu'on a oublié de poser.
 *
 * Elle est délibérée, et deux fonctions de la V1 en dépendent :
 *
 *   `print_header` et `printer_address` — c'est l'employé qui vend au comptoir
 *   et qui imprime le bon (E5-01). Un ticket sans en-tête de commerce, ou une
 *   impression qui ne trouve pas l'imprimante parce que la ligne lui est
 *   invisible, c'est la vente qu'on bloque — SPEC § 2.6, RÈGLE : rien ne bloque
 *   une vente.
 *
 *   `default_language` — c'est la langue dans laquelle il travaille (E11-01,
 *   SPEC § 2.8). Un employé arabophone devant une interface française parce que
 *   le réglage ne lui est pas lisible, c'est le retour au carnet.
 *
 * Ce que l'employé ne doit pas pouvoir faire, c'est **changer** l'adresse de
 * l'imprimante ou l'en-tête qui part chez le client. D'où les trois policies
 * d'écriture, et rien sur la lecture.
 */
do $migration$
declare
  policy_name text;
  reason      constant text :=
    'Écrire un réglage exige manage_settings ; le lire n''exige rien de plus '
    'que d''appartenir au commerce. L''employé imprime le bon — en-tête et '
    'adresse d''imprimante, E5-01 — et travaille dans la langue du commerce '
    '(E11-01) : lui fermer la lecture bloquerait la vente, ce que SPEC § 2.6 '
    'refuse. L''absence de capability_restriction ici est une décision, pas un '
    'oubli.';
begin
  foreach policy_name in array array[
    'write_capability_insert', 'write_capability_update', 'write_capability_delete'
  ] loop
    execute format(
      'comment on policy %I on public.tenant_setting is %L', policy_name, reason);
  end loop;
end;
$migration$;

/*
 * L'index de lecture. L'application demande toujours tous les réglages de son
 * commerce d'un coup — il y en a trois — et l'index de `tenant_id` posé par les
 * conventions y suffit. L'index unique ci-dessus sert le second accès, par clé.
 * Rien de plus n'est ajouté : un index qu'aucune requête n'emprunte est un coût
 * d'écriture sans contrepartie.
 */


-- ----------------------------------------------------------------------------
-- `merx.setting_default` — les défauts, à un seul endroit
--
-- Dans `merx` : ce n'est pas du métier, l'API ne l'expose pas, et aucun
-- commerce n'en possède les lignes (SPEC § 4, RÈGLE de placement des schémas).
--
-- Le contenu de ces trois lignes est ce qui décide si un commerçant qui
-- n'ouvre jamais l'écran peut vendre :
--
--   `default_language` — « fr ». SPEC § 2.8 met les deux langues sur le même
--   plan sans désigner de défaut ; l'arabe se choisit, il ne s'impose pas tant
--   que E11 n'a pas traduit l'interface. Un défaut « ar » afficherait du
--   français dans une coquille RTL, ce qui est pire que les deux.
--
--   `printer_address` — vide. Il n'y a pas de valeur plausible pour l'adresse
--   d'une imprimante qu'on n'a pas vue, et en inventer une ferait échouer
--   l'impression avec un délai d'attente réseau plutôt qu'avec une absence. Le
--   défaut utilisable, ici, c'est « pas d'imprimante » : l'impression réseau ne
--   s'offre pas, elle ne réclame rien, et le bon reste enregistré (E5-01 :
--   « échec d'impression non bloquant »).
--
--   `print_header` — la forme, que `merx.seed_tenant_settings()` remplit avec
--   ce que le commerce a déjà dit de lui à l'inscription. Les trois champs sont
--   présents et vides plutôt qu'absents : l'écran de réglage montre trois
--   champs à remplir, jamais une clé manquante à deviner.
-- ----------------------------------------------------------------------------

create table merx.setting_default (
  key   public.setting_key primary key,
  value jsonb not null
);

comment on table merx.setting_default is
  'La valeur par défaut de chaque réglage — la seule source. Le code '
  'applicatif n''en porte aucune. E1-05.';

insert into merx.setting_default (key, value) values
  ('print_header',     '{"business_name": "", "phone": "", "address": ""}'::jsonb),
  ('default_language', '"fr"'::jsonb),
  ('printer_address',  '""'::jsonb);


-- ----------------------------------------------------------------------------
-- `merx.seed_tenant_settings()` — les lignes manquantes, jamais les autres
--
-- `on conflict do nothing` : la fonction complète, elle n'écrase pas. C'est ce
-- qui permet de l'appeler en rattrapage sur un commerce vivant sans effacer les
-- réglages que le patron a choisis — et de la rappeler à chaque ajout de clé.
--
-- L'en-tête d'impression est le seul défaut dérivé : il est repris de la ligne
-- `tenant`, que la fonction a déjà sous la main. Ce n'est pas une seconde
-- source de défauts — le registre donne la forme et la valeur de repli, le
-- commerce donne le contenu quand il en a un. `jsonb_strip_nulls` est ce qui
-- tient cette distinction : un téléphone absent laisse la chaîne vide du
-- registre au lieu d'y écrire `null`, et l'écran continue de montrer un champ
-- vide plutôt qu'une valeur nulle à interpréter.
--
-- Dans `merx`, `security definer`, non exécutable par `authenticated` : c'est
-- un outil de migration et de création de commerce, pas une action d'utilisateur.
-- ----------------------------------------------------------------------------

create function merx.seed_tenant_settings(target_tenant uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  commerce public.tenant%rowtype;
begin
  if target_tenant is null then
    raise exception 'Aucun commerce désigné.' using errcode = '23514';
  end if;

  select * into commerce from public.tenant t where t.id = target_tenant;

  if not found then
    raise exception 'Commerce introuvable : %.', target_tenant using errcode = 'P0002';
  end if;

  insert into public.tenant_setting (tenant_id, key, value)
  select target_tenant,
         d.key,
         case d.key
           when 'print_header' then d.value || pg_catalog.jsonb_strip_nulls(
             pg_catalog.jsonb_build_object(
               'business_name', commerce.business_name,
               'phone',         commerce.phone,
               'address',       commerce.city))
           else d.value
         end
  from merx.setting_default d
  on conflict (tenant_id, key) do nothing;
end;
$function$;

comment on function merx.seed_tenant_settings(uuid) is
  'Matérialise les réglages manquants d''un commerce depuis '
  'merx.setting_default. Idempotente, n''écrase aucune valeur choisie. '
  'À rappeler sur tous les commerces à chaque ajout de clé. E1-05.';

revoke execute on function merx.seed_tenant_settings(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- Un commerce naît réglé
--
-- E1-01 montait le commerce entier d'un seul geste — commerce, dépôt, appareil,
-- patron. Il lui manquait ses réglages, et c'est là qu'ils doivent naître :
-- dans la même transaction, avec le nom et le téléphone que l'éditeur vient de
-- saisir. Un commerce créé sans réglages est un commerce dont le premier ticket
-- sort anonyme.
--
-- La fonction est reprise à l'identique, à une ligne près — c'est le prix d'un
-- `create or replace`, et il est préférable à une seconde fonction qui ferait
-- la même chose une ligne plus loin.
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

  -- E1-05. Les réglages, dans la même transaction que le reste : l'en-tête du
  -- premier ticket reprend le nom et le téléphone saisis à l'instant.
  perform merx.seed_tenant_settings(new_tenant);

  return new_tenant;
end;
$function$;

comment on function public.create_tenant(text, text, text, text, uuid) is
  'Crée un commerce et sa population initiale — dépôt, appareil, patron, '
  'réglages — en une transaction. Réservée à super_admin. E1-01, E1-05, '
  'SPEC § 2.4, § 9 M8.';


-- ----------------------------------------------------------------------------
-- Le rattrapage
--
-- Les commerces créés avant cette migration n'ont pas de réglages, et
-- l'invariant « tout commerce a toutes ses clés » serait faux dès la première
-- ligne s'il n'était pas rétabli ici. C'est le geste que toute migration
-- ajoutant une clé devra répéter.
-- ----------------------------------------------------------------------------

do $migration$
declare
  existing uuid;
begin
  for existing in select id from public.tenant loop
    perform merx.seed_tenant_settings(existing);
  end loop;
end;
$migration$;
