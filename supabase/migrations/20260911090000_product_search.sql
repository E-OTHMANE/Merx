-- ============================================================================
-- Merx — la recherche produit, et le registre des exceptions à la RLS
--
-- Référence : docs/SPEC.md § 2.1 (RÈGLE multi-tenant, et son exception
--             nommée), § 2.8 (français et arabe), § 3 (RÈGLE de placement des
--             coûts), § 6 M1 (RÈGLE M1-5), § 10 (point de rupture n° 4),
--             docs/BACKLOG.md E2-04.
--
-- Quatre choses :
--
--   1. le registre `merx.rls_exception_registry` : toute fonction
--      `security definer` de `public` qui lit ou écrit une table métier y est
--      inscrite, avec le garde qui la tient et sa justification. Les quatre
--      fonctions qui existent déjà y entrent ici ;
--   2. `merx.search_fold()`, la forme sous laquelle un texte se compare :
--      minuscules, sans accents, arabe sans voyelles brèves ni variantes de
--      lettres, chiffres arabes ramenés aux chiffres latins ;
--   3. le texte cherché, en colonnes générées sur `product` et `variant`, et
--      ses deux index trigrammes ;
--   4. `public.search_products()`, la seule fonction de ce fichier qui
--      contourne la RLS — et pourquoi elle le doit.
--
-- Rien d'E2-05 ni d'E2-06 : ni import, ni unicité du code-barres, ni scan. La
-- recherche sur l'appareil, hors-ligne, est E9 : les colonnes générées se
-- synchroniseront telles quelles, la manière de les chercher en SQLite reste
-- à écrire.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Le registre des exceptions à la RLS
--
-- SPEC § 2.1 : « Aucune requête applicative ne filtre le tenant à la main. »
-- Une fonction `security definer` s'exécute sous son propriétaire, `postgres`,
-- qui porte BYPASSRLS : les policies ne la voient pas. Tout ce qu'elle lit ou
-- écrit dans une table métier n'est borné au commerce que par ce que son corps
-- écrit lui-même. C'est exactement le filtre à la main que la RÈGLE refuse.
--
-- Six fonctions de `public` le sont déjà (E1-01 à E1-03), et `search_products`
-- s'y ajoute. Le danger n'est pas l'une d'elles : c'est la dixième, écrite par
-- quelqu'un qui aura vu les autres et supposé que c'est permis. Le registre
-- rend chaque exception nommée, bornée et surveillée :
--
--   — nommée : une ligne par fonction, et une justification en texte, que la
--     base refuse vide ;
--   — bornée : le garde attendu est déclaré — `current_tenant`, le corps filtre
--     sur `merx.current_tenant_id()` ; `super_admin`, le corps exige
--     `merx.is_super_admin()`. La seconde valeur n'est pas une dispense : elle
--     n'existe que pour ce qui ne peut pas avoir de commerce, parce qu'il le
--     crée ;
--   — surveillée : `supabase/tests/conventions.ts` signale par son nom toute
--     fonction `security definer` de `public` qui touche une table métier sans
--     être inscrite, et toute fonction inscrite dont le corps n'appelle pas le
--     garde déclaré. La valeur du registre ne suffit pas : le contrôle lit le
--     corps dans `pg_proc`.
--
-- Le registre vit dans `merx` : c'est de l'outillage de schéma, jamais exposé
-- par l'API (SPEC § 4, RÈGLE de placement des schémas).
-- ----------------------------------------------------------------------------

create type merx.rls_exception_guard as enum ('current_tenant', 'super_admin');

create table merx.rls_exception_registry (
  function_name text                     primary key,
  guard         merx.rls_exception_guard not null,
  justification text                     not null,
  constraint rls_exception_justified check (btrim(justification) <> '')
);

comment on table merx.rls_exception_registry is
  'Fonctions security definer de public qui touchent une table métier hors RLS, '
  'avec le garde qui les tient et leur justification. SPEC § 2.1, E2-04. '
  'Contrôlé par supabase/tests/conventions.ts.';

