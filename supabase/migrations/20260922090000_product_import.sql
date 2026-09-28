-- ============================================================================
-- Merx — l'import du catalogue
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant), § 2.3 (product /
--             variant), § 2.5 (hors-ligne, réconciliation), § 2.6 (RÈGLE de la
--             charge de saisie), § 3 (RÈGLE de placement des coûts), § 3.1
--             (`manage_product`, `manage_price_list`, `view_cost`), § 6 M1
--             (Import), § 9 M8 (RÈGLE M8-1), § 10 (point de rupture n° 1),
--             docs/BACKLOG.md E2-05.
--
-- **Point de rupture n° 1 du spec** : « si 2 000 références ne rentrent pas en
-- moins d'une heure, rien d'autre ne compte ». Tout ce fichier découle d'un
-- seul critère d'acceptation : *les lignes valides s'importent même si d'autres
-- échouent*. Un import qui annule tout sur une ligne fautive est inutilisable
-- sur le fichier d'un vrai commerçant — il y a toujours une ligne fautive.
--
-- Pourquoi une fonction, et pas des insertions depuis l'appareil. Une ligne de
-- fichier écrit dans quatre tables : `product`, sa variante par défaut (le
-- code-barres), la ligne `min_qty = 1` de `price_break` (le prix de vente) et,
-- si la colonne est fournie, `variant_cost` (le prix d'achat). Par PostgREST,
-- ce sont trois ou quatre requêtes par ligne, donc environ 8 000 pour un
-- fichier de 2 000 lignes, et surtout **aucune atomicité par ligne** : un
-- produit enregistré sans son prix, parce que la seconde requête est passée
-- après la première.
--
-- Ici, chaque ligne tourne dans son propre bloc `begin … exception … end`,
-- c'est-à-dire dans son propre point de sauvegarde implicite. Une écriture
-- refusée annule **cette ligne et elle seule** ; la boucle consigne le motif et
-- passe à la suivante. L'atomicité est par ligne, et le lot n'est pas
-- tout-ou-rien.
--
-- **`security invoker`, et c'est un choix, pas un oubli.** La tentation, en
-- E8 (réception) ou en E9 (synchronisation), sera de passer une fonction
-- d'import en `security definer` pour aller plus vite — une fois hors RLS, il
-- n'y a plus de policy à satisfaire par ligne. Ce qu'on perdrait :
--
--   — les policies de `product`, `variant`, `price_break` et `variant_cost`
--     s'appliquent ici ligne par ligne, sous l'identité de l'appelant. Le
--     commerce vient du défaut `merx.current_tenant_id()`, jamais du fichier :
--     aucune ligne importée ne peut atterrir chez un voisin ;
--   — le journal du prix d'achat (RÈGLE M8-1) reçoit l'auteur du jeton. En
--     `definer`, `merx.log_audit()` verrait le propriétaire de la fonction, ou
--     personne ;
--   — `merx.rls_exception_registry` garde ses cinq entrées (SPEC § 2.1). Cette
--     fonction n'en est pas une, et ne doit pas en devenir une.
--
-- Rien de E2-06 : ni unicité du code-barres, ni génération d'étiquette.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- `public.import_products(rows jsonb)`
--
-- Ce qu'elle reçoit : un tableau d'objets, un par ligne de fichier, déjà lus et
-- nettoyés par l'appareil (`src/modules/catalogue/import/`). L'appareil envoie
-- par blocs — 50 lignes, voir la note de performance — et n'envoie **que les
-- clés qui ont une valeur** :
--
--   { "line": 12,                     -- le numéro de ligne dans le fichier
--     "name_fr": "Crème hydratante",  -- seul champ obligatoire (SPEC § 2.6)
--     "name_ar": "كريم مرطب",
--     "code": "LOR-12",
--     "barcode": "6111234567890",
--     "category": "Soins visage",
--     "brand": "Nivea",
--     "unit_label": "pièce",
--     "pieces_per_carton": 12,
--     "unit_price": "15.00",          -- en texte : jamais de flottant
--     "cost_price": "9.50" }
--
-- **Une clé absente ne touche à rien.** C'est la règle de la cellule vide
-- (SPEC § 2.6) : l'outil n'efface pas une donnée que le fichier ne mentionne
-- pas. Un prix vide ou à 0 est arrivé ici comme une absence — « prix non
-- renseigné », jamais 0, qui ferait vendre gratuitement (E2-03) ; l'appareil
-- compte les deux cas séparément à l'aperçu, parce qu'un 0 saisi est une
-- saisie et une cellule vide est une absence.
--
-- Ce qu'elle rend : un tableau, une entrée par ligne reçue —
--
--   { "line": 12, "outcome": "created" | "updated" | "unchanged" | "rejected",
--     "product_id": "…",
--     "code": "…", "constraint": "…", "table": "…", "message": "…" }
--
-- Les quatre dernières clés ne sont présentes que sur un rejet. Le code SQL et
-- le nom de contrainte y sont **tels que la base les a donnés** : c'est ce qui
-- permet au rapport de rejets de nommer la cause, et aux tests d'asserter la
-- contrainte qui a refusé plutôt que le seul code (CLAUDE.md, E2-01).
--
-- Réimport : la clé est `code`, sans égard à la casse, parmi les produits non
-- supprimés — la même portée que `product_code_per_tenant` (E2-01). Un produit
-- supprimé ne reconnaît donc pas sa référence : la ligne crée un produit neuf,
-- et « une référence libérée est libre » reste vrai. Une ligne sans référence
-- ne se rapproche de rien : elle crée, et un second import du même fichier la
-- crée à nouveau. Rapprocher par le nom fusionnerait deux produits différents
-- qui portent le même nom, ce qui est pire qu'un doublon ; l'appareil signale
-- le compte à l'aperçu.
--
-- **Une mise à jour qui ne change rien n'écrit rien** : pas de nouvelle version
-- de ligne, pas d'`updated_at`, pas d'entrée au journal, rien à réconcilier au
-- retour du réseau (SPEC § 2.5). Réimporter un fichier inchangé ne coûte que
-- sa lecture.
--
-- Performance, et pourquoi l'appareil découpe en blocs de 50 lignes :
--
--   — une sous-transaction par ligne, et Postgres ne garde que 64 identifiants
--     de sous-transaction par transaction dans son cache ; au-delà, les autres
--     sessions vont lire `pg_subtrans` à chaque test de visibilité. 50 lignes
--     écrivantes par appel tiennent sous ce plafond ;
--   — `authenticated` est coupé par `statement_timeout` sur le stack Supabase :
--     un bloc court y reste largement ;
--   — un bloc rend la main, donc une barre de progression, et une coupure
--     réseau ne perd que le bloc en cours — le suivant mettra à jour ce qui est
--     déjà entré, au lieu de le dupliquer.
--
-- Le rapprochement des références se fait **par bloc, en une seule requête**,
-- et non ligne à ligne : sous RLS, `lower(code)` n'est pas `leakproof`, donc
-- `product_code_per_tenant` n'est pas utilisable comme condition d'index
-- (SPEC § 2.1, mesuré en E2-04). Une recherche par ligne ferait un parcours
-- complet par ligne ; ici, c'est un parcours par bloc.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- La clé du réimport, stockée et indexée
--
-- Le rapprochement se fait sur `lower(code)`, comme l'unicité
-- `product_code_per_tenant` (E2-01). Écrit tel quel, il coûte un parcours
-- complet de `product` par bloc : sous RLS, Postgres n'accepte comme condition
-- d'index que des prédicats `leakproof`, et `lower()` n'en est pas un — c'est
-- la mesure d'E2-04 (SPEC § 2.1), rencontrée ici une seconde fois. Mesuré sur
-- le stack local, 50 000 produits : **400 ms par bloc de 50 lignes**, soit
-- l'essentiel des 71 s qu'un import de 2 000 lignes coûtait.
--
-- La parade tient sans exception à la RÈGLE : la clé est **stockée** dans une
-- colonne générée, et l'égalité sur une colonne (`texteq`) est, elle,
-- `leakproof`. Même raisonnement qu'en E2-04 pour les colonnes de recherche :
-- ce qui se compare se range sous sa forme comparable, une fois, à l'écriture.
--
-- `lower(code)` et rien d'autre — surtout pas `merx.search_fold()`, qui plie
-- aussi les accents : « CRÈME-1 » et « CREME-1 » sont deux références
-- distinctes pour `product_code_per_tenant`, et les confondre ferait mettre à
-- jour le mauvais produit. La clé du réimport doit avoir exactement la portée
-- de l'unicité qu'elle interroge.
--
-- L'index est partiel, de la même portée encore : références non nulles,
-- produits non supprimés. `tenant_id` n'y est pas en tête, et ce n'est pas un
-- oubli : le filtre du commerce vient de la policy, qui porte un
-- `or merx.is_super_admin()` non `leakproof` — il ne peut donc pas servir de
-- condition d'index (BACKLOG E0-03, ouvert). L'égalité sur la référence est
-- assez sélective pour s'en passer.
-- ----------------------------------------------------------------------------

alter table public.product
  add column code_key text generated always as (lower(code)) stored;

comment on column public.product.code_key is
  'Référence en minuscules — la clé du réimport (E2-05), de la même portée que '
  'product_code_per_tenant. Stockée pour que l''égalité soit leakproof, donc '
  'utilisable comme condition d''index sous RLS (SPEC § 2.1).';

create index product_code_key on public.product (code_key)
  where deleted_at is null and code is not null;


create function public.import_products(rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  entry            jsonb;
  report           jsonb := '[]'::jsonb;
  known_products   jsonb;
  known_categories jsonb;
  keys             text[];

  /*
   * Les variables portent un `v_`, et ce n'est pas de la décoration : sans lui,
   * `code`, `brand` ou `unit_price` désignent à la fois une colonne et une
   * variable dans les mêmes instructions. plpgsql refuse alors l'ambiguïté, et
   * la qualifier par le nom de la fonction ne résout pas ici (constaté : «
   * missing FROM-clause entry for table "import_products" », chaque ligne
   * rejetée en 42P01).
   */
  v_line       integer;
  v_name_fr    text;
  v_name_ar    text;
  v_code       text;
  v_barcode    text;
  v_category   text;
  v_brand      text;
  v_unit_label text;
  v_pieces     integer;
  v_unit_price public.money_amount;
  v_cost_price public.money_amount;

  v_existing    uuid;
  v_target      uuid;
  v_category_id uuid;
  v_pending_key text;
  v_pending_id  uuid;
  v_touched     boolean;
  v_failed      boolean;
  v_outcome     text;
  v_written     integer;

  err_code       text;
  err_message    text;
  err_constraint text;
  err_table      text;
begin
  /*
   * Premier garde, et il parle avec ses propres mots. SPEC § 3.1 : « Créer /
   * modifier un produit », le patron seul. Sans lui, un employé recevrait
   * autant de rejets `42501` que de lignes — une réponse illisible pour un
   * refus qui tient en une phrase.
   *
   * Le second garde est ailleurs, et c'est lui qui protège : les policies
   * d'écriture, ligne par ligne, sous l'identité de l'appelant. Les deux
   * répondent `42501` ; ils se distinguent par leur forme — celui-ci fait
   * échouer l'appel entier avec cette phrase, celles-là remplissent le rapport
   * en nommant la table qui a refusé (CLAUDE.md, E1-02, E2-03).
   */
  if not merx.can('manage_product') then
    raise exception 'Importer le catalogue exige le droit de créer des produits.'
      using errcode = '42501';
  end if;

  if rows is null or pg_catalog.jsonb_typeof(rows) <> 'array' then
    raise exception 'L''import attend un tableau de lignes.'
      using errcode = '22023';
  end if;

  /*
   * Les produits déjà présents, par référence pliée en minuscules — une seule
   * requête pour tout le bloc. La RLS borne la lecture au commerce ; la portée
   * est celle de `product_code_per_tenant` : références non nulles, produits
   * non supprimés.
   */
  select pg_catalog.array_agg(distinct pg_catalog.lower(e ->> 'code'))
    into keys
  from pg_catalog.jsonb_array_elements(rows) as e
  where e ->> 'code' is not null;

  select coalesce(pg_catalog.jsonb_object_agg(t.key, t.id), '{}'::jsonb)
    into known_products
  from (
    -- `p.code_key = any(...)` et non `lower(p.code) = any(...)` : l'égalité sur
    -- la colonne stockée est leakproof, donc l'index sert sous RLS (plus haut).
    select p.code_key as key, pg_catalog.min(p.id::text) as id
    from public.product p
    where p.deleted_at is null
      and p.code is not null
      and p.code_key = any(keys)
    group by 1
  ) t;

  -- Les catégories existantes, même géométrie. Elles n'ont pas d'unicité : la
  -- première portant ce nom sert, et l'import n'en crée une que s'il n'en
  -- trouve aucune.
  select pg_catalog.array_agg(distinct pg_catalog.lower(pg_catalog.btrim(e ->> 'category')))
    into keys
  from pg_catalog.jsonb_array_elements(rows) as e
  where e ->> 'category' is not null;

  select coalesce(pg_catalog.jsonb_object_agg(t.key, t.id), '{}'::jsonb)
    into known_categories
  from (
    select pg_catalog.lower(pg_catalog.btrim(c.name_fr)) as key, pg_catalog.min(c.id::text) as id
    from public.category c
    where c.deleted_at is null
      and pg_catalog.lower(pg_catalog.btrim(c.name_fr)) = any(keys)
    group by 1
  ) t;

  for entry in select * from pg_catalog.jsonb_array_elements(rows) loop
    v_line        := (entry ->> 'line')::integer;
    v_name_fr     := entry ->> 'name_fr';
    v_name_ar     := entry ->> 'name_ar';
    v_code        := entry ->> 'code';
    v_barcode     := entry ->> 'barcode';
    v_category    := entry ->> 'category';
    v_brand       := entry ->> 'brand';
    v_unit_label  := entry ->> 'unit_label';
    v_pending_key := null;
    v_pending_id  := null;
    v_failed      := false;
    v_touched     := false;
    v_target      := null;

    v_existing := (known_products ->> pg_catalog.lower(coalesce(v_code, '')))::uuid;

    /*
     * Le bloc de la ligne. Tout ce qu'il écrit est annulé ensemble si l'une
     * des écritures échoue — la ligne entière, jamais une moitié — et la ligne
     * suivante repart d'une base intacte.
     */
    begin
      v_pieces     := (entry ->> 'pieces_per_carton')::integer;
      v_unit_price := (entry ->> 'unit_price')::public.money_amount;
      v_cost_price := (entry ->> 'cost_price')::public.money_amount;

      v_category_id := null;
      if v_category is not null then
        v_category_id := (known_categories ->> pg_catalog.lower(pg_catalog.btrim(v_category)))::uuid;
        if v_category_id is null then
          insert into public.category (name_fr) values (pg_catalog.btrim(v_category))
          returning id into v_category_id;
          -- Retenue pour les lignes suivantes seulement si celle-ci aboutit :
          -- une variable plpgsql ne suit pas l'annulation du bloc.
          v_pending_key := pg_catalog.lower(pg_catalog.btrim(v_category));
          v_pending_id  := v_category_id;
          v_touched     := true;
        end if;
      end if;

      if v_existing is null then
        v_target := pg_catalog.gen_random_uuid();
        insert into public.product
          (id, name_fr, name_ar, code, category_id, brand, unit_label, pieces_per_carton)
        values
          (v_target, v_name_fr, v_name_ar, v_code, v_category_id, v_brand, v_unit_label, v_pieces);
        v_outcome := 'created';
        v_touched := true;
      else
        v_target := v_existing;
        /*
         * Seules les colonnes que le fichier mentionne partent, et seulement
         * si elles changent quelque chose. `coalesce(valeur, colonne)` : une
         * clé absente laisse la valeur en place (SPEC § 2.6).
         */
        update public.product p set
          name_fr           = v_name_fr,
          name_ar           = coalesce(v_name_ar, p.name_ar),
          category_id       = coalesce(v_category_id, p.category_id),
          brand             = coalesce(v_brand, p.brand),
          unit_label        = coalesce(v_unit_label, p.unit_label),
          pieces_per_carton = coalesce(v_pieces, p.pieces_per_carton)
        where p.id = v_target
          and (p.name_fr is distinct from v_name_fr
            or (v_name_ar is not null and p.name_ar is distinct from v_name_ar)
            or (v_category_id is not null and p.category_id is distinct from v_category_id)
            or (v_brand is not null and p.brand is distinct from v_brand)
            or (v_unit_label is not null and p.unit_label is distinct from v_unit_label)
            or (v_pieces is not null and p.pieces_per_carton is distinct from v_pieces));
        get diagnostics v_written = row_count;
        if v_written > 0 then v_touched := true; end if;
      end if;

      /*
       * La variante par défaut et sa ligne de base portent l'identifiant du
       * produit : `variant.id = product.id` (E2-01) et
       * `price_break.id = variant.id` (E2-03). Rien à rechercher, donc, et
       * l'écriture se fait par clé primaire — la seule condition qui reste
       * indexée sous RLS.
       */
      if v_barcode is not null then
        update public.variant v set barcode = v_barcode
        where v.id = v_target
          and v.deleted_at is null
          and v.barcode is distinct from v_barcode;
        get diagnostics v_written = row_count;
        if v_written > 0 then v_touched := true; end if;
      end if;

      if v_unit_price is not null then
        update public.price_break b set unit_price = v_unit_price
        where b.id = v_target
          and b.deleted_at is null
          and b.unit_price is distinct from v_unit_price;
        get diagnostics v_written = row_count;
        if v_written > 0 then v_touched := true; end if;
      end if;

      /*
       * Le prix d'achat vit sur `variant_cost` (SPEC § 3, RÈGLE de placement
       * des coûts) : la policy `view_cost` refuse l'employé, et le trigger du
       * journal écrit `purchase_price_change` sous l'auteur du jeton (RÈGLE
       * M8-1). Un coût inchangé n'écrit rien, donc n'entre pas au journal.
       */
      if v_cost_price is not null then
        insert into public.variant_cost (variant_id, cost_price)
        values (v_target, v_cost_price)
        on conflict (variant_id) do update
          set cost_price = excluded.cost_price
          where public.variant_cost.cost_price is distinct from excluded.cost_price;
        get diagnostics v_written = row_count;
        if v_written > 0 then v_touched := true; end if;
      end if;

      if v_existing is not null then
        v_outcome := case when v_touched then 'updated' else 'unchanged' end;
      end if;

    exception when others then
      v_failed := true;
      get stacked diagnostics
        err_code       = returned_sqlstate,
        err_message    = message_text,
        err_constraint = constraint_name,
        err_table      = table_name;
    end;

    if v_failed then
      report := report || pg_catalog.jsonb_build_object(
        'line', v_line,
        'outcome', 'rejected',
        'code', err_code,
        'constraint', nullif(err_constraint, ''),
        'table', nullif(err_table, ''),
        'message', err_message);
    else
      if v_pending_key is not null then
        known_categories := known_categories
          || pg_catalog.jsonb_build_object(v_pending_key, v_pending_id::text);
      end if;
      if v_outcome = 'created' and v_code is not null then
        known_products := known_products
          || pg_catalog.jsonb_build_object(pg_catalog.lower(v_code), v_target::text);
      end if;
      report := report || pg_catalog.jsonb_build_object(
        'line', v_line, 'outcome', v_outcome, 'product_id', v_target);
    end if;
  end loop;

  return report;
end;
$function$;

comment on function public.import_products(jsonb) is
  'Importe un bloc de lignes de catalogue : une sous-transaction par ligne, '
  'donc les lignes valides entrent même si d''autres échouent, et rend un '
  'rapport ligne par ligne. security invoker : les policies s''appliquent '
  'ligne par ligne et le journal reçoit l''auteur du jeton — ne pas la passer '
  'en security definer (voir l''en-tête de la migration). Réimport sur code, '
  'sans égard à la casse ; une mise à jour qui ne change rien n''écrit rien. '
  'SPEC § 6 (Import), § 10 (point de rupture n° 1). E2-05.';

-- Même geste qu'en E2-04 : PostgREST expose toute fonction de `public`, et les
-- ACL par défaut de Supabase l'accordent à `anon`. Un appelant anonyme n'a
-- aucun commerce, mais le privilège se retire quand même.
revoke execute on function public.import_products(jsonb) from public, anon;
grant execute on function public.import_products(jsonb) to authenticated;
