-- ============================================================================
-- Merx — les retours : le stock qui revient, et jamais plus qu'il n'est parti
--
-- Référence : docs/SPEC.md § 2.4 (dépôt unique), § 3.1 (matrice), § 4
--             (conventions, refus en 4xx), § 7 M2 (RÈGLES M2-1, M2-2, M2-5 et
--             ses addenda E4-01, E4-05, E4-06), § 8 (RÈGLES M3-2, M3-3, M3-4,
--             M3-5, M3-8, et M3-9 écrite par cette story) ;
--             docs/BACKLOG.md E4-06.
--
-- Le type `return` est né dans `20261019090000_return_doc_type.sql` — une
-- valeur d'enum n'est pas utilisable dans la transaction qui la crée. Tout ce
-- qui s'en sert est ici, et rien d'autre.
--
-- ----------------------------------------------------------------------------
-- Les six pièces, et chacune sa phrase
--
--   1. **un retour est lié à un bon**, par `sale_document_return_has_source` et
--      par la chaîne `('delivery_note', 'return')` de
--      `merx.document_transformation` — après quoi
--      `merx.require_transformation_shape()` (E4-05) refuse déjà, sans une
--      ligne ajoutée, un original brouillon, annulé, ou d'un autre type ;
--
--   2. **`RT-A-26-00001`** : le schéma d'E4-02 intact, une branche de plus à la
--      table des codes. Pas `BR` (« bon de retour ») : `BL` et `BR` ne diffèrent
--      que d'une lettre sur un numéro qui se dicte au téléphone, ce qui est
--      précisément pourquoi l'année ne fait que deux chiffres (RÈGLE M3-2) ;
--
--   3. **RÈGLE M3-9 — on ne rend jamais plus que le bon n'a livré.**
--      `merx.require_returnable_quantity()`, à la confirmation, deux branches
--      et deux phrases : la quantité, et l'avoir. L'excès créerait du stock à
--      partir de rien **et** un avoir à partir de rien ;
--
--   4. **le mouvement `return` naît de la confirmation**, et d'elle seule :
--      `merx.write_return_movements()` l'écrit, `merx.require_return_origin()`
--      refuse l'écriture à la main, `merx.movement_writer` le déclare. La forme
--      d'E4-05 pour `sale`, pièce pour pièce ;
--
--   5. **un bon qui a un retour vivant ne s'annule pas.**
--      `merx.require_no_active_return()` — sans lui, l'inversion du bon
--      recréditerait un stock que le retour avait déjà rendu ;
--
--   6. **le plancher ne gouverne pas un avoir.** Le prix d'une ligne de retour
--      est celui du papier : `merx.require_floor_price()` sort tôt sur un
--      retour.
--
-- ----------------------------------------------------------------------------
-- Ce qui n'est **pas** ici, et pourquoi
--
--   — **l'écriture au crédit du client : E6-02**, qui porte déjà le critère mot
--     pour mot. `client_ledger_entry` n'existe pas, et `sale_document.client_id`
--     non plus (E6-01) : un retour n'a aujourd'hui aucun client à créditer, et
--     l'écrire ici serait inventer la table deux epics en avance. Même
--     traitement que la sélection du client en E4-03. Ce qu'E4-06 lui laisse de
--     concret est inscrit dans sa story : le crédit s'accroche à la **même**
--     table et à la **même** transition que le débit d'un bon confirmé, et un
--     retour annulé demande son écriture inverse (RÈGLE M4-2) ;
--   — aucune capacité neuve. `return` s'ouvre sur `create_sale`, la capacité
--     annoncée par l'addendum E4-01 de la RÈGLE M2-5 : les **quatre** copies de
--     la matrice ne bougent pas (CLAUDE.md) ;
--   — aucune entrée de journal neuve : la RÈGLE M8-1 n'audite que l'ajustement,
--     l'annulation et le forçage. Un retour est un document, et c'est son
--     annulation qui est tracée, comme celle de n'importe quel document ;
--   — aucun rattachement d'une ligne de retour à **la** ligne d'origine. Le
--     registre est tenu **par variante** : le commerçant rapporte « cinq de ce
--     produit », pas « cinq de la ligne 3 », et l'API autorise deux lignes de
--     la même variante sur un même bon (E4-05). Le prix en est la limite
--     connue, et c'est la branche « avoir » qui la borne ;
--   — aucun `delivered` qui veuille dire quelque chose pour un retour : la
--     transition `confirmed → delivered` existe pour la table entière (E4-01)
--     et ne fait rien ici. Elle n'ouvre aucun trou — le registre de la RÈGLE
--     M3-9 compte `confirmed` **et** `delivered` — et un garde de plus par type
--     coûterait une phrase pour un geste que rien ne propose.
-- ============================================================================