comment on column merx.rls_exception_registry.guard is
  'current_tenant : le corps filtre sur merx.current_tenant_id(). super_admin : '
  'le corps exige merx.is_super_admin() — réservé à ce qui crée un commerce et '
  'ne peut donc pas en avoir un.';


create function merx.register_rls_exception(
  target        regprocedure,
  guard         merx.rls_exception_guard,
  justification text
)
returns void
language plpgsql
set search_path = ''
as $function$
declare
  schema_name text;
  fn_name     text;
begin
  select n.nspname, p.proname into schema_name, fn_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where p.oid = target;

  if schema_name <> 'public' then
    raise exception 'Le registre des exceptions RLS ne connaît que public : %.%', schema_name, fn_name;
  end if;

  insert into merx.rls_exception_registry (function_name, guard, justification)
  values (fn_name, guard, justification);
end;
$function$;

comment on function merx.register_rls_exception(regprocedure, merx.rls_exception_guard, text) is
  'Inscrit une fonction security definer de public au registre des exceptions '
  'RLS. SPEC § 2.1, E2-04.';


-- Les fonctions déjà écrites. Chaque justification reprend la raison donnée
-- par sa propre migration, pas une raison reconstruite après coup.

select merx.register_rls_exception(
  'public.create_tenant(text, text, text, text, uuid)', 'super_admin',
  'Crée un commerce et sa population initiale — tenant, app_user, device, '
  'warehouse. Ne peut pas filtrer sur le commerce du jeton : elle le crée, et '
  'l''éditeur qui l''appelle n''en a aucun. Réservée à super_admin, garde en '
  'première ligne. E1-01.');

select merx.register_rls_exception(
  'public.create_worker(text, text, uuid)', 'current_tenant',
  'Écrit app_user hors RLS : le compte d''authentification est créé par la '
  'fonction Edge, qui rappelle la base avec le jeton de l''appelant (même '
  'raison qu''E1-01, dit sa migration). Le commerce vient du jeton, le rôle est '
  'écrit dans le corps, manage_users est exigé en première ligne. E1-02.');

select merx.register_rls_exception(
  'public.set_user_active(uuid, boolean)', 'current_tenant',
  'Met à jour app_user hors RLS, sur une ligne du commerce du jeton seulement ; '
  'manage_users est exigé en première ligne. E1-02.');

select merx.register_rls_exception(
  'public.register_device(uuid, text)', 'current_tenant',
  'Un worker enregistre sa tablette, alors que la policy restrictive '
  'manage_devices lui ferme device en lecture comme en écriture. Le commerce '
  'vient du jeton ; un identifiant connu ailleurs répond « introuvable ». E1-03.');


-- ----------------------------------------------------------------------------
-- 2. La forme comparable d'un texte
--
-- BACKLOG E2-04 : « creme » trouve « crème ». SPEC § 2.8 et § 10 : en arabe
-- aussi. Un vendeur tape vite, sur un clavier de tablette, sans voyelles ni
-- hamza ; la fiche a été saisie par le patron, parfois avec. Les deux textes
-- passent donc par la même forme :
--
--   — `unaccent`, puis minuscules : « Crème » → « creme » ;
--   — arabe : les voyelles brèves et signes de lecture (U+064B à U+065F,
--     U+0670) et le tatweel (U+0640) disparaissent ; les formes d'alif أ إ آ ٱ
--     deviennent ا, ى devient ي, ة devient ه, ؤ devient و, ئ devient ي — ce
--     sont les confusions d'orthographe courantes, pas des fautes rares ;
--   — les chiffres arabes, ٠ à ٩ et ۰ à ۹, deviennent 0 à 9 : une tablette
--     réglée en arabe tape ٤٥١, et la référence est 451 ;
--   — les blancs sont ramenés à un seul, et ceux des bords retirés.
--
-- `immutable` alors que `unaccent()` n'est que `stable` : c'est ce qu'exige une
-- colonne générée, et c'est vrai tant que le dictionnaire est nommé
-- explicitement (`extensions.unaccent`) plutôt que pris du `search_path`. Si
-- les règles d'`unaccent` changeaient à une montée de version de Postgres, les
-- valeurs stockées seraient à recalculer — une réécriture de la colonne, rien
-- qui se perde.
-- ----------------------------------------------------------------------------

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

