-- ============================================================================
-- Merx — liste et consultation des documents de vente
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant, et son exception
--             nommée), § 3.1 (matrice), § 4 (conventions, refus en 4xx),
--             § 8 (RÈGLES M3-2, M3-3, M3-4) ; docs/BACKLOG.md E4-07.
--
-- ÉCRITE SANS STACK : cette migration n'a jamais tourné (session cloud, sans
-- Docker ni Supabase). Voir docs/PENDING-CHECKS.md, « E4-07 ».
--
-- La story demande de retrouver un bon : le lister, le filtrer, le chercher par
-- numéro, en lire le détail avec son auteur et son appareil. Deux pièces :
--
--   1. `public.list_sale_documents()` — une fonction `security definer`, la
--      forme de `list_stock_movements()` (E3-02), pour deux raisons que la
--      lecture directe ne contourne pas :
--
--        — **l'auteur et l'appareil.** `sale_document.created_by` référence
--          `app_user`, et `device_id` référence `device` ; les deux tables
--          portent une policy restrictive (`manage_users`, `manage_devices`)
--          que l'employé n'a pas. L'acteur de la story est celui qui tient le
--          comptoir. Aucune jointure incorporée ne peut lui rendre ces deux
--          noms ;
--
--        — **le plan.** La policy `OR merx.is_super_admin()` de
--          `super_admin_all` fait perdre au planificateur la condition
--          d'index sur `tenant_id` (note de BACKLOG E0-03, ouverte) : une
--          liste lue directement parcourt les documents de tous les commerces.
--          Hors RLS, `tenant_id = $1` est une égalité simple. **E0-03 n'est
--          pas corrigée ici** : c'est une story à elle seule.
--
--   2. `sale_document_tenant_recent` — l'index du tri.
--
-- Le détail passe par la même fonction (`p_document_id`) : il lui faut les
-- mêmes deux noms, et une seconde fonction dirait deux fois la même exception.
-- Les lignes (`sale_line`) et la filiation (`documentLineage()`) restent des
-- lectures PostgREST ordinaires, sous RLS : elles n'ont besoin d'aucun nom que
-- la RLS refuse. Si leur plan sort en Seq Scan, le correctif prévu est un index
-- sur la colonne de l'égalité, pas une seconde fonction — décision en attente,
-- non posée ici (docs/PENDING-CHECKS.md).
--
-- ----------------------------------------------------------------------------
-- Les deux gardes, et deux réponses qu'aucune autre ne donne
--
--   1. `merx.can('create_sale')` — première ligne, `42501`, sa propre phrase.
--      Doublé par `RequireCapability` sur la route ; celui-ci est le seul qui
--      compte quand l'appel arrive sans passer par l'écran. La capacité est
--      celle de la vente : les deux rôles l'ont (§ 3.1), un jeton sans rôle
--      non.
--   2. le filtre sur `merx.current_tenant_id()`. SEUL GARDE D'ISOLATION de
--      cette lecture : la fonction est `security definer`, aucune policy ne
--      s'y applique. Un identifiant du voisin rend zéro ligne, pas une erreur —
--      un refus confirmerait l'existence d'une ligne qu'on n'a pas le droit de
--      voir (E1-02, E1-03).
--
-- ----------------------------------------------------------------------------
-- Tri et date : `coalesce(issued_at, created_at)`
--
-- Un brouillon n'a pas d'`issued_at` (RÈGLE M3-2, `sale_document_issued_at_when_numbered`).
-- Trier ou filtrer sur `issued_at` seul le rendrait injoignable : `null` ne
-- tombe dans aucun intervalle. La liste le range donc à sa date de création, et
-- l'index porte la même expression — c'est ce qui le rend utilisable.
--
-- ----------------------------------------------------------------------------
-- La recherche par numéro : trois formes, discriminées par la **forme** de ce
-- qui est tapé, pas par un réglage
--
--   — **numéro entier** (`BL-A-26-00042`, normalisé : majuscules, espaces de
--     bord retirés) → égalité sur `doc_number`, donc sur l'index unique
--     `sale_document_number_per_tenant` ;
--   — **chiffres seuls** (« 42 », « 00042 ») → égalité de `right(doc_number, 5)`
--     avec `lpad(chiffres, 5, '0')` : c'est ce qu'un commerçant dit à voix haute
--     d'un bon, et la séquence est sur cinq chiffres (RÈGLE M3-2). Elle
--     traverse les types et les appareils — « 42 » trouve `DV-A-26-00042` comme
--     `BL-B-26-00042`. Plus de cinq chiffres significatifs : rien ne peut
--     correspondre, la réponse est vide ;
--   — **autre fragment** (`BL-A`, `-26-`) → sous-chaîne, sur des lignes déjà
--     bornées par le commerce.
--
-- Les deux dernières formes ne portent aucun index, et **aucun index trigramme
-- n'est posé** : il ne se justifierait que par une mesure (CLAUDE.md, E2-04) qui
-- n'a pas pu être prise ici. `strpos()` et non `like` : aucun métacaractère à
-- échapper dans ce que l'utilisateur tape.
--
-- Les autres filtres (date, statut, type, appareil) restent appliqués avec la
-- recherche : « 42 » avec le type « Bon » ne rend pas le devis 42.
--
-- ----------------------------------------------------------------------------
-- Ce qui n'est **pas** ici
--
--   — **le filtre par client.** `sale_document.client_id` naît avec la table
--     `client`, en E6-01 (SPEC § 8) : aucun paramètre, aucune colonne. Le
--     critère reste décoché, « tenu par E6-01 ».
--   — **aucune capacité neuve, aucun registre neuf, aucune écriture.** Les
--     quatre copies de la matrice ne bougent pas.
--   — **un index trigramme** (voir plus haut).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. L'index du tri
-- ----------------------------------------------------------------------------