-- ============================================================================
-- 1. Un retour est lié à un bon existant
--
-- Deux pièces, et elles ne se recouvrent pas :
--
--   — la **chaîne** dit de quoi un retour peut être issu. Elle vit en données
--     depuis E4-05, donc un test l'énumère et le garde la lit ;
--   — le **`check`** dit qu'un retour ne peut pas être issu de *rien*. Le garde
--     de chaîne ne se déclenche que si `source_document_id` est posé (c'est la
--     condition de son trigger) : sans ce `check`, un retour sans origine passe
--     tout, rend du stock qu'aucun bon n'a livré, et ne rend compte à personne.
--
-- `23514` (*check_violation*), rendu **400** et mesuré (§ 4). Une contrainte
-- plutôt qu'une fonction : la propriété ne regarde qu'une seule ligne, et une
-- contrainte ne se contourne par aucun chemin.
-- ============================================================================

insert into merx.document_transformation (source_type, target_type) values
  ('delivery_note', 'return');

alter table public.sale_document
  add constraint sale_document_return_has_source
  check (doc_type <> 'return' or source_document_id is not null);

comment on constraint sale_document_return_has_source on public.sale_document is
  'Un retour est toujours issu d''un bon de livraison — SPEC § 8, RÈGLE M3-9. '
  'Le garde de chaîne ne parle que si source_document_id est posé ; ce check '
  'est ce qui interdit un retour sans origine. E4-06.';

comment on column public.sale_document.notes is
  'Note libre du document. Sur un retour, c''est le **motif** — saisissable, '
  'jamais obligatoire (critère d''E4-06) : un motif codifié n''aurait de sens '
  'que pour un type sur quatre, et rien en V1 ne compte les retours par motif. '
  'L''écran l''étiquette « Motif du retour ». E4-06.';


-- ============================================================================
-- 2. Le papier : `RT-A-26-00001`
--
-- La séquence est par `(commerce, appareil, doc_type, année)` : le retour a
-- donc son propre compteur sans qu'une ligne soit ajoutée à
-- `document_sequence`, et son trigger de constat (`advance_document_sequence`,
-- E4-02) le suit tel quel. Le serveur n'attribue toujours rien.
--
-- Les deux fonctions sont reprises de leur **dernière** définition, lue au
-- catalogue (`pg_get_functiondef`) et non du fichier qui les a créées : un
-- `create or replace` remplace la fonction entière, et ce qu'une migration
-- ultérieure aurait ajouté et qu'on ne recopie pas disparaît sans erreur
-- (CLAUDE.md, E3-02).
-- ============================================================================

create or replace function merx.doc_type_code(doc_type public.sale_doc_type)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case doc_type
           when 'quote'         then 'DV'
           when 'order'         then 'CM'
           when 'delivery_note' then 'BL'
           when 'return'        then 'RT'
         end
$function$;

comment on function merx.doc_type_code(public.sale_doc_type) is
  'Le code du type dans un numéro de document : DV, CM, BL, RT. RÈGLE M3-2 ; '
  'E4-02, RT en E4-06. Comparé au code du front par '
  'document-numbering.test.ts, sur les étiquettes lues au catalogue.';


