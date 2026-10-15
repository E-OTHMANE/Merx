-- ============================================================================
-- Merx — la numérotation locale des documents : BL-A-26-00001
--
-- Référence : docs/SPEC.md § 2.5 (RÈGLE numérotation, un appareil par
--             commerce), § 4 (conventions, clés composites, RÈGLE des refus en
--             4xx), § 6 (la leçon du SKU engendré, E2-06), § 8 (RÈGLE M3-2) ;
--             docs/BACKLOG.md E4-02.
--
-- RÈGLE M3-2 — le numéro est attribué **par l'appareil**, à la confirmation.
-- Le serveur n'attribue rien : une tablette doit pouvoir sortir un bon après
-- sept jours sans réseau (§ 2.5), et un numéro qu'il faudrait demander ne
-- s'obtiendrait pas. C'est ce qui rend E9 possible, et c'est pour cela qu'on ne
-- met ici aucune fonction d'attribution, aucune séquence Postgres, aucun
-- `default`.
--
-- Le serveur ne fait donc qu'une chose, et il la fait entièrement : **il refuse
-- ce qui est faux**. Trois gardes, trois phrases, trois codes — et aucun ne
-- refuse comme un autre, sans quoi le test de l'un passerait sur le refus du
-- voisin (CLAUDE.md ; E1-01, E1-02, E2-01, E3-01) :
--
--   `sale_document_number_per_tenant`     deux papiers d'un même commerce ne
--   index unique                          portent jamais le même numéro.
--                                         **L'autorité** : aucun chemin
--                                         d'écriture ne lui échappe, pas même
--                                         la synchronisation d'E9. `23505`,
--                                         rendu 409.
--
--   `merx.require_document_number_shape`  le numéro **dit la vérité sur sa
--   trigger, quatre branches               ligne** : son code est celui du
--                                         type, sa lettre celle de
--                                         `device_id`, son année celle
--                                         d'`issued_at`. `22023`, rendu 400.
--
--   `sale_document_number_when_numbered`  numéro et date nuls tant que
--   `sale_document_issued_at_when_numbered` brouillon, posés dès la
--   contraintes de contrôle                confirmation. `23514`, rendu 400.
--
-- Pourquoi le garde de forme est indispensable, et pas une politesse : la
-- lettre est ce qui sépare deux appareils. Si l'appareil A pouvait écrire
-- `BL-B-26-00001`, il prendrait un numéro que l'appareil B, hors ligne,
-- imprimera légitimement — et c'est **B** que l'unicité refuserait, des jours
-- plus tard, sur un papier déjà remis à un client. On ne renumérote pas un
-- papier signé (E1-03 dit la même chose du recyclage d'une lettre).
--
-- ----------------------------------------------------------------------------
-- Le format, tranché ici : `BL-A-26-00001`
--
-- E4-01 avait relevé que `BL-A-0001` ne porte pas l'année alors que la séquence
-- est annuelle : le premier bon de 2027 aurait été le texte du premier bon de
-- 2026. L'année entre donc dans le numéro, et M3-2 garde sa séquence annuelle.
--
-- Année sur **deux** chiffres : le numéro se dit au comptoir et au téléphone, et
-- `BL-A-26-00001` en fait douze caractères contre quinze. Le siècle n'est jamais
-- en doute sur un bon de livraison qu'un grossiste garde ; et l'ordre du texte
-- n'est jamais comparé qu'à l'intérieur d'une même année, puisque l'année est
-- dans la clé de la séquence.
--
-- Séquence sur **cinq** chiffres, largeur fixe. Quatre plafonnent à 9 999 bons
-- par an et par appareil, qu'un grossiste à 40 bons/jour dépasse ; et la largeur
-- fixe est ce qui fait que l'ordre du texte est l'ordre des nombres — la même
-- raison qu'`A-00001` en E2-06.
--
-- L'année est celle d'`issued_at` **lue en `Africa/Casablanca`** (§ 4) : un bon
-- émis le 31 décembre à 23 h 30 porte l'année que le commerçant a vécue, pas
-- celle d'UTC.
--
-- ----------------------------------------------------------------------------
-- Ce qui n'est pas ici
--
--   — **aucune unicité par `(appareil, type, année)`.** L'unicité porte sur le
--     texte entier, qui contient déjà ces trois-là. Elle est plus large et c'est
--     ce qu'on veut dire : dans ce commerce, ce numéro-ci n'existe qu'une fois.
--
--   — **aucune contrainte « sans trou ».** Une séquence sans trou n'est pas une
--     propriété qu'une contrainte de base puisse tenir — il faudrait lire la
--     ligne précédente à chaque écriture, donc sérialiser les confirmations du
--     commerce. Elle est tenue par la façon dont l'appareil choisit le numéro
--     (le brouillon n'en consomme aucun) et éprouvée par le test des 100
--     documents. Après une collision, un numéro est enjambé : BACKLOG E4-02 le
--     dit maintenant, et c'est un arbitrage, pas un oubli — un trou se retrouve,
--     un doublon imprimé ne se répare pas.
-- ============================================================================


-- ============================================================================
-- Les trois codes de type
--
-- Une seule copie en base, et `src/modules/sales/numbering.ts` en tient la
-- sienne pour l'appareil — `document-numbering.test.ts` les compare étiquette
-- par étiquette, les étiquettes lues au catalogue. Un quatrième type de
-- document ferait rougir la suite au lieu de sortir un numéro muet.
--
-- `DV` devis, `CM` commande, `BL` bon de livraison : les lettres que le
-- commerçant lit, en français, sur son papier.
-- ============================================================================

create function merx.doc_type_code(doc_type public.sale_doc_type)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case doc_type
           when 'quote'         then 'DV'
           when 'order'         then 'CM'
           when 'delivery_note' then 'BL'
         end
$function$;

comment on function merx.doc_type_code(public.sale_doc_type) is
  'Le code du type dans un numéro de document : DV, CM, BL. RÈGLE M3-2 ; '
  'E4-02. Comparé au code du front par document-numbering.test.ts.';


-- ----------------------------------------------------------------------------
-- L'année d'un numéro, et le numéro d'un texte
--
-- Deux fonctions minuscules, et une seule copie de chacune : le garde de forme
-- et la borne de la séquence s'en servent tous les deux, et un décalage entre
-- eux ne se verrait pas — il se lirait comme un numéro refusé au hasard.
-- ----------------------------------------------------------------------------

create function merx.document_number_year(issued_at timestamptz)
returns smallint
language sql
stable
set search_path = ''
as $function$
  select extract(year from (issued_at at time zone 'Africa/Casablanca'))::smallint
$function$;

comment on function merx.document_number_year(timestamptz) is
  'L''année d''un numéro de document, lue en Africa/Casablanca (SPEC § 4) : un '
  'bon émis le 31 décembre à 23 h 30 porte l''année du commerçant. E4-02.';

create function merx.document_number_sequence(doc_number text)
returns integer
language sql
immutable
set search_path = ''
as $function$
  select substring(doc_number from '([0-9]{5})$')::integer
$function$;

comment on function merx.document_number_sequence(text) is
  'Les cinq chiffres de séquence d''un numéro de document, ou NULL si le texte '
  'n''en porte pas. E4-02.';


-- ============================================================================
-- `sale_document.device_id` — la clé du numéro, plus seulement l'appareil
--                             qui a écrit la ligne
--
-- Les conventions posent `device_id` nullable sur toute table (§ 4). Ici la
-- colonne porte la lettre du numéro : sans elle, le garde de forme n'a rien à
-- comparer, et un document naîtrait numérotable par n'importe quelle lettre.
-- Elle passe donc NOT NULL, et reçoit sa clé composite — un numéro préfixé par
-- un appareil qui n'existe pas dans ce commerce n'a aucun sens, et une clé sans
-- `tenant_id` laisserait désigner l'appareil du voisin (§ 4, RÈGLE des clés
-- composites). Même forme que `document_sequence.device_id` en E4-01.
-- ============================================================================

alter table public.sale_document
  alter column device_id set not null;

alter table public.sale_document
  add constraint sale_document_device_id_fkey
  foreign key (tenant_id, device_id) references public.device (tenant_id, id);


-- ============================================================================
-- Numéro et date : nuls tant que brouillon, posés dès la confirmation
--
-- SPEC § 8 : « `doc_number` et `issued_at` sont nuls tant que le document est
-- un brouillon ». Les deux sens comptent, et c'est pourquoi la contrainte est
-- une équivalence et non un simple `not null` conditionnel :
--
--   nul tant que brouillon   — un brouillon qui réserverait son numéro puis
--                              serait abandonné laisserait un trou dans la
--                              séquence (§ 4, corrigé en E4-01). C'est la
--                              moitié qui tient le critère « aucun trou » ;
--   posé dès la confirmation — un document confirmé sans numéro ne se retrouve
--                              pas, et le numéro ne pourrait plus être écrit
--                              après coup : le contenu est figé (M3-3).
--
-- Deux contraintes et non une, chacune nommée : `23514` porte le nom de la
-- contrainte violée, donc un test peut dire laquelle a refusé — ce qu'un
-- `check` unique sur les deux colonnes ne permettrait pas.
-- ============================================================================

alter table public.sale_document
  add constraint sale_document_number_when_numbered
  check ((status = 'draft') = (doc_number is null));

alter table public.sale_document
  add constraint sale_document_issued_at_when_numbered
  check ((status = 'draft') = (issued_at is null));


-- ============================================================================
-- L'autorité : `sale_document_number_per_tenant`
--
-- Le compteur de l'appareil est une commodité ; cet index est ce qui garantit
-- l'unicité. Exactement le partage d'E2-06 pour le SKU engendré, et pour la
-- même raison : l'appareil choisit hors réseau, sans rien demander à personne,
-- donc c'est à l'écriture que la vérité se tranche.
--
-- `where doc_number is not null` : les brouillons n'en ont pas, et une unicité
-- qui les compterait refuserait le deuxième brouillon du commerce.
--
-- Partiel et non total aussi parce qu'il sert de borne : `document_sequence` est
-- ce que l'appareil lit (voir plus bas), mais la base locale d'E9, où aucune
-- RLS ne gêne, lira le plus grand numéro par cet index.
-- ============================================================================

create unique index sale_document_number_per_tenant
  on public.sale_document (tenant_id, doc_number)
  where doc_number is not null;

comment on index public.sale_document_number_per_tenant is
  'Un numéro n''est porté qu''une fois par commerce. L''autorité de la '
  'numérotation locale : l''appareil choisit, cet index tranche. RÈGLE M3-2 ; '
  'E4-02.';


-- ============================================================================
-- `merx.require_document_number_shape()` — le numéro dit la vérité sur sa ligne
--
-- Quatre branches, quatre phrases. Ce n'est pas du zèle : chacune ment
-- autrement, et un seul message pour les quatre rendrait trois d'entre elles
-- intestables — retirer une branche ne changerait rien qu'une assertion puisse
-- voir (CLAUDE.md, deux gardes sur le même chemin).
--
--   forme     le texte n'est pas un numéro de document ;
--   type      `CM-...` sur un bon de livraison ;
--   appareil  la lettre n'est pas celle de `device_id` — **la branche qui
--             tient le critère des deux appareils** ;
--   année     l'année ne suit pas `issued_at`.
--
-- `22023` — *invalid_parameter_value*, rendu 400 par PostgREST (SPEC § 4,
-- RÈGLE des refus en 4xx, et la liste mesurée de `refusalCodes.ts`). Le code
-- n'est pas détourné : c'est bien une valeur invalide qu'on refuse, et la
-- famille `PTxxx` n'a pas à servir là où Postgres dit déjà la chose.
--
-- `security definer` pour une seule raison, la même qu'en E3-01 pour
-- `merx.reject_derived_write()` : la fonction lit `public.device` pour comparer
-- la lettre. En invoker, un commerce dont la policy de `device` serait un jour
-- resserrée verrait ce garde refuser en `42501` — « permission denied » au lieu
-- de sa phrase, un refus qui ne dit pas qui refuse. La lecture ne fuit rien :
-- elle est faite sur `(tenant_id, device_id)` de la ligne, paire que la clé
-- composite ci-dessus force à être dans le commerce de la ligne.
--
-- L'année n'est comparée que si `issued_at` est posée : un numéro sans date est
-- le travail de `sale_document_issued_at_when_numbered`, qui refuse en `23514`
-- avec son nom. Un garde, une faute.
-- ============================================================================

create function merx.require_document_number_shape()
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
  if new.doc_number !~ '^(DV|CM|BL)-[A-Z]-[0-9]{2}-[0-9]{5}$' then
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
  'RÈGLE M3-2 ; E4-02.';

create trigger require_document_number_shape
  before insert or update on public.sale_document
  for each row execute function merx.require_document_number_shape();


-- ============================================================================
-- `document_sequence` devient une table **dérivée**
--
-- E4-01 l'avait posée sans fonction ni trigger, en écrivant que l'attribution
-- était E4-02. E4-02 ne lui donne pas un trigger qui *attribue* — il lui en
-- donne un qui *constate* : le plus grand numéro que l'appareil a réellement
-- écrit. Le serveur n'attribue donc toujours rien, et M3-2 est intacte.
--
-- Pourquoi dérivée, et non écrite par l'appareil :
--
--   — un compteur écrit à la main peut mentir, et il mentirait dans le seul
--     sens qui coûte : en arrière. Un appareil qui reposerait son compteur à
--     zéro réattribuerait des numéros déjà imprimés, et l'index refuserait les
--     écritures *suivantes* — celles d'un appareil qui, lui, n'a rien fait de
--     mal ;
--   — un compteur dérivé ne se contredit pas avec les documents : il *est* leur
--     maximum, par construction, et il ne peut pas reculer (`greatest`).
--
-- C'est aussi ce que l'appareil **lit** pour choisir son prochain numéro, et la
-- raison est mesurée, pas supposée (BACKLOG E4-02, et le test de plan de
-- `document-numbering.test.ts`) : sous la paire de policies de § 2.1,
-- `max(doc_number)` sur `sale_document` est un Seq Scan de toute la table, tous
-- commerces confondus — `textlike` n'est pas `leakproof`, donc aucun index ne
-- peut servir de condition sous une policy (CLAUDE.md, mesuré en E2-04). 493 ms
-- par appel sur 20 000 documents, 222 ms sur 10 000 : le coût suit l'historique
-- du commerce, sur le chemin d'une confirmation qu'un client attend au
-- comptoir. La forme par intervalle (`>=` / `<`, tous deux `leakproof`) emprunte
-- l'index — *parfois* : Seq Scan à 10 000 documents, Index Only Scan à 20 000.
-- Un plan qui bascule avec le volume n'est pas une base pour un chemin
-- d'écriture. La borne se lit donc dans `document_sequence`, une poignée de
-- lignes par commerce, dont le coût ne dépend d'aucun historique — 3,8 ms. Et
-- `max(doc_number)` reste la bonne lecture pour la base locale d'E9, où il n'y
-- a ni RLS ni voisin.
-- ============================================================================

create function merx.advance_document_sequence()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.doc_number is null then
    return null;
  end if;

  if tg_op = 'UPDATE' and old.doc_number is not distinct from new.doc_number then
    return null;
  end if;

  insert into public.document_sequence
    (tenant_id, device_id, doc_type, year, last_number, created_by)
  values
    (new.tenant_id, new.device_id, new.doc_type,
     merx.document_number_year(new.issued_at),
     merx.document_number_sequence(new.doc_number),
     new.created_by)
  on conflict (tenant_id, device_id, doc_type, year)
  -- Jamais en arrière : une confirmation en retard — un document posté hors
  -- ligne, remonté après un plus récent (E9) — ne doit pas faire reculer la
  -- borne, sinon l'appareil suivant réattribuerait un numéro déjà imprimé.
  do update set last_number = greatest(public.document_sequence.last_number,
                                       excluded.last_number);

  return null;
end;
$function$;

comment on function merx.advance_document_sequence() is
  'Trigger AFTER INSERT OR UPDATE sur sale_document : pose dans '
  'document_sequence le plus grand numéro écrit par l''appareil. Constate, '
  'n''attribue pas — RÈGLE M3-2. Seul écrivain déclaré de la table dérivée ; '
  'E4-02.';

create trigger advance_document_sequence
  after insert or update on public.sale_document
  for each row execute function merx.advance_document_sequence();

-- `security invoker`, comme l'agrégat de `stock_level` (E3-01) : la RLS de
-- `document_sequence` gouverne cette écriture comme n'importe quelle autre, et
-- l'appareil n'a aucun privilège de plus que son jeton. La table garde donc
-- INSERT et UPDATE accordés à `authenticated` — c'est pour cela que le garde de
-- ligne porte sur la ligne entière, et que `conventions.ts` interdit tout autre
-- écrivain : `pg_trigger_depth()` sait qu'un trigger écrit, pas lequel.
select merx.apply_derived_from(
  'public.document_sequence',
  'sale_document',
  'advance_document_sequence'
);

comment on table public.document_sequence is
  'La borne de la numérotation locale : le plus grand numéro écrit par '
  '(commerce, appareil, type, année). Dérivée — maintenue par '
  'merx.advance_document_sequence() sur sale_document, jamais écrite à la '
  'main. Le serveur ne l''attribue pas, il la constate. RÈGLE M3-2 ; posée en '
  'E4-01, dérivée en E4-02.';

comment on column public.sale_document.doc_number is
  'Nul tant que brouillon, posé par l''appareil à la confirmation — '
  'BL-A-26-00001, RÈGLE M3-2. Unique par commerce '
  '(sale_document_number_per_tenant), et conforme à sa ligne '
  '(merx.require_document_number_shape). E4-02.';

-- Le commentaire de `device.prefix` date d'E1-01 et montre l'ancien format.
-- Il vit dans le catalogue de la base, pas seulement dans un fichier : il se
-- corrige donc par une migration, comme le reste.
comment on column public.device.prefix is
  'Lettre unique par commerce, jamais recyclée, employée dans les numéros de '
  'document (BL-A-26-00001). SPEC § 2.5 et § 8, RÈGLE M3-2 ; format arrêté en '
  'E4-02.';
