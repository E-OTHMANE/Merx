-- ============================================================================
-- Merx — la résolution du prix : l'arrondi, le plancher, le forçage, la trace
--
-- Référence : docs/SPEC.md § 8 M3 (RÈGLE M3-7, `sale_line`), § 6 M1
--             (RÈGLES M1-2 à M1-4, `variant.floor_price`), § 3 + § 3.1
--             (`override_price`, `override_price_below_floor`), § 9 M8-1
--             (`price_override`), § 4 (conventions, RÈGLE des refus en 4xx),
--             § 2.5 (hors-ligne), docs/BACKLOG.md E4-04.
--
-- Quatre choses, et elles se tiennent :
--
--   1. **l'arrondi de `line_total`**, que E4-01 avait laissé ouvert et que
--      E4-03 tenait pour provisoire dans `src/modules/sales/amounts.ts`. Il
--      cesse d'être une règle que l'appareil applique de son côté : la colonne
--      devient **engendrée**, donc l'appareil ne l'envoie plus et ne peut plus
--      en dire autre chose que la base ;
--
--   2. **la cohérence des totaux**, qui n'était posée nulle part — faute de
--      règle d'arrondi, E4-01 s'en était abstenue. Deux pièces de plus : un
--      `check` dans la ligne du document, et un garde à la confirmation pour
--      la somme, qu'aucun `check` ne sait exprimer ;
--
--   3. **le plancher**, opposé au `worker` par la base et non par l'écran ;
--
--   4. **la trace** du forçage au journal, conditionnée à ce qui *est* un
--      forçage — ce que la colonne `overridden_price` rend lisible.
--
-- Aucune capacité ajoutée : `override_price` et `override_price_below_floor`
-- sont à § 3.1 depuis E0-05, qui les y avait posées pour un appelant d'E4. Les
-- quatre copies de la matrice ne bougent donc pas.
-- ============================================================================


-- ============================================================================
-- 1. `line_total` engendrée — RÈGLE M3-7
--
-- Une quantité est un `numeric(12,3)`, un prix un `numeric(12,2)` : leur
-- produit porte cinq décimales, et il faut revenir à deux. La règle, tranchée
-- en E4-04 et écrite à SPEC § 8 :
--
--     line_total = round(quantity × unit_price, 2) − line_discount
--
-- **demi loin de zéro**, **au niveau de la ligne**. Demi loin de zéro parce que
-- c'est ce que fait `round(numeric, 2)` : toute autre convention — demi vers le
-- pair, troncature — obligerait l'appareil à implémenter un arrondi que le SQL
-- écrit naïvement ne fait pas, et le jour où les deux divergent, c'est d'un
-- centime sur un papier déjà remis. Au niveau de la ligne parce que c'est la
-- ligne qui s'imprime et que le client relit.
--
-- **Engendrée, et non gardée par un `check`.** Un `check` laisserait l'appareil
-- affirmer le total et se contenterait de le contredire ; une colonne engendrée
-- ne lui laisse pas la parole. L'accord sur le centime devient structurel au
-- lieu d'être asserté — c'est la forme qu'avait déjà prise le SKU figé (E2-06)
-- et `product.code_key` (E2-05) : ce que la base peut calculer, elle le calcule.
--
-- Conséquences, les deux assumées :
--
--   — `saleWrite.ts` cesse d'envoyer `line_total`. Une colonne engendrée refuse
--     toute valeur fournie (`428C9`), et ce refus-là ne serait pas un garde :
--     c'est pourquoi la note est portée à BACKLOG E9-01 — la synchronisation ne
--     doit jamais la renvoyer, sans quoi la file de l'appareil se bloquerait
--     sur une écriture qui ne passera jamais ;
--   — un brouillon dont la quantité change voit son total suivre tout seul, ce
--     que le harnais d'E4-01 faisait à la main.
--
-- `drop` puis `add` : Postgres ne convertit pas une colonne ordinaire en
-- colonne engendrée. Le `check` des montants nomme `line_total`, donc le `drop`
-- l'emporterait — il est retiré et reposé explicitement, pour qu'on voie qu'il
-- revient entier et qu'il ne perde pas en passant ses deux autres membres.
-- Autorisé parce que rien n'est déployé et que la seule base est le stack local
-- (CLAUDE.md) ; la colonne reparaît en fin de table, ce dont rien ne dépend.
-- ============================================================================

alter table public.sale_line
  drop constraint sale_line_amounts_not_negative;

alter table public.sale_line
  drop column line_total;

alter table public.sale_line
  add column line_total public.money_amount
    generated always as (round(quantity * unit_price, 2) - line_discount) stored;

alter table public.sale_line
  add constraint sale_line_amounts_not_negative
    check (unit_price >= 0 and line_discount >= 0 and line_total >= 0);