create index sale_document_tenant_recent
  on public.sale_document (tenant_id, (coalesce(issued_at, created_at)) desc);

comment on index public.sale_document_tenant_recent is
  'Tri « du plus récent au plus ancien » de la liste des documents (E4-07), '
  'sur la date d''émission, ou de création pour un brouillon qui n''en a pas '
  'encore. L''expression est celle de list_sale_documents() : sans elle '
  'identique, l''index ne sert pas.';


-- ----------------------------------------------------------------------------
-- 2. `public.list_sale_documents()`
-- ----------------------------------------------------------------------------

create function public.list_sale_documents(
  p_from        timestamptz            default null,
  p_to          timestamptz            default null,
  p_status      public.sale_doc_status default null,
  p_doc_type    public.sale_doc_type   default null,
  p_device_id   uuid                   default null,
  p_search      text                   default null,
  p_document_id uuid                   default null,
  p_limit       int                    default 100
)
returns table (
  id                 uuid,
  doc_type           public.sale_doc_type,
  doc_number         text,
  status             public.sale_doc_status,
  subtotal           public.money_amount,
  discount_total     public.money_amount,
  total              public.money_amount,
  notes              text,
  cancellation_reason text,
  issued_at          timestamptz,
  created_at         timestamptz,
  sort_at            timestamptz,
  source_document_id uuid,
  device_id          uuid,
  device_label       text,
  device_prefix      public.device_prefix,
  author_name        text
)
language plpgsql
stable
security definer
set search_path = ''
/*
 * Même réglage, et même raison, que `search_products()` (E2-04) et
 * `list_stock_movements()` (E3-02). Après cinq exécutions d'une instruction
 * préparée — PostgREST en prépare —, PostgreSQL remplace le plan personnalisé
 * par un plan générique, qui ne connaît pas les valeurs des paramètres. Ici le
 * dommage est double : les filtres optionnels (`p_status is null or ...`) ne se
 * replient plus, et la forme de la recherche (`kind`) non plus — le planificateur
 * ne peut plus choisir l'égalité sur l'index unique. Un plan personnalisé les
 * voit comme des constantes.
 */
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

  -- La forme de la recherche. Les trois formes s'excluent : un numéro entier
  -- contient des chiffres, et ne doit pas être pris pour une séquence.
  if needle <> '' then
    if needle ~ '^(DV|CM|BL|RT)-[A-Z]-[0-9]{2}-[0-9]{5}$' then
      kind := 'number';
    elsif needle ~ '^[0-9]+$' then
      kind := 'digits';
      seq := ltrim(needle, '0');
      -- Au-delà de cinq chiffres significatifs, aucune séquence ne correspond.
      -- `lpad` tronquerait à droite : on sort avant plutôt que de comparer faux.
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
         d.subtotal, d.discount_total, d.total,
         d.notes, d.cancellation_reason,
         d.issued_at, d.created_at,
         coalesce(d.issued_at, d.created_at),
         d.source_document_id,
         d.device_id, dv.label, dv.prefix,
         a.full_name
  from public.sale_document d
  left join public.device dv
    on dv.tenant_id = d.tenant_id and dv.id = d.device_id
  left join public.app_user a
    on a.tenant_id = d.tenant_id and a.id = d.created_by
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
  uuid, text, uuid, int
) is
  'La liste des documents de vente du commerce, du plus récent au plus ancien, '
  'avec le nom de l''auteur et l''appareil — que app_user et device refusent à '
  'qui n''a pas manage_users / manage_devices. Page bornée (défaut 100, plafond '
  '500). Exception § 2.1 nommée ; BACKLOG E4-07.';

revoke execute on function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, int
) from public, anon;
grant execute on function public.list_sale_documents(
  timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type,
  uuid, text, uuid, int
) to authenticated;

select merx.register_rls_exception(
  'public.list_sale_documents(timestamptz, timestamptz, public.sale_doc_status, public.sale_doc_type, uuid, text, uuid, int)',
  'current_tenant',
  'Rend le nom de l''auteur et le libellé de l''appareil de chaque document, '
  'que les policies restrictives d''app_user et de device réservent à '
  'manage_users et manage_devices — or l''acteur de la story est celui qui tient '
  'le comptoir. Et la policy OR merx.is_super_admin() de sale_document met toute '
  'liste en Seq Scan sur les documents de tous les commerces (BACKLOG E0-03). '
  'N''expose qu''un full_name et un libellé par document du commerce du jeton, '
  'jamais le registre des employés ni celui des appareils. Deux gardes : '
  'can(create_sale) en première ligne, et le filtre sur '
  'merx.current_tenant_id() — seul garde d''isolation de ce chemin. E4-07.');
