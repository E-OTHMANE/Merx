# BACKLOG — Merx

Épiques et user stories.

**Version :** 1.0
**Documents associés :** `docs/SPEC.md` (technique), `docs/CAHIER-DES-CHARGES.md` (métier)

---

## Comment lire ce document

Douze épiques. Chaque story porte :

- **Un identifiant** `Exx-nn`, stable, à citer dans les commits et les branches.
- **Une étape** correspondant à `SPEC.md` § 11. C'est l'ordre de construction.
- **Des dépendances** — ne pas démarrer une story dont les dépendances ne sont pas terminées.
- **Des critères d'acceptation** testables. Une story n'est terminée que si tous sont vérifiés.
- **Des renvois aux RÈGLES** du spec. En cas de contradiction, le spec fait foi.

**Une story à la fois.** Ne pas anticiper sur une étape suivante, même quand l'ajout paraît trivial.

**Définition de terminé**, pour chaque story sans exception :
`npm run typecheck` passe · `npm run lint` passe · les critères d'acceptation sont vérifiés à la main · aucune régression sur les stories précédentes.

---

## Vue d'ensemble

| Épique | Sujet | Étapes |
|---|---|---|
| E0 | Fondations | 1 |
| E1 | Administration | 1 |
| E2 | Catalogue | 2 |
| E3 | Stock | 3, 9 |
| E4 | Ventes | 4 |
| E5 | Impression | 5 |
| E6 | Clients et crédit | 6 |
| E7 | Règlements | 7 |
| E8 | Achats | 8 |
| E9 | Hors-ligne | 10 |
| E10 | Rapports | 11 |
| E11 | Langues et interface | continu |

**Arrêt obligatoire après E5.** Aller voir trois commerçants avant de démarrer E6.

---

# E0 — Fondations

Schéma, isolation, authentification. Rien de visible pour l'utilisateur, tout le reste en dépend.

### E0-01 — Projet et outillage
**Étape 1** · aucune dépendance

**En tant que** développeur, **je veux** un projet qui démarre et se vérifie, **afin de** construire sur une base saine.

**Critères d'acceptation**
- [ ] Vite + React + TypeScript en mode strict, livré en PWA
- [ ] Tailwind et shadcn/ui installés, un composant de test rendu
- [ ] `npm run dev`, `build`, `lint`, `typecheck`, `test` fonctionnent
- [ ] Vitest configuré — **tout critère d'acceptation vérifiable par machine devient un test**
- [ ] Supabase local démarre via `npx supabase start`
- [ ] `npx supabase db reset` reconstruit depuis les migrations
- [ ] Arborescence conforme à `CLAUDE.md` : `src/app`, `src/modules`, `src/lib`, `supabase/`

---

### E0-02 — Schéma de base et conventions
**Étape 1** · dépend de E0-01

**En tant que** développeur, **je veux** des conventions appliquées dès la première migration, **afin de** ne pas les rétro-corriger sur 30 tables.

**Critères d'acceptation**
- [ ] Toutes les clés primaires en `uuid`, générées par la base
- [ ] Montants en `numeric(12,2)`, quantités en `numeric(12,3)` — **aucun flottant nulle part**
- [ ] Dates en `timestamptz`, stockées en UTC
- [ ] Toute table métier porte `tenant_id`, `created_at`, `updated_at`, `created_by`, `device_id`
- [ ] `updated_at` maintenu par trigger
- [ ] Tables de référence : colonne `deleted_at` pour la suppression douce
- [ ] Une seule migration initiale, relisible

**Notes** — `SPEC.md` § 4.

---

### E0-03 — Multi-tenant et RLS
**Étape 1** · dépend de E0-02

**En tant qu'**éditeur, **je veux** que deux commerces ne puissent jamais se voir, **afin de** ne pas perdre la totalité de mes clients sur une seule fuite.

**Critères d'acceptation**
- [ ] Tables `tenant` et `app_user` créées
- [ ] RLS activée sur **toutes** les tables métier, sans exception
- [ ] Les policies dérivent `tenant_id` du JWT, jamais d'un paramètre client
- [ ] Aucune requête applicative ne filtre `tenant_id` à la main
- [ ] Test automatisé : l'utilisateur du commerce A ne lit ni n'écrit aucune ligne du commerce B, sur chaque table
- [ ] Le rôle `super_admin` accède à tous les tenants par une policy distincte et explicite

**Notes** — `SPEC.md` § 2.1. La story n'est pas terminée sans le test d'isolation.

---

### E0-04 — Authentification
**Étape 1** · dépend de E0-03

**En tant qu'**utilisateur, **je veux** me connecter, **afin d'**accéder à mon commerce.

**Critères d'acceptation**
- [ ] Connexion par email et mot de passe via Supabase Auth
- [ ] Session persistante entre les redémarrages de l'application
- [ ] Déconnexion vidant la session locale
- [ ] Les routes protégées redirigent vers la connexion
- [ ] `app_user` lié à `auth.users`, avec `tenant_id` et `role`
- [ ] Écran de connexion utilisable au doigt sur téléphone

---

### E0-05 — Rôles et permissions
**Étape 1** · dépend de E0-04

**En tant que** patron, **je veux** que mon employé ne voie pas mes prix d'achat, **afin de** pouvoir mettre l'outil entre ses mains.

