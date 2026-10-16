-- ============================================================================
-- Merx — le cycle des documents : filiation, et le stock qui bouge enfin
--
-- Référence : docs/SPEC.md § 2.3 (variant_id), § 2.4 (dépôt unique),
--             § 3 / § 3.1 (matrice, RÈGLE un seul helper), § 4 (conventions,
--             clés composites, refus en 4xx), § 7 M2 (RÈGLES M2-1, M2-2, M2-5
--             et son addendum E4-01), § 8 (RÈGLES M3-3, M3-4, M3-5) ;
--             docs/BACKLOG.md E4-05.
--
-- Trois choses, et chacune son garde — aucun ne refuse comme un autre, sans
-- quoi le test de l'un passerait sur le refus du voisin (CLAUDE.md ; E1-01,
-- E1-02, E2-01, E3-01, E4-01) :
--
--   RÈGLE M3-4 — une transformation crée un **nouveau** document lié, sans
--     muter l'original. `sale_document.source_document_id`, auto-référence à
--     clé composite, et `merx.require_transformation_shape()` : quatre
--     branches, quatre phrases, `22023` rendu 400.
--
--   RÈGLE M3-5 — le stock est décrémenté **à la confirmation du bon de
--     livraison**, ni au devis ni à la commande. `merx.write_sale_movements()`,
--     trigger AFTER sur la transition `draft → confirmed`, et lui seul.
--
--   RÈGLE M2-5 — le type `sale` s'ouvre, sur `create_sale`. Et comme le
--     mouvement naît de la confirmation et non d'un geste de l'appareil,
--     l'écriture directe est refusée : `merx.require_sale_origin()`, la forme
--     de `require_cancellation_origin()` d'E4-01.
--
-- ----------------------------------------------------------------------------
-- Pourquoi `sale` n'est pas simplement ouvert à `create_sale` et laissé là
--
-- La capacité est la bonne — un employé vend, donc un employé fait bouger le
-- stock —, mais une porte ouverte à `create_sale` est aussi un `POST` de
-- mouvements sans écran : l'employé posterait un `sale` de n'importe quel
-- signe, de n'importe quelle quantité, sans document, et **sans entrée de
-- journal** (RÈGLE M8-1 n'audite que l'ajustement, l'annulation et le forçage).
-- C'est exactement l'objection d'E4-01 pour `sale_cancellation`, et la réponse
-- est la même : un écrivain déclaré, l'écriture à la main refusée, et une règle
-- de `conventions.ts` qui nomme tout autre écrivain.
--
-- Un mouvement de vente se corrige donc comme tout le reste : en annulant le
-- document, ce qui écrit l'inverse (E4-01) et laisse une trace.
--
-- ----------------------------------------------------------------------------
-- Ce qui n'est **pas** ici, et pourquoi
--
--   — `return` reste fermé : c'est E4-06, et son document n'existe pas.
--   — aucune capacité neuve. `create_sale` est à § 3.1 depuis E0-05 : les
--     **quatre** copies de la matrice ne bougent pas (CLAUDE.md).
--   — aucune valeur d'enum neuve : `sale` est une étiquette de
--     `public.stock_movement_type` depuis E3-01. Une seule migration suffit.
--   — aucune comparaison des quantités d'un enfant à celles de son parent :
--     une commande de 100 peut donner deux bons de 100. Limite connue, écrite
--     en BACKLOG E4-05 et à poser aux commerçants à l'arrêt terrain d'E6.
--   — l'affichage de la filiation : E4-07 porte l'écran de détail.
-- ============================================================================


-- ============================================================================
-- 1. La filiation — RÈGLE M3-4
--
-- **Une colonne sur l'enfant, pas une table de liens.** Un parent a plusieurs
-- enfants — une commande de 100 livrée en deux camions fait deux bons, un devis
-- accepté à moitié fait deux commandes —, mais un enfant n'a qu'un parent :
-- c'est la définition même d'« issu de ». Une colonne le dit exactement, et les
-- deux sens se lisent (critère d'E4-05) : le parent par la colonne, les enfants
-- par l'index ci-dessous. Une table de liens n'apporterait qu'un `n..n` que
-- rien ne demande, et il faudrait l'empêcher.
--
-- **Aucune unicité**, donc, et c'est l'arbitrage : deux enfants du même parent
-- sont le cas normal, pas une anomalie.
--
-- Clé **composite** sur `tenant_id` (SPEC § 4) : sans elle un commerce
-- rattacherait ses bons aux devis du voisin. Auto-référence, et **sans
-- cascade** — un document ne se supprime pas (§ 4), et la suppression d'un
-- brouillon ne doit surtout pas emporter ses enfants ; `on delete` par défaut
-- (`no action`) refuse alors, ce qui est le bon côté de l'erreur.
-- ============================================================================

alter table public.sale_document
  add column source_document_id uuid;

comment on column public.sale_document.source_document_id is
  'Le document dont celui-ci est issu — le devis d''une commande, la commande '
  'd''un bon. Nul pour un document né de la saisie. L''original n''est jamais '
  'muté : la transformation ne fait que créer cette ligne-ci. SPEC § 8, '
  'RÈGLE M3-4 ; E4-05.';

alter table public.sale_document
  add constraint sale_document_source_document_id_fkey
  foreign key (tenant_id, source_document_id)
  references public.sale_document (tenant_id, id);

-- Le sens descendant : les enfants d'un document, sans lire ceux du commerce.
create index sale_document_source
  on public.sale_document (tenant_id, source_document_id)
  where source_document_id is not null;


-- ----------------------------------------------------------------------------
-- La chaîne admise, en données
--
-- Même geste que `merx.frozen_transition` (E4-01) : la règle se lit dans une
-- table plutôt que dans un `case` au corps d'une fonction, donc un test peut
-- l'énumérer et un quatrième type de document fera rougir la suite au lieu de
-- passer en silence.
--
-- **`devis → bon` est admis**, et c'est un arbitrage, pas un oubli : un client
-- accepte un devis et on le livre. L'interdire forcerait une commande fictive
-- pour le cas le plus courant du comptoir.
--
-- Rien ne part d'un bon de livraison, et aucun lien ne remonte la chaîne : un
-- bon est la fin du cycle de vente (le retour est un autre document, E4-06).
-- ----------------------------------------------------------------------------

create table merx.document_transformation (
  source_type public.sale_doc_type not null,
  target_type public.sale_doc_type not null,

  primary key (source_type, target_type)
);

comment on table merx.document_transformation is
  'Les transformations admises, en données : devis → commande, devis → bon, '
  'commande → bon. Rien ne part d''un bon, et rien ne remonte. SPEC § 8, '
  'RÈGLE M3-4 ; E4-05.';

insert into merx.document_transformation (source_type, target_type) values
  ('quote', 'order'),
  ('quote', 'delivery_note'),
  ('order', 'delivery_note');


-- ----------------------------------------------------------------------------
-- Le garde de la filiation — quatre branches, quatre phrases
--
-- `22023` (*invalid_parameter_value*), rendu **400** et mesuré par PostgREST
-- (§ 4, RÈGLE des refus en 4xx ; `refusalCodes.ts`) : le même code que
-- `merx.require_document_number_shape()` d'E4-02, et pour la même raison — la
-- valeur fournie ne décrit pas une filiation possible.
--
-- `security definer`, même raison qu'`require_floor_price()` (E4-04) : la
-- fonction lit `public.sale_document` pour y prendre le type et le statut du
-- parent. En invoker, un garde qui ne lit plus ne tient plus rien, en silence.
-- Dans `merx`, donc hors de PostgREST et hors du registre des exceptions RLS,
-- qui ne régit que `public` (§ 2.1).
--
-- **Parent hors du commerce : aucun avis.** Le filtre `tenant_id` ne trouve
-- alors rien, le garde laisse passer, et ce sont la clé composite et la RLS qui
-- refusent. Un garde qui refuserait là tiendrait lieu d'isolation dans le
-- balayage, qui ne saurait pas distinguer les deux (CLAUDE.md, E3-01).
--
-- BEFORE INSERT seulement : la colonne est posée à la naissance du brouillon.
-- Elle reste modifiable tant que le document est brouillon — comme ses lignes
-- et ses totaux (RÈGLE M3-3) — et gèle avec lui à la confirmation.
-- ----------------------------------------------------------------------------

create function merx.require_transformation_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source record;
begin
  if new.source_document_id = new.id then
    raise exception
      'Un document ne peut pas être issu de lui-même.'
      using errcode = '22023';
  end if;

  select d.doc_type, d.status into source
  from public.sale_document d
  where d.tenant_id = new.tenant_id
    and d.id = new.source_document_id;

  -- Hors du commerce, ou inexistant : la clé composite tranche, pas ce garde.
  if not found then
    return new;
  end if;

  if source.status = 'draft' then
    raise exception
      'Le document d''origine est encore un brouillon : il n''y a rien à transformer.'
      using errcode = '22023',
            hint = 'Confirmer l''original d''abord.';
  end if;

  if source.status = 'cancelled' then
    raise exception
      'Le document d''origine est annulé : on ne transforme pas un document annulé.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from merx.document_transformation t
    where t.source_type = source.doc_type
      and t.target_type = new.doc_type
  ) then
    raise exception
      'Transformation impossible : un document de type % ne donne pas un document de type %.',
      source.doc_type, new.doc_type
      using errcode = '22023',
            hint = 'Admises : devis → commande, devis → bon, commande → bon.';
  end if;

  return new;
end;
$function$;

comment on function merx.require_transformation_shape() is
  'Trigger BEFORE INSERT sur sale_document quand source_document_id est posé : '
  'pas d''auto-référence, pas de parent brouillon ni annulé, et la chaîne de '
  'merx.document_transformation. SPEC § 8, RÈGLE M3-4 ; E4-05.';

create trigger require_transformation_shape
  before insert on public.sale_document
  for each row
  when (new.source_document_id is not null)
  execute function merx.require_transformation_shape();


-- ============================================================================
-- 2. Le registre des écrivains de mouvements
--
-- `merx.require_sale_origin()` et `merx.require_cancellation_origin()` reposent
-- sur `pg_trigger_depth()`, qui dit « écrit par un trigger » et non « écrit par
-- le trigger qu'il faut » : une seconde fonction qui insérerait depuis un
-- trigger passerait les deux gardes. E4-01 fermait cette porte dans
-- `conventions.ts` en cherchant le mot `sale_cancellation` au corps des
-- fonctions. Le mot est distinctif ; **`sale` ne l'est pas** — il apparaît dans
-- `sale_document`, `sale_line`, `sale_cancellation`, et un balayage qui le
-- chercherait nommerait tout le monde.
--
-- Chercher le littéral *transtypé* (`'sale'::public.stock_movement_type`) ne
-- marche pas davantage : Postgres accepte `movement_type = 'sale'` sans
-- transtypage, et la règle s'éviterait **en écrivant moins**. Une règle statique
-- qui se contourne par une écriture plus courte ne vaut rien.
--
-- D'où un registre, et une règle qui ne lit aucun littéral : **toute fonction
-- de `public` ou de `merx` qui insère dans `stock_movement` est déclarée ici,
-- ou elle est nommée par `conventions.ts`**. Le type n'entre plus dans la
-- question posée au catalogue, donc plus rien ne dépend de la façon de
-- l'écrire.
--
-- Limite résiduelle, écrite plutôt que tue : un écrivain **déclaré** pourrait
-- insérer un autre type que celui qu'on lui prête. C'est une faute qui se voit
-- à la relecture de la story qui l'écrit, et non une porte ouverte par l'API —
-- les deux gardes d'origine, eux, ne laissent passer aucune insertion directe.
-- ============================================================================

create table merx.movement_writer (
  function_name text                       not null,
  movement_type public.stock_movement_type not null,

  primary key (function_name, movement_type)
);

comment on table merx.movement_writer is
  'Les fonctions autorisées à insérer dans stock_movement, et le type qu''elles '
  'écrivent. conventions.ts nomme toute autre fonction qui y insère — '
  'pg_trigger_depth() dit qu''un trigger écrit, pas lequel. RÈGLE M2-5 ; E4-05.';

insert into merx.movement_writer (function_name, movement_type) values
  -- E4-01 : l'inverse des mouvements d'un document annulé.
  ('reverse_sale_movements', 'sale_cancellation'),
  -- E4-05 : la sortie de stock d'un bon de livraison confirmé.
  ('write_sale_movements', 'sale');


-- ============================================================================
-- 3. Le stock à la confirmation — RÈGLE M3-5
--
-- Trigger AFTER UPDATE sur `sale_document`, à la transition `draft → confirmed`
-- **et au seul type `delivery_note`**. Le devis et la commande ne touchent pas
-- au stock : un devis est une offre, une commande une promesse, et seule la
-- livraison sort la marchandise du dépôt. La condition vit dans le `when` du
-- trigger, donc au catalogue — où elle se lit — plutôt que dans un `if` du
-- corps qu'on retirerait sans que rien ne le dise (même geste
-- qu'`require_consistent_totals`, E4-04).
--
-- **AFTER** : `reject_frozen_update` (BEFORE) a déjà tranché la transition. Un
-- document déjà confirmé est refusé par le gel, jamais ici, donc un mouvement
-- ne s'écrit qu'une fois — la confirmation est la seule transition qui mène à
-- `confirmed`, et rien n'y revient.
--
-- **`security invoker`** — le défaut, et il est voulu, comme pour
-- `reverse_sale_movements()` (E4-01) : la policy `column_capability_insert` de
-- `stock_movement` et le garde du type ouvert s'appliquent à cette insertion
-- comme à n'importe quelle autre. Ce n'est pas une exception à la RLS (§ 2.1) et
-- rien ne s'inscrit à `merx.rls_exception_registry`. Une confirmation qui ne
-- peut pas écrire ses mouvements échoue **entière** : un bon imprimé dont le
-- stock n'aurait pas bougé serait pire que pas de bon du tout.
--
-- **Un mouvement par ligne**, et non un par variante : l'historique raconte le
-- document tel qu'il est écrit. Deux lignes de la même variante — ce que
-- l'écran fusionne mais que l'API permet — font deux mouvements, et leur somme
-- est la même.
--
-- `quantity` est **négative** : une vente sort (SPEC § 7). `source_type` et
-- `source_id` désignent le document, ce qui est exactement ce que
-- `reverse_sale_movements()` relit pour inverser. `device_id` est celui du
-- document : l'appareil qui a vendu, et non celui qui synchronise.
-- ============================================================================

create function merx.write_sale_movements()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.stock_movement (
    tenant_id, variant_id, warehouse_id, movement_type, quantity,
    source_type, source_id, device_id, note
  )
  select new.tenant_id, l.variant_id, new.warehouse_id,
         'sale'::public.stock_movement_type,
         - l.quantity,
         'sale_document'::public.stock_source_type, new.id,
         new.device_id,
         'Vente ' || coalesce(new.doc_number, 'sans numéro')
  from public.sale_line l
  where l.tenant_id = new.tenant_id
    and l.sale_document_id = new.id;

  return null;
end;
$function$;

comment on function merx.write_sale_movements() is
  'Trigger AFTER UPDATE sur la confirmation d''un bon de livraison : un '
  'mouvement sale négatif par ligne. Invoker — la RLS et la capacité du type '
  's''appliquent. Ni le devis ni la commande n''y passent, par la condition du '
  'trigger. SPEC § 8, RÈGLE M3-5 ; E4-05.';

create trigger write_sale_movements
  after update on public.sale_document
  for each row
  when (old.status = 'draft' and new.status = 'confirmed'
        and new.doc_type = 'delivery_note')
  execute function merx.write_sale_movements();


-- ----------------------------------------------------------------------------
-- 4. Le mouvement de vente ne s'écrit pas à la main
--
-- La forme exacte de `merx.require_cancellation_origin()` (E4-01), et pour la
-- même raison : la porte ouverte à `create_sale` laisserait un employé poster
-- un `sale` de n'importe quel signe, sans document et sans trace.
--
-- `pg_trigger_depth()` vaut 1 pour une insertion directe — PostgREST, `psql` —
-- et 2 pour celle que fait un trigger. La profondeur ne se forge pas depuis une
-- requête, un drapeau de session si.
--
-- AFTER, et pas BEFORE : la RLS d'une insertion est vérifiée entre les deux, et
-- un garde BEFORE refuserait avant elle, ce qui ferait passer le test de la
-- policy sur son refus à lui (E3-01).
--
-- `42501` comme la policy, et **sa propre phrase** — qui n'est ni celle de la
-- policy ni celle du garde de l'annulation : c'est la phrase que le test
-- assert, et c'est à elle qu'on voit lequel des gardes a refusé (E1-02).
-- ----------------------------------------------------------------------------

create function merx.require_sale_origin()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception
      'Un mouvement de type sale ne s''écrit pas à la main : il naît de la '
      'confirmation de son bon de livraison.'
      using errcode = '42501',
            hint = 'Enregistrer le bon depuis l''écran de vente.';
  end if;

  return null;
end;
$function$;

comment on function merx.require_sale_origin() is
  'Trigger AFTER INSERT sur un mouvement sale : refuse toute insertion '
  'directe. Sans lui, create_sale serait un POST de mouvements sans écran. '
  'pg_trigger_depth(), comme merx.require_cancellation_origin(). E4-05.';

create trigger require_sale_origin
  after insert on public.stock_movement
  for each row
  when (new.movement_type = 'sale')
  execute function merx.require_sale_origin();


-- ----------------------------------------------------------------------------
-- 5. Le type ouvert : `sale`, sur `create_sale`
--
-- L'addendum E4-01 de la RÈGLE M2-5 l'annonçait : « `sale` et `return`
-- s'ouvriront sur `create_sale` [...] parce que les employés les écrivent ».
-- Aucune capacité n'est ajoutée — `create_sale` est à § 3.1 depuis E0-05 —,
-- donc les quatre copies de la matrice ne bougent pas.
--
-- `return`, `receipt` et `inventory` restent fermés (E4-06, E8-02, E3-04).
-- ----------------------------------------------------------------------------

insert into merx.movement_type_capability (movement_type, capability) values
  ('sale', 'create_sale');
