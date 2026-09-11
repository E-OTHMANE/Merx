-- ============================================================================
-- Merx — le journal du prix d'achat
--
-- Référence : docs/SPEC.md § 3 (RÈGLE de placement des coûts), § 6 M1
--             (`variant_cost`), § 9 M8 (RÈGLE M8-1), docs/BACKLOG.md E1-04,
--             E2-03 (addendum).
--
-- Une lacune dans du code livré, pas une anticipation. E2-03 a livré
-- `variant_cost`, que le patron écrit directement par PostgREST ; la RÈGLE M8-1
-- dit que tout changement de prix d'achat écrit dans `audit_log`, et rien ne
-- l'écrivait (relevé à la clôture d'E2-04).
--
-- **Par trigger**, parce que l'écriture arrive par PostgREST sans fonction
-- intermédiaire : un contrôle placé dans l'application se contournerait d'une
-- requête. Le trigger est sur la table, et aucun chemin d'écriture ne l'évite.
--
-- **Hors session, l'écriture est refusée** — sans commerce dans le jeton
-- (`42501`), ou sans fiche utilisateur derrière lui (`23502`). C'est le
-- comportement de `merx.log_audit()`, appelé tel quel : E1-04 a posé
-- `audit_log.user_id NOT NULL` pour qu'une entrée sans auteur ne puisse pas
-- exister, et la RÈGLE M8-1 dit « écrivent obligatoirement ». Une écriture de
-- `service_role` ou de `postgres` changerait sinon un prix d'achat sans trace —
-- le chemin qu'un incident empruntera. Arbitré à la clôture d'E2-04.
--
-- Le seul contournement est la suspension des triggers
-- (`session_replication_role = replica`), et il est réservé au harnais de test,
-- pour peupler et ranger (`supabase/tests/rest.ts`, `withoutTriggers`). Une
-- migration ou une fonction applicative qui en aurait besoin serait le signe
-- que la règle est mal posée — pas qu'il faut l'écarter une fois de plus.
--
-- Écrit pour servir deux fois : `goods_receipt_line_cost` (E8-03) s'y
-- branchera par un appel à `merx.apply_audit()`, et
-- `supabase/tests/conventions.ts` refusera toute relation restreinte par
-- `view_cost` qui ne l'aurait pas fait.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Le registre des tables journalisées
--
-- Même rôle que `merx.append_only_registry` (E1-04) : ce n'est pas une
-- étiquette. `supabase/tests/isolation.ts` et `rest.ts` le lisent pour savoir
-- quelles tables peupler et ranger triggers suspendus, sans en nommer aucune ;
-- `conventions.ts` le confronte aux triggers réellement posés.
-- ----------------------------------------------------------------------------

create table merx.audited_registry (
  table_name text                primary key,
  action     public.audit_action not null,
  columns    text[]              not null check (cardinality(columns) > 0)
);

comment on table merx.audited_registry is
  'Tables dont chaque écriture est journalisée par merx.audit_row_change(), '
  'sous quelle étiquette, et quelles colonnes l''entrée retient. RÈGLE M8-1, '
  'addendum E2-03.';


-- ----------------------------------------------------------------------------
-- `merx.audit_row_change()` — le trigger
--
-- Création, modification, suppression : chacune écrit son entrée, avec l'état
-- avant et l'état après — NULL de part et d'autre pour la création et la
-- suppression. L'entrée vise la ligne (`entity_type` = la table,
-- `entity_id` = son identifiant).
--
-- **Seules les colonnes déclarées entrent dans l'entrée**, pas la ligne
-- entière : le journal dit ce qui a changé de prix, pas l'horodatage ni le
-- commerce, que l'entrée porte déjà. Et une mise à jour qui ne change aucune de
-- ces colonnes n'écrit rien : toucher `updated_at` n'est pas changer un prix.
--
-- `security definer`, parce que `merx.log_audit()` n'est exécutable par
-- personne d'autre que son propriétaire (E1-04) : c'est ce qui fait qu'aucune
-- entrée ne naît sans action réelle. Le commerce et l'auteur, eux, viennent
-- toujours du jeton de celui qui écrit — le trigger n'en passe aucun.
--
-- AFTER : l'entrée n'est écrite que pour une ligne que toutes les contraintes
-- ont acceptée, dans la même transaction. Une écriture refusée n'entre pas au
-- journal ; une entrée refusée annule l'écriture.
-- ----------------------------------------------------------------------------