create or replace function merx.require_document_number_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  expected_prefix public.device_prefix;
  expected_year   smallint;
begin
  if new.doc_number is null then
    return new;
  end if;

  -- Code de type, lettre, deux chiffres d'année, cinq de séquence.
  if new.doc_number !~ '^(DV|CM|BL|RT)-[A-Z]-[0-9]{2}-[0-9]{5}$' then
    raise exception
      'Numéro de document mal formé : « % ». Attendu BL-A-26-00001 — code du type, lettre de l''appareil, année, cinq chiffres.',
      new.doc_number
      using errcode = '22023';
  end if;

  if substring(new.doc_number from 1 for 2) <> merx.doc_type_code(new.doc_type) then
    raise exception
      'Le numéro « % » n''est pas celui du type % : son code devrait être %.',
      new.doc_number, new.doc_type, merx.doc_type_code(new.doc_type)
      using errcode = '22023';
  end if;

  select d.prefix into expected_prefix
  from public.device d
  where d.tenant_id = new.tenant_id and d.id = new.device_id;

  -- `expected_prefix` est une étiquette de l'enum `public.device_prefix` (E1-03,
  -- et c'est ce qui permet au balayage d'isolation de remplir la colonne) : la
  -- comparaison passe par son texte, le sens inverse jetterait sur une lettre
  -- hors de l'enum avant que la branche de forme ait pu parler.
  if substring(new.doc_number from 4 for 1) <> expected_prefix::text then
    raise exception
      'Le numéro « % » n''est pas celui de cet appareil : sa lettre est %. Deux appareils ne partagent jamais une lettre.',
      new.doc_number, expected_prefix
      using errcode = '22023';
  end if;

  if new.issued_at is not null then
    expected_year := merx.document_number_year(new.issued_at);
    if substring(new.doc_number from 6 for 2) <> to_char(expected_year % 100, 'FM00') then
      raise exception
        'Le numéro « % » ne porte pas l''année de sa date d''émission (%).',
        new.doc_number, expected_year
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

comment on function merx.require_document_number_shape() is
  'Trigger BEFORE INSERT OR UPDATE : un numéro de document dit la vérité sur '
  'sa ligne — type, appareil, année. Quatre branches, quatre phrases, 22023. '
  'RÈGLE M3-2 ; E4-02, RT ajouté en E4-06.';