/*
 * Sans `set search_path`, contrairement aux autres helpers, et c'est voulu :
 * une fonction SQL qui porte une clause SET n'est jamais inlinée. La recherche
 * l'appelle plusieurs fois par candidat pour le classement ; appelée comme une
 * fonction, elle coûtait l'essentiel du temps de réponse (mesuré en E2-04).
 * Le chemin de recherche n'y joue aucun rôle : chaque nom est qualifié —
 * `pg_catalog.`, `extensions.` —, rien n'est résolu par le `search_path`.
 */
create function merx.search_fold(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.regexp_replace(
        pg_catalog.lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(value, ''))),
        -- Voyelles brèves U+064B à U+065F, alif suscrit U+0670, tatweel U+0640.
        -- En échappements, pas en caractères : une plage tapée en caractères
        -- se lit mal et s'étend facilement jusqu'à U+0670 — elle avalerait
        -- alors les chiffres arabes U+0660 à U+0669 avant `translate`.
        U&'[\064B-\065F\0670\0640]', '', 'g'),
      -- alif hamza dessus, dessous, madda, wasla ; alif maqsura ; ta marbuta ;
      -- waw hamza ; ya hamza ; chiffres arabes ; chiffres arabes orientaux.
      U&'\0623\0625\0622\0671\0649\0629\0624\0626\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9',
      -- alif x4 ; ya ; ha ; waw ; ya ; puis 0 à 9, deux fois.
      U&'\0627\0627\0627\0627\064A\0647\0648\064A' || '01234567890123456789'),
    '\s+', ' ', 'g'))
$function$;

comment on function merx.search_fold(text) is
  'Forme comparable d''un texte pour la recherche : minuscules, sans accents, '
  'arabe sans voyelles brèves ni variantes d''alif, chiffres arabes en latin. '
  'E2-04.';

-- Évaluée par les colonnes générées, donc sous le rôle qui insère.
grant execute on function merx.search_fold(text) to authenticated;


-- Un mot saisi devient un motif `like` : ses `%` et `_` sont des caractères,
-- pas des jokers. Une référence « A_12 » ne doit pas trouver « AB12 ». Sans
-- `set search_path`, pour la même raison que `search_fold` : être inlinée.
create function merx.like_pattern(value text)
returns text
language sql
immutable
parallel safe
as $function$
  select pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    value, '\', '\\'), '%', '\%'), '_', '\_')
$function$;

comment on function merx.like_pattern(text) is
  'Échappe \, % et _ pour qu''un mot saisi se cherche tel quel avec like. E2-04.';


