-- ============================================================================
-- Un refus est une réponse 4xx
--
-- SPEC § 4, RÈGLE des refus en 4xx. E4-01 avait laissé quatre gardes lever un
-- SQLSTATE que PostgREST rend en **500** — mesuré, pas supposé : 55006 (tables
-- figées), 55000 (tables dérivées), 54000 (26 appareils), P0002 (introuvable).
--
-- Un 5xx n'est pas un détail d'affichage. En E9, PowerSync rejoue les écritures
-- en attente et lit un 5xx comme une panne passagère : il réessaie sans fin, et
-- la file de l'appareil reste bloquée sur un refus qui, lui, ne changera jamais
-- d'avis. Un refus légitime doit donc sortir en 4xx, pour que le client
-- l'abandonne et le remonte à l'utilisateur.
--
-- La voie retenue est la famille `PTxxx` de PostgREST, faite pour cela : les
-- trois chiffres du code *sont* le statut HTTP, et le code reste propre à son
-- garde — un garde, un code, une phrase, un test. Aucun code de Postgres n'est
-- détourné de son sens, et rien d'autre que le `errcode` ne change ici.
--
--   55006 → PT409  l'état de la ligne interdit l'écriture (conflit)
--   55000 → PT422  la table ne s'écrit pas : c'est un agrégat
--   54000 → PT400  la demande ne peut pas être satisfaite (26 appareils)
--   P0002 → PT404  la ligne désignée n'existe pas
--
-- Mesuré sur ce stack : PT400→400, PT403→403, PT409→409, PT422→422, PT428→428.
-- Les douze fonctions sont reprises depuis leur **dernière** définition, lue au
-- catalogue, et seul leur code de refus change.
-- ============================================================================

CREATE OR REPLACE FUNCTION merx.maintain_stock_level()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
        using errcode = 'PT422';
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

CREATE OR REPLACE FUNCTION merx.next_device_prefix(target_tenant uuid)
 RETURNS device_prefix
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      using errcode = 'PT400';
  end if;

  return chosen;
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_derived_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  source text;
begin
  select r.source_table into source
  from merx.derived_registry r
  where r.table_name = tg_table_name;

  raise exception
    '% est un agrégat : la table ne se vide pas d''un coup. Elle se recalcule depuis %.',
    tg_table_name, coalesce(source, 'sa table source')
    using errcode = 'PT422';
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_derived_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  source text;
begin
  if pg_catalog.pg_trigger_depth() >= 2 then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select r.source_table into source
  from merx.derived_registry r
  where r.table_name = tg_table_name;

  raise exception
    '% est un agrégat : il ne s''écrit pas à la main. Écrire dans %, le trigger s''en charge.',
    tg_table_name, coalesce(source, 'sa table source')
    using errcode = 'PT422';
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_frozen_birth()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  reg    merx.frozen_registry%rowtype;
  status text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  status := pg_catalog.to_jsonb(new) ->> reg.status_column;

  if status <> reg.open_status then
    raise exception
      '% naît au statut « % », et à aucun autre : l''enregistrement demandait « % ». '
      'Le statut avance ensuite par UPDATE, le long des transitions déclarées.',
      tg_table_name, reg.open_status, status
      using errcode = 'PT409';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_frozen_child_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  parent_table  text := tg_argv[0];
  parent_column text := tg_argv[1];
  status_column text := tg_argv[2];
  open_status   text := tg_argv[3];
  parent_id     uuid;
  status        text;