-- ============================================================================
-- 3. RÈGLE M3-9 — on ne rend jamais plus que le bon n'a livré
--
-- Contrairement au reste à livrer d'E4-05 — où rien ne compare les quantités
-- d'un enfant à celles de son parent, et où une commande de 100 peut donner
-- deux bons de 100 —, l'excès **crée** ici deux choses à partir de rien : du
-- stock, et un avoir. Un bon de trop est une erreur de gestion qui se voit sur
-- le papier ; un retour de trop est une fuite.
--
-- **À la confirmation, et là seulement.** C'est le moment où le stock et
-- l'avoir naissent, et le contenu se figeait déjà (RÈGLE M3-3). Un garde
-- permanent sur `sale_line` refuserait de surcroît le brouillon lui-même, qui
-- s'écrit avant ses lignes (E4-03) — même raisonnement que
-- `merx.require_consistent_totals()` (E4-04), et le nom range celui-ci après
-- `reject_frozen_update` dans l'ordre alphabétique, donc après le gel.
--
-- **Deux branches, deux phrases**, parce que l'excès crée deux choses :
--
--   — la **quantité** : Σ lignes du retour ≤ Σ lignes du bon − Σ déjà rendu ;
--   — l'**avoir** : Σ `line_total` du retour ≤ Σ d'origine − Σ déjà crédité.
--     Sans elle, un `POST` crédite 1 000 DH pour une pièce vendue 9 DH, et la
--     première branche ne voit rien passer. C'est la borne du choix fait plus
--     haut de tenir le registre par variante et non par ligne d'origine : un
--     plafond, jamais une égalité, donc aucun retour légitime n'est refusé.
--
-- **Ce qui compte comme « déjà rendu »** : les retours du **même** bon au
-- statut `confirmed` ou `delivered`. Pas les brouillons — un retour abandonné
-- bloquerait le bon pour toujours ; pas les annulés — leur stock est reparti, et
-- leur avoir sera contre-écrit (RÈGLE M4-2, E6-02).
--
-- ----------------------------------------------------------------------------
-- Deux retours qui se croisent
--
-- Les deux brouillons sont invisibles l'un à l'autre, et deux confirmations
-- simultanées liraient chacune un registre où l'autre n'est pas : les deux
-- passeraient, et la somme dépasserait. Le garde prend donc, **avant de
-- compter**, un verrou de ligne sur le **bon d'origine** — une ligne que les
-- deux retours doivent traverser, et une seule.
--
--   — le bon est figé depuis sa confirmation (RÈGLE M3-3) : rien d'autre ne le
--     met à jour, donc le verrou ne gêne personne — sauf son **annulation**,
--     qui est un UPDATE sur cette même ligne. C'est voulu : un retour qui se
--     confirme et une annulation qui passe ne doivent pas se croiser (§ 5
--     ci-dessous) ;
--   — en READ COMMITTED, la seconde transaction attend le commit de la
--     première, puis ses instructions suivantes prennent un instantané neuf :
--     elle **voit** le retour confirmé et refuse l'excès. Même raisonnement que
--     le `for share` de `merx.reject_frozen_child_write()` (E4-01) ;
--   — et ce n'est **pas mesuré** : il faut deux connexions entrelacées, ce que
--     le harnais ne sait pas faire. Troisième ligne de la même famille (E4-01,
--     E4-02), inscrite à `docs/PENDING-CHECKS.md` et rattachée au même harnais,
--     noté en E9-03. Ce qui est mesuré : deux retours **successifs** dont le
--     second dépasse, le retour annulé qui libère son registre, le brouillon
--     qui ne le consomme pas.
--
-- `PT400` — « demande impossible à satisfaire », dont les trois chiffres *sont*
-- le statut (§ 4, RÈGLE des refus en 4xx). Pas `22023` : la quantité est bien
-- formée, c'est le registre du bon qui ne la permet pas.
--
-- `security definer`, et elle vit dans `merx` : la règle « exception nommée » de
-- `conventions.ts` ne balaye que les fonctions de `public`, les seules que
-- PostgREST expose. Celle-ci n'est appelable par personne — elle s'exécute dans
-- une écriture qui a déjà passé la policy de sa table — et ne lit que les lignes
-- de `new.tenant_id`, que le `with check` de `tenant_isolation` a déjà forcé au
-- commerce du jeton. Invoker, elle cesserait de voir, donc de garder, en
-- silence (même raison qu'E4-04 pour `require_floor_price`). Le trou résiduel —
-- une fonction definer de `merx` qui oublierait ce filtre — est relevé à
-- BACKLOG E0-03 ; le fermer demande d'étendre la règle à `merx` et de ranger
-- cinq fonctions existantes, ce qui est une story, pas un passager de celle-ci.
-- ============================================================================

create function merx.require_returnable_quantity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  excess record;
  label  text;
begin
  -- Le verrou : la ligne que deux retours concurrents doivent traverser. Rien
  -- n'est lu de l'original — seul son verrou compte ici.
  perform 1
  from public.sale_document d
  where d.tenant_id = new.tenant_id
    and d.id = new.source_document_id
  for update;

  with mine as (
    select l.variant_id,
           sum(l.quantity)   as quantity,
           sum(l.line_total) as amount
    from public.sale_line l
    where l.tenant_id = new.tenant_id
      and l.sale_document_id = new.id
    group by l.variant_id
  ),
  delivered as (
    select l.variant_id,
           sum(l.quantity)   as quantity,
           sum(l.line_total) as amount
    from public.sale_line l
    where l.tenant_id = new.tenant_id
      and l.sale_document_id = new.source_document_id
    group by l.variant_id
  ),
  already_returned as (
    -- Les retours déjà faits sur le **même** bon, celui-ci exclu.
    select l.variant_id,
           sum(l.quantity)   as quantity,
           sum(l.line_total) as amount
    from public.sale_document r
    join public.sale_line l
      on l.tenant_id = r.tenant_id
     and l.sale_document_id = r.id
    where r.tenant_id = new.tenant_id
      and r.source_document_id = new.source_document_id
      and r.doc_type = 'return'
      and r.id <> new.id
      and r.status in ('confirmed', 'delivered')
    group by l.variant_id
  )
  select m.variant_id,
         m.quantity as asked,
         m.amount   as credited,
         coalesce(d.quantity, 0) - coalesce(p.quantity, 0) as quantity_left,
         coalesce(d.amount, 0)   - coalesce(p.amount, 0)   as amount_left
  into excess
  from mine m
  left join delivered d on d.variant_id = m.variant_id
  left join already_returned p on p.variant_id = m.variant_id
  where m.quantity > coalesce(d.quantity, 0) - coalesce(p.quantity, 0)
     or m.amount   > coalesce(d.amount, 0)   - coalesce(p.amount, 0)
  order by m.variant_id
  limit 1;

  if not found then
    return new;
  end if;

  -- La variante se nomme dans la phrase, et la jointure n'est payée que sur le
  -- chemin du refus : un retour qui passe ne la lit pas.
  select coalesce(v.sku, p.code, p.name_fr) into label
  from public.variant v
  join public.product p on p.tenant_id = v.tenant_id and p.id = v.product_id
  where v.tenant_id = new.tenant_id and v.id = excess.variant_id;

  if excess.asked > excess.quantity_left then
    raise exception
      'Ce retour rend plus que le bon n''a livré : % pour % de « % » encore retournable.',
      excess.asked, excess.quantity_left, coalesce(label, '?')
      using errcode = 'PT400',
            hint = 'Les retours déjà enregistrés sur ce bon sont déduits.';
  end if;

  raise exception
    'Ce retour crédite plus que le bon n''a facturé : % DH pour % DH encore à l''avoir sur « % ».',
    excess.credited, excess.amount_left, coalesce(label, '?')
    using errcode = 'PT400',
          hint = 'Le prix d''une ligne de retour est celui du bon d''origine.';
end;
$function$;

comment on function merx.require_returnable_quantity() is
  'Trigger BEFORE UPDATE sur la confirmation d''un retour : ni plus de '
  'quantité, ni plus d''avoir que le bon d''origine n''en portait, retours '
  'précédents déduits. Deux branches, deux phrases, PT400 rendu 400. Verrou '
  'for update sur le bon, pour que deux retours ne se croisent pas. '
  'SPEC § 8, RÈGLE M3-9 ; E4-06.';

create trigger require_returnable_quantity
  before update on public.sale_document
  for each row
  when (old.status = 'draft' and new.status = 'confirmed'
        and new.doc_type = 'return')
  execute function merx.require_returnable_quantity();


-- ============================================================================
-- 4. Le mouvement `return` — la forme d'E4-05, pièce pour pièce
--
-- Le stock revient **à la confirmation du retour**, jamais au brouillon : même
-- partage que la RÈGLE M3-5 pour la vente. La condition de type vit dans le
-- `when` du trigger, donc au catalogue où elle se lit, et non dans un `if` du
-- corps qu'on retirerait sans que rien ne le dise.
--
-- `quantity` est **positive** : le retour entre. `source_type`/`source_id`
-- désignent le document — c'est par là que `merx.reverse_sale_movements()`
-- retrouve ce qu'il faut inverser si le retour est annulé. `device_id` est celui
-- du document : l'appareil qui a pris le retour, pas celui qui synchronise.
--
-- `security invoker` — le défaut, et il est voulu : la policy
-- `column_capability_insert` et `merx.require_open_movement_type()`
-- s'appliquent à celui qui confirme. Un retour qui ne peut pas écrire ses
-- mouvements échoue **entier**.
-- ============================================================================

create function merx.write_return_movements()
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
         'return'::public.stock_movement_type,
         l.quantity,
         'sale_document'::public.stock_source_type, new.id,
         new.device_id,
         'Retour ' || coalesce(new.doc_number, 'sans numéro')
  from public.sale_line l
  where l.tenant_id = new.tenant_id
    and l.sale_document_id = new.id;

  return null;
end;
$function$;

comment on function merx.write_return_movements() is
  'Trigger AFTER UPDATE sur la confirmation d''un retour : un mouvement return '
  'positif par ligne. Invoker — la RLS et la capacité du type s''appliquent. '
  'Aucun autre type de document n''y passe, par la condition du trigger. '
  'SPEC § 7, addendum E4-06 ; E4-06.';

create trigger write_return_movements
  after update on public.sale_document
  for each row
  when (old.status = 'draft' and new.status = 'confirmed'
        and new.doc_type = 'return')
  execute function merx.write_return_movements();


-- ----------------------------------------------------------------------------
-- Le mouvement de retour ne s'écrit pas à la main
--
-- La forme de `merx.require_sale_origin()` (E4-05) et de
-- `merx.require_cancellation_origin()` (E4-01), pour la même raison : `return`
-- s'ouvre sur `create_sale`, donc la policy laisse passer les deux rôles. Une
-- porte simplement ouverte serait un `POST` de mouvements sans écran — un
-- employé poserait du stock de n'importe quelle quantité, sans document, sans
-- bon d'origine à qui rendre compte, et **sans entrée de journal**.
--
-- AFTER, et non BEFORE : la RLS d'une insertion est vérifiée entre les deux, et
-- un garde BEFORE refuserait avant elle — le test de la policy passerait alors
-- sur le refus de celui-ci (E3-01).
--
-- `42501` comme la policy, et **sa propre phrase** : ni celle de la vente, ni
-- celle de l'annulation. C'est à elle qu'un test voit lequel des trois gardes a
-- refusé (CLAUDE.md, E1-02).
-- ----------------------------------------------------------------------------

create function merx.require_return_origin()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if pg_catalog.pg_trigger_depth() < 2 then
    raise exception
      'Un mouvement de type return ne s''écrit pas à la main : il naît de la '
      'confirmation de son bon de retour.'
      using errcode = '42501',
            hint = 'Enregistrer le retour depuis le bon de livraison d''origine.';
  end if;

  return null;
end;
$function$;

comment on function merx.require_return_origin() is
  'Trigger AFTER INSERT sur un mouvement return : refuse toute insertion '
  'directe. Sans lui, create_sale serait un POST de stock sans écran et sans '
  'bon d''origine. pg_trigger_depth(), comme merx.require_sale_origin(). E4-06.';

create trigger require_return_origin
  after insert on public.stock_movement
  for each row
  when (new.movement_type = 'return')
  execute function merx.require_return_origin();


-- ----------------------------------------------------------------------------
-- Le registre des écrivains, et le type ouvert
--
-- `pg_trigger_depth()` sait qu'un trigger écrit, pas lequel : le registre est
-- ce qui ferme la porte, et la règle `aucun écrivain de mouvement non déclaré`
-- de `conventions.ts` nomme toute autre fonction qui insère dans
-- `stock_movement`. Rien à ajouter à cette règle — elle ne lit aucun littéral
-- de type, elle demande qui insère (E4-05).
--
-- `return` s'ouvre sur `create_sale`, la capacité annoncée par l'addendum
-- E4-01 : les quatre copies de la matrice ne bougent pas. `receipt` (E8-02) et
-- `inventory` (E3-04) restent fermés.
-- ----------------------------------------------------------------------------

insert into merx.movement_writer (function_name, movement_type) values
  ('write_return_movements', 'return');

insert into merx.movement_type_capability (movement_type, capability) values
  ('return', 'create_sale');


-- ============================================================================
-- 5. L'annulation, des deux côtés du lien
--
-- **Un retour annulé rend ce qu'il avait rendu.** Un retour étant un document
-- de vente, il est annulable depuis E4-01 par `merx.require_cancel_capability()`
-- — mais `merx.reverse_sale_movements()` ne filtrait que `movement_type =
-- 'sale'` : le document passait à `cancelled` et le stock restait crédité. Elle
-- inverse désormais **les mouvements qu'une confirmation a écrits**, `sale` ou
-- `return`, en `sale_cancellation`.
--
-- Le filtre reste un filtre, et c'est ce qui compte : un `sale_cancellation` ne
-- se réinverse jamais. L'étiquette, elle, s'élargit — « l'inverse de ce qu'une
-- confirmation avait écrit » — et c'est écrit à SPEC § 7, addendum E4-06. Un
-- septième type `return_cancellation` aurait coûté un label, deux migrations, un
-- garde d'origine, une entrée au registre et une ligne de capacité pour une
-- seule différence : le signe.
--
-- Reprise de sa **dernière** définition lue au catalogue (CLAUDE.md, E3-02).
--
-- ----------------------------------------------------------------------------
-- **Un bon qui a un retour vivant ne s'annule pas**, et c'est un trou que le
-- choix du type ouvrait :
--
--   un bon de 10 est confirmé (−10) ; on en rend 3 (+3) ; le bon est annulé, et
--   l'inversion de ses mouvements `sale` rend +10. Le stock finit à **+3 de
--   trop** : les pièces rendues sont comptées deux fois, et l'avoir du retour
--   survit à une vente qui n'existe plus.
--
-- Le refus, plutôt qu'une annulation en cascade : annuler les retours d'office
-- déciderait à la place du patron, et une cascade d'annulations est exactement
-- ce que l'ajout seul refuse (RÈGLE M2-2 — une correction est une écriture, pas
-- un effacement). Il annule donc ses retours, puis son bon, et chaque geste
-- laisse sa trace et son motif.
--
-- **Le verrou du § 3 sert ici aussi** : l'annulation est un UPDATE sur la ligne
-- du bon, donc elle attend le `for update` qu'un retour en cours de confirmation
-- détient, et réciproquement. Les deux ne peuvent pas se croiser — non mesuré,
-- même harnais, même ligne de `PENDING-CHECKS.md`.
--
-- `PT409`, rendu **409** : l'état d'une ligne voisine interdit l'écriture,
-- exactement le sens que la famille porte déjà pour les tables figées (§ 4). La
-- phrase **nomme le retour en cause** — un patron qui lit « annulez d'abord vos
-- retours » sans savoir lesquels n'a rien appris.
-- ----------------------------------------------------------------------------