**Critères d'acceptation**
- [ ] Enum `user_role` : `super_admin`, `owner`, `worker`
- [ ] Un helper serveur unique porte toutes les vérifications de droits
- [ ] `cost_price` et toute marge sont **retirés de la réponse API** pour `worker` — pas masqués dans l'interface
- [ ] Test : un appel API brut par un `worker` ne contient jamais `cost_price`
- [ ] L'interface masque les actions interdites, en plus du contrôle serveur
- [ ] Matrice de `SPEC.md` § 3.1 entièrement implémentée

**Notes** — Le test sur la réponse API brute est le cœur de la story. Masquer un champ dans l'interface n'est pas un contrôle d'accès.

---

# E1 — Administration

### E1-01 — Création d'un commerce
**Étape 1** · dépend de E0-05

**En tant qu'**éditeur, **je veux** créer un commerce avec son patron, **afin d'**installer un nouveau client.

**Critères d'acceptation**
- [ ] Formulaire `super_admin` : nom du commerce, nom du patron, téléphone, ville
- [ ] Crée le `tenant`, le premier `app_user` en `owner`, et un `device` par défaut
- [ ] **Crée automatiquement l'unique `warehouse`**, jamais affiché ensuite
- [ ] Le patron peut se connecter immédiatement
- [ ] Liste des commerces avec date de création et dernière activité

**Notes** — `SPEC.md` § 2.4. Le `warehouse` est une constante invisible.

---

### E1-02 — Gestion des employés
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** créer des comptes pour mes employés, **afin qu'**ils utilisent l'outil sans voir mes marges.

**Critères d'acceptation**
- [ ] Le `owner` crée un `worker` : nom, téléphone, mot de passe
- [ ] Il peut désactiver un compte sans le supprimer
- [ ] Un compte désactivé ne peut plus se connecter
- [ ] Un `worker` ne voit pas cet écran
- [ ] Le patron ne peut pas se retirer son propre rôle `owner`

---

### E1-03 — Appareils
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** que mes bons soient numérotés sans doublon, **afin de** m'y retrouver.

**Critères d'acceptation**
- [ ] Table `device` : `label`, `prefix`, `last_sync_at`, `is_active`
- [ ] `prefix` unique par commerce, attribué automatiquement (A, B, C…)
- [ ] Un appareil s'enregistre à la première connexion
- [ ] Le patron voit ses appareils et leur dernière synchronisation

**Notes** — `SPEC.md` RÈGLE M3-2. Sans préfixe, la numérotation hors-ligne produit des doublons.

---

### E1-04 — Journal d'audit
**Étape 1** · dépend de E0-05

**En tant que** patron, **je veux** savoir qui a fait quoi, **afin de** comprendre un écart.

**Critères d'acceptation**
- [ ] Table `audit_log` avec `before` et `after` en `jsonb`
- [ ] Un helper unique, appelé par toutes les actions sensibles
- [ ] Écrivent obligatoirement : forçage de prix, annulation de document, dépassement de plafond, validation d'écart d'inventaire, modification de rôle, changement de prix d'achat
- [ ] Consultation filtrable par utilisateur et par date, `owner` seul
- [ ] `audit_log` est en ajout seul : ni modification, ni suppression

**Notes** — `SPEC.md` RÈGLE M8-1.

---

### E1-05 — Paramètres du commerce
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** régler ce qui est propre à mon commerce, **afin que** l'outil me corresponde.

**Critères d'acceptation**
- [ ] Table `tenant_setting` en clé/valeur `jsonb`
- [ ] Réglages V1 : nom et coordonnées à imprimer, langue par défaut, adresse de l'imprimante réseau
- [ ] Valeurs par défaut fonctionnelles — l'application marche sans qu'on ouvre cet écran

---

# E2 — Catalogue

L'épique la plus déterminante pour l'adoption.

### E2-01 — Modèle produit / variante
**Étape 2** · dépend de E0-02

**En tant que** développeur, **je veux** la couche variante en place dès le départ, **afin de** ne jamais migrer le stock d'un client en production.

**Critères d'acceptation**
- [ ] Tables `category`, `product`, `variant`, `price_break`
- [ ] **Créer un `product` crée toujours une `variant` avec `is_default = true`** — par trigger ou dans une transaction serveur
- [ ] `product.code` unique par tenant, saisie libre
- [ ] `variant.sku` unique par tenant, dérivé de `product.code` s'il n'y a qu'une variante
- [ ] `variant.attributes` en `jsonb`, `{}` en V1
- [ ] **Aucune** table ne référence `product_id` pour du stock ou du prix
- [ ] Test : créer un produit produit exactement une variante

**Notes** — `SPEC.md` RÈGLES 2.3, M1-1. La décision la plus structurante du schéma.

---

### E2-02 — Créer et modifier un produit
**Étape 2** · dépend de E2-01

**En tant que** patron, **je veux** ajouter un produit en quelques secondes, **afin de** ne pas passer ma soirée à saisir.

**Critères d'acceptation**
- [x] **Le seul champ obligatoire est le nom.** Enregistrer avec le seul nom fonctionne.
- [x] Champs facultatifs : `code`, nom arabe, catégorie, marque, photo, `unit_label`, `pieces_per_carton`
- [x] Aucun champ vide n'affiche d'avertissement, de rouge, ni de rappel
- [ ] Photo prise directement depuis l'appareil, redimensionnée avant envoi — *code et compartiment testés ; la prise de vue réelle reste à vérifier sur une tablette*
- [x] Suppression douce via `deleted_at` ; un produit supprimé disparaît des recherches mais reste dans l'historique
- [ ] Formulaire utilisable au doigt, sur téléphone — *à vérifier à la main, sur un Android d'entrée de gamme*

