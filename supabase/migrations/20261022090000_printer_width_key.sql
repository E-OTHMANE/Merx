-- ============================================================================
-- Merx — `printer_width`, quatrième clé de réglage
--
-- Référence : docs/SPEC.md § 2.7 (RÈGLE de l'enveloppe Android, RÈGLE du ticket
--             rendu en image) et § 9 M8 ; docs/BACKLOG.md E5-01 ;
--             docs/research/E5-02-arabe-thermique.md § 3.
--
-- **Pourquoi un réglage et non une constante.** Le ticket est rendu en image à
-- la largeur de la tête d'impression, et cette largeur n'est pas déductible du
-- format du papier : 80 mm vaut 576 points sur la plupart des modèles, 512 sur
-- certains, et 58 mm vaut 384. La recherche ne l'établit pour aucun modèle du
-- parc visé — c'est la première chose à mesurer sur une vraie imprimante.
--
-- Une constante fausse se corrige par un APK à réinstaller sur chaque tablette,
-- les assets web étant empaquetés dans l'enveloppe Capacitor (SPEC § 2.7). Une
-- clé de réglage se corrige depuis l'écran, et la correction traverse la
-- synchronisation comme n'importe quel réglage. C'est tout l'écart entre les
-- deux, et il est décisif : ce projet installe chez des commerçants qu'on ne
-- revoit pas.
--
-- **Le patron n'a rien à régler pour autant** (SPEC § 2.6) : le défaut est posé
-- à 576 dans `20261022100000_printer_width.sql`, un commerce naît réglé, et
-- l'écran ne réclame rien.
--
-- ----------------------------------------------------------------------------
-- Pourquoi une migration pour une seule ligne
--
-- Une valeur d'enum n'est pas utilisable dans la transaction qui la crée :
-- l'`insert` dans `merx.setting_default` et le rattrapage de
-- `merx.seed_tenant_settings()` échoueraient sur « unsafe use of new value ».
-- Même découpage qu'E4-01 (`sale_cancellation`) et E4-06 (`return`). La suite
-- est dans `20261022100000_printer_width.sql`.
-- ============================================================================

alter type public.setting_key add value 'printer_width';

comment on type public.setting_key is
  'Les réglages du commerce, SPEC § 9 M8 et E1-05. Une clé ajoutée ici exige '
  'sa ligne dans merx.setting_default, un rappel de '
  'merx.seed_tenant_settings() sur tous les commerces, et son entrée dans '
  'SETTING_KEYS de src/modules/admin/settingKeys.ts, que '
  'supabase/tests/settings.test.ts compare à ce type.';