create or replace function merx.reverse_sale_movements()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.stock_movement (
    tenant_id, variant_id, warehouse_id, movement_type, quantity,
    source_type, source_id, note
  )
  select m.tenant_id, m.variant_id, m.warehouse_id,
         'sale_cancellation'::public.stock_movement_type,
         - m.quantity,
         m.source_type, m.source_id,
         'Annulation de ' || coalesce(new.doc_number, 'ce document')
           || ' : ' || new.cancellation_reason
  from public.stock_movement m
  where m.tenant_id = new.tenant_id
    and m.source_type = 'sale_document'
    and m.source_id = new.id
    and m.movement_type in ('sale', 'return');

  return null;
end;
$function$;

comment on function merx.reverse_sale_movements() is
  'Trigger AFTER UPDATE sur la transition vers cancelled : écrit l''inverse de '
  'chaque mouvement que la confirmation du document avait écrit — sale pour un '
  'bon, return pour un retour. Invoker — la RLS et la capacité du type '
  's''appliquent. RÈGLE M3-3, E4-01 ; élargie en E4-06.';


create function merx.require_no_active_return()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  blocking text;
begin
  select coalesce(r.doc_number, 'un retour encore en cours') into blocking
  from public.sale_document r
  where r.tenant_id = new.tenant_id
    and r.source_document_id = new.id
    and r.doc_type = 'return'
    and r.status in ('confirmed', 'delivered')
  order by r.doc_number
  limit 1;

  if blocking is null then
    return new;
  end if;

  raise exception
    'Ce bon porte un retour non annulé (%) : l''annuler rendrait une deuxième fois le stock déjà retourné.',
    blocking
    using errcode = 'PT409',
          hint = 'Annuler le retour d''abord, puis le bon.';
