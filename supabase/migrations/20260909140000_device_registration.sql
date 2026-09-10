-- ============================================================================
-- Merx — l'appareil s'enregistre, et sa lettre ne se donne qu'une fois
--
-- Référence : docs/SPEC.md § 2.5 (RÈGLE numérotation), § 2.1 (RLS), § 3 +
--             § 3.1 (matrice, capacité `manage_devices`), § 4 (conventions),
--             § 9 M8 (`device`), docs/BACKLOG.md E1-03, E4-02.
--
-- E1-01 a posé la table, le type `device_prefix` et le premier appareil du
-- commerce, en « A ». Il manquait l'essentiel : l'attribution des suivants, et
-- la garantie qu'aucun commerce ne peut donner deux fois la même lettre.
--
-- Ce que la lettre porte se lit en E4-02 : un numéro de document est
-- `BL-A-0001`, attribué **localement**, sans que le serveur en sache rien
-- (SPEC § 2.5, RÈGLE). Deux appareils d'un même commerce qui partagent une
-- lettre fabriquent donc deux `BL-B-0001` distincts, chacun sur sa propre
-- tablette, chacun légitime — et personne ne s'en aperçoit avant la
-- synchronisation, c'est-à-dire des jours plus tard, sur des bons déjà remis à
-- des clients. C'est irréparable : on ne renumérote pas un papier signé.
--
-- L'unicité est donc tenue à deux niveaux, et ils ne font pas le même travail :
--
--   l'index unique   — l'autorité. Aucun chemin d'écriture ne lui échappe, pas
--                      même un INSERT direct ni la synchronisation de E10. Il
--                      rend le doublon impossible, au prix d'une erreur.
--   le verrou        — le confort. Il sérialise l'attribution *par commerce*,
--   consultatif        de sorte que deux enregistrements simultanés donnent
--                      « B » et « C » au lieu d'un succès et d'un échec.
--
-- Retirer le verrou laisse l'unicité intacte et casse la simultanéité ; retirer
-- l'index laisse la simultanéité intacte et casse l'unicité. Les deux tests
-- correspondants tombent séparément (supabase/tests/device-registration.test.ts).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Une lettre attribuée l'est définitivement
--
-- E1-01 posait `device_prefix_per_tenant` avec un `where deleted_at is null` :
-- l'unicité ne portait que sur les appareils vivants, et supprimer un appareil
-- rendait sa lettre au stock.
--
-- C'est un doublon à retardement. Un appareil supprimé emporte sa ligne, pas
-- ses numéros : les `BL-B-0001` qu'il a produits restent en base et sur le
-- papier du client (SPEC § 4 — « Documents et mouvements jamais supprimés »).
-- Redonner « B » à une tablette neuve, six mois plus tard, la ferait
-- recommencer à `BL-B-0001`. La collision ne se produirait pas à
-- l'enregistrement, où on la verrait, mais au premier bon, contre un historique
-- que plus personne ne regarde.
--
-- L'index devient donc total. Il ne dit plus « deux appareils vivants n'ont pas
-- la même lettre » mais « ce commerce n'a jamais donné cette lettre deux fois »,
-- ce qui est la propriété dont E4-02 a besoin.
-- ----------------------------------------------------------------------------

drop index public.device_prefix_per_tenant;

create unique index device_prefix_per_tenant
  on public.device (tenant_id, prefix);

comment on index public.device_prefix_per_tenant is
  'Un préfixe n''est donné qu''une fois par commerce, y compris à une ligne '
  'désactivée ou supprimée : les documents qu''elle a numérotés lui survivent. '
  'SPEC § 2.5, RÈGLE numérotation ; E4-02.';