comment on column public.sale_line.line_total is
  'round(quantity × unit_price, 2) − line_discount, demi loin de zéro, '
  'engendrée : l''appareil ne l''envoie pas et ne peut pas en dire autre chose '
  'que la base. SPEC § 8, RÈGLE M3-7 ; E4-04.';


-- ============================================================================
-- 2. `overridden_price` — les deux sortes de `manual`
--
-- E4-03 marque `manual` une ligne dont la grille ne donne **aucun** prix : le
-- vendeur le saisit parce qu'il n'en existe pas, et rien ne bloque une vente
-- (§ 2.6). E4-04 apporte le **forçage**, qui remplace un prix *qui existe*. Les
-- deux porteraient `manual`, et le journal des forçages compterait alors chaque
-- ligne sans prix pour un forçage — il dirait faux sur ce qu'il est seul à
-- dire.
--
-- La colonne les distingue, et ce n'est pas une étiquette de plus : elle porte
-- **le prix remplacé**, qui n'est nulle part ailleurs sur la ligne et qui est
-- la seule chose qu'un patron veut lire dans l'entrée du journal. L'« avant »
-- de l'audit existe donc, sans que `merx.audit_row_change()` ait à aller le
-- chercher dans une table qui bouge.
--
--   auto    | NULL          le prix du palier (RÈGLE M1-2)
--   manual  | NULL          aucun prix n'existait — E4-03
--   manual  | le prix       forçage d'un prix qui existait — E4-04
--
-- Le `check` tient les trois états : un forçage ne peut pas se déguiser en
-- ligne sans prix tout en gardant la trace de ce qu'il remplace, et un prix
-- remplacé égal au prix retenu n'est pas un forçage. Le défaut reste
-- `auto` / NULL, donc le balayage d'isolation continue de remplir `sale_line`
-- sans rien savoir de cette story.
--
-- **Posée par l'appareil, jamais recalculée à l'arrivée.** Le serveur pourrait
-- résoudre `price_break` lui-même et contredire l'appareil ; il ne le fera pas.
-- Une vente faite hors ligne dont la grille a changé depuis serait refusée à la
-- synchronisation — un refus en 4xx, donc définitif, sur une écriture qui ne
-- passera jamais : la file de l'appareil resterait bloquée dessus (§ 4, RÈGLE
-- des refus en 4xx ; E9). Un document raconte la vente telle qu'elle a eu lieu ;
-- la grille, elle, bouge.
--
-- Limite assumée, et elle est écrite plutôt que tue : par l'API, un employé
-- peut taire son forçage en laissant `overridden_price` nul. Il n'échappe pas
-- au plancher ci-dessous, qui ne dépend d'aucune déclaration de l'appareil —
-- c'est le garde qui tient l'argent, et il lit `variant.floor_price` en base.
-- ============================================================================

alter table public.sale_line
  add column overridden_price public.money_amount;

alter table public.sale_line
  add constraint sale_line_override_shape
    check (
      overridden_price is null
      or (price_source = 'manual' and overridden_price <> unit_price)
    );

comment on column public.sale_line.overridden_price is
  'Le prix que la grille donnait et que le vendeur a remplacé — nul quand la '
  'ligne n''est pas un forçage, y compris quand aucun prix n''existait. C''est '
  'ce qui distingue les deux sortes de manual, et l''« avant » de l''entrée '
  'price_override. Posé par l''appareil, jamais recalculé. E4-04.';


