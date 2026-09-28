-- ============================================================================
-- Merx — les codes-barres
--
-- Référence : docs/SPEC.md § 2.5 (hors-ligne), § 2.6 (charge de saisie),
--             § 3.1 (`manage_product`), § 4 (conventions), § 6 M1
--             (RÈGLE M1-5, entité `variant`, bloc Recherche),
--             docs/BACKLOG.md E2-06.
--
-- RÈGLE M1-5 pose deux sources, et elles n'ont pas la même nature :
--
--   — l'**EAN fabricant**, scanné, stocké dans `variant.barcode`. Il vient du
--     carton, le système ne l'invente pas. C'est la voie principale en
--     cosmétique ;
--   — le **Code 128 émis par le système**, encodant `variant.sku`, pour tout ce
--     qui arrive sans code. Le système l'imprime, donc il en répond.
--
-- Cette migration livre trois choses, et la troisième est celle qui compte :
--
--   1. l'unicité du code-barres par commerce (critère 5 d'E2-06) ;
--   2. la normalisation de `barcode` — une douchette ajoute un retour chariot ;
--   3. **`sku_printed_at` : l'impression d'une étiquette fige le SKU.**
--
-- E2-01 puis E2-02 laissaient explicitement le point 3 à cette story. Le SKU de
-- la variante par défaut suit la référence du produit tant qu'il n'en a pas
-- divergé — utile quand rien n'est imprimé, destructeur dès qu'une étiquette est
-- collée sur un carton : le code imprimé cesserait de désigner quoi que ce soit,
-- et le scan ne trouverait plus rien, sans erreur visible.
--
-- **Arbitrage E2-06 : l'impression fige, et par une colonne, pas par un refus.**
-- Le patron garde le droit de corriger sa référence interne — c'est le champ le
-- plus souvent faux après un import (E2-05), et le lui interdire pour une
-- étiquette serait le punir d'une faute de frappe pour toujours. Ce qui est
-- figé est le SKU, pas la référence : les deux divergent, et la divergence est
-- déjà un état de première classe depuis E2-02.
--
-- La conséquence est réelle et assumée : la référence libérée sur `product`
-- reste tenue par le SKU figé de l'ancienne variante. La recréer est refusé par
-- `variant_sku_per_tenant` et non par `product_code_per_tenant` — c'est correct,
-- le code est imprimé sur des cartons, donc il est pris. Le message de
-- l'application se branche sur **le nom de la contrainte** et dit pourquoi
-- (CLAUDE.md, règle des unicités : deux index refusent avec le même `23505`).
--
-- Rien d'autre n'est construit : pas d'inventaire au scan (E3-04), pas de scan
-- à l'écran de vente (E4-03). La recherche interroge déjà les deux sources —
-- `search_sku` et `search_barcode` sont des colonnes générées indexées depuis
-- E2-04, et le classement place « code-barres égal à la requête » au premier
-- rang. Cette story l'éprouve, elle ne la réécrit pas.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Normalisation de `barcode`
--
-- Une douchette USB ou Bluetooth se comporte comme un clavier : elle tape le
-- code puis un **retour chariot**. Sur un champ de formulaire, la touche Entrée
-- valide ; dans un collage, dans un import, ou dans une saisie que l'écran
-- n'a pas nettoyée, le CR reste dans la valeur. Un code-barres avec un CR
-- invisible au bout n'est égal à rien : le scan suivant ne le retrouve pas, et
-- l'unicité ci-dessous ne le voit pas comme un doublon.
--
-- `btrim` avec sa liste explicite, pas le `btrim` d'un seul argument : celui-ci
-- ne retire que les espaces. Chaîne vide ramenée à nul, comme `sku` et `code`
-- (E2-01) — « pas de code-barres » est une absence, pas une chaîne vide, sinon
-- l'unicité refuserait le deuxième produit sans code-barres.
--
-- Le trigger de `sku` existe déjà ; il gagne `barcode`, et son nom le dit.
-- ----------------------------------------------------------------------------