-- ----------------------------------------------------------------------------
-- `merx.next_device_prefix()` — la prochaine lettre libre, sous verrou
--
-- Le calcul est un lire-puis-écrire, et c'est là qu'est le piège. Sous
-- `READ COMMITTED` — le niveau par défaut, celui sous lequel PostgREST
-- travaille — deux transactions simultanées lisent le même ensemble de lettres
-- prises, n'y voient ni l'une ni l'autre la ligne que l'autre n'a pas encore
-- validée, et choisissent toutes deux « B ». L'index arrête la seconde, mais il
-- l'arrête par une erreur : l'appareil du vendeur ne s'enregistre pas.
--
-- `pg_advisory_xact_lock` rend la paire atomique. Le verrou est pris avant la
-- lecture et tenu jusqu'au commit : la seconde transaction attend, relit un
-- ensemble où « B » figure, et prend « C ». Aucune des deux ne repart en erreur.
--
-- Le verrou porte sur le `tenant_id`, jamais sur la table : deux commerces
-- s'enregistrent en parallèle sans jamais s'attendre. C'est ce qui permet de le
-- tenir toute la transaction sans en faire un point de contention — un commerce
-- a une poignée d'appareils, et les enregistre une fois.
--
-- `hashtextextended` plutôt que `hashtext` : la clé de `pg_advisory_xact_lock`
-- est un `bigint`, et rétrécir à 32 bits multiplierait les collisions entre
-- commerces. Une collision ne serait pas une faute — deux commerces
-- attendraient l'un pour l'autre, rien de plus — mais il n'y a aucune raison de
-- la payer.
--
-- L'alphabet n'est pas réécrit ici : il est lu du type (`enum_range`), qui est
-- l'endroit où il est déclaré. C'est la deuxième raison pour laquelle E1-01 en
-- a fait un type et non une contrainte de forme.
--
-- Les lettres prises sont comptées **sans filtrer** `deleted_at` ni
-- `is_active`, pour la raison de l'index ci-dessus : une lettre rendue serait
-- une lettre redonnée.
-- ----------------------------------------------------------------------------

create function merx.next_device_prefix(target_tenant uuid)
returns public.device_prefix
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  chosen public.device_prefix;
begin
  if target_tenant is null then
    raise exception 'Aucun commerce désigné.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_tenant::text, 0));

  select letter into chosen
  from pg_catalog.unnest(pg_catalog.enum_range(null::public.device_prefix)) as letter
  where not exists (
    select 1
    from public.device d
    where d.tenant_id = target_tenant
      and d.prefix = letter
  )
  order by letter
  limit 1;

  if chosen is null then
    -- Vingt-six appareils dans un commerce de gros n'arrivera pas ; si cela
    -- arrive, mieux vaut un refus lisible qu'une lettre recyclée. Le code est
    -- distinct de tous les autres refus de cette migration.
    raise exception
      'Ce commerce a déjà 26 appareils, le maximum. Retirez-en un avant d''en ajouter un autre.'
      using errcode = '54000';
  end if;

  return chosen;
end;
$function$;

comment on function merx.next_device_prefix(uuid) is
  'Prochaine lettre libre d''un commerce, jamais une lettre déjà donnée. '
  'Sérialise l''attribution par commerce (verrou consultatif). E1-03, SPEC § 2.5.';


-- ----------------------------------------------------------------------------
-- La liste des appareils est un écran de patron
--
-- E1-03 : « Le patron voit ses appareils et leur dernière synchronisation. »
-- Masquer la route ne fait pas cela — la liste se demande à PostgREST sans
-- passer par aucun écran (constaté en E1-02). Ce qui rend le critère vrai est
-- que la relation elle-même refuse de répondre.
--
-- `manage_devices` est une ligne de la matrice § 3.1, ajoutée au spec avec
-- cette story : owner ✓, worker —, l'éditeur traité en amont du helper comme
-- partout ailleurs. Le droit reste donc gouverné par la matrice (SPEC § 3,
-- RÈGLE un seul helper), et `supabase/tests/permissions.test.ts` compare la
-- ligne à sa copie de `src/lib/auth/permissions.ts`.
--
-- Conséquence assumée, et c'est elle qui dicte la forme de `register_device()`
-- plus bas : un `worker` ne lit plus aucune ligne de `device`, pas même celle
-- de la tablette qu'il tient. Il n'en a pas besoin — son appareil lui est rendu
-- par la fonction d'enregistrement, qui est `security definer` et ne rend que
-- le sien.
-- ----------------------------------------------------------------------------

insert into merx.role_capability (capability, role) values
  -- Gérer les appareils
  ('manage_devices', 'owner');

select merx.apply_capability_restriction('public.device', 'manage_devices');


