-- ============================================================================
-- Merx — consultation du stock
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant, et son exception
--             nommée), § 2.5 (une valeur incertaine ne se présente pas comme
--             certaine), § 3 / § 3.1 (matrice, RÈGLE un seul helper), § 4
--             (conventions, domaines nommés), § 7 M2 (RÈGLES M2-1, M2-2,
--             M2-3), § 11 étape 3 ; docs/BACKLOG.md E3-02.
--
-- E3-01 a posé les mouvements et leur agrégat. Cette story les donne à lire, et
-- la lecture demande trois choses que le schéma n'avait pas :
--
--   1. **`stock_level` complet.** L'agrégat ne naissait qu'au premier
--      mouvement. Juste après un import de 2 000 références, aucune variante
--      n'a de ligne — donc aucune quantité à afficher, et le filtre « stock à
--      zéro » ne montrerait rien au moment précis où il montre presque tout le
--      catalogue. Couvrir l'absence de ligne par une anti-jointure sur
--      `variant` a été mesuré et refusé (voir § 3 ci-dessous) : la ligne doit
--      exister, pas être devinée.
--
--   2. **De quoi distinguer « 0 compté » de « jamais saisi ».** Une fois la
--      ligne créée d'office, `quantity = 0` ne dit plus si quelqu'un a compté.
--      SPEC § 2.5 refuse de présenter l'un comme l'autre : `last_movement_at`
--      porte la différence, et l'écran écrit « Stock non saisi » plutôt que
--      « 0 ».
--
--   3. **L'auteur d'un mouvement, lisible par un vendeur.**
--      `stock_movement.created_by` pointe sur `app_user`, que la policy
--      restrictive `capability_restriction` ferme à qui n'a pas
--      `manage_users` — le patron seul. Or l'acteur de la story est le
--      vendeur, et le critère exige l'auteur. D'où `list_stock_movements()`,
--      exception § 2.1 nommée et inscrite au registre.
--
-- Ce qui n'est **pas** ici : l'ajustement manuel (E3-03) — aucun type de
-- mouvement n'est ouvert par cette migration, la consultation ne crée rien ;
-- `inventory_session` et `inventory_line` (E3-04, étape 9) ; le document
-- d'origine d'un mouvement, qui n'existe pas avant E4.
-- ============================================================================


-- ============================================================================
-- 1. `last_movement_at` — ce qui sépare un zéro compté d'un stock jamais saisi
--
-- SPEC § 2.5. Un commerçant qui vient d'importer son catalogue n'a pas compté
-- son stock ; écrire « 0 » sur 2 000 lignes lui ferait lire un inventaire que
-- personne n'a fait, et c'est exactement la valeur incertaine présentée comme
-- certaine que la RÈGLE refuse.
--
-- La distinction est **stockée**, pas déduite. Déduite, elle demanderait de
-- demander à `stock_movement` s'il existe une ligne pour cette variante — et
-- l'index d'E3-01 est `(tenant_id, variant_id, created_at desc)`, dont la
-- colonne de tête est `tenant_id`, qui ne vient que de la policy. Sous RLS la
-- policy porte `or merx.is_super_admin()`, non `leakproof`, donc inutilisable
-- comme condition d'index (BACKLOG E0-03) : la question coûterait un parcours
-- complet de `stock_movement`. Stockée, elle arrive dans la même lecture que la
-- quantité, sans requête de plus.
--
-- La colonne vit sur l'agrégat parce qu'elle en est un : le maximum des
-- `created_at` des mouvements de la paire. Elle n'est donc écrite que par
-- l'écrivain déclaré, comme `quantity`.
--
-- **`greatest()` et non `new.created_at`.** En E9 un mouvement saisi hors ligne
-- il y a trois jours arrivera après des mouvements plus récents : écrire
-- l'horodatage du dernier arrivé ferait reculer la date, et un écran qui dit
-- « dernier mouvement avant-hier » alors qu'il y en a eu un ce matin se lit
-- comme une perte de données. Le maximum ne recule pas, quel que soit l'ordre
-- d'arrivée — c'est la même raison qui rend les mouvements commutatifs et la
-- synchronisation possible (RÈGLE M2-2).
-- ============================================================================