-- ----------------------------------------------------------------------------
-- 3. Le texte cherché, et ses index
--
-- BACKLOG E2-04 : « recherche simultanée sur nom français, nom arabe, code,
-- sku, barcode ». Les trois premiers sont sur le produit, les deux derniers sur
-- la variante (SPEC § 2.3). Des colonnes générées : une colonne générée ne lit
-- que sa propre ligne, donc pas de trigger à tenir, pas de copie à
-- resynchroniser quand le patron corrige un nom.
--
-- Une colonne par champ, pas un seul texte par table, et c'est mesuré :
-- `merx.search_fold()` coûte 19 µs par appel (50 000 lignes, stack local,
-- E2-04), et le classement a besoin de chaque champ séparément — la référence
-- égale, le nom qui contient chaque mot, le code-barres qui contient la
-- requête. Recalculés à la volée, ces pliages coûtaient cinq appels par
-- candidat : 582 ms pour « creme ». Stockés, ils se paient une fois, à
-- l'écriture.
--
-- Index GIN, un par table, sur le commerce et l'expression qui concatène ses
-- champs : ils servent `like '%451%'` (référence partielle) comme l'opérateur
-- de similarité par mot `<%` (faute de frappe). La requête doit écrire
-- l'expression à l'identique, sans quoi l'index n'est pas utilisé et rien ne
-- le dit — sauf `supabase/tests/product-search.test.ts`, qui lit le plan
-- d'exécution du vrai appel.
--
-- `tenant_id` dans le même index (`btree_gin`), et c'est mesuré — deux fois,
-- parce que la première n'a pas suffi. Avec un index trigramme seul, le
-- planificateur préfère, pour les requêtes larges (« creme »), lire tout le
-- commerce par l'index de `tenant_id` puis filtrer : l'index trigramme présent,
-- et inutilisé, sur la branche produit. Un index qui porte les deux conditions
-- à la fois est celui qu'il choisit. Le sabotage qui retirait `tenant_id` de
-- l'index est d'abord resté vert, sur une seule exécution où le plan tombait
-- du bon côté ; l'assertion de plan relit désormais le plan d'une session
-- chaude, comme une connexion PostgREST, et ce même sabotage fait tomber
-- « creme », « crème » et « nivea creme 200 » (E2-04).
--
-- À remesurer à l'échelle : avec ou sans `tenant_id` dans l'index, une
-- recherche lit les listes de trigrammes de tous les commerces avant de ne
-- garder que les siennes. À cinq commerces de 10 000 produits, c'est au plus
-- 90 ms de bout en bout ; à plusieurs centaines, personne ne l'a mesuré.
--
-- `fastupdate = off`, et c'est mesuré aussi. Par défaut, un index GIN range
-- les insertions dans une liste d'attente, relue en entier à chaque recherche
-- jusqu'au passage de l'autovacuum ; le planificateur la compte, et juge alors
-- l'index trop cher. Constaté en E2-04, transaction annulée, batterie de
-- douze requêtes : index propres, 12/12 par l'index trigramme ; juste après
-- l'insertion de 10 000 produits, 3/12 — les neuf autres relisaient tout le
-- commerce ; liste vidée, 12/12 ; mêmes insertions avec `fastupdate = off`,
-- 12/12 d'emblée. Un import (E2-05) insère en masse : sans ce réglage, la
-- recherche perdrait son index jusqu'au vacuum suivant, sans que rien le dise.
-- Le prix est une insertion un peu plus lente, que E2-05 mesurera.
-- ----------------------------------------------------------------------------


alter table public.product
  add column search_name text generated always as (
    merx.search_fold(name_fr) || ' ' || merx.search_fold(name_ar)
  ) stored,
  add column search_code text generated always as (merx.search_fold(code)) stored;

alter table public.variant
  add column search_sku     text generated always as (merx.search_fold(sku))     stored,
  add column search_barcode text generated always as (merx.search_fold(barcode)) stored;

comment on column public.product.search_name is
  'Nom français et nom arabe, sous merx.search_fold(). Généré. E2-04.';
comment on column public.product.search_code is
  'Référence, sous merx.search_fold(). Générée. E2-04.';
comment on column public.variant.search_sku is
  'SKU, sous merx.search_fold(). Généré. E2-04.';
comment on column public.variant.search_barcode is
  'Code-barres, sous merx.search_fold(). Généré. E2-04.';

create extension if not exists btree_gin with schema extensions;

create index product_search on public.product
  using gin (tenant_id, (search_name || ' ' || search_code) extensions.gin_trgm_ops)
  with (fastupdate = off);
create index variant_search on public.variant
  using gin (tenant_id, (search_sku || ' ' || search_barcode) extensions.gin_trgm_ops)
  with (fastupdate = off);


