-- ============================================================================
-- Merx — l'ajustement manuel de stock
--
-- Référence : docs/SPEC.md § 2.6 (charge de saisie), § 3 / § 3.1 (matrice,
--             RÈGLE un seul helper), § 4 (conventions), § 7 M2 (RÈGLES M2-1,
--             M2-2, M2-5), § 9 (RÈGLE M8-1), § 11 étape 3 ;
--             docs/BACKLOG.md E3-03.
--
-- La première story qui ouvre un type de mouvement. Quatre choses, et une
-- seule est neuve :
--
--   1. la capacité `adjust_stock`, `owner` seul, à la matrice § 3.1 ;
--   2. `adjustment` inscrit à `merx.movement_type_capability` — et lui seul.
--      `inventory` (E3-04), `sale` et `return` (E4), `receipt` (E8-02)
--      restent fermés ;
--   3. le motif, obligatoire sur un ajustement et sur lui seul ;
--   4. la trace au journal, par trigger, sous l'étiquette ajoutée par la
--      migration précédente.
--
-- ----------------------------------------------------------------------------
-- Rectificatif à E3-01
--
-- La migration d'E3-01 annonçait : « Les capacités existent déjà dans la
-- matrice § 3.1 : aucune story n'aura à en inventer une, seulement à inscrire
-- une ligne ici. » C'était faux pour celle-ci, et la suite le dit plutôt que de
-- plier la matrice : **aucune capacité `owner` seul de § 3.1 ne veut dire
-- « corriger une quantité »**. `approve_stock_variance` est la validation d'un
-- écart d'inventaire — elle servira à E3-04, et l'emprunter ici rendrait
-- impossible de retirer l'ajustement à quelqu'un sans lui retirer
-- l'inventaire. `manage_product` est le catalogue, pas le stock.
--
-- Une capacité empruntée fait mentir la matrice sur ce qu'un droit gouverne, et
-- la matrice est le seul endroit où les droits se lisent (§ 3, RÈGLE un seul
-- helper). `adjust_stock` est donc une capacité à part entière. `docs/SPEC.md`
-- § 3.1 et sa RÈGLE M2-5, ainsi que la note E3-03 de `docs/BACKLOG.md`, sont
-- corrigés dans la même story ; le commentaire d'E3-01 n'est pas retouché — une
-- migration passée est un constat, pas un brouillon.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. La capacité
--
-- Trois copies de la matrice § 3.1 doivent bouger ensemble : cette ligne, le
-- type `Capability` et l'objet `CAPABILITIES` de `src/lib/auth/permissions.ts`.
-- `supabase/tests/permissions.test.ts` les compare ligne à ligne — une case
-- ajoutée d'un seul côté casse le build.
-- ----------------------------------------------------------------------------

insert into merx.role_capability (capability, role) values
  -- Ajuster une quantité manuellement
  ('adjust_stock', 'owner');


-- ----------------------------------------------------------------------------
-- 2. Le type ouvert
--
-- Après la capacité, et pas avant : `merx.require_known_capability()` refuse en
-- `23503` une capacité absente de la matrice — c'est la clé étrangère que
-- `merx.role_capability` ne peut pas offrir (E3-01).
--
-- À partir d'ici, la policy `column_capability_insert` laisse passer un
-- `adjustment` au `owner` et le refuse au `worker`, avec le message de la RLS ;
-- le trigger `require_open_movement_type` continue de nommer les quatre types
-- encore fermés. Deux refus distincts, deux tests (CLAUDE.md, E1-02).
-- ----------------------------------------------------------------------------

insert into merx.movement_type_capability (movement_type, capability) values
  ('adjustment', 'adjust_stock');


