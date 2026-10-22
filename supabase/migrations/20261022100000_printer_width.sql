-- ============================================================================
-- Merx — le défaut de `printer_width`, et le rattrapage des commerces existants
--
-- Référence : docs/SPEC.md § 2.7 et § 9 M8 ; docs/BACKLOG.md E5-01.
-- Suite de `20261022090000_printer_width_key.sql`, qui a posé l'étiquette.
--
-- **576, et c'est un défaut utilisable, pas un pis-aller.** 80 mm à 203 points
-- par pouce donne 576 points de large, ce qu'annoncent la majorité des modèles.
-- Le réglage existe pour les autres — 512 sur certains 80 mm, 384 en 58 mm —, et
-- c'est ce que la vérification sur matériel réel tranchera, imprimante par
-- imprimante (docs/PENDING-CHECKS.md).
--
-- Contrairement à `printer_address`, où le vide est la seule valeur honnête
-- pour une imprimante qu'on n'a pas vue, une largeur a un défaut plausible : il
-- n'y a pas d'imprimante thermique de comptoir dont la tête ne soit ni 576, ni
-- 512, ni 384, et 576 est la plus répandue. Un défaut vide ici n'aurait rien
-- protégé — il aurait seulement empêché d'imprimer sur l'imprimante la plus
-- courante tant que personne n'ouvre l'écran, ce que SPEC § 2.6 refuse.
--
-- **Un nombre, pas une chaîne.** C'est un compte de points, et la mise en page
-- du ticket calcule avec : colonnes, bandes, position des montants. Une chaîne
-- obligerait chaque lecteur à la convertir, c'est-à-dire à décider seul ce
-- qu'il fait d'une valeur inconvertible.
--
-- **Aucune contrainte de forme, ici non plus**, et pour la raison écrite en
-- tête de `20260910090000_tenant_settings.sql` : le générateur de lignes du
-- balayage d'isolation écrit `'{}'::jsonb` dans toute colonne jsonb, et une
-- contrainte sortirait `tenant_setting` du balayage. La liste des largeurs
-- admises vit donc côté interface (`PRINTER_WIDTHS`), et une valeur illisible
-- n'offre pas l'impression thermique au lieu d'imprimer de travers — une
-- fonctionnalité privée de sa donnée se désactive en silence (SPEC § 2.6).
-- ============================================================================

insert into merx.setting_default (key, value) values
  ('printer_width', '576'::jsonb);


-- ----------------------------------------------------------------------------
-- Le rattrapage — le geste que toute migration ajoutant une clé doit répéter
--
-- `merx.seed_tenant_settings()` ne pose que les lignes manquantes et n'écrase
-- rien : appelée sur un commerce vivant, elle lui ajoute `printer_width` et
-- laisse intacts l'en-tête, la langue et l'adresse que le patron a choisis.
--
-- Sans cette boucle, les commerces créés avant cette migration n'auraient pas
-- la ligne, et l'invariant « toutes les clés, toujours présentes » — celui sur
-- lequel `loadSettings()` s'appuie pour ne jamais insérer — serait rompu pour
-- eux seuls. C'est le genre d'écart qui ne se voit que chez un client.
-- ----------------------------------------------------------------------------

select merx.seed_tenant_settings(t.id) from public.tenant t;