-- ----------------------------------------------------------------------------
-- 4. `public.search_products()` — l'exception nommée de SPEC § 2.1
--
-- Pourquoi `security definer`, mesuré (E2-04, stack local, cinq commerces de
-- 10 000 produits, « creme » sous le jeton d'un employé, les deux chemins
-- rendant les mêmes 1 251 lignes) :
--
--   — sous `authenticated`, la requête lit toute la table en Seq Scan, tous
--     commerces confondus : 417 à 472 ms en sous-chaîne, 517 ms en
--     similarité — et ce temps croît avec le nombre de commerces ;
--   — par l'index trigramme, hors RLS : 8,6 à 9,7 ms.
--
-- La raison est mécanique. Sous RLS, Postgres n'accepte comme condition d'index
-- que des prédicats `leakproof` — ceux qui ne peuvent rien laisser fuir d'une
-- ligne que la policy aurait écartée. `like`, `lower`, `unaccent` et les
-- opérateurs de `pg_trgm` ne le sont pas, et `postgres` n'étant pas
-- superutilisateur, rien ne peut être déclaré tel. L'index existerait, et ne
-- servirait jamais.
--
-- Le prix : sur ce chemin, l'isolation ne tient qu'au filtre écrit dans le
-- corps. Il est en tête, et commenté comme tel. Le reste de la fonction ne
-- nomme aucune table : tout passe par `catalogue`, et `catalogue` porte le
-- filtre.
--
-- Pourquoi plpgsql, en `plan_cache_mode = force_custom_plan`. Une fonction
-- `language sql` est planifiée sans connaître la requête : le motif
-- `'%creme%'` y est une inconnue, le planificateur en estime mal la
-- sélectivité, et il a choisi, sur la branche produit, de lire tout le commerce
-- par l'index de `tenant_id` puis de filtrer — l'index trigramme présent, et
-- inutilisé : 192 ms pour cette seule branche (constaté en E2-04). En plpgsql,
-- avec un plan personnalisé à chaque appel, `merx.search_fold(q)` et les
-- fonctions `immutable` qui en dérivent sont évaluées à la planification : le
-- motif est une constante, l'estimation est juste, et ce qui ne sert pas
-- disparaît du plan — la faute de frappe sur un mot de deux caractères, la
-- similarité d'une requête vide.
--
-- **`force_custom_plan` est un garde non éprouvé**, et c'est dit ici pour
-- qu'on ne le prenne pas pour prouvé. Sans lui, plpgsql garde des plans
-- personnalisés pour les cinq premiers appels d'une session, puis peut basculer
-- sur un plan générique — celui qui, en `language sql`, écartait l'index
-- (192 ms, plus haut). Le sabotage qui le retire est resté vert en E2-04, même
-- après huit appels de chauffe dans la même session : sur 10 000 produits en
-- local, Postgres n'a jamais choisi le plan générique. Cela ne dit pas qu'il ne
-- le choisira jamais — seulement qu'on ne sait pas le provoquer ici. C'est le
-- seul garde de la story qu'aucun sabotage ne fait tomber (BACKLOG E2-04).
--
-- Ce qu'elle rend : des variantes, puisque c'est ce qui se vend (SPEC § 2.3),
-- avec ce que la liste et la vente affichent. Aucun coût : ni `variant_cost`,
-- ni aucune colonne qui en dériverait (SPEC § 3). 50 lignes au plus.
--
-- Comment elle cherche (SPEC § 6, Recherche) :
--
--   — la requête passe par `merx.search_fold()`, comme le texte stocké, puis se
--     découpe en mots. Chaque mot doit être trouvé : en sous-chaîne (« 451 »
--     dans « 4512 »), ou à une faute près — similarité par mot ≥ 0,4 — s'il a
--     au moins trois caractères et n'est pas fait que de chiffres ;
--   — les candidats viennent de l'index, par le mot le plus long — le plus
--     sélectif —, cherché dans le texte du produit et dans celui de la
--     variante ; les autres mots filtrent ces candidats ;
--   — classement : référence, SKU ou code-barres égal à la requête ; référence
--     ou SKU qui commence par elle ; qui la contient ; nom qui contient chaque
--     mot ; code-barres qui la contient ; le reste, à une faute près. Puis la
--     similarité, puis le nom ;
--   — requête vide : les 50 premières variantes par ordre alphabétique.
--
-- `is_active` n'est pas filtré : aucun écran ne s'en sert encore, et la liste
-- ne le filtre pas non plus (arbitré en E2-04).
-- ----------------------------------------------------------------------------