end;
$function$;

comment on function merx.require_no_active_return() is
  'Trigger BEFORE UPDATE sur l''annulation d''un bon de livraison : refuse si '
  'un retour confirmé non annulé en est issu — l''inversion des mouvements '
  'sale recréditerait un stock que le retour avait déjà rendu. PT409 rendu '
  '409, et la phrase nomme le retour. SPEC § 8, RÈGLE M3-9 ; E4-06.';

-- Le nom le range après `require_cancel_capability` dans l'ordre alphabétique :
-- un employé lit d'abord qu'il n'a pas le droit d'annuler, ce qui est la phrase
-- que l'utilisateur doit voir, et ce garde-ci ne parle qu'à qui peut annuler.
create trigger require_no_active_return
  before update on public.sale_document
  for each row
  when (old.status is distinct from new.status and new.status = 'cancelled'
        and new.doc_type = 'delivery_note')
  execute function merx.require_no_active_return();


-- ============================================================================
-- 6. Le plancher ne gouverne pas un avoir — RÈGLE M3-8, exception écrite
--
-- Le prix d'une ligne de retour est celui du papier d'origine : c'est ce que le
-- client a payé, et c'est ce qu'on lui rend. `merx.require_floor_price()` est
-- posé sur `sale_line` sans regarder le document : sans cette sortie-ci, un
-- retour d'un bon ancien, passé sous un plancher relevé depuis, serait refusé
-- en `42501` — un refus de vente appliqué à un remboursement.
--
-- **Le même `select`, pas un aller-retour de plus.** Le garde tourne sur chaque
-- ligne du chemin des dix lignes au comptoir (SPEC § 10, point de rupture n° 2) :
-- `doc_type` est lu par une jointure dans la requête qui lisait déjà
-- `floor_price`, donc le coût ne change pas. Une jointure interne, comme
-- aujourd'hui : document ou variante absents, rien n'est trouvé, le garde
-- laisse passer et ce sont les clés étrangères qui refusent en fin
-- d'instruction — exactement le comportement d'avant.
--
-- Reprise de sa dernière définition lue au catalogue (CLAUDE.md, E3-02).
-- ============================================================================

create or replace function merx.require_floor_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  floor_price public.money_amount;
  doc_type    public.sale_doc_type;
begin
  select v.floor_price, d.doc_type into floor_price, doc_type
  from public.variant v
  join public.sale_document d
    on d.tenant_id = new.tenant_id
   and d.id = new.sale_document_id
  where v.tenant_id = new.tenant_id
    and v.id = new.variant_id;

  -- Un retour rend le prix du papier : le plancher du jour ne s'y applique pas.
  if doc_type = 'return' then
    return new;
  end if;

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
  'price_source — sinon le contrôle se contourne en posant auto. Ne vaut pas '
  'sur un retour, qui rend le prix du bon d''origine (E4-06). SPEC § 3.1, '
  'astérisque du plancher ; E4-04.';