create or replace function merx.normalize_variant_sku()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.sku     := nullif(pg_catalog.btrim(new.sku), '');
  new.barcode := nullif(pg_catalog.btrim(new.barcode, E' \t\r\n'), '');
  return new;
end;
$function$;

comment on function merx.normalize_variant_sku() is
  'Trigger BEFORE INSERT OR UPDATE sur variant : espaces de bord retirés, '
  'chaîne vide ramenée à nul, sur sku et sur barcode. Une douchette ajoute un '
  'retour chariot. E2-01, E2-06.';

drop trigger normalize_sku on public.variant;

create trigger normalize_sku
  before insert or update of sku, barcode on public.variant
  for each row execute function merx.normalize_variant_sku();


-- ----------------------------------------------------------------------------
-- 2. Un code-barres appartient à une variante, et à une seule
--
-- BACKLOG E2-06, critère 5 : « un `barcode` déjà attribué à une autre variante
-- est refusé avec un message clair ». Deux variantes sous le même code-barres,
-- c'est un scan au comptoir qui rend deux produits — le vendeur choisit, et il
-- choisit vite, donc parfois mal. Le prix facturé n'est alors pas celui du
-- produit qui sort.
--
-- **Par commerce**, comme toute unicité du projet : deux grossistes vendent le
-- même shampooing, donc portent le même EAN. Une unicité globale ferait
-- échouer le second import sans que personne puisse comprendre pourquoi —
-- l'autre ligne est invisible, elle est chez le voisin (SPEC § 2.1).
--
-- Même portée que `variant_sku_per_tenant` et `product_code_per_tenant` : sans
-- égard à la casse, parmi les variantes non supprimées. Un EAN est fait de
-- chiffres, où `lower()` ne change rien ; un Code 128 de fabricant peut porter
-- des lettres, et « 6111A » et « 6111a » se scannent pareil.
--
-- Son nom est ce qu'un test asserte, et ce sur quoi l'application branche son
-- message : `variant_sku_per_tenant` refuserait avec le même `23505` (CLAUDE.md,
-- règle des unicités — troisième occurrence de cette confusion depuis E1-01).
-- ----------------------------------------------------------------------------

create unique index variant_barcode_per_tenant
  on public.variant (tenant_id, lower(barcode))
  where deleted_at is null and barcode is not null;

comment on index public.variant_barcode_per_tenant is
  'Un code-barres désigne une variante, par commerce, sans égard à la casse, '
  'parmi les variantes vivantes. RÈGLE M1-5, BACKLOG E2-06.';


-- ----------------------------------------------------------------------------
-- 3. L'impression fige le SKU
--
-- `sku_printed_at` : la date de la première impression d'une étiquette pour
-- cette variante. Nulle tant que rien n'est imprimé.
--
-- Elle est posée par l'appareil, au moment de l'impression. Pas par le serveur :
-- une étiquette s'imprime au comptoir, parfois sans réseau (SPEC § 2.5), et la
-- date est celle de l'impression, pas celle de la synchronisation.
--
-- Ce qu'elle change, une fois posée : `merx.follow_product_code()` cesse de
-- suivre la référence pour cette variante. Le SKU imprimé reste ce qu'il est.
-- ----------------------------------------------------------------------------

alter table public.variant
  add column sku_printed_at timestamptz;

comment on column public.variant.sku_printed_at is
  'Date de la première étiquette imprimée pour cette variante. Une fois posée, '
  'le SKU ne suit plus la référence du produit et ne se modifie plus. Posée par '
  'l''appareil, jamais effacée. E2-06.';