alter table public.stock_level
  add column last_movement_at timestamptz;

comment on column public.stock_level.last_movement_at is
  'Le plus récent created_at des mouvements de la paire, ou NULL si la variante '
  'n''en a jamais eu. NULL se lit « stock non saisi », jamais « 0 » — SPEC '
  '§ 2.5. Posée par greatest() : un mouvement synchronisé en retard ne fait pas '
  'reculer la date. E3-02.';


-- ============================================================================
-- 2. L'écrivain unique, étendu à la naissance de la variante
--
-- RÈGLE M2-1 : `stock_level` est maintenu par trigger. Le registre des tables
-- dérivées (E3-01) n'admet **qu'un** écrivain par table, et
-- `conventions.ts` refuse toute autre fonction qui y écrit — c'est pourquoi la
-- ligne d'origine n'est pas créée par une seconde fonction, ni par le trigger
-- qui crée la variante par défaut (E2-01), mais par l'écrivain lui-même, muni
-- d'un second point d'entrée.
--
-- `merx.apply_stock_movement()` devient donc `merx.maintain_stock_level()` :
-- le nom dit ce qu'elle fait maintenant, puisqu'elle ne traite plus seulement
-- un mouvement. Deux triggers, une fonction, un seul écrivain déclaré.
--
-- `pg_trigger_depth()` vaut 2 sur les deux chemins — l'insertion dans `variant`
-- ou dans `stock_movement` est à 0, le trigger à 1, et le garde de ligne
-- d'E3-01 s'exécute à 2 : il laisse passer, comme avant, et refuse toujours
-- l'écriture directe en `55000`.
--
-- `security invoker`, toujours : la RLS gouverne la ligne dérivée comme
-- n'importe quelle autre, et le `tenant_id` écrit est celui de la ligne source,
-- qui a elle-même franchi `tenant_isolation`. En `security definer` la fonction
-- tournerait sous `postgres`, qui porte BYPASSRLS, et l'isolation de
-- `stock_level` ne tiendrait plus qu'à ce corps-ci (SPEC § 2.1).
-- ============================================================================

drop trigger apply_stock_movement on public.stock_movement;
drop function merx.apply_stock_movement();

create function merx.maintain_stock_level()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  home uuid;
begin
  if tg_table_name = 'variant' then
    /*
     * La ligne d'origine. SPEC § 2.4 : un commerce n'a qu'un dépôt, jamais
     * affiché, jamais choisi — la variante naissante prend celui-là.
     *
     * `quantity` reste à son défaut, 0, et `last_movement_at` à NULL : rien n'a
     * bougé, et c'est précisément ce que NULL dit.
     *
     * Aucun dépôt, et la fonction refuse plutôt que de ne rien faire : sans
     * ligne, la variante serait invisible à la liste des quantités et aux deux
     * filtres, c'est-à-dire le trou que cette migration ferme. `create_tenant()`
     * crée le dépôt par défaut avec le commerce (E1-01), donc ce refus ne se
     * voit que si cette garantie-là casse — et alors il vaut mieux le lire ici
     * que le découvrir dans un écran vide.
     */
    select w.id into home
    from public.warehouse w
    where w.tenant_id = new.tenant_id
      and w.is_default
      and w.deleted_at is null;

    if home is null then
      raise exception 'Aucun dépôt par défaut pour ce commerce : le stock de la variante ne peut pas être ouvert.'
        using errcode = '55000';
    end if;

    insert into public.stock_level (
      tenant_id, variant_id, warehouse_id, created_by, device_id
    )
    values (new.tenant_id, new.id, home, new.created_by, new.device_id)
    /*
     * `do nothing` : une variante restaurée après une suppression douce (E2-02)
     * retrouve une ligne qui n'a jamais été supprimée — son historique non
     * plus. Écraser la quantité serait perdre un stock réel.
     */
    on conflict (variant_id, warehouse_id) do nothing;

    return null;
  end if;

  insert into public.stock_level (
    tenant_id, variant_id, warehouse_id, quantity, last_movement_at,
    created_by, device_id
  )
  values (
    new.tenant_id, new.variant_id, new.warehouse_id, new.quantity,
    new.created_at, new.created_by, new.device_id
  )
  on conflict (variant_id, warehouse_id) do update
    set quantity         = stock_level.quantity + excluded.quantity,
        -- Le maximum, jamais le dernier arrivé : voir § 1.
        last_movement_at = greatest(
          stock_level.last_movement_at, excluded.last_movement_at);

  return null;