**Notes** — `SPEC.md` § 2.6. Chaque champ obligatoire ajouté est un commerçant perdu.

**Tranché — `tenant_id` à l'insertion** (relevé en E2-01). Défaut posé dans les conventions : `tenant_id` vaut `merx.current_tenant_id()` sur toutes les tables, existantes par migration additive (`product_form`). L'application n'envoie jamais `tenant_id` ; la policy refuse toujours une valeur étrangère explicite. Le générateur de `supabase/tests/isolation.ts` pose `tenant_id` lui-même, défaut ou pas — sans cela le peuplement en `postgres` écrivait NULL (constaté : `23502`). Voir SPEC § 4.

**Tranché aussi en E2-02** — le SKU de la variante par défaut suit la référence tant qu'il n'en a pas divergé (SPEC § 6) ; photos dans un compartiment Storage privé (SPEC § 6) ; catégorie proposée parmi celles qui existent, champ absent s'il n'y en a aucune — elles arrivent par l'import (E2-05) ; registre des formulaires de création contrôlé par `conventions.test.ts` (SPEC § 2.6).

---

### E2-03 — Grille de prix par palier
**Étape 2** · dépend de E2-01

**En tant que** patron, **je veux** un prix qui baisse à la quantité, **afin de** vendre en gros sans recalculer de tête.

**Critères d'acceptation**
- [x] Saisie de plusieurs `price_break` par variante : `min_qty` et `unit_price`
- [x] Une ligne `min_qty = 1` est obligatoire et créée par défaut
- [x] Résolution : prendre le plus grand `min_qty` inférieur ou égal à la quantité demandée
- [x] `floor_price` saisissable, `owner` seul
- [x] `cost_price` saisissable, `owner` seul, sur `variant_cost` — jamais une colonne de `variant`
- [x] `variant_cost` créée par `merx.apply_capability_restriction(..., 'view_cost')` ; le balayage de `conventions.test.ts` le vérifie
- [x] Test unitaire de résolution couvrant les bornes exactes (9, 10, 99, 100)

**Notes** — `SPEC.md` RÈGLE M1-2, et RÈGLE de placement des coûts § 3. Le mécanisme de restriction est livré par E0-05 ; E2 ne fait que l'appeler.

**Tranché en E2-03** — `unit_price` nullable, « prix non renseigné », jamais 0 par défaut ; une quantité sous le plus petit `min_qty` ne résout aucun palier ; grille sur un écran à part, `/products/:id/prices` ; la ligne à l'unité porte l'identifiant de sa variante ; `variant_cost` n'a qu'un garde, la policy `view_cost` (SPEC § 6).

**Vérifié par sabotage** (14 cas, chacun seul sur une base fraîche, suite base complète) : trigger de la ligne à l'unité, G1, G2, unicité des paliers, les trois policies d'écriture de `price_break` et de `variant`, la policy restrictive de `variant_cost`, un `cost_price` posé sur `variant`, l'unicité de `variant_cost`, `apply_capability_restriction` retirée. Chacun fait tomber son test, code et nom de contrainte assertés. Deux tests corrigés en chemin : précondition « ligne à l'unité présente » (`price-grid.test.ts`), et le balayage d'insertion (`settings.test.ts`) qui asserte désormais la table nommée dans le `42501` — un trigger faisait refuser par la policy d'une autre table.

---

### E2-04 — Recherche produit
**Étape 2** · dépend de E2-02

**En tant que** vendeur, **je veux** trouver un produit même en tapant mal, **afin de** ne pas faire attendre le client.

**Critères d'acceptation**
- [ ] Recherche simultanée sur nom français, nom arabe, `code`, `sku`, `barcode`
- [ ] Tolérante aux fautes et aux accents : « creme » trouve « crème »
- [ ] Fonctionne sur référence partielle : « 451 » trouve « 4512 »
- [ ] Résultat en moins de 300 ms sur 10 000 références
- [ ] Résultats en liste **et** en grille photo, au choix
- [ ] Index base de données en place, testés sur un jeu réaliste de 10 000 lignes

**Notes** — Point de rupture n° 4 du spec.

---

### E2-05 — Import CSV
**Étape 2** · dépend de E2-03

**En tant que** patron, **je veux** importer mon fichier Excel, **afin de** ne pas ressaisir 2 000 références à la main.

**Critères d'acceptation**
- [ ] Dépôt d'un fichier CSV ou XLSX
- [ ] Écran de correspondance des colonnes, avec proposition automatique
- [ ] Prévisualisation des 20 premières lignes avant validation
- [ ] Validation ligne par ligne, avec numéro de ligne et motif d'erreur
- [ ] Les lignes valides s'importent même si d'autres échouent ; rapport téléchargeable des rejets
- [ ] Import de 2 000 lignes en moins d'une minute
- [ ] Gère les cas réels : colonnes vides, doublons de référence, prix en texte (« 15,00 DH »), accents cassés, espaces parasites
- [ ] Réimporter le même fichier met à jour au lieu de dupliquer, sur la clé `code`

**Notes** — Point de rupture n° 1. Y consacrer plus de soin qu'à tout autre écran. Le code se fait en deux jours, les cas tordus en deux semaines.

---

### E2-06 — Codes-barres
**Étape 2** · dépend de E2-02

