-- ============================================================================
-- Merx — gestion des employés : qui entre dans un commerce, et qui n'entre plus
--
-- Référence : docs/SPEC.md § 3 (rôles, RÈGLE un seul helper), § 3.1 (matrice,
--             capacité `manage_users`), § 2.1 (RLS), § 9 M8 (`app_user`),
--             docs/BACKLOG.md E1-02.
--
-- E1-02 est le premier écran interdit à un `worker`. Jusqu'ici, la matrice
-- § 3.1 existait en données et personne ne s'en servait : `manage_users` y
-- figurait sans qu'aucune relation, aucune fonction, aucune route ne la
-- consulte. Cette migration l'accroche à quelque chose.
--
-- Quatre gardes, à quatre niveaux, et ce n'est pas de la redondance : chacun
-- tient un chemin que les autres ne couvrent pas.
--
--   1. la policy restrictive sur `app_user` — tient la lecture et l'écriture
--      directes par PostgREST, y compris un POST écrit à la main ;
--   2. le garde en tête des deux fonctions — tient l'appel RPC, qui contourne
--      la policy puisque les fonctions sont `security definer` ;
--   3. le trigger d'auto-protection — tient ce qu'une policy ne sait pas dire :
--      la comparaison de l'ancienne ligne à la nouvelle ;
--   4. le hook d'émission de jeton — tient la porte d'entrée elle-même.
--
-- La fonction Edge et le garde de route, eux, ne tiennent rien : ils évitent un
-- aller-retour et une page vide. L'autorité est ici.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- `app_user` devient une relation à capacité
--
-- E1-02 : « Un `worker` ne voit pas cet écran. » Masquer la route ne fait pas
-- cela : elle se tape dans la barre d'adresse, et surtout la liste des employés
-- se demande à PostgREST sans passer par aucun écran. Ce qui rend le critère
-- vrai est que la relation elle-même refuse de répondre.
--
-- Le mécanisme est celui de E0-05, sans rien y ajouter :
-- `merx.apply_capability_restriction()` pose une policy **restrictive** —
-- combinée en ET avec l'isolation, elle ne peut que restreindre — et inscrit la
-- table au registre, d'où `supabase/tests/isolation.ts` la relit. Le droit
-- passe donc par `merx.can()`, donc par la matrice § 3.1 (SPEC § 3, RÈGLE un
-- seul helper) : `manage_users` n'est pas un droit inventé ici, c'est la
-- dernière ligne du tableau de § 3.1.
--
-- Conséquence assumée : un `worker` ne lit plus aucune ligne d'`app_user`, pas
-- même la sienne. Rien n'en a besoin — son rôle et son commerce voyagent dans
-- le jeton, pas dans une requête — et E1-04 réserve déjà le journal d'audit au
-- `owner`. La restriction porte sur `for all` : sans `with check`, un employé
-- ne lirait pas la liste mais pourrait s'y ajouter.
--
-- Ce qui écrit `app_user` sans être un utilisateur continue de passer :
-- `public.create_tenant()` (E1-01) et `merx.custom_access_token()` sont
-- `security definer`, donc hors RLS.
-- ----------------------------------------------------------------------------

select merx.apply_capability_restriction('public.app_user', 'manage_users');


-- ----------------------------------------------------------------------------
-- L'utilisateur courant, en fiche
--
-- `merx.current_tenant_id()` rend le commerce du jeton ; il manquait l'autre
-- moitié — la ligne `app_user` de celui qui parle. Elle sert deux fois plus
-- bas : à renseigner `created_by` (SPEC § 4), et à reconnaître l'appelant quand
-- il se vise lui-même.
--
-- `security definer` : la fonction est appelée depuis des contextes où la
-- policy restrictive ci-dessus refuserait la lecture — un `worker` doit pouvoir
-- être identifié même s'il n'a pas le droit de lire la table. Elle ne rend
-- qu'un identifiant, celui de l'appelant, jamais celui d'un autre.
-- ----------------------------------------------------------------------------

create function merx.current_app_user()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select u.id
  from public.app_user u
  where u.auth_user_id = auth.uid()
    and u.deleted_at is null
$function$;

comment on function merx.current_app_user() is
  'Fiche app_user de l''appelant, déduite du jeton. NULL hors session ou sans '
  'fiche. E1-02.';

grant execute on function merx.current_app_user() to authenticated;