end;
$function$;

comment on function merx.maintain_stock_level() is
  'Le seul écrivain de stock_level, par deux chemins : la naissance d''une '
  'variante ouvre sa ligne à 0, un mouvement y ajoute sa quantité signée et '
  'avance last_movement_at. RÈGLE M2-1 ; E3-01, étendu en E3-02.';

create trigger maintain_stock_level
  after insert on public.stock_movement
  for each row execute function merx.maintain_stock_level();

/*
 * SPEC § 2.3 : « toute variante a son stock », corollaire de « tout produit a
 * au moins une variante ». La ligne naît avec la variante, pas avec le premier
 * mouvement — sans quoi un catalogue importé n'a pas de stock à montrer.
 */
create trigger open_stock_level
  after insert on public.variant
  for each row execute function merx.maintain_stock_level();

update merx.derived_registry
set writer_function = 'maintain_stock_level'
where table_name = 'stock_level';


-- ============================================================================
-- 3. Les variantes qui précèdent cette migration
--
-- Le garde de ligne d'E3-01 refuse toute écriture à `pg_trigger_depth() < 2`,
-- migration comprise — c'est voulu, et c'est pourquoi ce rattrapage lève le
-- garde explicitement au lieu de le contourner.
--
-- **`disable trigger` et non `session_replication_role = replica`.** Le second
-- suspend aussi les clés étrangères, donc les cascades, et les lignes qui
-- auraient dû suivre restent en place — silencieusement, et pour de bon : c'est
-- ce qui a laissé 283 000 variantes orphelines en E2-05. Celui-ci ne touche
-- qu'un trigger nommé, sur une table, le temps d'une instruction.
--
-- Le garde ne peut pas rester baissé par accident : `alter table ... disable
-- trigger` est du DDL transactionnel. Vérifié sur le stack — `tgenabled` passe
-- de `O` à `D` puis revient à `O` dès que la transaction échoue, donc un
-- insert-select en erreur annule le `disable` avec le reste. Et si quelqu'un
-- oubliait le `enable`, la règle « gardes des tables dérivées » de
-- `conventions.ts` le dit maintenant par son nom : elle lit `tgenabled`, pas
-- seulement l'existence du trigger (corrigé en E3-02 — un trigger désactivé
-- existe toujours dans le catalogue, et la règle le laissait passer).
-- ============================================================================

alter table public.stock_level disable trigger reject_derived_insert;

insert into public.stock_level (tenant_id, variant_id, warehouse_id, created_by)
select v.tenant_id, v.id, w.id, v.created_by
from public.variant v
join public.warehouse w
  on w.tenant_id = v.tenant_id and w.is_default and w.deleted_at is null
on conflict (variant_id, warehouse_id) do nothing;

alter table public.stock_level enable trigger reject_derived_insert;