-- ----------------------------------------------------------------------------
-- 3. Le motif
--
-- Obligatoire, et § 2.6 ne s'y applique pas. Cette règle-là vise les
-- **formulaires de création d'entités de référence** — sa mécanique le dit
-- mieux que sa prose : `merx.register_creation_form(table, colonne_de_nom)`,
-- qui inscrit `product` (E2-02), inscrira `client` (E6) et `supplier` (E8). Un
-- mouvement n'est pas de cette famille : ce n'est pas une fiche qu'on crée
-- maigre et qu'on complète plus tard, c'est un événement — il n'y a pas de
-- « plus tard », et aucun écran ne liste des ajustements à enrichir.
--
-- Le principe de § 2.6 — « une fonctionnalité privée de sa donnée se désactive
-- silencieusement, elle ne réclame pas » — ne peut pas s'appliquer parce que le
-- motif **est le contenu de l'acte**, pas son accessoire. Un ajustement sans
-- motif n'est pas un ajustement dégradé : c'est un chiffre changé à la main
-- sans raison, ce que le critère « tracé » existe pour empêcher. Même forme que
-- `quantity <> 0`, obligatoire depuis E3-01 sans que personne y lise une
-- infraction : un formulaire peut exiger ce qui est l'acte lui-même.
--
-- En base **et** à l'écran, parce que l'API se passe de l'écran : un `POST`
-- direct sur PostgREST poserait des ajustements anonymes, et le critère
-- perdrait son sens (constaté en E1-02).
--
-- La contrainte ne vise que l'ajustement : une vente, une réception, un
-- inventaire n'ont rien à justifier — leur document le fait.
-- ----------------------------------------------------------------------------

alter table public.stock_movement
  add constraint stock_movement_adjustment_reason
  check (movement_type <> 'adjustment' or btrim(coalesce(note, '')) <> '');

comment on column public.stock_movement.note is
  'Le motif d''un ajustement manuel, obligatoire sur ce type-là et sur lui '
  'seul — contrainte stock_movement_adjustment_reason. Libre ailleurs. E3-03.';


-- ----------------------------------------------------------------------------
-- L'auteur du mouvement
--
-- Le jeton ne porte pas l'identifiant `app_user` — `src/lib/auth/claims.ts` ne
-- lit que `tenant_id` et `role` — donc l'écran ne peut pas remplir `created_by`
-- lui-même, et l'historique d'E3-02 afficherait « Auteur inconnu » sur le
-- mouvement le plus sensible de la table. Le défaut le prend à la source, comme
-- `tenant_id` prend la sienne (§ 4).
--
-- Limite assumée : un appelant peut toujours envoyer explicitement un autre
-- `created_by` de son commerce. Cela ne falsifie pas la trace — l'entrée
-- d'`audit_log` tient son auteur du jeton signé, par `merx.log_audit()`, hors
-- de portée de l'appelant (RÈGLE M8-2).
-- ----------------------------------------------------------------------------

alter table public.stock_movement
  alter column created_by set default merx.current_app_user();


-- ============================================================================
-- 4. La trace
--
-- Par trigger, et non par une RPC. `merx.log_audit()` n'est exécutable ni par
-- `authenticated` ni hors d'une fonction `security definer` de `public`
-- (E1-04) : une RPC devrait donc être `security definer`, ce qui lui ferait
-- contourner la policy `column_capability_insert` d'E3-01 et m'obligerait à
-- réécrire le contrôle de droit ailleurs que dans la matrice — interdit par
-- § 3. Le chemin d'écriture reste l'insertion directe, gardée par la policy, et
-- la trace est un `AFTER INSERT` : elle n'est écrite que pour une ligne que la
-- RLS et toutes les contraintes ont acceptée.
--
-- Et **par `merx.apply_audit()`**, non à la main : un trigger d'audit posé hors
-- de ce helper échapperait à `merx.audited_registry`, que le harnais de test
-- lit pour peupler et ranger et que `conventions.ts` confronte aux triggers
-- réellement posés. La règle refuse d'ailleurs les deux sens — un registre sans
-- trigger, un trigger sans registre.
--
-- Le helper lui manquait deux choses pour cette table-ci :
--
--   — **une condition de ligne.** Auditer chaque mouvement noierait le journal
--     sous les ventes, et M8-1 ne le demande pas : seul l'ajustement est une
--     action auditée. La condition vit dans le `when` du trigger, donc dans le
--     catalogue, et non dans un `if` du corps qu'on pourrait retirer ;
--
--   — **des événements dérivés, et non codés en dur.** Les trois événements
--     d'origine sont impossibles ici : `stock_movement` est en ajout seul, un
--     trigger UPDATE ou DELETE y serait mort-né, et surtout Postgres refuse un
--     `when (new....)` sur un trigger DELETE — `new` n'y est pas défini. Le
--     helper lit donc `merx.append_only_registry` : une table en ajout seul ne
--     reçoit qu'un `AFTER INSERT`, les autres gardent les trois. Les deux
--     registres disent la même chose au lieu de se recopier.
-- ============================================================================

alter table merx.audited_registry
  add column row_condition text;