-- Les mots d'une requête, sous leur forme comparable.
create function merx.search_words(q text)
returns text[]
language sql
immutable
parallel safe
as $function$
  select pg_catalog.array_remove(pg_catalog.string_to_array(merx.search_fold(q), ' '), '')
$function$;

-- Le mot le plus long : le plus sélectif, celui qui choisit les candidats.
create function merx.search_pivot(q text)
returns text
language sql
immutable
parallel safe
as $function$
  select w
  from pg_catalog.unnest(merx.search_words(q)) as w
  order by pg_catalog.length(w) desc, w
  limit 1
$function$;

/*
 * Un mot se cherche à une faute près s'il a au moins trois caractères — en
 * dessous, un trigramme n'a rien à comparer — et s'il n'est pas fait que de
 * chiffres. Un morceau de référence ou d'EAN se cherche en sous-chaîne : à une
 * faute près, « 6110000 » ressemblait à chaque code-barres commençant par 611,
 * et coûtait 1 105 ms (E2-04, SPEC § 6).
 */
create function merx.search_allows_typo(word text)
returns boolean
language sql
immutable
parallel safe
as $function$
  select pg_catalog.length(word) >= 3 and word !~ '^[0-9./-]+$'
$function$;

comment on function merx.search_words(text) is
  'Mots d''une requête de recherche, sous merx.search_fold(). E2-04.';
comment on function merx.search_pivot(text) is
  'Mot le plus long d''une requête : celui qui choisit les candidats. E2-04.';
comment on function merx.search_allows_typo(text) is
  'Vrai si un mot se cherche à une faute près : trois caractères au moins, pas '
  'seulement des chiffres. SPEC § 6, E2-04.';


/*
 * Le seuil de similarité se règle sur la fonction. Une clause
 * `set pg_trgm.…` n'est acceptée de `postgres`, qui n'est pas
 * superutilisateur, que si la bibliothèque est chargée dans la session : sans
 * elle, le paramètre n'est qu'un nom réservé, et la création échoue sur
 * « permission denied to set parameter » (constaté en E2-04). `create
 * extension` la charge quand il crée l'extension, pas quand elle existe déjà —
 * d'où cet appel, qui la charge dans tous les cas.
 */
select extensions.similarity('', '');