-- ============================================================================
-- 3. Le plancher, tenu par la base
--
-- § 3.1, l'astérisque : « `worker` peut forcer un prix uniquement au-dessus du
-- `floor_price`. En dessous, refusé — sinon rien n'empêche de vendre à prix
-- coûtant. » L'écran le dira aussi, mais l'écran se contourne d'une requête
-- (E1-02) : le refus vient d'ici.
--
-- **Un trigger, pas une policy.** Une policy restrictive saurait le faire — et
-- rendrait le message générique de la RLS, indistinguable de l'isolation.
-- `variant`, `price_break` et `sale_line` ont déjà montré ce piège trois fois
-- (E2-01, E2-03, E2-06) : un code seul ne dit pas qui a refusé. Le garde a donc
-- sa phrase, et le test l'assert.
--
-- **Il ne regarde pas `price_source`.** S'il ne valait que pour `manual`, un
-- employé poserait `auto` par l'API et passerait dessous : le contrôle serait
-- une politesse. Une ligne sous le plancher exige la capacité, quelle que soit
-- la provenance du prix. Conséquence assumée : un palier que le patron aurait
-- réglé *sous* son propre plancher devient invendable par l'employé. C'est une
-- contradiction de la grille, et le refus est le bon côté de l'erreur — l'écran
-- de grille devrait la signaler à la saisie (noté en BACKLOG E2-03).
--
-- **`security definer`**, même raison qu'`merx.require_document_number_shape()`
-- en E4-02 : la fonction lit `public.variant` pour y prendre le plancher. En
-- invoker, un commerce dont la policy de `variant` serait un jour resserrée
-- verrait ce garde ne plus rien lire — donc ne plus rien tenir, en silence, ce
-- qui est la pire façon pour un garde d'argent de disparaître. La lecture ne
-- fuit rien : elle porte sur `(tenant_id, variant_id)` de la ligne, paire que
-- la clé composite force à être dans le commerce de la ligne, et elle ne rend
-- rien à l'appelant. Dans `merx`, donc hors de PostgREST et hors du registre
-- des exceptions RLS, qui ne régit que `public` (§ 2.1).
--
-- **Variante hors du commerce : aucun avis.** Le filtre `tenant_id` ne trouve
-- alors aucune ligne, le garde laisse passer, et ce sont la RLS et la clé
-- composite qui refusent. Un garde BEFORE qui refuserait là tiendrait lieu
-- d'isolation dans le balayage, qui ne saurait pas distinguer les deux
-- (CLAUDE.md, E3-01).
--
-- `42501` — *insufficient_privilege*, rendu **403**, mesuré par PostgREST
-- (§ 4 ; `refusalCodes.ts`). C'est bien un droit qui manque.
-- ============================================================================

create function merx.require_floor_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  floor_price public.money_amount;
begin
  select v.floor_price into floor_price
  from public.variant v
  where v.tenant_id = new.tenant_id
    and v.id = new.variant_id;

  if floor_price is null or new.unit_price >= floor_price then
    return new;
  end if;

  if merx.can('override_price_below_floor') then
    return new;
  end if;

  -- La phrase n'est pas celle de l'écran, et c'est voulu : celle-ci ne se lit
  -- que lorsque quelque chose a parlé à PostgREST sans passer par l'écran
  -- (CLAUDE.md, deux gardes sur le même chemin).
  raise exception
    'Prix sous le plancher de cette variante : % pour un plancher de %. La capacité override_price_below_floor est requise.',
    new.unit_price, floor_price
    using errcode = '42501';
end;
$function$;

comment on function merx.require_floor_price() is
  'Trigger BEFORE INSERT OR UPDATE sur sale_line : un prix sous '
  'variant.floor_price exige override_price_below_floor. Vaut quelle que soit '
  'price_source — sinon le contrôle se contourne en posant auto. SPEC § 3.1, '
  'astérisque du plancher ; E4-04.';

create trigger require_floor_price
  before insert or update on public.sale_line
  for each row execute function merx.require_floor_price();


-- ============================================================================
-- 4. La cohérence des totaux — RÈGLE M3-7, seconde moitié
--
-- E4-01 n'en avait posé aucune, faute de règle d'arrondi : « cette règle se
-- tranche avant toute contrainte de ce genre » (BACKLOG E4-04). Elle est
-- tranchée, et les contraintes arrivent en trois pièces qui ne tiennent pas la
-- même chose :
--
--   `line_total` engendrée                 dans la ligne, toujours, par
--                                          construction — section 1
--   `sale_document_total_consistent`       dans la ligne du document,
--   (`check`)                              toujours. `23514`, rendu 400
--   `merx.require_consistent_totals()`     `subtotal = Σ line_total`, à la
--   (trigger)                              confirmation. `23514`, rendu 400
--
-- **Pourquoi la somme n'est pas tenue en permanence.** Elle traverse les
-- lignes, donc aucun `check` ne l'exprime ; et surtout `saleWrite` écrit le
-- document *avant* ses lignes (E4-03) — un garde permanent refuserait le
-- brouillon lui-même, dont le total ne correspond encore à rien. Le moment où
-- elle doit être vraie est exactement celui où le contenu se figeait déjà : la
-- confirmation (RÈGLE M3-3). Après, plus une ligne ne s'écrit et plus un
-- montant ne change — la propriété tient donc pour toujours, gardée une fois.
--
-- **`23514` et non un `PTxxx` neuf.** Les trois pièces disent la même règle, et
-- celle-ci est le `check` que Postgres ne sait pas écrire : lui donner le code
-- d'une violation de contrôle n'est pas détourner un code, c'est le nommer.
-- Elle reste distinguable de ses voisines du même chemin, qui ne partagent ni
-- son code ni sa phrase — `merx.require_document_number_shape()` lève `22023`,
-- le gel de la table figée `PT409`.
--
-- **`security definer`**, et le filtre `tenant_id` en tête du corps : la somme
-- doit être celle de *toutes* les lignes du document. En invoker, une policy
-- resserrée en masquerait une et la confirmation serait refusée pour une raison
-- fausse — un refus qu'aucune lecture de la ligne n'expliquerait. Elle ne rend
-- rien à l'appelant et ne lit que les lignes du document qu'il confirme.
-- ============================================================================