-- ============================================================================
-- 3 bis. L'agrégat suit sa variante ; l'historique, lui, la retient
--
-- E3-01 avait posé les deux clés de `stock_level` sans cascade, par le même
-- raisonnement que pour `stock_movement` : « un mouvement ne se supprime pas,
-- donc rien ne doit pouvoir l'emporter ». Juste pour le mouvement, trop large
-- pour l'agrégat — et sans conséquence tant qu'une variante sans mouvement
-- n'avait pas de ligne. Depuis § 2 elles en ont toutes une, et plus aucune
-- variante n'est supprimable nulle part.
--
-- La ligne de `stock_level` **suit** donc sa variante. Ce n'est pas un
-- relâchement : ce qui protège l'historique est la clé de `stock_movement`,
-- qui reste restrictive. Une variante qui a bougé ne se supprime pas — sa
-- première ligne de mouvement la retient, et c'est la bonne barrière. Une
-- variante qui n'a jamais bougé n'emporte qu'un agrégat de rien : zéro, et
-- `last_movement_at` nul.
--
-- Autrement dit la suppression reste refusée exactement là où elle détruirait
-- quelque chose, et nulle part ailleurs. Sans cela, chaque jeu d'essai — et
-- plus tard chaque purge de commerce — doit lever le garde de la table dérivée
-- pour effacer un zéro.
-- ============================================================================

alter table public.stock_level
  drop constraint stock_level_variant_id_fkey;

alter table public.stock_level
  add constraint stock_level_variant_id_fkey
  foreign key (tenant_id, variant_id) references public.variant (tenant_id, id)
  on delete cascade;

comment on constraint stock_level_variant_id_fkey on public.stock_level is
  'En cascade : l''agrégat suit sa variante. Ce qui retient une variante qui a '
  'bougé est la clé de stock_movement, qui ne cascade pas — l''historique ne se '
  'purge pas. E3-01, revu en E3-02.';


-- ============================================================================
-- 4. Les deux filtres, et pourquoi ce sont des index partiels
--
-- BACKLOG E3-02 : « Filtres : stock à zéro, stock négatif ».
--
-- `numeric_lt` et `numeric_eq` ne sont pas `leakproof` — vérifié dans
-- `pg_proc` :
--
--     numeric_eq | f     numeric_lt | f     uuid_eq | t     texteq | t
--
-- Sous une policy, Postgres n'accepte comme condition d'index qu'un prédicat
-- `leakproof` ; `quantity < 0` ne peut donc **jamais** en être une, et un index
-- ordinaire sur `quantity` serait ignoré — tout parcours lirait la table
-- entière, tous commerces confondus. C'est la famille de pièges que
-- CLAUDE.md enregistre, et elle a déjà coûté trois fois.
--
-- La sortie est un index **partiel** : son prédicat est démontré au moment de
-- la planification, il n'évalue rien à l'exécution, et l'index ne contient que
-- les lignes voulues — il n'y a donc pas de qual à rendre `leakproof`. Mesuré
-- sur le stack, 50 000 lignes, cinq commerces, policy de la forme
-- `tenant_isolation` + `super_admin_all` (`plpgsql` + `or admin()`, donc non
-- inlinable, donc les quals de sécurité survivent dans le plan) :
--
--   `where quantity = 0`, sans index partiel ......... Seq Scan
--   `where quantity = 0`, avec index partiel ......... Index Scan
--   `where quantity < 0`, avec index partiel ......... Bitmap Index Scan,
--       `quantity < 0` en Recheck seulement, policy en Filter
--
-- Et l'alternative écartée, qui aurait couvert l'absence de ligne au lieu de la
-- supprimer — `variant left join stock_level ... where l.id is null or
-- quantity = 0`, ordonnée par nom, dans le cas défavorable où presque rien ne
-- qualifie, 39 lignes rendues de part et d'autre :
--
--   anti-jointure ............ Seq Scan sur `variant`, 40 000 lignes écartées
--                              par le filtre — les quatre autres commerces,
--                              65,3 ms
--   `stock_level` complet .... Bitmap Index Scan, 0,71 ms
--
-- 92 fois, et l'écart grandit avec le catalogue **des voisins** : le mode de
-- panne d'E2-04, mot pour mot. D'où § 2 et § 3 de cette migration.
--
-- `tenant_id` en tête des deux index : la policy ne peut pas s'en servir comme
-- condition (E0-03), mais la colonne garde les entrées d'un commerce groupées,
-- et la condition redevient utilisable le jour où `super_admin_all` sera
-- réglée. L'ordre mesuré ci-dessus est celui-ci.
--
-- `quantity` en seconde colonne du seul index négatif : c'est l'ordre de
-- lecture de l'écran — le plus négatif d'abord, celui qu'on régularise en
-- premier. Pour « à zéro » la quantité est connue par le prédicat, la stocker
-- une seconde fois ne servirait à rien.
--
-- Pas de `fastupdate` à régler ici : ce sont des index btree, non des GIN — la
-- liste d'attente qui faisait perdre le plan de recherche après un import
-- (E2-04) n'existe pas pour eux.
-- ============================================================================

