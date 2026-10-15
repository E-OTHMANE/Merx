-- ============================================================================
-- Merx — le dépôt d'un bon de vente, posé par la base
--
-- Référence : docs/SPEC.md § 2.4 (dépôt unique, « jamais exposée »),
--             § 2.1 (isolation), § 4 (conventions), § 8 ;
--             docs/BACKLOG.md E4-03.
--
-- `sale_document.warehouse_id` est NOT NULL et sans défaut depuis E4-01 : tout
-- appelant devait donc nommer le dépôt. Pour l'écran de vente, cela voudrait
-- dire lire `public.warehouse` avant de pouvoir vendre — un aller-retour de
-- plus sur le chemin d'un bon qu'un client attend debout (SPEC § 10, point de
-- rupture n° 2), et une table que § 2.4 dit « jamais exposée » lue par
-- l'interface.
--
-- Le défaut descend donc dans la base, comme `tenant_id` et `created_by` qui
-- viennent déjà du jeton (`merx.apply_business_conventions`, E0-03 ; E3-03).
-- Même geste qu'en E3-02 pour le dépôt d'une ligne de `stock_level` : ce que la
-- base sait, l'appelant n'a pas à le redire.
--
-- **`security invoker`**, et c'est ce qui compte ici : les deux policies de
-- § 2.1 s'appliquent à cette lecture comme à toute autre, donc la fonction ne
-- peut pas voir le dépôt d'un voisin même si son filtre tombait. Le filtre sur
-- `merx.current_tenant_id()` est quand même en tête du corps — deux refus pour
-- la même ligne, et c'est le filtre qu'on sabote pour mesurer la policy.
-- Aucune inscription à `merx.rls_exception_registry` : rien ici ne sort de la
-- RLS (la règle de `conventions.ts` ne vise que le `security definer`).
--
-- Un commerce a exactement un dépôt par défaut — le trigger d'E3-02 en garantit
-- au moins un, `warehouse_one_default_per_tenant` au plus un. La fonction rend
-- donc une ligne, ou `null` si la session n'a pas de commerce : le NOT NULL de
-- la colonne refuse alors l'insertion (`23502`), ce qui est le bon refus — il
-- n'y a pas de dépôt à deviner.
-- ============================================================================

create function merx.default_warehouse_id()
returns uuid
language sql
stable
set search_path = ''
as $function$
  select w.id
  from public.warehouse w
  where w.tenant_id = merx.current_tenant_id()
    and w.is_default
    and w.deleted_at is null
$function$;

comment on function merx.default_warehouse_id() is
  'Le dépôt par défaut du commerce de la session — SPEC § 2.4. Invoker : les '
  'policies de § 2.1 gouvernent la lecture. Sert de défaut à '
  'sale_document.warehouse_id, pour que l''écran de vente n''ait pas à lire une '
  'table que le spec ne lui expose pas. E4-03.';

grant execute on function merx.default_warehouse_id() to authenticated;

alter table public.sale_document
  alter column warehouse_id set default merx.default_warehouse_id();

comment on column public.sale_document.warehouse_id is
  'Le dépôt d''où part la marchandise. Posé par défaut depuis le commerce de la '
  'session (merx.default_warehouse_id(), E4-03) : un seul dépôt en V1 (SPEC '
  '§ 2.4), et l''écran n''a pas à le nommer.';
