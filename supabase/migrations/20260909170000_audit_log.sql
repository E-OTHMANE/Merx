-- ============================================================================
-- Merx — le journal d'audit, en ajout seul
--
-- Référence : docs/SPEC.md § 9 M8 (`audit_log`, RÈGLE M8-1), § 3 (RÈGLE un
--             seul helper, RÈGLE de filtrage serveur), § 3.1 (matrice,
--             capacité `view_audit_log`), § 2.1 (RLS), § 4 (conventions),
--             docs/BACKLOG.md E1-04.
--
-- E1-04 demande trois choses : une table, « un helper unique appelé par toutes
-- les actions sensibles », et l'ajout seul. La difficulté est qu'aucune des six
-- actions de la RÈGLE M8-1 n'existe aujourd'hui — le forçage de prix suppose la
-- grille (E2, E4), l'annulation un document (E4), le dépassement un plafond
-- (E6), la validation d'écart l'inventaire (E9), le changement de prix d'achat
-- la réception (E8), et la modification de rôle n'a pas de fonction : E1-02
-- écrit le rôle en dur à la création et `merx.protect_own_role()` interdit d'y
-- toucher.
--
-- Livrer « le helper et ses six appelants » construirait cinq étapes en avance.
-- Livrer le helper seul ne prouverait rien : ni qu'il sera appelé, ni qu'il est
-- le seul chemin.
--
-- La sortie est celle d'E0-05 : rendre la propriété **structurelle** plutôt que
-- conventionnelle, et laisser le catalogue la vérifier.
--
--   1. `authenticated` n'a aucun privilège d'écriture sur `audit_log`. Le seul
--      chemin est `merx.log_audit()`, `security definer`, que `authenticated`
--      ne peut pas exécuter non plus — donc appelable seulement depuis une
--      fonction `security definer` de `public`. « Un helper unique » cesse
--      d'être une consigne : c'est la seule porte. Aucun appelant n'est
--      nécessaire pour que ce soit vrai, et vérifiable, aujourd'hui.
--
--   2. Les six actions sont l'enum `public.audit_action`, une étiquette par
--      ligne de M8-1. Un test compare les étiquettes à la liste, une à une : la
--      liste ne peut plus perdre une entrée en silence, et E4 emploiera
--      l'étiquette existante au lieu d'en inventer une. Même geste que
--      `override_price_below_floor`, posé en E0-05 pour un appelant de E4.
--
--   3. L'ajout seul est une propriété de la table, donc se teste sans appelant.
--      Il est tenu à deux niveaux qui ne font pas le même travail, et rendent
--      des réponses distinctes — voir plus bas.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Les six actions de la RÈGLE M8-1, en type
--
-- Un enum, et pas un `text` libre ni un `check` de forme, pour trois raisons
-- qui se cumulent :
--
--   — la RÈGLE M8-1 est une liste fermée, arbitrée. Un type fermé la dit ;
--   — `supabase/tests/isolation.ts` déduit ses valeurs du catalogue Postgres :
--     il lit les étiquettes d'un enum, il ne lit pas un motif (CLAUDE.md,
--     même raison que `device_prefix` en E1-03) ;
--   — une action inconnue est refusée par le cast, avant le corps du helper.
--     Le refus ne dépend d'aucun `if` qu'on pourrait retirer.
--
-- Les étiquettes sont en anglais, comme tout identifiant du projet, et l'ordre
-- est celui de la RÈGLE pour que les deux se relisent en regard.
-- ----------------------------------------------------------------------------

create type public.audit_action as enum (
  'price_override',           -- forçage de prix                    (M3, E4)
  'document_cancellation',    -- annulation de document             (M3, E4)
  'credit_limit_override',    -- dépassement de plafond             (M4, E6)
  'stock_variance_approval',  -- validation d'écart d'inventaire    (M2, E9)
  'role_change',              -- modification de rôle               (M8)
  'purchase_price_change'     -- changement de prix d'achat         (M5, E8)
);

comment on type public.audit_action is
  'Les six actions qui écrivent obligatoirement dans audit_log. SPEC § 9, '
  'RÈGLE M8-1. Aucune n''est implémentée en E1-04 : elles arrivent avec leurs '
  'modules, et emploieront ces étiquettes-là.';