**En tant que** vendeur, **je veux** scanner ce qui a un code et étiqueter ce qui n'en a pas, **afin d'**aller vite dans les deux cas.

**Critères d'acceptation**
- [ ] Scan d'un EAN fabricant, stocké dans `variant.barcode`
- [ ] Génération d'un Code 128 encodant `variant.sku` pour les produits sans code
- [ ] La recherche interroge les deux indifféremment
- [ ] Impression d'étiquettes en planche A4, quantité paramétrable
- [ ] Un `barcode` déjà attribué à une autre variante est refusé avec un message clair

**Notes** — `SPEC.md` RÈGLE M1-5. En cosmétique les marques portent un EAN fiable : c'est la voie principale.

---

# E3 — Stock

### E3-01 — Mouvements et niveaux
**Étape 3** · dépend de E2-01

**En tant que** patron, **je veux** que chaque mouvement soit traçable, **afin de** comprendre un écart.

**Critères d'acceptation**
- [ ] Tables `warehouse`, `stock_level`, `stock_movement`
- [ ] `stock_level` unique sur `(variant_id, warehouse_id)`
- [ ] **`stock_level` n'est jamais écrit directement** : trigger sur `stock_movement`
- [ ] `stock_movement` immuable : ni UPDATE, ni DELETE, refusé au niveau base
- [ ] `quantity` signée, négative en sortie
- [ ] `movement_type` : `sale | return | receipt | adjustment | inventory`
- [ ] `source_type` et `source_id` renvoient au document d'origine
- [ ] Test : une série de mouvements produit le `stock_level` attendu

**Notes** — `SPEC.md` RÈGLES M2-1, M2-2. L'immutabilité est ce qui rendra la synchronisation possible en E9. Ne pas l'assouplir.

---

### E3-02 — Consultation du stock
**Étape 3** · dépend de E3-01

**En tant que** vendeur, **je veux** voir ce qu'il reste, **afin de** répondre au client.

**Critères d'acceptation**
- [ ] Liste des produits avec quantité, recherchable et filtrable
- [ ] Filtres : stock à zéro, stock négatif
- [ ] Fiche variante affichant l'historique complet des mouvements, du plus récent au plus ancien
- [ ] Chaque mouvement affiche sa date, son type, sa quantité, son auteur et son document
- [ ] Le stock négatif s'affiche en repère visuel, sans blocage ni alerte modale

**Notes** — `SPEC.md` RÈGLE M2-3. Un grossiste vend ce qui est encore sur le camion.

---

### E3-03 — Ajustement manuel
**Étape 3** · dépend de E3-01

**En tant que** patron, **je veux** corriger une quantité fausse, **afin de** repartir juste sans attendre l'inventaire.

**Critères d'acceptation**
- [ ] Saisie d'une quantité corrigée, générant un `adjustment` de la différence
- [ ] Motif obligatoire, en texte libre
- [ ] Réservé au `owner`
- [ ] Tracé dans `audit_log`

---

### E3-04 — Inventaire
**Étape 9** · dépend de E3-01, E2-06

**En tant que** patron, **je veux** compter mon stock sans fermer, **afin de** savoir ce que je possède vraiment.

**Critères d'acceptation**
- [ ] Ouverture d'une `inventory_session`, plusieurs sessions possibles dans le temps
- [ ] Comptage au scan : scanner puis saisir la quantité
- [ ] Comptage manuel possible pour les produits sans code
- [ ] **Saisie en cartons quand `pieces_per_carton` existe**, convertie automatiquement en pièces
- [ ] Écart calculé par ligne : compté moins théorique
- [ ] Motif saisissable sur un écart
- [ ] Validation réservée au `owner`, générant les mouvements `inventory`
- [ ] Une session peut être interrompue et reprise
- [ ] Les ventes continuent pendant la session

**Notes** — `SPEC.md` RÈGLE M2-4. On compte des cartons sur une étagère, pas des pièces.

---

# E4 — Ventes

L'épique la plus critique. L'écran de vente décide de l'adoption.

### E4-01 — Modèle document
**Étape 4** · dépend de E2-01, E3-01

**En tant que** développeur, **je veux** des documents non modifiables, **afin que** l'historique reste fiable.

**Critères d'acceptation**
- [ ] Tables `sale_document`, `sale_line`, `document_sequence`
- [ ] `doc_type` : `quote | order | delivery_note`. **Aucune facture fiscale.**
- [ ] `status` : `draft | confirmed | delivered | cancelled`
- [ ] Un document `confirmed` ne peut être ni modifié ni supprimé, contrainte en base
- [ ] L'annulation passe le statut à `cancelled` et génère les mouvements de stock inverses
- [ ] `price_source` par ligne : `auto | manual`

**Notes** — `SPEC.md` RÈGLES M3-1, M3-3.

---

### E4-02 — Numérotation
**Étape 4** · dépend de E4-01, E1-03

**En tant que** patron, **je veux** des numéros sans trou ni doublon, **afin de** retrouver un bon.

**Critères d'acceptation**
- [ ] Format `BL-A-0001` : type, préfixe d'appareil, séquence
- [ ] Séquence par `(tenant, device, doc_type, year)`
- [ ] Attribué à la confirmation, jamais au brouillon
- [ ] **Attribué localement. Le serveur n'attribue aucun numéro.**
- [ ] Aucun trou dans la séquence
- [ ] Test : deux appareils créant chacun 100 documents ne produisent aucune collision

