-- ============================================================================
-- Merx — le sixième type de mouvement : l'annulation d'une vente
--
-- Référence : docs/SPEC.md § 7 (RÈGLE M2-5), § 8 (RÈGLE M3-3) ;
--             docs/BACKLOG.md E4-01.
--
-- Cette migration ne contient qu'une étiquette, pour la raison d'E3-03 : **une
-- valeur d'enum créée dans une transaction n'y est pas utilisable**. Ce qui
-- l'emploie — la correspondance type → capacité — vit dans la migration
-- suivante, `20261014100000_sale_documents.sql`.
--
-- Pourquoi un type neuf, et non `sale` ou `return`.
--
--   — `sale` et `return` s'ouvriront sur `create_sale` (E4-03, E4-05, E4-06),
--     parce que les employés les écrivent. Les ouvrir dès maintenant donnerait
--     à un employé un `POST` de mouvements de stock, de n'importe quel signe,
--     sans écran pour le justifier : exactement ce que M2-5 interdit (« tant
--     qu'aucun écran n'écrit un type, personne ne doit pouvoir en écrire un »).
--   — Les rattacher à `cancel_document` en attendant ferait mentir la matrice
--     sur ce qu'un droit gouverne, et il faudrait les rouvrir plus tard : même
--     objection qu'`adjust_stock` en E3-03.
--   — Un type n'a qu'une capacité (`merx.movement_type_capability`, clé
--     primaire sur le type). Annuler est un acte du patron ; vendre, un acte de
--     l'employé. Ce sont deux types.
--
-- `sale_cancellation` est le mouvement inverse d'un mouvement `sale` : même
-- variante, même dépôt, même document d'origine, quantité opposée. RÈGLE M2-2 —
-- une erreur se corrige par un mouvement inverse, jamais par UPDATE ou DELETE.
--
-- Placée en dernier, l'étiquette ne change pas ce que le balayage d'isolation
-- prend pour la valeur d'enum d'une ligne de peuplement : il lit la première,
-- `sale`, qui reste fermée.
-- ============================================================================

alter type public.stock_movement_type add value 'sale_cancellation';

comment on type public.stock_movement_type is
  'Les six types de mouvement : les cinq de SPEC § 7 M2, plus sale_cancellation '
  '(E4-01), l''inverse d''un mouvement sale quand son document est annulé. '
  'Chacun n''est écrivable que par la capacité que merx.movement_type_capability '
  'lui associe.';