-- ----------------------------------------------------------------------------
-- L'ajout seul, en mécanisme réutilisable
--
-- `audit_log` n'est pas la seule table concernée : `stock_movement` (E3) et le
-- grand livre (E6) sont en ajout seul par CLAUDE.md, et pour la même raison de
-- fond — c'est ce qui rend la synchronisation possible (SPEC § 2.5). Le
-- mécanisme est donc écrit une fois, ici, et le registre le porte.
--
-- Le registre n'est pas décoratif. `supabase/tests/isolation.test.ts` affirme
-- aujourd'hui, pour chaque table conventionnée, qu'un `owner` modifie et
-- supprime **sa propre** ligne : c'est le contrôle positif sans lequel toutes
-- les assertions négatives passeraient pour n'importe quelle raison — une table
-- verrouillée à tout le monde les satisfait aussi. Sur une table en ajout seul,
-- ce contrôle doit s'**inverser**, pas disparaître. Le test lit le registre
-- pour savoir quoi attendre ; il ne nomme aucune table. `stock_movement` en
-- héritera en s'inscrivant, sans qu'une ligne de test change.
--
-- `write_path` dit qui écrit la ligne, et c'est ce qui distingue les deux cas :
--
--   'application' — l'application insère elle-même, sous `authenticated`. Ce
--                   sera `stock_movement`. Le contrôle positif est l'insertion.
--   'helper'      — l'insertion elle-même passe par une fonction `security
--                   definer` ; `authenticated` n'a pas le privilège. C'est
--                   `audit_log`, et le contrôle positif reste la lecture.
--
-- Sans cette colonne, le balayage ne saurait pas si un refus d'insertion est la
-- propriété recherchée ou une régression.
-- ----------------------------------------------------------------------------

create table merx.append_only_registry (
  table_name text primary key,
  write_path text not null check (write_path in ('application', 'helper'))
);

comment on table merx.append_only_registry is
  'Tables en ajout seul, et par quel chemin leurs lignes s''écrivent. '
  'SPEC § 2.5 ; CLAUDE.md, mouvements et écritures en ajout seul. E1-04.';


-- ----------------------------------------------------------------------------
-- Garde de ligne — UPDATE et DELETE
--
-- `TG_TABLE_NAME` plutôt qu'un nom en dur : la fonction sert à toute table du
-- registre. Le message dit ce qu'il faut faire à la place, parce que c'est la
-- vraie question de celui qui le lit — une correction est une écriture
-- inverse, jamais une rature (CLAUDE.md).
--
-- SQLSTATE `2F004` — *modifying_sql_data_not_permitted*. Le code n'est celui
-- d'aucun autre refus du projet : `42501` est l'autorisation, `23514` un
-- argument manquant, `P0002` une ligne introuvable, `54000` la limite d'E1-03.
-- Un test qui assert `2F004` mesure ce garde-ci et rien d'autre.
-- ----------------------------------------------------------------------------

create function merx.reject_row_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception
    '% est en ajout seul : une ligne écrite ne se modifie ni ne se supprime. Corriger par une écriture inverse.',
    tg_table_name
    using errcode = '2F004';
end;
$function$;

comment on function merx.reject_row_mutation() is
  'Trigger BEFORE UPDATE OR DELETE : refuse toute rature sur une table en '
  'ajout seul. E1-04.';


-- ----------------------------------------------------------------------------
-- Garde d'instruction — TRUNCATE
--
-- Un trigger de ligne ne voit pas passer TRUNCATE : l'instruction ne produit
-- aucune ligne, donc n'en déclenche aucun. Sans ce second trigger, la table
-- entière s'efface par la porte de derrière, et le garde précédent reste vert
-- pendant ce temps-là.
--
-- C'est un garde séparé, pas une variante du premier : il couvre un chemin que
-- l'autre ne voit pas. Il porte donc sa propre phrase, pour qu'un test puisse
-- dire lequel des deux a refusé — retirer l'un doit faire tomber son test à lui
-- seul (E1-03 : l'index total et le verrou consultatif tombent séparément).
-- ----------------------------------------------------------------------------

create function merx.reject_truncate()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception
    '% est en ajout seul : la table ne se vide pas, même en une fois.',
    tg_table_name
    using errcode = '2F004';
end;
$function$;

comment on function merx.reject_truncate() is
  'Trigger BEFORE TRUNCATE : TRUNCATE ne déclenche aucun trigger de ligne, '
  'donc échapperait à merx.reject_row_mutation(). E1-04.';


-- ----------------------------------------------------------------------------
-- `merx.apply_append_only()` — pose les deux gardes et le privilège
--
-- Trois couches, et c'est délibéré : chacune arrête un appelant que les autres
-- ne voient pas.
--
--   privilèges  — `authenticated` n'a plus UPDATE ni DELETE. C'est ce que
--                 rencontre l'application : PostgREST refuse en `42501`, sans
--                 même atteindre la table.
--   trigger     — tout le reste. `service_role`, une fonction `security
--   de ligne      definer`, une console `psql`, la synchronisation de E10.
--                 Refus `2F004`.
--   trigger     — TRUNCATE, que le précédent ne voit pas.
--   d'instruction
--
-- Les deux premiers ne se remplacent pas : retirer le trigger laisse le refus
-- applicatif intact et ouvre tout le reste ; retirer le `revoke` laisse le
-- trigger répondre — avec un autre code, donc un test qui tombe. Aucun des
-- tests ne peut passer à la place de l'autre (CLAUDE.md, deux gardes sur un
-- même chemin).
--
-- Le trigger `set_updated_at` posé par les conventions reste en place. Il ne
-- s'exécutera jamais, et une table en ajout seul n'est pas une raison de faire
-- une exception aux conventions : `updated_at` est vérifiée sur toute table
-- conventionnée par `supabase/tests/conventions.test.ts`.
-- ----------------------------------------------------------------------------

create function merx.apply_append_only(target regclass, write_path text)
returns void
language plpgsql
as $function$
declare
  table_name text;
begin
  if write_path not in ('application', 'helper') then
    raise exception
      'Chemin d''écriture inconnu : %. Attendu « application » ou « helper ».',
      write_path;
  end if;

  -- TRUNCATE figure dans le `revoke` autant que UPDATE et DELETE : les ACL par
  -- défaut de Supabase l'accordent avec le reste, et une table vidée d'un coup
  -- l'est aussi définitivement qu'une ligne raturée.
  execute format('revoke update, delete, truncate on %s from authenticated', target);

  if write_path = 'helper' then
    execute format('revoke insert on %s from authenticated', target);
  end if;

  execute format(
    'create trigger reject_row_mutation before update or delete on %s'
    ' for each row execute function merx.reject_row_mutation()',
    target);

  execute format(
    'create trigger reject_truncate before truncate on %s'
    ' for each statement execute function merx.reject_truncate()',
    target);

  select c.relname into table_name from pg_class c where c.oid = target;

  insert into merx.append_only_registry (table_name, write_path)
  values (table_name, write_path);
end;
$function$;

comment on function merx.apply_append_only(regclass, text) is
  'Rend une table en ajout seul : privilèges retirés, garde de ligne, garde '
  'de TRUNCATE, inscription au registre. E1-04.';


-- ----------------------------------------------------------------------------
-- La capacité de consultation
--
-- E1-04 : « Consultation filtrable par utilisateur et par date, `owner` seul. »
--
-- Une ligne de plus dans la matrice § 3.1, ajoutée au spec avec cette story —
-- même procédé qu'`manage_devices` en E1-03. Le droit reste donc gouverné par
-- la matrice (SPEC § 3, RÈGLE un seul helper), et `permissions.test.ts` compare
-- la ligne à sa copie de `src/lib/auth/permissions.ts`.
--
-- Une capacité propre, et non `view_reports` : un rapport agrège une activité,
-- le journal nomme des personnes. Le jour où un commerce voudra un chef de
-- rayon qui lit les rapports sans lire le journal, la matrice le permettra sans
-- rien déplacer. L'inverse — les fusionner maintenant — se paierait par une
-- migration sur les droits, c'est-à-dire au pire endroit.
-- ----------------------------------------------------------------------------

insert into merx.role_capability (capability, role) values
  -- Consulter le journal d'audit
  ('view_audit_log', 'owner');


-- ----------------------------------------------------------------------------
-- `public.audit_log`
--
-- Les colonnes du spec § 9 M8, et rien de plus. Les conventions apportent
-- `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `device_id`, la
-- RLS et ses deux policies (SPEC § 4, § 2.1).
--
-- `user_id` est NOT NULL. Un journal qui répond « qui » avec des lignes
-- anonymes ne répond pas — c'est la seule question que la story pose (« savoir
-- qui a fait quoi »). Corollaire assumé, et il est réel : un `super_admin` sans
-- fiche `app_user` dans le commerce ne peut pas déclencher une action auditée,
-- le helper refuse avec un code propre. C'est le bon sens du refus : mieux vaut
-- une action bloquée et lisible qu'une ligne d'audit sans auteur.
--
-- `created_by` et `user_id` disent la même chose et cohabitent quand même :
-- `created_by` est une convention § 4 posée sur toute table, `user_id` est la
-- colonne que le spec nomme pour ce journal-ci. Le helper renseigne les deux
-- avec la même valeur ; les dissocier serait une invention.
--
-- `entity_type` est du texte, `entity_id` un uuid sans clé étrangère : les
-- tables visées n'existent pas encore, et une clé étrangère polymorphe ne
-- s'écrit pas. La contrepartie est acceptée — une ligne peut désigner une
-- entité disparue, ce qui, sur un journal en ajout seul dont les cibles ne se
-- suppriment pas non plus (SPEC § 4 : documents et mouvements jamais
-- supprimés), reste théorique.
--
-- `before` et `after` sont nullables et sans contrainte croisée : une création
-- n'a pas d'avant, une suppression pas d'après. Un `check (before is not null
-- or after is not null)` aurait été juste et coûteux — le balayage d'isolation
-- ne remplit que les colonnes obligatoires, laisserait les deux à NULL, et
-- `audit_log` sortirait du balayage en silence, ce que CLAUDE.md refuse.
-- ----------------------------------------------------------------------------

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  action      public.audit_action not null,
  entity_type text not null,
  entity_id   uuid not null,
  "before"    jsonb,
  "after"     jsonb
);

select merx.apply_business_conventions('public.audit_log');

alter table public.audit_log
  add constraint audit_log_user_id_fkey
  foreign key (user_id) references public.app_user (id);

comment on table public.audit_log is
  'Qui a fait quoi. En ajout seul, écrit par merx.log_audit() seulement. '
  'SPEC § 9 M8, RÈGLE M8-1 ; E1-04.';

comment on column public.audit_log.user_id is
  'L''auteur, NOT NULL : un journal sans auteur ne répond pas à la question '
  'qu''il pose.';

/*
 * La lecture exige `view_audit_log`. C'est la relation qui refuse, pas la
 * route : E1-02 a établi qu'un écran masqué se contourne en parlant
 * directement à PostgREST. La policy est **restrictive**, donc en ET avec
 * l'isolation — elle ne peut qu'ajouter une condition.
 */
select merx.apply_capability_restriction('public.audit_log', 'view_audit_log');

/*
 * Et l'ajout seul, chemin d'écriture « helper » : `authenticated` n'insère pas
 * non plus. Le seul écrivain est `merx.log_audit()`.
 */
select merx.apply_append_only('public.audit_log', 'helper');

/*
 * L'index de lecture. E1-04 : « filtrable par utilisateur et par date ».
 * L'écran demande toujours un commerce (RLS), souvent un utilisateur, toujours
 * un intervalle, et lit du plus récent au plus ancien.
 */
create index audit_log_tenant_created_at
  on public.audit_log (tenant_id, created_at desc);

create index audit_log_tenant_user_created_at
  on public.audit_log (tenant_id, user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- `merx.log_audit()` — le helper unique
--
-- Dans `merx`, jamais dans `public` : c'est un outil, pas du métier (SPEC § 4,
-- RÈGLE de placement des schémas). Conséquence utile — PostgREST n'expose pas
-- `merx`, donc la fonction n'est pas une route.
--
-- **Aucun `grant` à `authenticated`.** C'est la décision qui porte la story. Si
-- l'application pouvait l'appeler, un employé fabriquerait des lignes : un
-- forçage de prix qu'il n'a pas fait, une annulation attribuée au patron. Le
-- journal ne vaut que si ses lignes ne peuvent naître que d'une action réelle.
-- La fonction est donc appelée depuis les fonctions `security definer` de
-- `public` qui portent ces actions — elles s'exécutent sous le propriétaire, et
-- c'est à ce moment-là que la ligne s'écrit, dans la même transaction que
-- l'action. Une action annulée n'entre pas au journal ; une action validée y
-- est.
--
-- `tenant_id` et `user_id` ne sont pas des paramètres. Ils viennent du jeton
-- signé (SPEC § 2.1) : un appelant ne peut pas signer une ligne au nom d'un
-- autre, ni la déposer chez le voisin. C'est la même règle qu'en E1-02 pour
-- `create_worker()`, et elle vaut ici davantage — le journal est la pièce qu'on
-- consulte quand quelque chose s'est mal passé.
--
-- `device_id` reste NULL : le jeton ne porte pas l'appareil. Ce serait un claim
-- de plus dans `merx.custom_access_token()`, et cette décision appartient à
-- E10 (local-first), où l'appareil devient une donnée de session. La colonne
-- existe, par convention § 4 ; elle attend.
-- ----------------------------------------------------------------------------

-- Les paramètres ne portent pas le nom des colonnes — `performed_action` et
-- non `action`, `state_before` et non `before`. Deux raisons, la seconde
-- suffirait : `before` et `after` demanderaient des guillemets à chaque
-- mention, et un paramètre homonyme d'une colonne se retourne contre celui qui
-- l'écrit dès qu'une requête met la table dans la portée — plpgsql refuse alors
-- la requête comme ambiguë, à l'exécution, pas à la lecture (E1-02, E1-03,
-- même précaution).
create function merx.log_audit(
  performed_action   public.audit_action,
  target_entity_type text,
  target_entity_id   uuid,
  state_before       jsonb default null,
  state_after        jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_tenant uuid;
  author        uuid;
  written       uuid;
begin
  target_tenant := merx.current_tenant_id();

  if target_tenant is null then
    raise exception 'Aucun commerce rattaché à ce compte : rien à journaliser.'
      using errcode = '42501';
  end if;

  -- Le corollaire du NOT NULL sur `user_id`, énoncé au-dessus de la table. Le
  -- code diffère de celui du garde précédent pour qu'un test sache lequel des
  -- deux a refusé : ici ce n'est pas une question de droit, c'est une colonne
  -- obligatoire qu'on ne sait pas remplir.
  author := merx.current_app_user();

  if author is null then
    raise exception
      'Aucune fiche utilisateur pour ce compte : une action auditée exige un auteur.'
      using errcode = '23502';
  end if;

  if target_entity_id is null or btrim(coalesce(target_entity_type, '')) = '' then
    raise exception 'Action auditée sans entité visée.' using errcode = '23514';
  end if;

  insert into public.audit_log (
    tenant_id, user_id, created_by, action, entity_type, entity_id, "before", "after"
  )
  values (
    target_tenant, author, author,
    performed_action, btrim(target_entity_type), target_entity_id,
    state_before, state_after
  )
  returning id into written;

  return written;
end;
$function$;

comment on function merx.log_audit(public.audit_action, text, uuid, jsonb, jsonb) is
  'Le seul chemin d''écriture du journal. Commerce et auteur viennent du jeton '
  'signé, jamais des paramètres. Non exécutable par authenticated : les '
  'fonctions security definer de public l''appellent. SPEC RÈGLE M8-1, E1-04.';

-- `merx` n'est pas exposé par PostgREST, et `authenticated` a `usage` sur le
-- schéma depuis E0-03 : sans ce `revoke`, une fonction du schéma resterait
-- exécutable par un appel imbriqué. On l'enlève explicitement — un privilège
-- qu'aucune vérification ne rattrape est un accident qui attend une
-- modification.
revoke execute on function
  merx.log_audit(public.audit_action, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