**Notes** — `SPEC.md` RÈGLE M3-2. Une numérotation serveur rendrait E9 impossible.

---

### E4-03 — Écran de vente
**Étape 4** · dépend de E4-01, E2-04

**En tant que** vendeur, **je veux** sortir un bon pendant que le client attend, **afin de** ne pas revenir au carnet.

**Critères d'acceptation**
- [ ] **Trois entrées, aboutissant toutes à la même ligne** : scan, saisie de la référence, sélection sur grille photo
- [ ] **Pas d'écran scan-only** : la marchandise n'est pas toujours à portée de main
- [ ] Ajout d'une ligne : produit, quantité, prix résolu automatiquement
- [ ] Modification de quantité et suppression de ligne directes
- [ ] Total mis à jour en temps réel
- [ ] Sélection ou création d'un client sans quitter l'écran
- [ ] **Bon de 10 lignes en moins de 90 secondes**, chronométré
- [ ] Utilisable debout, au doigt, d'une seule main
- [ ] Un stock à zéro n'empêche rien

**Notes** — `SPEC.md` RÈGLE M3-6, point de rupture n° 2. Chaque tap superflu est payé mille fois par jour.

---

### E4-04 — Résolution du prix
**Étape 4** · dépend de E4-03, E2-03

**En tant que** vendeur, **je veux** que le prix suive la quantité tout seul, **afin de** ne pas me tromper.

**Critères d'acceptation**
- [ ] Prix résolu automatiquement depuis `price_break`
- [ ] **Recalculé à chaque changement de quantité**, jamais figé à la première saisie
- [ ] Passer de 8 à 12 fait basculer **toute la ligne** au palier supérieur, sans la scinder
- [ ] À moins de 20 % du palier suivant, afficher l'incitation : « +2 → 12,00 DH »
- [ ] Forçage manuel possible, marqué `manual`
- [ ] Un `worker` ne peut pas descendre sous `floor_price` : refus avec message
- [ ] Tout forçage est tracé dans `audit_log`

**Notes** — `SPEC.md` RÈGLES M1-3, M1-4. L'incitation au palier est une fonction produit, pas une décoration.

---

### E4-05 — Cycle des documents
**Étape 4** · dépend de E4-01

**En tant que** patron, **je veux** transformer un devis en bon, **afin de** ne pas ressaisir.

**Critères d'acceptation**
- [ ] Devis → commande → bon de livraison
- [ ] **Chaque transformation crée un nouveau document lié**, l'original n'est jamais muté
- [ ] Le lien de filiation est consultable dans les deux sens
- [ ] **Le stock n'est décrémenté qu'à la confirmation du `delivery_note`**, ni au devis ni à la commande
- [ ] Modification des lignes possible pendant la transformation

**Notes** — `SPEC.md` RÈGLES M3-4, M3-5.

---

### E4-06 — Retours
**Étape 4** · dépend de E4-01

**En tant que** vendeur, **je veux** enregistrer un retour, **afin que** le stock et le compte du client soient justes.

**Critères d'acceptation**
- [ ] Retour lié à un bon existant, total ou partiel
- [ ] Génère les mouvements `return` et remet en stock
- [ ] Génère l'écriture au crédit du client
- [ ] Numéroté selon le même schéma que les bons
- [ ] Motif saisissable

---

### E4-07 — Liste et consultation
**Étape 4** · dépend de E4-01

**En tant que** patron, **je veux** retrouver un bon, **afin de** régler un litige.

**Critères d'acceptation**
- [ ] Liste filtrable par date, client, statut, type, appareil
- [ ] Recherche par numéro
- [ ] Détail affichant les lignes, les totaux, l'auteur, l'appareil et l'horodatage
- [ ] Annulation réservée au `owner`, avec motif, tracée
- [ ] Un document annulé reste visible, clairement marqué

---

# E5 — Impression

### E5-01 — Bon thermique 80 mm
**Étape 5** · dépend de E4-03

**En tant que** vendeur, **je veux** remettre un papier au client, **afin qu'**il ait sa preuve.

**Critères d'acceptation**
- [ ] Impression ESC/POS sur imprimante **réseau Wi-Fi**
- [ ] Adresse configurée dans les paramètres du commerce
- [ ] Contient : nom et coordonnées du commerce, numéro du bon, date et heure, client, lignes avec quantité et prix, total
- [ ] Échec d'impression non bloquant : le bon reste enregistré, réimpression possible
- [ ] Réimpression depuis le détail du document

**Notes** — `SPEC.md` § 2.7. Bluetooth exclu en V1.

---

### E5-02 — Arabe sur imprimante thermique
**Étape 5** · dépend de E5-01

**En tant que** commerçant, **je veux** un ticket lisible en arabe, **afin que** mes clients le comprennent.

**Critères d'acceptation**
- [ ] Le texte arabe s'imprime correctement : liaison des lettres et sens droite-à-gauche respectés
- [ ] Solution de repli acceptée : rendu du ticket en image, imprimé en mode graphique
- [ ] Mélange arabe et chiffres latins sur une même ligne sans casse
- [ ] Testé sur une imprimante physique, pas seulement en émulation

**Notes** — Le support ESC/POS de l'arabe est mauvais. Prévoir le rendu image dès le départ plutôt que de s'entêter sur les jeux de caractères.

---

### E5-03 — PDF A4
**Étape 5** · dépend de E4-01

**En tant que** patron, **je veux** envoyer un bon par WhatsApp, **afin de** livrer un client d'une autre ville.