begin
  for parent_id in
    select distinct v
    from (
      select case when tg_op <> 'INSERT'
                  then (pg_catalog.to_jsonb(old) ->> parent_column)::uuid end as v
      union all
      select case when tg_op <> 'DELETE'
                  then (pg_catalog.to_jsonb(new) ->> parent_column)::uuid end
    ) s
    where v is not null
  loop
    execute pg_catalog.format(
      'select %I::text from public.%I where tenant_id = $1 and id = $2 for share',
      status_column, parent_table)
      into status
      using coalesce(
        case when tg_op <> 'INSERT' then (pg_catalog.to_jsonb(old) ->> 'tenant_id')::uuid end,
        (pg_catalog.to_jsonb(new) ->> 'tenant_id')::uuid),
        parent_id;

    if status is not null and status <> open_status then
      raise exception
        'Les lignes de % ne se modifient plus : son document est au statut « % » '
        '(RÈGLE M3-3). Seul un brouillon reçoit, change ou perd des lignes.',
        tg_table_name, status
        using errcode = 'PT409';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_frozen_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  reg    merx.frozen_registry%rowtype;
  status text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  status := pg_catalog.to_jsonb(old) ->> reg.status_column;

  if status <> reg.open_status then
    raise exception
      'Un enregistrement de % au statut « % » ne se supprime pas (RÈGLE M3-3) : '
      'seul le statut « % » peut l''être. Un document confirmé s''annule.',
      tg_table_name, status, reg.open_status
      using errcode = 'PT409';
  end if;

  return old;
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_frozen_truncate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception
    '% ne se vide pas d''un coup : ses lignes figées ne se suppriment jamais '
    '(RÈGLE M3-3).', tg_table_name
    using errcode = 'PT409';
end;
$function$;

CREATE OR REPLACE FUNCTION merx.reject_frozen_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  reg        merx.frozen_registry%rowtype;
  old_status text;
  new_status text;
  allowed    text[];
  changed    text;
begin
  select * into reg from merx.frozen_registry r where r.table_name = tg_table_name;
  old_status := pg_catalog.to_jsonb(old) ->> reg.status_column;
  new_status := pg_catalog.to_jsonb(new) ->> reg.status_column;

  if old_status = new_status then
    if old_status = reg.open_status then
      return new;
    end if;

    select pg_catalog.string_agg(n.key, ', ' order by n.key) into changed
    from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as n
    where n.key <> 'updated_at'
      and (pg_catalog.to_jsonb(old) -> n.key) is distinct from n.value;

    if changed is not null then
      raise exception
        'Un enregistrement de % au statut « % » ne se modifie plus (RÈGLE M3-3) : '
        'colonne(s) changée(s) — %. Seul son statut avance.',
        tg_table_name, old_status, changed
        using errcode = 'PT409';
    end if;

    return new;
  end if;

  select t.mutable_columns into allowed
  from merx.frozen_transition t
  where t.table_name = tg_table_name
    and t.from_status = old_status
    and t.to_status = new_status;

  if not found then
    raise exception
      'Transition de statut refusée sur % : « % » → « % ». Seules les transitions '
      'déclarées à merx.frozen_transition sont admises.',
      tg_table_name, old_status, new_status
      using errcode = 'PT409';
  end if;

  if old_status = reg.open_status then
    return new;
  end if;

  select pg_catalog.string_agg(n.key, ', ' order by n.key) into changed
  from pg_catalog.jsonb_each(pg_catalog.to_jsonb(new)) as n
  where n.key <> all (array['updated_at', reg.status_column] || allowed)
    and (pg_catalog.to_jsonb(old) -> n.key) is distinct from n.value;

  if changed is not null then
    raise exception
      'La transition « % » → « % » de % ne change que le statut%, et a changé aussi : % '
      '(RÈGLE M3-3).',
      old_status, new_status, tg_table_name,
      case when pg_catalog.cardinality(allowed) = 0 then ''
           else ' et ' || pg_catalog.array_to_string(allowed, ', ') end,
      changed
      using errcode = 'PT409';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION merx.seed_tenant_settings(target_tenant uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  commerce public.tenant%rowtype;
begin
  if target_tenant is null then
    raise exception 'Aucun commerce désigné.' using errcode = '23514';
  end if;

  select * into commerce from public.tenant t where t.id = target_tenant;

  if not found then
    raise exception 'Commerce introuvable : %.', target_tenant using errcode = 'PT404';
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

CREATE OR REPLACE FUNCTION public.register_device(device_key uuid, device_label text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, label text, prefix device_prefix, last_sync_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      raise exception 'Appareil introuvable.' using errcode = 'PT404';
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

CREATE OR REPLACE FUNCTION public.set_user_active(target_user uuid, active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    raise exception 'Employé introuvable.' using errcode = 'PT404';
  end if;
end;
$function$;