comment on column merx.audited_registry.row_condition is
  'La clause when du trigger, telle que le catalogue la rend, ou NULL quand '
  'toute écriture est journalisée. Relue du catalogue à la pose, jamais '
  'recopiée : conventions.ts la compare au trigger réel. E3-03.';


-- ----------------------------------------------------------------------------
-- `merx.apply_audit()`, repris
--
-- `drop` puis `create`, et non un `create or replace` : la signature change, et
-- un `replace` aurait laissé une surcharge à trois paramètres derrière lui — un
-- appel à trois arguments aurait alors eu deux candidats. Le corps est celui de
-- la dernière migration qui touche la fonction (`20260911160000`, addendum
-- E2-03), augmenté et non réécrit (CLAUDE.md, un `create or replace` part de la
-- dernière définition).
--
-- Aucune dépendance à casser : les triggers posés référencent
-- `merx.audit_row_change()`, pas ce helper-ci.
-- ----------------------------------------------------------------------------

drop function merx.apply_audit(regclass, public.audit_action, text[]);

create function merx.apply_audit(
  target          regclass,
  audited_action  public.audit_action,
  audited_columns text[],
  row_condition   text default null
)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  audited_table text;
  unknown       text;
  arguments     text;
  append_only   boolean;
  events        text;
  posed         text;
begin
  select c.relname into audited_table from pg_catalog.pg_class c where c.oid = target;

  select pg_catalog.string_agg(col, ', ') into unknown
  from pg_catalog.unnest(audited_columns) as col
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = target and a.attname = col and a.attnum > 0 and not a.attisdropped
  );

  if unknown is not null then
    raise exception 'Colonne auditée inconnue sur % : %', audited_table, unknown;
  end if;

  select pg_catalog.string_agg(pg_catalog.quote_literal(arg), ', ' order by ord)
    into arguments
  from pg_catalog.unnest(array[audited_action::text] || audited_columns)
    with ordinality as t(arg, ord);

  -- Les événements, dérivés du registre d'ajout seul. Une table dont les lignes
  -- ne peuvent ni changer ni disparaître n'a qu'une écriture à journaliser ; et
  -- une condition sur `new` ne se laisse pas poser sur un trigger DELETE.
  select exists (
    select 1 from merx.append_only_registry r where r.table_name = audited_table
  ) into append_only;

  if row_condition is not null and not append_only then
    raise exception
      'Condition de ligne sur %, qui n''est pas en ajout seul : le when porterait '
      'sur new, que Postgres ne définit pas pour un trigger DELETE.', audited_table;
  end if;

  events := case when append_only then 'insert' else 'insert or update or delete' end;

  execute pg_catalog.format(
    'create trigger audit_row_change after %s on %s for each row %s'
    ' execute function merx.audit_row_change(%s)',
    events, target,
    case when row_condition is null then ''
         else pg_catalog.format('when (%s)', row_condition) end,
    arguments);

  -- La condition est relue du catalogue, sous la forme que Postgres lui donne :
  -- c'est elle que `conventions.ts` comparera au trigger, et une forme recopiée
  -- à la main aurait divergé du premier coup.
  select (pg_catalog.regexp_match(
            pg_catalog.pg_get_triggerdef(tg.oid), 'WHEN \((.*)\) EXECUTE'))[1]
    into posed
  from pg_catalog.pg_trigger tg
  where tg.tgrelid = target and tg.tgname = 'audit_row_change';

  insert into merx.audited_registry (table_name, action, columns, row_condition)
  values (audited_table, audited_action, audited_columns, posed);
end;
$function$;

comment on function merx.apply_audit(regclass, public.audit_action, text[], text) is
  'Journalise les écritures d''une table sous une étiquette de la RÈGLE M8-1 : '
  'trigger merx.audit_row_change(), inscription à merx.audited_registry. '
  'Événements dérivés de merx.append_only_registry ; row_condition restreint la '
  'journalisation à une partie des lignes. Addendum E2-03, étendu en E3-03 ; '
  'servira à goods_receipt_line_cost en E8-03.';


-- ----------------------------------------------------------------------------
-- `stock_movement` — l'ajustement, et lui seul
--
-- L'entrée retient ce qu'un patron relit le soir où une quantité ne tombe pas
-- juste : la variante, la quantité du mouvement, le motif. La date, l'auteur et
-- le commerce, l'entrée les porte déjà.
-- ----------------------------------------------------------------------------

select merx.apply_audit(
  'public.stock_movement', 'stock_adjustment',
  array['variant_id', 'quantity', 'note'],
  $$new.movement_type = 'adjustment'$$);
