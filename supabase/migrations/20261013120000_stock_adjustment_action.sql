-- ============================================================================
-- Merx — la septième action auditée : l'ajustement manuel de stock
--
-- Référence : docs/SPEC.md § 9 (RÈGLE M8-1), § 7 M2 (RÈGLE M2-5) ;
--             docs/BACKLOG.md E3-03.
--
-- Cette migration ne contient qu'une étiquette, et c'est une contrainte de
-- Postgres, pas un choix de présentation : **une valeur d'enum créée dans une
-- transaction n'y est pas utilisable**. Or `merx.apply_audit()` reçoit son
-- action en `public.audit_action` et la transtype au moment de la migration.
-- Tout réunir dans un seul fichier échouerait sur « unsafe use of new value of
-- enum type ». Ce qui *emploie* l'étiquette vit donc dans la migration
-- suivante, `20261013130000_stock_adjustment.sql`.
--
-- Pourquoi une septième étiquette, et non le mouvement comme trace. Le critère
-- d'E3-03 dit « tracé dans `audit_log` », et `stock_movement` ne tient aucune
-- des trois propriétés de cette table-là : il est lu par tout le commerce
-- (`view_catalogue`), noyé parmi les mouvements de vente, et son `created_by`
-- vient du client. `audit_log` est l'inverse point par point — lecture réservée
-- à `view_audit_log`, ajout seul pour tous y compris le patron (RÈGLE M8-2),
-- commerce et auteur pris au jeton signé par `merx.log_audit()`, donc hors de
-- portée de l'appelant.
--
-- La liste de M8-1 est un plancher — « écrivent obligatoirement » — pas un
-- plafond. Mais l'enum est fermé et `supabase/tests/audit.test.ts` compare ses
-- étiquettes à la liste une à une : la RÈGLE M8-1 de `docs/SPEC.md` passe donc
-- de six actions à sept dans la même story. C'est ce test qui empêche la liste
-- de dériver, et il fait son travail ici.
--
-- Le fichier d'E1-04 n'est pas retouché : l'étiquette s'ajoute par `alter
-- type`, le commentaire se remplace par `comment on type`.
-- ============================================================================

alter type public.audit_action add value 'stock_adjustment';

comment on type public.audit_action is
  'Les sept actions qui écrivent obligatoirement dans audit_log. SPEC § 9, '
  'RÈGLE M8-1. Les six premières sont posées en E1-04 et arrivent avec leurs '
  'modules ; stock_adjustment est branchée sur stock_movement en E3-03.';