-- ----------------------------------------------------------------------------
-- Garde — la date d'impression ne se retire pas, le SKU imprimé ne bouge plus
--
-- Un seul trigger, deux refus distincts, parce que ce sont deux chemins
-- différents vers la même perte :
--
--   — effacer ou reculer `sku_printed_at`, et le SKU se remet à suivre la
--     référence : l'étiquette collée redevient périssable ;
--   — changer `sku` sur une variante déjà étiquetée, directement par
--     PostgREST : l'étiquette ne désigne plus rien, sans passer par la
--     référence du tout.
--
-- Le second est le vrai trou. Sans lui, la condition posée dans
-- `follow_product_code()` ne protège qu'un seul chemin — celui de l'écran — et
-- un appel direct à l'API contourne tout, ce que E1-01 a mesuré sur
-- `create_tenant()` : 18 tests sur 19 restaient verts.
--
-- Chaque refus porte **sa propre phrase**, pour qu'un test puisse dire lequel a
-- refusé (CLAUDE.md, deux gardes sur un même chemin). SQLSTATE `2F004`, celui
-- de l'ajout seul (E1-04) : une valeur posée qui ne se rature plus est la même
-- propriété, et le code n'est celui d'aucun autre refus de `variant` —
-- `42501` est l'autorisation, `23505` l'unicité, `23514` les gardes de
-- `price_break`.
--
-- `sku_printed_at` n'est pas non plus un droit d'écriture nouveau : la policy
-- restrictive de `variant` exige `manage_product` pour toute écriture, celle-ci
-- comprise (E2-01). Un employé ne l'atteint pas.
-- ----------------------------------------------------------------------------

create function merx.protect_printed_sku()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.sku_printed_at is not null
     and new.sku_printed_at is distinct from old.sku_printed_at then
    raise exception
      'Une étiquette a déjà été imprimée pour cette variante : sa date d''impression ne s''efface pas.'
      using errcode = '2F004';
  end if;

  if old.sku_printed_at is not null
     and new.sku is distinct from old.sku then
    raise exception
      'Le SKU % est imprimé sur une étiquette : il ne se modifie plus, sinon l''étiquette ne désigne plus rien.',
      old.sku
      using errcode = '2F004';
  end if;

  return new;
end;
$function$;

comment on function merx.protect_printed_sku() is
  'Trigger BEFORE UPDATE sur variant : une date d''impression posée ne '
  's''efface pas, et le SKU qu''elle protège ne se modifie plus. E2-06.';

create trigger protect_printed_sku
  before update on public.variant
  for each row execute function merx.protect_printed_sku();


-- ----------------------------------------------------------------------------
-- `merx.follow_product_code()` — le SKU imprimé ne suit plus
--
-- E2-02 posait la fonction et laissait la condition à cette story, à la ligne
-- près : « Aucune étiquette n'existe avant E2-06 ; c'est elle qui décidera si
-- l'impression fige le SKU. » Elle fige.
--
-- `create or replace`, et non une modification du fichier d'E2-02 : la règle
-- des migrations (CLAUDE.md) ne tient que tant que rien n'est déployé, et
-- l'habitude se prend maintenant ou jamais.
--
-- Le trigger reste le même ; seul le corps change. Sans la condition, corriger
-- une référence effacerait un SKU imprimé — et le garde ci-dessus refuserait
-- l'UPDATE, donc la correction de la référence elle-même échouerait en `2F004`.
-- La condition n'est pas une commodité : c'est ce qui laisse la référence
-- corrigeable.
-- ----------------------------------------------------------------------------

create or replace function merx.follow_product_code()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  update public.variant v
  set sku = new.code
  where v.product_id = new.id
    and v.is_default
    and v.sku is not distinct from old.code
    and v.sku_printed_at is null;
  return null;
end;
$function$;

comment on function merx.follow_product_code() is
  'Trigger AFTER UPDATE OF code sur product : le SKU de la variante par défaut '
  'suit la référence, tant qu''il n''en a pas divergé et qu''aucune étiquette '
  'ne le porte. E2-02, E2-06.';
