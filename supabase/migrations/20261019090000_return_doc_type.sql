-- ============================================================================
-- Merx — `return`, quatrième type de document de vente
--
-- Référence : docs/SPEC.md § 8 (liste des entités, RÈGLES M3-2, M3-4, M3-9) ;
--             docs/BACKLOG.md E4-06.
--
-- **Une étiquette de plus, et non une table à part.** SPEC § 8 nommait
-- `return_document` + `return_line` sans une seule colonne : une intention, pas
-- une décision. L'inventaire de ce que chaque voie oblige à refaire a tranché
-- en E4-06, et il est écrit à SPEC § 8 — ici, le résumé :
--
--   — `document_sequence` est clé par `(commerce, appareil, doc_type, année)`,
--     et `doc_type` est de ce type-ci. Une table à part exigeait une **seconde
--     table dérivée**, son trigger, son écrivain au registre, sa seconde
--     unicité, et une seconde borne à lire par l'appareil — jusque dans la base
--     locale d'E9 ;
--   — cinq fonctions de numérotation sont typées `public.sale_doc_type` ou
--     posées sur `sale_document` : à dupliquer ou à rendre génériques ;
--   — le gel (RÈGLE M3-3), les totaux (`line_total` engendrée,
--     `total_consistent`, `require_consistent_totals`), l'annulation et son
--     motif obligatoire, l'entrée `document_cancellation` au journal : tout
--     vaut déjà pour la table, et rien n'en vaudrait pour une autre ;
--   — `source_document_id` **est** le « retour lié à un bon existant » du
--     premier critère, avec sa clé composite, son index partiel, et un garde de
--     chaîne qui refuse déjà un original brouillon, annulé, ou d'un autre type.
--
-- Le prix de l'étiquette, et il est payé ici : la table des codes de type a
-- quatre copies (`merx.doc_type_code()`, le motif de
-- `merx.require_document_number_shape()`, `DOC_TYPE_CODES` de
-- `src/modules/sales/documentNumber.ts`, `TRANSFORM_TARGET` de `transform.ts`),
-- et `document-numbering.test.ts` énumère les étiquettes **lues au catalogue** :
-- la suite rougit d'elle-même jusqu'à ce que les copies soient à jour. C'est la
-- propriété qu'E4-02 avait construite pour un quatrième type, et c'est ce
-- quatrième type.
--
-- ----------------------------------------------------------------------------
-- Pourquoi une migration pour une seule ligne
--
-- Une valeur d'enum n'est pas utilisable dans la transaction qui la crée : le
-- `when` d'un trigger, un `insert` dans `merx.document_transformation` ou un
-- `case` qui la nomme échoueraient. Même découpage qu'E4-01 pour
-- `sale_cancellation`. La suite est dans `20261019100000_returns.sql`.
--
-- L'étiquette s'ajoute **en dernier** : `supabase/tests/isolation.ts` peuple une
-- colonne enum avec sa **première** étiquette, et une ligne de peuplement doit
-- rester un devis ordinaire — un retour, lui, exige un bon d'origine
-- (`sale_document_return_has_source`).
-- ============================================================================

alter type public.sale_doc_type add value 'return';

comment on type public.sale_doc_type is
  'Les quatre types de document de vente : devis, commande, bon de livraison '
  '— le document par défaut, RÈGLE M3-1 — et retour, ajouté en E4-06. Aucune '
  'facture fiscale en V1. Un retour est un document de vente parce que tout ce '
  'qui fait un document — le gel, la numérotation locale, la filiation, '
  'l''annulation, la cohérence des totaux — vaut pour lui mot pour mot. '
  'SPEC § 8.';