**Critères d'acceptation**
- [ ] Génération PDF d'un bon, d'un devis, d'un relevé
- [ ] **Lisible sur un écran de téléphone sans zoomer**
- [ ] Partage via l'API native de partage de l'appareil
- [ ] Nom de fichier explicite : `BL-A-0042-2026-09-04.pdf`
- [ ] Généré localement, sans appel serveur

---

# E6 — Clients et crédit

> **Arrêt terrain avant de démarrer cette épique.** Voir trois commerçants.

### E6-01 — Fiche client
**Étape 6** · dépend de E0-02

**En tant que** vendeur, **je veux** créer un client en deux secondes, **afin de** ne pas bloquer la vente.

**Critères d'acceptation**
- [ ] **Le seul champ obligatoire est le nom**
- [ ] Facultatifs : téléphone, ville, adresse, plafond de crédit, notes
- [ ] Champ `ice` présent en base, masqué, inutilisé en V1
- [ ] Création possible depuis l'écran de vente, sans le quitter
- [ ] Recherche par nom et par téléphone, tolérante aux fautes
- [ ] Suppression douce

---

### E6-02 — Grand livre et solde
**Étape 6** · dépend de E6-01, E4-01

**En tant que** patron, **je veux** savoir exactement qui me doit combien, **afin d'**arrêter de perdre de l'argent.

**Critères d'acceptation**
- [ ] Table `client_ledger_entry`, `entry_type` : `debit | credit`
- [ ] **Le solde n'est pas une colonne** : il se calcule depuis le grand livre
- [ ] **Grand livre en ajout seul** : une correction est une écriture inverse
- [ ] Un bon confirmé génère automatiquement le débit
- [ ] Un retour génère automatiquement le crédit
- [ ] Solde exact au dirham, vérifié sur un scénario de 50 opérations mêlant ventes, retours et paiements partiels

**Notes** — `SPEC.md` RÈGLES M4-1, M4-2. L'ajout seul est ce qui rendra la synchronisation possible.

---

### E6-03 — Plafond de crédit
**Étape 6** · dépend de E6-02

**En tant que** patron, **je veux** que mon employé ne puisse pas laisser filer l'ardoise, **afin de** limiter ma perte.

**Critères d'acceptation**
- [ ] `credit_limit` saisissable, `owner` seul
- [ ] Dépassement : avertissement bloquant pour `worker`
- [ ] Franchissable par le `owner` seul
- [ ] Tout franchissement tracé dans `audit_log`
- [ ] Sans plafond saisi, aucun contrôle et aucun rappel

**Notes** — `SPEC.md` RÈGLE M4-3.

---

### E6-04 — Relevé de compte
**Étape 6** · dépend de E6-02, E5-03

**En tant que** patron, **je veux** envoyer son relevé à un client, **afin de** me faire payer.

**Critères d'acceptation**
- [ ] Relevé sur période, avec report à nouveau, mouvements et solde final
- [ ] Export PDF lisible sur téléphone
- [ ] Partageable en un geste
- [ ] Liste des clients triée par encours décroissant
- [ ] Ancienneté de l'encours : 0-30, 31-60, 61-90, 90+ jours

---

# E7 — Règlements

### E7-01 — Encaissement
**Étape 7** · dépend de E6-02

**En tant que** vendeur, **je veux** enregistrer ce que le client paie, **afin que** son compte soit à jour.

**Critères d'acceptation**
- [ ] Table `payment`, `direction` : `in | out`
- [ ] `method` : `cash` seul en V1. L'enum prévoit `cheque | bill_of_exchange | transfer | card`, non implémentés.
- [ ] Encaissement possible au moment de la vente ou plus tard
- [ ] Génère l'écriture au crédit du client
- [ ] Reçu imprimable

**Notes** — `SPEC.md` RÈGLE M6-2. Ne pas construire le portefeuille d'effets.

---

### E7-02 — Ventilation
**Étape 7** · dépend de E7-01

**En tant que** patron, **je veux** répartir un paiement sur plusieurs bons, **afin de** savoir ce qui reste dû sur chacun.

**Critères d'acceptation**
- [ ] Table `payment_allocation`
- [ ] Un règlement se ventile sur un ou plusieurs bons
- [ ] Proposition automatique du plus ancien au plus récent, modifiable
- [ ] Reste à payer visible par bon
- [ ] Les paiements partiels sont le cas normal, pas une exception

**Notes** — `SPEC.md` RÈGLE M6-1.

---

### E7-03 — Caisse
**Étape 7** · dépend de E7-01

**En tant que** patron, **je veux** contrôler ma caisse le soir, **afin de** repérer un écart le jour même.

**Critères d'acceptation**
- [ ] Ouverture avec fonds de caisse
- [ ] Clôture : montant compté, montant théorique, écart calculé
- [ ] Écart commenté, jamais bloquant
- [ ] Historique des sessions consultable
- [ ] Une session ouverte est reprise au redémarrage de l'application

---

# E8 — Achats

### E8-01 — Fournisseurs
**Étape 8** · dépend de E0-02

**En tant que** patron, **je veux** garder mes fournisseurs, **afin de** ne pas les ressaisir.

**Critères d'acceptation**
- [ ] Table `supplier` : nom, téléphone, pays, notes
- [ ] Seul le nom est obligatoire
- [ ] Recherche et suppression douce

---

### E8-02 — Réception
**Étape 8** · dépend de E8-01, E3-01