create index stock_level_zero
  on public.stock_level (tenant_id)
  where quantity = 0;

create index stock_level_negative
  on public.stock_level (tenant_id, quantity)
  where quantity < 0;

comment on index public.stock_level_zero is
  'Filtre « stock à zéro » (E3-02). Partiel : sous RLS, numeric_eq n''est pas '
  'leakproof et ne peut pas être une condition d''index — le prédicat, lui, est '
  'démontré à la planification.';

comment on index public.stock_level_negative is
  'Filtre « stock négatif » (E3-02), quantité croissante donc le plus négatif '
  'd''abord. Partiel pour la même raison que stock_level_zero.';


-- ============================================================================
-- 5. `public.list_stock_movements()` — l'historique d'une variante, avec son auteur
--
-- BACKLOG E3-02 : « Fiche variante affichant l'historique complet des
-- mouvements, du plus récent au plus ancien », et « chaque mouvement affiche sa
-- date, son type, sa quantité, son auteur et son document ».
--
-- **Pourquoi une exception à § 2.1, et pourquoi elle ne s'évite pas.**
-- `stock_movement.created_by` référence `app_user`, et `app_user` porte la
-- policy restrictive `capability_restriction` qui exige `manage_users` (E1-02,
-- § 3.1) : le patron seul la lit. L'acteur de cette story est le **vendeur**.
-- Aucune lecture par PostgREST — jointure incorporée comprise — ne peut donc
-- lui rendre le nom de l'auteur. La fonction rend un `full_name` par mouvement
-- d'une variante de son propre commerce ; elle n'ouvre pas le registre des
-- employés, et `app_user` reste fermé partout ailleurs. Inscrite au registre
-- des exceptions, avec sa justification, surveillée par `conventions.ts`.
--
-- **Trois gardes, trois réponses qu'aucune autre ne donne** (CLAUDE.md : deux
-- gardes sur un même chemin doivent se distinguer, sinon le test de l'un passe
-- sur le refus de l'autre) :
--
--   1. `merx.can('view_catalogue')` — ce que l'utilisateur lit. C'est le garde
--      doublé par `RequireCapability` sur la route ; celui-ci est le seul qui
--      compte quand l'appel arrive sans passer par l'écran.
--   2. la variante hors du commerce du jeton — **zéro ligne**, pas une erreur.
--      Un refus confirmerait l'existence d'une ligne qu'on n'a pas le droit de
--      voir, ce qu'E1-02 et E1-03 refusent déjà de faire ; et la question « que
--      sais-je de cette variante » a pour bonne réponse « rien ».
--   3. le filtre du commerce sur les mouvements eux-mêmes. SEUL GARDE
--      D'ISOLATION de cette lecture : la fonction est `security definer`,
--      aucune policy ne s'y applique.
--
-- Le garde 2 n'est pas redondant avec le garde 3. Le 3 borne les mouvements
-- rendus ; le 2 borne la **question** — sans lui, un identifiant du voisin
-- rendrait zéro ligne par accident de données plutôt que par décision, et le
-- jour où la fonction rendrait aussi l'en-tête de la variante, la différence se
-- paierait. Un test l'appelle avec l'identifiant réel d'une variante du voisin.
--
-- `stable`, pas `volatile` : elle ne fait que lire.
--
-- L'ordre et l'index : `created_at desc`, sur
-- `stock_movement_variant_created_at (tenant_id, variant_id, created_at desc)`,
-- posé par E3-01 pour cette story et nommé dans son commentaire. Hors RLS —
-- `security definer` — les deux colonnes de tête sont de simples égalités, donc
-- la condition d'index est entière et le tri est déjà fait.
--
-- `source_type` et `source_id` sont rendus tels quels : le document d'origine
-- n'a pas de table avant E4, et inventer un lien maintenant serait construire
-- en avance. L'écran les nomme sans y mener.
-- ============================================================================