alter table public.sale_document
  add constraint sale_document_total_consistent
    check (total = subtotal - discount_total);

comment on constraint sale_document_total_consistent on public.sale_document is
  'total = subtotal − discount_total, à tout instant. SPEC § 8, RÈGLE M3-7 ; '
  'E4-04.';

create function merx.require_consistent_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lines_total public.money_amount;
begin
  select coalesce(sum(l.line_total), 0) into lines_total
  from public.sale_line l
  where l.tenant_id = new.tenant_id
    and l.sale_document_id = new.id;

  if new.subtotal <> lines_total then
    raise exception
      'Le sous-total du document ne dit pas la vérité sur ses lignes : % contre % pour la somme des lignes. Un document confirmé imprime ce qui est stocké.',
      new.subtotal, lines_total
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

comment on function merx.require_consistent_totals() is
  'Trigger BEFORE UPDATE sur sale_document, à la confirmation seulement : '
  'subtotal = somme des line_total. La somme traverse les lignes, donc aucun '
  'check ne l''exprime ; et un brouillon s''écrit avant ses lignes. SPEC § 8, '
  'RÈGLE M3-7 ; E4-04.';

-- `when` et non un `if` dans le corps : la condition vit dans le catalogue,
-- où elle se lit et où `conventions.ts` peut la voir, au lieu d'un test qu'on
-- pourrait retirer sans que rien ne le dise. Le nom range le garde après
-- `reject_frozen_update` dans l'ordre alphabétique, donc après le gel : un
-- document déjà confirmé est refusé par le gel, pas par celui-ci.
create trigger require_consistent_totals
  before update on public.sale_document
  for each row
  when (old.status = 'draft' and new.status = 'confirmed')
  execute function merx.require_consistent_totals();


-- ============================================================================
-- 5. La trace — RÈGLE M8-1, `price_override`
--
-- `merx.apply_audit()` tel qu'E3-03 et E4-01 l'ont fait : condition de ligne
-- dans le `when` du trigger, événements explicites sans `delete`, condition
-- relue du catalogue et inscrite au registre que `conventions.ts` confronte au
-- trigger réel. Le helper ne change pas — c'est la première fois depuis E2-03
-- qu'un audit s'y branche sans rien lui ajouter.
--
-- **Sur la ligne, et non à la confirmation du document.** La note d'ouverture
-- d'E4-04 disait l'inverse, et c'est l'inverse qui est faux :
-- `merx.log_audit()` prend l'auteur dans le jeton de **celui qui écrit**
-- (E1-04). Journalisée à la transition `draft → confirmed`, l'entrée
-- attribuerait le forçage à celui qui confirme — le patron qui valide, pas
-- l'employé qui a baissé le prix. Le journal ne pose qu'une question, « qui »,
-- et il y répondrait faux. **Ne pas déplacer cette trace vers la
-- confirmation** ; c'est écrit à SPEC § 8 pour la même raison.
--
-- Le garde du plancher et la trace voient donc le même instant, ce qui est la
-- seconde raison : un forçage refusé n'entre pas au journal, un forçage accepté
-- y est, dans la même transaction.
--
-- Et « pas à chaque frappe » est déjà tenu par E4-03 : **rien n'est écrit
-- pendant la saisie**. Les lignes partent en un seul appel, à l'appui sur
-- « Enregistrer le bon » — une écriture de ligne *est* le geste de
-- confirmation. Un `PATCH` répété par l'API écrirait plusieurs entrées : ce
-- sont plusieurs écritures réelles d'un prix forcé, et un journal en ajout seul
-- les retient toutes.
--
-- (`sale_document` ne pouvait de toute façon pas la porter : `table_name` est
-- la clé primaire de `merx.audited_registry`, le trigger a un nom fixe, et elle
-- porte déjà `document_cancellation`.)
--
-- L'entrée retient ce qu'un patron relit : la variante, la quantité, le prix
-- remplacé, le prix retenu. Le document, lui, se retrouve par la ligne ; la
-- date, l'auteur et le commerce, l'entrée les porte déjà.
-- ============================================================================

select merx.apply_audit(
  'public.sale_line', 'price_override',
  array['variant_id', 'quantity', 'overridden_price', 'unit_price'],
  $$new.overridden_price is not null$$,
  array['insert', 'update']);

comment on type public.audit_action is
  'Les sept actions qui écrivent obligatoirement dans audit_log. SPEC § 9, '
  'RÈGLE M8-1. purchase_price_change est branchée en E2-03, stock_adjustment '
  'en E3-03, document_cancellation en E4-01, price_override en E4-04 ; les '
  'autres arrivent avec leurs modules.';