**En tant que** patron, **je veux** faire entrer ma marchandise, **afin que** mon stock soit juste.

**Critères d'acceptation**
- [ ] Tables `goods_receipt`, `goods_receipt_line`
- [ ] Saisie : produit, quantité, coût unitaire
- [ ] **Saisie en cartons quand `pieces_per_carton` existe**, convertie en pièces
- [ ] **Pas de ventilation de frais annexes en V1** : `unit_cost` saisi directement
- [ ] La validation génère les mouvements `receipt`
- [ ] Numérotée avec préfixe d'appareil

**Notes** — `SPEC.md` RÈGLES M5-1, M5-3.

---

### E8-03 — Coût moyen pondéré
**Étape 8** · dépend de E8-02

**En tant que** patron, **je veux** connaître mon coût réel, **afin de** savoir si je gagne de l'argent.

**Critères d'acceptation**
- [ ] La validation d'une réception met à jour `variant_cost.cost_price` en CMUP, en créant la ligne si absente
- [ ] Formule : `(stock_actuel × cost_actuel + qté_reçue × cout_reçu) / (stock_actuel + qté_reçue)`
- [ ] Stock initial nul : `cost_price` prend le coût de réception
- [ ] Le recalcul passe par une fonction `security definer` : un `worker` valide la réception sans jamais recevoir le coût moyen
- [ ] Test : après validation par un `worker`, la réponse API de ce `worker` ne contient pas `cost_price`, et le coût est bien à jour côté `owner`
- [ ] Toute variation de `cost_price` tracée dans `audit_log`
- [ ] Test couvrant plusieurs réceptions successives à des coûts différents

- [ ] `unit_cost` ne vit pas sur `goods_receipt_line` : il rejoint une relation confidentielle, restreinte par `view_cost`
- [ ] La saisie d'une réception se fait à deux mains : le `worker` saisit les quantités, le `owner` saisit les coûts
- [ ] Test : le corps rendu à un `worker` sur une réception ne contient ni `unit_cost` ni de quoi le reconstituer

**Notes** — `SPEC.md` RÈGLE M5-2, RÈGLE de placement des coûts § 3, et note \*\* de § 3.1.

**Arbitrage rendu pendant E0-05, à appliquer ici.** `goods_receipt_line.unit_cost` va sur une relation confidentielle, au même titre que `variant_cost`. La raison n'est pas une question de principe : sans cela, un employé qui lit les lignes de réception recalcule lui-même le coût moyen pondéré, et la protection de `variant_cost` ne vaut plus rien. Protéger un résultat en laissant fuir ses composants ne protège pas, cela ajoute une multiplication.

Conséquence sur § 3.1 : « saisir une réception » se scinde. Le `worker` saisit les quantités reçues — c'est son travail au quai — et le `owner` saisit les coûts. Prévoir l'écran en deux temps plutôt qu'un formulaire unique dont la moitié des champs seraient interdits.

La décision est enregistrée, pas implémentée : E0-05 n'a livré que le mécanisme. `unit_cost` figure déjà dans la liste des colonnes confidentielles de `supabase/tests/conventions.ts` — le jour où la colonne apparaît sur une table ordinaire, le balayage la signale.

---

# E9 — Hors-ligne

L'épique la plus coûteuse. Ne pas la démarrer avant que tout le reste tourne en ligne.

### E9-01 — Base locale et synchronisation
**Étape 10** · dépend de toutes les épiques précédentes

**En tant que** commerçant, **je veux** continuer à vendre quand internet tombe, **afin de** ne pas fermer boutique.

**Critères d'acceptation**
- [ ] PowerSync intégré, SQLite local sur l'appareil
- [ ] Règles de synchronisation déclaratives, alignées sur la RLS
- [ ] Portée : l'intégralité du commerce de l'utilisateur
- [ ] Synchronisation bidirectionnelle
- [ ] **Le moteur n'est pas écrit sur mesure**
- [ ] Chargement initial d'un catalogue de 10 000 références en moins de deux minutes

**Notes** — `SPEC.md` § 2.5. Écrire son propre moteur coûterait des mois et les erreurs de cohérence ne se découvriraient que chez un client.

---

### E9-02 — Sept jours hors-ligne
**Étape 10** · dépend de E9-01

**En tant que** commerçant, **je veux** tenir une semaine sans réseau, **afin de** ne pas dépendre de mon opérateur.

**Critères d'acceptation**
- [ ] Vente, encaissement, création de client et consultation du catalogue fonctionnent hors-ligne
- [ ] La numérotation locale fonctionne sans serveur
- [ ] **Test : 7 jours simulés hors-ligne, 200 documents créés, tous remontés intacts à la reconnexion**
- [ ] Aucune perte, aucun doublon
- [ ] Reconnexion sans intervention de l'utilisateur
- [ ] État de synchronisation visible en permanence dans l'interface

**Notes** — Ce test est la story. Il est lent et ne s'accélère pas ; le prévoir.

---

### E9-03 — Réconciliation
**Étape 10** · dépend de E9-02

**En tant que** patron, **je veux** que mes chiffres soient justes après une coupure, **afin de** faire confiance à l'outil.

**Critères d'acceptation**
- [ ] Mouvements de stock et écritures de grand livre **s'additionnent**, jamais écrasés
- [ ] Entités de référence — produit, client, prix — en dernière écriture gagnante
- [ ] Un stock négatif après synchronisation est accepté et signalé, jamais rejeté
- [ ] Aucun document confirmé n'est jamais écrasé
- [ ] Test : deux appareils hors-ligne vendant le même stock produisent un total correct après synchronisation