create function merx.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  audited_action  public.audit_action := tg_argv[0]::public.audit_action;
  audited_columns text[] := tg_argv[1:tg_nargs - 1];
  state_before    jsonb;
  state_after     jsonb;
  entity          uuid;
begin
  if tg_op <> 'INSERT' then
    select pg_catalog.jsonb_object_agg(c, pg_catalog.to_jsonb(old) -> c)
      into state_before
    from pg_catalog.unnest(audited_columns) as c;
    entity := old.id;
  end if;

  if tg_op <> 'DELETE' then
    select pg_catalog.jsonb_object_agg(c, pg_catalog.to_jsonb(new) -> c)
      into state_after
    from pg_catalog.unnest(audited_columns) as c;
    entity := new.id;
  end if;

  if tg_op = 'UPDATE' and state_before = state_after then
    return null;
  end if;

  perform merx.log_audit(audited_action, tg_table_name, entity, state_before, state_after);
  return null;
end;
$function$;

comment on function merx.audit_row_change() is
  'Trigger AFTER INSERT, UPDATE, DELETE posé par merx.apply_audit() : écrit '
  'l''entrée de journal de chaque écriture, colonnes déclarées seulement. '
  'Refuse, par merx.log_audit(), toute écriture sans commerce ni auteur. '
  'RÈGLE M8-1.';


-- ----------------------------------------------------------------------------
-- `merx.apply_audit()` — pose le trigger et inscrit la table
--
-- Une colonne déclarée qui n'existe pas est refusée ici, à la migration : sans
-- ce contrôle, l'entrée porterait `null` pour elle, en silence, pour toujours.
-- ----------------------------------------------------------------------------

create function merx.apply_audit(
  target          regclass,
  audited_action  public.audit_action,
  audited_columns text[]
)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  table_name text;
  unknown    text;
  arguments  text;
begin
  select c.relname into table_name from pg_catalog.pg_class c where c.oid = target;

  select pg_catalog.string_agg(col, ', ') into unknown
  from pg_catalog.unnest(audited_columns) as col
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = target and a.attname = col and a.attnum > 0 and not a.attisdropped
  );

  if unknown is not null then
    raise exception 'Colonne auditée inconnue sur % : %', table_name, unknown;
  end if;

  select pg_catalog.string_agg(pg_catalog.quote_literal(arg), ', ' order by ord)
    into arguments
  from pg_catalog.unnest(array[audited_action::text] || audited_columns)
    with ordinality as t(arg, ord);

  execute pg_catalog.format(
    'create trigger audit_row_change after insert or update or delete on %s'
    ' for each row execute function merx.audit_row_change(%s)',
    target, arguments);

  insert into merx.audited_registry (table_name, action, columns)
  values (table_name, audited_action, audited_columns);
end;
$function$;

comment on function merx.apply_audit(regclass, public.audit_action, text[]) is
  'Journalise chaque écriture d''une table sous une étiquette de la RÈGLE M8-1 : '
  'trigger merx.audit_row_change(), inscription à merx.audited_registry. '
  'Addendum E2-03 ; servira à goods_receipt_line_cost en E8-03.';


-- ----------------------------------------------------------------------------
-- `variant_cost` — le prix d'achat
--
-- L'entrée retient la variante et le prix : c'est ce qu'un patron relit quand
-- une marge ne tombe pas juste.
-- ----------------------------------------------------------------------------

select merx.apply_audit(
  'public.variant_cost', 'purchase_price_change', array['variant_id', 'cost_price']);