-- ----------------------------------------------------------------------------
-- On ne se retire pas son propre rôle
--
-- E1-02 : « Le patron ne peut pas se retirer son propre rôle `owner`. » Un
-- commerce dont le seul patron s'est rétrogradé n'a plus personne pour créer un
-- employé ni pour voir ses marges, et personne ne peut le réparer de
-- l'intérieur — il faut l'éditeur. C'est une porte qui ne se referme pas.
--
-- Ce garde n'est pas une capacité, et il n'a donc rien à faire dans la matrice
-- § 3.1 : celle-ci répond à « ce rôle a-t-il ce droit ? », alors qu'ici la
-- réponse ne dépend pas du rôle. Un patron *a* le droit de gérer les
-- utilisateurs ; ce qu'il ne peut pas, c'est se l'enlever. C'est un invariant de
-- ligne, comme `tenant_self_reference` (E0-03) — donc un trigger.
--
-- Un trigger, et pas une policy, parce qu'une policy ne compare pas l'ancienne
-- ligne à la nouvelle : `with check` ne voit que le résultat. Une policy
-- pourrait dire « pas de ligne `worker` », jamais « pas de passage de `owner` à
-- `worker` sur sa propre ligne ».
--
-- Il couvre les deux façons de se mettre dehors : changer son rôle, et se
-- désactiver. La seconde n'est pas moins définitive — un compte désactivé ne
-- reçoit plus de jeton (plus bas), donc ne peut pas se réactiver.
--
-- `auth.uid()` est NULL hors session : les migrations, les fonctions de service
-- et la restauration d'une sauvegarde passent sans être gênées. La condition la
-- plus importante de ce bloc est celle-là — écrit `old.auth_user_id <>
-- auth.uid()` sans le contrôle de nullité, la comparaison rend NULL, la
-- condition est fausse, et le garde s'appliquerait à des écritures qui n'ont
-- pas d'appelant.
-- ----------------------------------------------------------------------------

create function merx.protect_own_role()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or old.auth_user_id is null
     or old.auth_user_id <> auth.uid() then
    return new;
  end if;

  if new.role <> old.role then
    raise exception 'Vous ne pouvez pas changer votre propre rôle.'
      using errcode = '42501';
  end if;

  if old.is_active and not new.is_active then
    raise exception 'Vous ne pouvez pas désactiver votre propre compte.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

comment on function merx.protect_own_role() is
  'Trigger BEFORE UPDATE sur app_user : personne ne change son propre rôle ni '
  'ne se désactive. E1-02.';

create trigger app_user_protect_own_role
  before update on public.app_user
  for each row execute function merx.protect_own_role();


-- ----------------------------------------------------------------------------
-- `public.create_worker()` — un employé, et rien d'autre
--
-- E1-02 : « Le `owner` crée un `worker` : nom, téléphone, mot de passe. »
--
-- Le rôle n'est pas un paramètre. C'est la décision qui compte dans cette
-- fonction : un `role` transmis par l'appelant, même contrôlé, est une surface
-- d'escalade — il suffit d'un contrôle relâché un jour pour qu'un patron
-- fabrique un `super_admin`, ou qu'un employé se fabrique un patron. Ici la
-- question ne se pose pas : la valeur est écrite dans le corps. Créer un
-- `owner` supplémentaire n'est demandé par aucune story ; le jour où ce le
-- sera, cela s'écrira ici, à un seul endroit.
--
-- Le `tenant_id` n'est pas un paramètre non plus : il vient du jeton signé
-- (SPEC § 2.1 — aucune requête applicative ne filtre le commerce à la main).
-- Un patron ne peut donc pas déposer un employé chez le voisin, quoi qu'il
-- envoie.
--
-- `security definer` pour la même raison qu'en E1-01 : le compte
-- d'authentification est créé par l'API Admin, depuis la fonction Edge, et
-- celle-ci rappelle la base avec le jeton de l'appelant. La fonction s'exécute
-- donc hors RLS — et c'est précisément pourquoi son garde est en première
-- ligne, et pourquoi il est éprouvé par un appel direct à la RPC.
-- ----------------------------------------------------------------------------