**Notes** — `SPEC.md` § 2.5. `[À VALIDER]` L'hypothèse V1 est un appareil par commerce. Le test à deux appareils vérifie que le modèle ne se casse pas, sans que le scénario soit traité.

---

### E9-04 — Affichage de la fraîcheur
**Étape 10** · dépend de E9-01

**En tant que** vendeur, **je veux** savoir si le chiffre affiché est à jour, **afin de** ne pas promettre ce que je n'ai pas.

**Critères d'acceptation**
- [ ] Hors-ligne, stock et solde client portent la mention « à la dernière synchronisation », datée
- [ ] Indicateur permanent : en ligne, hors-ligne, synchronisation en cours
- [ ] Nombre de documents en attente d'envoi visible
- [ ] **Ne jamais présenter une valeur potentiellement périmée comme certaine**

---

# E10 — Rapports

### E10-01 — Rapport de journée
**Étape 11** · dépend de E7-01, E9-01

**En tant que** patron, **je veux** savoir ce que j'ai fait aujourd'hui, **afin de** piloter mon commerce.

**Critères d'acceptation**
- [ ] Sur une journée : vendu, encaissé, crédit accordé, nombre de bons
- [ ] Marge du jour, **`owner` seul**
- [ ] **Fonctionne hors-ligne**, calculé depuis la base locale
- [ ] Affichage instantané
- [ ] Lisible sur un écran de téléphone, sans défilement horizontal
- [ ] Choix de la date

**Notes** — `SPEC.md` RÈGLE M7-2. C'est ce que le patron ouvrira chaque soir.

---

### E10-02 — Rapports de période
**Étape 11** · dépend de E10-01

**En tant que** patron, **je veux** comparer mes semaines, **afin de** voir si ça monte.

**Critères d'acceptation**
- [ ] Ventes par jour, semaine, mois
- [ ] Top produits par quantité et par chiffre d'affaires
- [ ] Encours clients avec ancienneté
- [ ] Valorisation du stock
- [ ] Références dormantes, seuil de jours paramétrable
- [ ] Export CSV

---

### E10-03 — Filtrage des coûts
**Étape 11** · dépend de E10-01

**En tant que** patron, **je veux** que mes marges restent invisibles à mes employés, **afin de** garder l'outil dans mon magasin.

**Critères d'acceptation**
- [ ] Tout rapport contenant un coût ou une marge est **refusé côté serveur** hors rôle `owner`
- [ ] Test : un appel API brut par un `worker` retourne une erreur, pas un rapport amputé
- [ ] Les rapports interdits n'apparaissent pas dans la navigation d'un `worker`

**Notes** — `SPEC.md` RÈGLE M7-1, point de rupture n° 5.

---

# E11 — Langues et interface

Transversal. Chaque écran construit doit satisfaire cette épique.

### E11-01 — Bilingue et RTL
**Continu** · dépend de E0-01

**En tant que** commerçant arabophone, **je veux** travailler dans ma langue, **afin de** ne pas déchiffrer du français.

**Critères d'acceptation**
- [ ] Français et arabe, bascule instantanée sans rechargement
- [ ] **RTL complet en arabe** : mise en page, alignements, icônes directionnelles
- [ ] Vocabulaire métier réel, pas d'arabe littéraire
- [ ] Nombres et montants toujours en chiffres latins
- [ ] Aucune chaîne codée en dur dans un composant

---

### E11-02 — Utilisable au comptoir
**Continu** · dépend de E0-01

**En tant que** vendeur, **je veux** un écran utilisable debout et d'une main, **afin de** servir sans poser le téléphone.

**Critères d'acceptation**
- [ ] Cibles tactiles d'au moins 44 px
- [ ] Actions principales atteignables au pouce
- [ ] Photo produit systématique — **ne jamais dépendre du seul texte**
- [ ] Lisible sous éclairage de boutique
- [ ] Testé sur un appareil Android d'entrée de gamme, pas seulement en simulateur
- [ ] Démarrage de l'application en moins de 3 secondes

---

### E11-03 — Aucun champ imposé
**Continu** · dépend de E0-01

**En tant qu'**utilisateur, **je veux** que l'outil ne me réclame rien, **afin de** ne pas retourner au carnet.

**Critères d'acceptation**
- [ ] Un seul champ obligatoire par formulaire de création : le nom
- [ ] Aucune fonctionnalité ne réclame sa donnée manquante : ni avertissement, ni rouge, ni rappel
- [ ] Une fonctionnalité privée de sa donnée se désactive **en silence**
- [ ] **Rien ne bloque une vente** : ni stock à zéro, ni donnée absente
- [ ] Revue systématique en fin de chaque story : quels champs ai-je rendus obligatoires, et pourquoi

**Notes** — `SPEC.md` § 2.6. Cette épique prime sur toute autre considération fonctionnelle.

---

## Questions non tranchées

À décider hors de ce document. Aucune ne bloque avant l'étape 10.

1. Un ou plusieurs appareils par commerce — hypothèse V1 : un seul
2. Onboarding du catalogue facturé, offert, ou vendu en prestation
3. Nombre de pilotes avant ouverture commerciale — recommandation : trois
4. Structure juridique et encaissement des abonnements
5. Qui répond au téléphone quand un vendeur est bloqué un samedi à 11 h