create function public.list_stock_movements(
  p_variant_id uuid,
  p_limit      int default 100
)
returns table (
  id            uuid,
  created_at    timestamptz,
  movement_type public.stock_movement_type,
  quantity      public.quantity,
  source_type   public.stock_source_type,
  source_id     uuid,
  note          text,
  author_name   text
)
language plpgsql
stable
security definer
set search_path = ''
/*
 * Même réglage, et même raison, qu'en E2-04 pour `search_products()`. Après
 * cinq exécutions, PostgreSQL remplace le plan personnalisé par un plan
 * générique, qui ne connaît pas la valeur de `p_variant_id` : il estime la
 * sélectivité au doigt mouillé et bascule sur un parcours séquentiel de
 * `stock_movement`. Une connexion PostgREST du pool en sert des centaines, donc
 * c'est le plan générique qui tourne en production, pas celui du premier appel.
 *
 * Constaté à la passe de sabotage d'E3-02 : l'assertion de plan passait un tour
 * sur deux, sur les mêmes données. Ce n'était pas le test qui vacillait.
 */
set plan_cache_mode = force_custom_plan
as $function$
declare
  home_tenant uuid;
begin
  -- Garde 1. Sa phrase est celle que l'utilisateur lit ; aucun autre garde de
  -- cette fonction ne répond `42501`.
  if not merx.can('view_catalogue') then
    raise exception 'Ce compte ne peut pas consulter le catalogue et le stock.'
      using errcode = '42501';
  end if;

  home_tenant := merx.current_tenant_id();
  if home_tenant is null then
    return;
  end if;

  -- Garde 2. Zéro ligne, et la sortie est immédiate : la variante n'appartient
  -- pas au commerce du jeton, ou n'existe pas — on ne dit pas lequel des deux.
  if not exists (
    select 1
    from public.variant v
    where v.tenant_id = home_tenant
      and v.id = p_variant_id
  ) then
    return;
  end if;

  return query
  select m.id, m.created_at, m.movement_type, m.quantity,
         m.source_type, m.source_id, m.note, a.full_name
  from public.stock_movement m
  left join public.app_user a
    on a.tenant_id = m.tenant_id and a.id = m.created_by
  -- Garde 3.
  where m.tenant_id = home_tenant
    and m.variant_id = p_variant_id
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$function$;

comment on function public.list_stock_movements(uuid, int) is
  'L''historique des mouvements d''une variante, du plus récent au plus ancien, '
  'avec le nom de l''auteur — que app_user refuse à qui n''a pas manage_users. '
  'Exception § 2.1 nommée ; BACKLOG E3-02.';

select merx.register_rls_exception(
  'public.list_stock_movements(uuid, int)', 'current_tenant',
  'Rend le nom de l''auteur de chaque mouvement, que la policy restrictive '
  'd''app_user réserve à manage_users — or l''acteur de la story est le '
  'vendeur, et le critère exige l''auteur. N''expose qu''un full_name par '
  'mouvement d''une variante du commerce du jeton, jamais le registre des '
  'employés. Trois gardes : can(view_catalogue) en première ligne, '
  'l''appartenance de la variante au commerce (zéro ligne sinon), et le filtre '
  'sur merx.current_tenant_id() des mouvements rendus. E3-02.');