create function public.create_worker(
  full_name    text,
  phone        text,
  auth_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target_tenant uuid;
  new_user      uuid;
begin
  -- Le libellé n'est pas celui de la fonction Edge, et la différence est
  -- délibérée. Les deux gardes rendent un 403 au client ; si les deux disaient
  -- la même phrase, rien ne distinguerait celui qui a refusé — et le test du
  -- pré-contrôle Edge serait resté vert le pré-contrôle retiré, la RPC prenant
  -- le refus à son compte sous une réponse identique. C'est la panne de E1-01,
  -- constatée ici par sabotage : garde Edge retiré, 0 test sur 180 tombait.
  --
  -- Ce message-ci n'est vu que lorsqu'on est arrivé jusqu'à la base sans passer
  -- par le pré-contrôle : appel direct à la RPC, ou pré-contrôle défaillant.
  if not merx.can('manage_users') then
    raise exception 'Ce compte n''a pas le droit de créer un employé.'
      using errcode = '42501';
  end if;

  target_tenant := merx.current_tenant_id();
  if target_tenant is null then
    raise exception 'Aucun commerce rattaché à ce compte.'
      using errcode = '42501';
  end if;

  -- SPEC § 2.6 vise le produit et le client, pas ceci : un employé sans nom ne
  -- se distingue pas d'un autre dans une liste, et sans numéro il n'a pas
  -- d'identifiant de connexion — le numéro *est* l'identifiant (E1-01).
  if coalesce(btrim(full_name), '') = '' then
    raise exception 'Le nom de l''employé est obligatoire.' using errcode = '23514';
  end if;

  if coalesce(btrim(phone), '') = '' then
    raise exception 'Le téléphone de l''employé est obligatoire.' using errcode = '23514';
  end if;

  if auth_user_id is null then
    raise exception 'Aucun compte d''authentification fourni.' using errcode = '23514';
  end if;

  insert into public.app_user (tenant_id, auth_user_id, full_name, phone, role, created_by)
  values (
    target_tenant,
    auth_user_id,
    btrim(full_name),
    btrim(phone),
    'worker',
    merx.current_app_user()
  )
  returning id into new_user;

  return new_user;
end;
$function$;

comment on function public.create_worker(text, text, uuid) is
  'Crée un employé dans le commerce de l''appelant. Le rôle et le commerce ne '
  'sont pas des paramètres. Exige la capacité manage_users. E1-02, SPEC § 3.1.';

-- PostgREST expose toute fonction de `public`, et les ACL par défaut de
-- Supabase l'accordent à `anon`. Le garde suffirait — un appelant anonyme n'a
-- aucune capacité — mais un privilège qu'aucune vérification ne rattrape est un
-- accident qui attend une modification.
revoke execute on function public.create_worker(text, text, uuid) from public, anon;
grant  execute on function public.create_worker(text, text, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- `public.set_user_active()` — désactiver sans supprimer
--
-- E1-02 : « Il peut désactiver un compte sans le supprimer. » La distinction
-- n'est pas de la prudence : les documents, les mouvements et les écritures
-- portent `created_by`, et un employé supprimé emporterait la réponse à « qui a
-- fait ce bon ? ». `is_active` coupe l'accès, la fiche reste.
--
-- Le garde de sa première ligne fait double emploi avec la policy restrictive —
-- volontairement : la fonction est `security definer`, donc la policy ne
-- s'applique pas à elle. Sans ce garde, un `worker` réactiverait par RPC un
-- compte que le patron vient de couper.
--
-- Le refus de se viser soi-même double le trigger, et les deux n'arrêtent pas
-- au même endroit : la fonction refuse avant d'écrire, le trigger refuse même
-- un `PATCH` écrit à la main, qui ne passe par aucune fonction. Les messages
-- diffèrent pour que chaque test sache lequel des deux l'a arrêté.
-- ----------------------------------------------------------------------------

create function public.set_user_active(target_user uuid, active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not merx.can('manage_users') then
    raise exception 'Seul le patron modifie un employé.'
      using errcode = '42501';
  end if;

  if target_user is null then
    raise exception 'Aucun employé désigné.' using errcode = '23514';
  end if;

  if target_user = merx.current_app_user() then
    raise exception 'Vous ne pouvez pas désactiver votre propre compte depuis cet écran.'
      using errcode = '42501';
  end if;

  -- Le commerce vient du jeton, jamais de l'appelant : la fonction s'exécute
  -- hors RLS, la frontière est donc réécrite ici, à la main, et une seule fois.
  update public.app_user u
  set is_active = active
  where u.id = target_user
    and u.deleted_at is null
    and (u.tenant_id = merx.current_tenant_id() or merx.is_super_admin());

  if not found then
    -- Le même refus qu'une ligne appartenant à un autre commerce : dire
    -- « introuvable » plutôt que « pas à vous » évite de confirmer l'existence
    -- d'une fiche qu'on n'a pas le droit de voir.
    raise exception 'Employé introuvable.' using errcode = 'P0002';
  end if;
end;
$function$;

comment on function public.set_user_active(uuid, boolean) is
  'Active ou désactive un employé du commerce de l''appelant. Exige la '
  'capacité manage_users. E1-02.';

revoke execute on function public.set_user_active(uuid, boolean) from public, anon;
grant  execute on function public.set_user_active(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- `public.can_manage_users()` — la même question, posée avant d'agir
--
-- Le guichet de E1-01, reposé pour cette capacité et pour la même raison : la
-- fonction Edge doit savoir si l'appelant a le droit **avant** de créer un
-- compte d'authentification, sinon un employé qui tente sa chance fait naître
-- un compte que l'étape suivante refusera et qu'il faudra supprimer.
--
-- Elle ne peut pas lire ce droit dans le jeton elle-même : les bibliothèques
-- clientes ne rendent pas les claims déposés par le hook de façon stable (voir
-- `create-tenant/index.ts`). La question est donc posée à qui connaît la
-- réponse, et la fonction ne décide rien — elle rend `merx.can()`, la même
-- expression que le garde en tête de `create_worker()`.
-- ----------------------------------------------------------------------------

create function public.can_manage_users()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select merx.can('manage_users')
$function$;

comment on function public.can_manage_users() is
  'Guichet PostgREST de la capacité manage_users. Ne décide rien : rend '
  'merx.can(). E1-02.';

revoke execute on function public.can_manage_users() from public, anon;
grant  execute on function public.can_manage_users() to authenticated;


-- ----------------------------------------------------------------------------
-- Un compte désactivé ne se connecte plus
--
-- E1-02, troisième critère. Jusqu'ici, une fiche désactivée obtenait un jeton
-- sans claims : la session s'ouvrait, aucune ligne n'était lisible, et le front
-- déconnectait l'utilisateur en le lui expliquant (E0-04). C'était une
-- application vide, pas un refus — et cela ne tenait que tant que l'accès
-- passait par le front. Un jeton émis reste un jeton émis.
--
-- Le refus est donc posé là où il ne se contourne pas : le hook d'émission,
-- seul chemin vers une session — connexion **comme rafraîchissement**. Le
-- second point est celui qui compte en exploitation : un employé coupé à 14 h
-- sort au renouvellement suivant de son jeton, pas en fin de journée, et sans
-- qu'on ait à révoquer quoi que ce soit.
--
-- La distinction entre les deux absences compte, et elle est conservée :
--
--   fiche absente      — le jeton part sans claims. C'est le cas de tout compte
--                        d'authentification créé mais pas encore rattaché : le
--                        refuser casserait la création de commerce, qui crée le
--                        compte avant la fiche (E1-01).
--   fiche désactivée   — le jeton n'est pas émis. Quelqu'un a décidé que ce
--   ou supprimée         compte n'entre plus.
--
-- Le message est celui que l'employé lira. BRAND-UI § 6 : il dit ce qui s'est
-- passé et à qui s'adresser, il ne s'excuse pas.
-- ----------------------------------------------------------------------------

create or replace function merx.custom_access_token(event jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  found_user public.app_user;
  claims     jsonb;
  metadata   jsonb;
begin
  select u.* into found_user
  from public.app_user u
  where u.auth_user_id = (event ->> 'user_id')::uuid;

  -- E1-02 : le compte existe, et il a été coupé. Aucun jeton n'est émis.
  if found_user.id is not null
     and (not found_user.is_active or found_user.deleted_at is not null) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Ce compte a été désactivé. Contactez votre responsable.'));
  end if;

  -- E1-01 : la dernière activité d'un commerce, alimentée par le seul chemin
  -- que tout accès emprunte. L'estampille est posée avant la lecture des
  -- claims, de sorte que le jeton en cours d'émission reflète l'activité qu'il
  -- constitue.
  if found_user.id is not null then
    update public.app_user u
    set last_seen_at = now()
    where u.id = found_user.id;
  end if;

  claims   := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb);

  -- Retirées d'abord, systématiquement : un jeton renouvelé ne doit jamais
  -- conserver le tenant d'une fiche entre-temps supprimée ou désactivée.
  metadata := metadata - 'tenant_id' - 'role';

  /*
   * La condition répète `is_active` et `deleted_at`, que le refus plus haut a
   * déjà examinés. Ce n'est pas une redondance : les deux répondent à deux
   * questions, et E0-03 tient la seconde depuis avant E1-02 — « une fiche
   * désactivée ne donne aucun claim ». Les fondre en un seul test les rendrait
   * solidaires, et adoucir un jour le refus (le restreindre aux fiches
   * supprimées, par exemple) rendrait au compte désactivé un jeton **complet**,
   * avec son commerce et son rôle. Constaté par sabotage : le refus retiré, la
   * fiche désactivée repartait avec `role` et `tenant_id`.
   */
  if found_user.id is not null
     and found_user.is_active
     and found_user.deleted_at is null then
    metadata := metadata || jsonb_build_object(
      'tenant_id', found_user.tenant_id,
      'role',      found_user.role);
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
  'Hook Supabase Auth : refuse le jeton d''un compte désactivé, estampille '
  'last_seen_at, puis dépose tenant_id et role dans app_metadata. '
  'SPEC § 2.1, E0-03, E1-01, E1-02.';
