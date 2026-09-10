# src/modules

Un dossier par module métier : `catalogue`, `stock`, `sales`, `clients`, `purchasing`,
`payments`, `reports`, `admin`.

Le code d'un module reste dans son dossier. Un module peut importer depuis `src/lib` et
depuis l'`index.ts` public d'un autre module, jamais depuis ses fichiers internes.

Vide tant que l'étape 2 (`SPEC.md` § 11) n'est pas démarrée.