-- ----------------------------------------------------------------------------
-- `public.register_device()` — l'appareil se présente, une fois pour toutes
--
-- E1-03 : « Un appareil s'enregistre à la première connexion. »
--
-- L'identifiant est engendré par le client et conservé dans son stockage local
-- (`src/lib/device/installation.ts`). C'est ce qui rend l'appel **idempotent** :
-- la même tablette qui rouvre l'application, se reconnecte, ou tombe et
-- réessaie ne fabrique pas un second appareil, donc ne consomme pas une seconde
-- lettre. Un identifiant attribué par le serveur aurait demandé au client de le
-- garder de toute façon — avec, en plus, une fenêtre entre l'insertion et la
-- réponse pendant laquelle une coupure réseau laisse un appareil orphelin et
-- une lettre brûlée.
--
-- C'est aussi la direction que E10 impose : en local-first, les identifiants
-- naissent sur l'appareil, pas au retour du réseau (SPEC § 2.5).
--
-- Le rôle n'entre pas dans la question. Un `worker` doit pouvoir enregistrer sa
-- tablette — c'est lui qui tient le comptoir — alors qu'il n'a pas le droit de
-- lire la liste. La fonction est donc ouverte à tout compte rattaché à un
-- commerce, et c'est la policy restrictive ci-dessus qui tient la lecture. Les
-- deux gardes ne répondent pas à la même question : « puis-je me présenter ? »
-- et « puis-je voir les autres ? ».
--
-- `security definer`, donc hors RLS : sans cela, un `worker` ne pourrait pas
-- écrire dans `device`. Le commerce n'est jamais un paramètre — il vient du
-- jeton signé (SPEC § 2.1).
--
-- Les paramètres ne s'appellent ni `device_id` ni `label` : ce sont deux
-- colonnes de `public.device` — `device_id` par les conventions § 4, `label`
-- par le spec — et plpgsql refuserait la requête comme ambiguë, à l'exécution,
-- pas à la lecture.
-- ----------------------------------------------------------------------------

create function public.register_device(device_key uuid, device_label text default null)
returns table (
  id           uuid,
  label        text,
  prefix       public.device_prefix,
  last_sync_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_tenant uuid;
  existing      public.device;
  chosen        public.device_prefix;
begin
  target_tenant := merx.current_tenant_id();

  if target_tenant is null then
    raise exception 'Aucun commerce rattaché à ce compte.'
      using errcode = '42501';
  end if;

  if device_key is null then
    raise exception 'Aucun appareil désigné.' using errcode = '23514';
  end if;

  select d.* into existing
  from public.device d
  where d.id = device_key;

  if existing.id is not null then
    -- Un identifiant qui existe ailleurs. Dire « introuvable » plutôt que « pas
    -- à vous » évite de confirmer l'existence d'une ligne qu'on n'a pas le droit
    -- de voir — même formulation qu'en E1-02, même raison.
    if existing.tenant_id <> target_tenant then
      raise exception 'Appareil introuvable.' using errcode = 'P0002';
    end if;

    -- Un appareil que le patron a retiré ne revient pas tout seul au premier
    -- redémarrage de l'application. BRAND-UI § 6 : le message dit ce qui s'est
    -- passé et à qui s'adresser.
    if not existing.is_active or existing.deleted_at is not null then
      raise exception 'Cet appareil a été retiré. Demandez à votre patron de le réactiver.'
        using errcode = '42501';
    end if;

    update public.device d
    set last_sync_at = now()
    where d.id = existing.id;

    return query
      select d.id, d.label, d.prefix, d.last_sync_at
      from public.device d
      where d.id = existing.id;
    return;
  end if;

  chosen := merx.next_device_prefix(target_tenant);

  -- Le nom par défaut porte la lettre : c'est ce que le patron lit sur ses bons
  -- (`BL-C-0001`), donc le seul nom sous lequel il reconnaît l'appareil tant
  -- qu'il ne l'a pas renommé. `label` est NOT NULL et aucun écran ne demande de
  -- nom à la connexion — un vendeur qui ouvre la caisse n'a pas à baptiser sa
  -- tablette.
  insert into public.device (id, tenant_id, label, prefix, last_sync_at, created_by)
  values (
    device_key,
    target_tenant,
    coalesce(nullif(btrim(coalesce(device_label, '')), ''), 'Appareil ' || chosen::text),
    chosen,
    now(),
    merx.current_app_user()
  );

  return query
    select d.id, d.label, d.prefix, d.last_sync_at
    from public.device d
    where d.id = device_key;
end;
$function$;

comment on function public.register_device(uuid, text) is
  'Enregistre l''appareil de l''appelant dans son commerce, ou estampille sa '
  'dernière synchronisation s''il est déjà connu. Idempotente. E1-03.';

-- PostgREST expose toute fonction de `public`, et les ACL par défaut de
-- Supabase l'accordent à `anon`. Le garde de la première ligne suffirait — un
-- appelant anonyme n'a pas de commerce — mais un privilège qu'aucune
-- vérification ne rattrape est un accident qui attend une modification.
revoke execute on function public.register_device(uuid, text) from public, anon;
grant  execute on function public.register_device(uuid, text) to authenticated;