create function public.search_products(q text)
returns table (
  variant_id uuid,
  product_id uuid,
  name_fr    text,
  name_ar    text,
  code       text,
  sku        text,
  barcode    text,
  photo_url  text
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
set pg_trgm.word_similarity_threshold = 0.4
as $function$
#variable_conflict use_column
begin
  return query
  with catalogue as not materialized (
    select p.id as product_id, v.id as variant_id,
           p.name_fr, p.name_ar, p.code, v.sku, v.barcode, p.photo_url,
           p.search_name, p.search_code, v.search_sku, v.search_barcode,
           -- Les expressions des index `product_search` et `variant_search`,
           -- à l'identique : écrites autrement, l'index n'est plus utilisé.
           p.search_name || ' ' || p.search_code   as product_text,
           v.search_sku  || ' ' || v.search_barcode as variant_text
    from public.product p
    join public.variant v on v.tenant_id = p.tenant_id and v.product_id = p.id
    -- SEUL GARDE D'ISOLATION DE CE CHEMIN. La fonction est `security definer` :
    -- aucune policy ne s'applique ici, et cette ligne est tout ce qui sépare le
    -- catalogue de l'appelant de celui des autres commerces. SPEC § 2.1,
    -- exception nommée ; merx.rls_exception_registry. Sous-requête : évaluée
    -- une fois par appel, pas une fois par ligne.
    where p.tenant_id = (select merx.current_tenant_id())
      and p.deleted_at is null
      and v.deleted_at is null
  ),
  query as not materialized (
    select merx.search_fold(q)  as folded,
           merx.search_words(q) as words,
           merx.search_pivot(q) as pivot
  ),
  hits as (
    select c.*
    from catalogue c, query x
    where x.pivot is null
    union
    select c.*
    from catalogue c, query x
    where c.product_text like '%' || merx.like_pattern(x.pivot) || '%'
       or (merx.search_allows_typo(x.pivot) and x.pivot operator(extensions.<%) c.product_text)
    union
    select c.*
    from catalogue c, query x
    where c.variant_text like '%' || merx.like_pattern(x.pivot) || '%'
       or (merx.search_allows_typo(x.pivot) and x.pivot operator(extensions.<%) c.variant_text)
  )
  select h.variant_id, h.product_id, h.name_fr, h.name_ar, h.code, h.sku, h.barcode, h.photo_url
  from hits h, query x
  where not exists (
    select 1
    from pg_catalog.unnest(x.words) as w
    where not ((h.product_text || ' ' || h.variant_text) like '%' || merx.like_pattern(w) || '%'
               or (merx.search_allows_typo(w)
                   and w operator(extensions.<%) (h.product_text || ' ' || h.variant_text)))
  )
  order by
    case
      when x.folded = '' then 0
      when x.folded in (h.search_code, h.search_sku, h.search_barcode) then 0
      when h.search_code like merx.like_pattern(x.folded) || '%'
        or h.search_sku  like merx.like_pattern(x.folded) || '%' then 1
      when h.search_code like '%' || merx.like_pattern(x.folded) || '%'
        or h.search_sku  like '%' || merx.like_pattern(x.folded) || '%' then 2
      when not exists (
        select 1
        from pg_catalog.unnest(x.words) as w
        where h.search_name not like '%' || merx.like_pattern(w) || '%'
      ) then 3
      when h.search_barcode like '%' || merx.like_pattern(x.folded) || '%' then 4
      else 5
    end,
    case
      when merx.search_allows_typo(x.pivot)
        then extensions.word_similarity(x.folded, h.product_text || ' ' || h.variant_text)
      else 0
    end desc,
    h.name_fr,
    h.variant_id
  limit 50;
end;
$function$;

comment on function public.search_products(text) is
  'Recherche produit : nom français, nom arabe, référence, SKU, code-barres — '
  'sans accents, à une faute près, sur référence partielle. security definer : '
  'exception nommée de SPEC § 2.1, le filtre du commerce en tête du corps est '
  'le seul garde d''isolation. Aucun coût rendu. E2-04.';

-- PostgREST expose toute fonction de `public`, et les ACL par défaut de
-- Supabase l'accordent à `anon`. Un appelant anonyme n'a pas de commerce et ne
-- trouverait rien ; le privilège est retiré quand même, pour qu'aucune
-- modification future du filtre ne l'ouvre à qui n'est pas connecté.
revoke execute on function public.search_products(text) from public, anon;
grant execute on function public.search_products(text) to authenticated;

select merx.register_rls_exception(
  'public.search_products(text)', 'current_tenant',
  'Sous RLS, Postgres n''utilise comme condition d''index que des prédicats '
  'leakproof ; like, lower, unaccent et pg_trgm ne le sont pas, et postgres '
  'n''est pas superutilisateur. Mesuré en E2-04 (cinq commerces de 10 000 '
  'produits, mêmes 1 251 lignes rendues) : Seq Scan de 417 à 472 ms sous '
  'authenticated, 8,6 à 9,7 ms par l''index trigramme. Le filtre '
  'merx.current_tenant_id() en tête du corps est le seul garde d''isolation. '
  'SPEC § 2.1, exception nommée.');
