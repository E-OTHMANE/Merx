-- ============================================================================
-- Merx — la fiche client
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant, exception nommée),
--             § 2.6 (RÈGLE de la charge de saisie), § 3.1 (`manage_client`,
--             déjà dans la matrice), § 4 (conventions, clés étrangères
--             composites, refus en 4xx), § 8 (`sale_document.client_id`),
--             § 9 M4 ; docs/BACKLOG.md E6-01, E4-01, E4-03, E4-07.
--
-- Ferme trois notes laissées par l'étape 4 :
--
--   — `sale_document.client_id`, avec sa clé composite, dans le même geste
--     que la table `client` (note d'E4-01) ;
--   — le filtre par client de `list_sale_documents()` (note d'E4-07).
--   — la sélection ou création d'un client depuis l'écran de vente (E4-03)
--     n'a rien ici : c'est du front, elle n'a besoin d'aucune colonne neuve.
--
-- Quatre choses :
--
--   1. `public.client` — le nom seul obligatoire (SPEC § 2.6), `ice` masqué,
--      pas de `credit_limit` (E6-03 le pose avec son garde `owner` seul) ;
--   2. la recherche, par nom et par téléphone, tolérante aux fautes — la forme
--      de `search_products()` (E2-04), mesurée pour elle-même et non recopiée ;
--   3. `sale_document.client_id`, et sa clé composite ;
--   4. `list_sale_documents()`, reprise depuis sa dernière définition, avec le
--      filtre par client.
--
-- Aucune capacité neuve : `manage_client` est dans la matrice depuis E0-05
-- (owner et worker), avant même que la table existe. Les quatre copies ne
-- bougent pas.
-- ============================================================================


-- ============================================================================
-- 1. `public.client`
--
-- SPEC § 9 M4 : `id, tenant_id, name, phone, city, address, credit_limit, ice,
-- notes, is_active, deleted_at`. `credit_limit` n'est **pas** posée ici : elle
-- naît en E6-03 avec son garde `owner` seul, et une colonne nullable posée en
-- avance serait écrite par un `worker` par simple appel API pendant tout
-- l'intervalle qui sépare les deux stories — même raisonnement que `client_id`
-- sur `sale_document` en E4-01.
--
-- `ice` : nullable, jamais affiché ni écrit par l'application (SPEC § 9 M4).
-- Rien ne l'empêche en base — ce n'est pas un garde, c'est une absence
-- d'écran.
-- ============================================================================

create table public.client (
  id        uuid    primary key default gen_random_uuid(),
  name      text    not null,
  phone     text,
  city      text,
  address   text,
  ice       text,
  notes     text,
  is_active boolean not null default true
);

comment on table public.client is
  'Fiche client. Seul le nom est obligatoire (SPEC § 2.6). SPEC § 9 M4 ; E6-01.';

comment on column public.client.ice is
  'Identifiant commun de l''entreprise. Nullable, masqué, inutilisé en V1 — '
  'SPEC § 9 M4.';

select merx.apply_reference_conventions('public.client');
select merx.register_creation_form('public.client', 'name');

alter table public.client
  add constraint client_tenant_id_id_key unique (tenant_id, id);

select merx.apply_write_capability_restriction('public.client', 'manage_client');

comment on policy write_capability_insert on public.client is
  'Écrire un client exige manage_client ; le lire n''exige que d''appartenir '
  'au commerce — les deux rôles le lisent et le créent (SPEC § 3.1). E6-01.';
comment on policy write_capability_update on public.client is
  'Écrire un client exige manage_client ; le lire n''exige que d''appartenir '
  'au commerce — les deux rôles le lisent et le créent (SPEC § 3.1). E6-01.';
comment on policy write_capability_delete on public.client is
  'Écrire un client exige manage_client ; le lire n''exige que d''appartenir '
  'au commerce — les deux rôles le lisent et le créent (SPEC § 3.1). E6-01.';


-- ----------------------------------------------------------------------------
-- Le téléphone : normalisé quand c'est possible, jamais refusé
--
-- Le front passe la saisie à `normalizePhone()` (E1-01, la copie partagée de
-- `supabase/functions/_shared/phone.ts`) : reconnue, c'est la forme canonique
-- qui s'écrit (`0612345678`) ; sinon la saisie elle-même, bords retirés — un
-- numéro étranger ou une faute de frappe n'empêche jamais la création d'un
-- client (SPEC § 2.6, « rien ne bloque »). Le trigger ne fait que le ménage
-- qu'une saisie directe par l'API ou un import ne ferait pas elle-même : même
-- forme que `normalize_product_code` (E2-02).
--
-- Deux clients peuvent partager un numéro — un numéro de boutique sert à
-- plusieurs fiches. Aucun index unique.
-- ----------------------------------------------------------------------------

create function merx.normalize_client_phone()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.phone := nullif(pg_catalog.btrim(new.phone), '');
  return new;
end;
$function$;

create trigger normalize_phone
  before insert or update of phone on public.client
  for each row execute function merx.normalize_client_phone();


-- ============================================================================
-- 2. La recherche : nom et téléphone, à une faute près
--
-- BACKLOG E6-01 : « recherche par nom et par téléphone, tolérante aux
-- fautes ». Même obstacle qu'en E2-04, pour la même raison mesurée là-bas :
-- sous RLS, aucune condition d'index sur `like`, `unaccent` ou `pg_trgm` n'est
-- `leakproof`, et `postgres` n'est pas superutilisateur. `public.search_clients()`
-- reprend donc la forme de `search_products()` — même registre, même garde,
-- même réglage de plan — réemployant `merx.search_fold()`, `like_pattern()`,
-- `search_words()`, `search_pivot()` et `search_allows_typo()` (E2-04) plutôt
-- que de les recopier.
--
-- `merx.phone_digits()` est une **seconde copie**, délibérée, du cœur de
-- `normalizePhone()` (E1-01) : l'extraction des chiffres et les trois préfixes
-- (`00212`, `212` sur 12 chiffres, 9 chiffres sans zéro). Elle ne valide pas la
-- forme finale — `normalizePhone()` refuse un numéro qui n'a pas dix chiffres
-- commençant par zéro, `phone_digits()` rend ce qu'elle trouve, pour qu'un
-- numéro étranger reste cherchable par ses chiffres. Les deux copies sont
-- mesurées l'une contre l'autre par `supabase/tests/phone-parity.test.ts` : sur
-- chaque écriture valide de `src/lib/phone.test.ts`, les deux doivent rendre la
-- même forme canonique — une divergence future se verrait avant de se vivre
-- en support, comme la table du fuseau mesurée contre Postgres (SPEC § 4).
-- ============================================================================

/*
 * Chiffres seuls, préfixes internationaux ramenés au national — le cœur de
 * `normalizePhone()` (supabase/functions/_shared/phone.ts), sans sa
 * validation finale. `null` seulement si l'entrée ne contient aucun chiffre :
 * un `phone` vide ou sans chiffre n'a rien à chercher.
 *
 * `\D` est délibérément celui de la classe POSIX ASCII, pas celui de
 * `merx.search_fold()` : la parité se mesure contre `normalizePhone()`, qui ne
 * reconnaît pas les chiffres arabes (`input.replace(/\D/g, '')` en JavaScript
 * ne les retire pas comme des chiffres). Leur traduction est le travail de la
 * requête de recherche (merx.phone_query_digits ci-dessous), pas de cette
 * colonne.
 */
create function merx.phone_digits(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select case
    when d = '' then null
    when d like '00212%' then '0' || pg_catalog.substr(d, 6)
    when d like '212%' and pg_catalog.length(d) = 12 then '0' || pg_catalog.substr(d, 4)
    when pg_catalog.length(d) = 9 and d not like '0%' then '0' || d
    else d
  end
  from (select pg_catalog.regexp_replace(coalesce(value, ''), '\D', '', 'g') as d) s
$function$;

comment on function merx.phone_digits(text) is
  'Chiffres d''un numéro, préfixes internationaux ramenés au national — le '
  'cœur de normalizePhone() (E1-01), sans sa validation finale. Mesurée contre '
  'elle par supabase/tests/phone-parity.test.ts. E6-01.';

-- Évaluée par les colonnes générées ci-dessous, donc sous le rôle qui insère —
-- même raison que merx.search_fold() en E2-04.
grant execute on function merx.phone_digits(text) to authenticated;

alter table public.client
  add column phone_digits text generated always as (merx.phone_digits(phone)) stored,
  add column search_text  text generated always as (
    merx.search_fold(name) || ' ' || coalesce(merx.phone_digits(phone), '')
  ) stored;

comment on column public.client.phone_digits is
  'Chiffres du téléphone, préfixe international ramené au national. Générée, '
  'merx.phone_digits(). E6-01.';
comment on column public.client.search_text is
  'Nom sous merx.search_fold() et chiffres du téléphone. Générée. E6-01.';

create index client_search on public.client
  using gin (tenant_id, search_text extensions.gin_trgm_ops)
  with (fastupdate = off);

comment on index public.client_search is
  'Recherche client (E6-01) : nom à une faute près, téléphone en sous-chaîne '
  'de ses chiffres. L''expression est celle de search_clients() : sans elle '
  'identique, l''index ne sert pas.';


/*
 * Les mêmes trois préfixes que `merx.phone_digits()`, appliqués aux chiffres
 * d'une requête de recherche — mais extraits par `merx.search_fold()`, donc
 * chiffres arabes compris, à la différence de `merx.phone_digits()`. Une
 * requête réduite à ses seuls chiffres sans ce passage par le national
 * chercherait « 212612345678 » dans une colonne qui porte « 0612345678 », et
 * ne le trouverait jamais : la tablette réglée en arabe qui tape ٠٦١٢ doit
 * retrouver le même client que celle qui tape 0612, écrit depuis un clavier
 * latin par le patron.
 */
create function merx.phone_query_digits(q text)
returns text
language sql
immutable
parallel safe
as $function$
  select case
    when d = '' then ''
    when d like '00212%' then '0' || pg_catalog.substr(d, 6)
    when d like '212%' and pg_catalog.length(d) = 12 then '0' || pg_catalog.substr(d, 4)
    when pg_catalog.length(d) = 9 and d not like '0%' then '0' || d
    else d
  end
  from (select pg_catalog.regexp_replace(merx.search_fold(q), '[^0-9]', '', 'g') as d) s
$function$;

comment on function merx.phone_query_digits(text) is
  'Chiffres d''une requête, réduits au national comme merx.phone_digits() — '
  'mais extraits par merx.search_fold(), donc chiffres arabes compris. Sert à '
  'reconnaître une requête « en forme de téléphone » et à la comparer à '
  'phone_digits. E6-01.';


select extensions.similarity('', '');

create function public.search_clients(q text)
returns table (
  id    uuid,
  name  text,
  phone text,
  city  text
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
set pg_trgm.word_similarity_threshold = 0.4
as $function$
#variable_conflict use_column
declare
  digits   text    := merx.phone_query_digits(q);
  /*
   * Une requête « en forme de téléphone » : une fois pliée (chiffres arabes
   * compris), elle ne contient que des chiffres et la ponctuation d'un numéro
   * — espaces, « + », « . », « - », parenthèses — et au moins deux chiffres.
   * Sous ce seuil, « 06 » chercherait n'importe quel nom qui contient ces deux
   * chiffres n'importe où.
   */
  as_phone boolean :=
    pg_catalog.length(digits) >= 2
    and pg_catalog.regexp_replace(merx.search_fold(q), '[0-9 +.()-]', '', 'g') = '';
begin
  return query
  with catalogue as not materialized (
    select c.id, c.name, c.phone, c.city, c.phone_digits, c.search_text
    from public.client c
    -- SEUL GARDE D'ISOLATION DE CE CHEMIN. security definer : aucune policy ne
    -- s'applique ici. SPEC § 2.1, exception nommée ; merx.rls_exception_registry.
    where c.tenant_id = (select merx.current_tenant_id())
      and c.deleted_at is null
  ),
  query as not materialized (
    select merx.search_fold(q)  as folded,
           merx.search_words(q) as words,
           merx.search_pivot(q) as pivot
  ),
  hits as (
    select cl.*
    from catalogue cl, query x
    where as_phone and cl.phone_digits like '%' || merx.like_pattern(digits) || '%'
    union
    select cl.*
    from catalogue cl, query x
    where not as_phone and (
      x.pivot is null
      or cl.search_text like '%' || merx.like_pattern(x.pivot) || '%'
      or (merx.search_allows_typo(x.pivot) and x.pivot operator(extensions.<%) cl.search_text)
    )
  )
  select h.id, h.name, h.phone, h.city
  from hits h, query x
  where as_phone or not exists (
    select 1
    from pg_catalog.unnest(x.words) as w
    where not (h.search_text like '%' || merx.like_pattern(w) || '%'
               or (merx.search_allows_typo(w) and w operator(extensions.<%) h.search_text))
  )
  order by
    case
      when as_phone then 0
      when x.folded = '' then 0
      when h.search_text like merx.like_pattern(x.folded) || '%' then 1
      when h.search_text like '%' || merx.like_pattern(x.folded) || '%' then 2
      else 3
    end,
    case
      when not as_phone and merx.search_allows_typo(x.pivot)
        then extensions.word_similarity(x.folded, h.search_text)
      else 0
    end desc,
    h.name,
    h.id
  limit 50;
end;
$function$;

comment on function public.search_clients(text) is
  'Recherche client : nom sans accents à une faute près, téléphone en '
  'sous-chaîne de ses chiffres, dans les deux écritures (latine et arabe). '
  'security definer : exception nommée de SPEC § 2.1, le filtre du commerce en '
  'tête du corps est le seul garde d''isolation. E6-01.';

revoke execute on function public.search_clients(text) from public, anon;
grant execute on function public.search_clients(text) to authenticated;

select merx.register_rls_exception(
  'public.search_clients(text)', 'current_tenant',
  'Sous RLS, Postgres n''utilise comme condition d''index que des prédicats '
  'leakproof ; like, lower, unaccent et pg_trgm ne le sont pas, et postgres '
  'n''est pas superutilisateur — même mesure qu''en E2-04 (search_products). '
  'Le filtre merx.current_tenant_id() en tête du corps est le seul garde '
  'd''isolation. SPEC § 2.1, exception nommée. E6-01.');


-- ============================================================================
-- 3. `sale_document.client_id`
--
-- Note laissée par E4-01 et redite par SPEC § 8 : posée avant que `client`
-- existe, la colonne aurait laissé passer l'identifiant d'un commerce voisin.
-- Elle arrive donc ici, avec sa clé composite, **dans le même geste** —
-- jamais la colonne seule.
--
-- Nullable : un bon sans client reste valable (SPEC § 2.6, rien ne bloque une
-- vente). Sans cascade, comme toute clé étrangère d'une table figée vers une
-- table de référence (le document ne doit pas disparaître si le client est
-- supprimé — et un client est supprimé en douceur, jamais en cascade de son
-- côté).
--
-- Le garde « figé » de `sale_document` (`merx.reject_frozen_update()`)
-- compare `to_jsonb(new)` à `to_jsonb(old)` hors statut, sur **toutes** les
-- colonnes de la table : `client_id` y entre d'office, sans qu'une ligne du
-- registre bouge. Un document confirmé ne change pas de client.
-- ============================================================================

alter table public.sale_document
  add column client_id uuid;

comment on column public.sale_document.client_id is
  'Le client du document, facultatif — un bon sans client reste valable '
  '(SPEC § 2.6). Posée avec sa clé composite dans le même geste que la table '
  'client. Figée dès confirmation, comme le reste du document (RÈGLE M3-3). '
  'E6-01.';

alter table public.sale_document
  add constraint sale_document_client_id_fkey
  foreign key (tenant_id, client_id) references public.client (tenant_id, id);

create index sale_document_client on public.sale_document (tenant_id, client_id);


-- ============================================================================
-- 4. `list_sale_documents()` — le filtre par client
--
-- Reprise depuis sa **dernière** définition (20261021090000_sale_document_list.sql,
-- CLAUDE.md : un `create or replace` part de la dernière version, pas de la
-- première). Un paramètre de plus, `p_client_id`, et deux colonnes rendues :
-- `client_id` et `client_name` — le nom, pour que la liste n'ait rien d'autre
-- à résoudre. `client` est une table de référence ordinaire, lisible par les
-- deux rôles (SPEC § 3.1) : contrairement à `app_user` et `device`, aucune
-- policy restrictive ne la ferme à l'employé, et une jointure PostgREST
-- ordinaire l'aurait tout aussi bien rendue. Elle reste ici parce qu'une
-- seconde fonction dirait deux fois la même exception § 2.1 pour le même
-- appel, et que `client_id` seul suffirait au filtre mais pas à l'affichage.
--
-- Clients supprimés compris dans la jointure (`left join`, sans condition sur
-- `deleted_at`) : un vieux bon garde le nom du client qui l'a passé, même si
-- la fiche a depuis été supprimée en douceur.
-- ============================================================================

drop function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, int
);

create function public.list_sale_documents(
  p_from        timestamptz            default null,
  p_to          timestamptz            default null,
  p_status      public.sale_doc_status default null,
  p_doc_type    public.sale_doc_type   default null,
  p_device_id   uuid                   default null,
  p_search      text                   default null,
  p_document_id uuid                   default null,
  p_client_id   uuid                   default null,
  p_limit       int                    default 100
)
returns table (
  id                 uuid,
  doc_type           public.sale_doc_type,
  doc_number         text,
  status             public.sale_doc_status,
  subtotal           text,
  discount_total     text,
  total              text,
  notes              text,
  cancellation_reason text,
  issued_at          timestamptz,
  created_at         timestamptz,
  sort_at            timestamptz,
  source_document_id uuid,
  device_id          uuid,
  device_label       text,
  device_prefix      public.device_prefix,
  author_name        text,
  client_id          uuid,
  client_name        text
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $function$
declare
  home_tenant uuid;
  needle      text := upper(btrim(coalesce(p_search, '')));
  kind        text := 'none';
  seq         text;
begin
  -- Garde 1. Sa phrase est celle que l'utilisateur lit ; aucun autre garde de
  -- cette fonction ne répond `42501`.
  if not merx.can('create_sale') then
    raise exception 'Ce compte ne peut pas consulter les documents de vente.'
      using errcode = '42501';
  end if;

  home_tenant := merx.current_tenant_id();
  if home_tenant is null then
    return;
  end if;

  if needle <> '' then
    if needle ~ '^(DV|CM|BL|RT)-[A-Z]-[0-9]{2}-[0-9]{5}$' then
      kind := 'number';
    elsif needle ~ '^[0-9]+$' then
      kind := 'digits';
      seq := ltrim(needle, '0');
      if length(seq) > 5 then
        return;
      end if;
      seq := lpad(seq, 5, '0');
    else
      kind := 'fragment';
    end if;
  end if;

  return query
  select d.id, d.doc_type, d.doc_number, d.status,
         d.subtotal::text, d.discount_total::text, d.total::text,
         d.notes, d.cancellation_reason,
         d.issued_at, d.created_at,
         coalesce(d.issued_at, d.created_at),
         d.source_document_id,
         d.device_id, dv.label, dv.prefix,
         a.full_name,
         d.client_id, cl.name
  from public.sale_document d
  left join public.device dv
    on dv.tenant_id = d.tenant_id and dv.id = d.device_id
  left join public.app_user a
    on a.tenant_id = d.tenant_id and a.id = d.created_by
  left join public.client cl
    on cl.tenant_id = d.tenant_id and cl.id = d.client_id
  -- Garde 2. SEUL GARDE D'ISOLATION de cette lecture : `security definer`, donc
  -- aucune policy ne s'applique. Le retirer rend les documents de tous les
  -- commerces à quiconque a `create_sale`.
  where d.tenant_id = home_tenant
    and (p_document_id is null or d.id = p_document_id)
    and (p_from is null or coalesce(d.issued_at, d.created_at) >= p_from)
    and (p_to is null or coalesce(d.issued_at, d.created_at) < p_to)
    and (p_status is null or d.status = p_status)
    and (p_doc_type is null or d.doc_type = p_doc_type)
    and (p_device_id is null or d.device_id = p_device_id)
    and (p_client_id is null or d.client_id = p_client_id)
    and (
      kind = 'none'
      or (kind = 'number' and d.doc_number = needle)
      or (kind = 'digits' and right(d.doc_number, 5) = seq)
      or (kind = 'fragment' and strpos(d.doc_number, needle) > 0)
    )
  order by coalesce(d.issued_at, d.created_at) desc, d.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$function$;

comment on function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, uuid, int
) is
  'La liste des documents de vente du commerce, du plus récent au plus '
  'ancien, avec le nom de l''auteur, l''appareil et le client — que app_user '
  'et device refusent à qui n''a pas manage_users / manage_devices. Page '
  'bornée (défaut 100, plafond 500). Exception § 2.1 nommée ; BACKLOG E4-07, '
  'filtre client ajouté en E6-01.';

revoke execute on function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, uuid, int
) from public, anon;
grant execute on function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, uuid, int
) to authenticated;

-- La clé du registre est le nom de la fonction, pas sa signature : l'entrée
-- d'E4-07 reste valable, seule sa justification est mise à jour pour dire ce
-- que la fonction rend désormais.
update merx.rls_exception_registry
set justification =
  'Rend le nom de l''auteur, le libellé de l''appareil et le nom du client de '
  'chaque document, que les policies restrictives d''app_user et de device '
  'réservent à manage_users et manage_devices — or l''acteur de la story est '
  'celui qui tient le comptoir. Et la policy OR merx.is_super_admin() de '
  'sale_document met toute liste en Seq Scan sur les documents de tous les '
  'commerces (BACKLOG E0-03). N''expose qu''un full_name, un libellé '
  'd''appareil et un nom de client par document du commerce du jeton, jamais '
  'les registres eux-mêmes. Deux gardes : can(create_sale) en première ligne, '
  'et le filtre sur merx.current_tenant_id() — seul garde d''isolation de ce '
  'chemin. E4-07 ; filtre client ajouté en E6-01.'
where schema_name = 'public' and function_name = 'list_sale_documents';
