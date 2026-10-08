# SPEC — Merx

SaaS de gestion pour commerces de gros.

**Version :** 3.0
**Métier cible V1 :** cosmétique, parfumerie, soins
**Statut :** spécification d'implémentation
**Convention :** prose en français, tous les identifiants (tables, colonnes, enums, routes) en anglais.

---

## 0. Comment utiliser ce document

Ce fichier vit dans le dépôt. `CLAUDE.md` y renvoie.

Construire **une étape à la fois**, dans l'ordre de la section 11. Ne jamais bâtir en avance sur une étape suivante.

Les lignes marquées **RÈGLE** encodent des décisions déjà arbitrées. Ne pas les réinterpréter. Si une RÈGLE paraît impossible, s'arrêter et le dire.

---

## 1. Périmètre V1

**Le cycle complet, rien à côté.**

produit → entrée de stock → vente → reçu → inventaire → encaissement

| Module | V1 |
|---|---|
| M1 Catalogue | Complet |
| M2 Stock et inventaire | Complet, dépôt unique |
| M3 Ventes et impression | Complet |
| M4 Clients et crédit | Complet |
| M5 Achats et réception | Simple, sans frais annexes |
| M6 Règlements | Espèces uniquement |
| M7 Rapports | Journée du commerce |
| M8 Administration | Complet |

**Hors V1 :** dates de péremption, packs métier, multi-dépôt, chèques et traites, coût de revient avec frais annexes, comptabilité, facturation fiscale, WhatsApp API, champs personnalisés.

---

## 2. Décisions d'architecture

### 2.1 Multi-tenant

Une base, isolation par `tenant_id`.

**RÈGLE** — Toute table métier porte `tenant_id NOT NULL`, avec Row-Level Security. Aucune requête applicative ne filtre le tenant à la main.

**Exception nommée — la recherche produit (E2-04).** `public.search_products()` est `security definer` et filtre le commerce elle-même, sur `merx.current_tenant_id()`, en tête de son corps. Ce filtre est le **seul garde d'isolation** de ce chemin : aucune policy ne s'y applique.

La raison est mesurée, pas supposée. Sous RLS, Postgres n'accepte comme condition d'index que des prédicats `leakproof` — qui ne peuvent rien laisser fuir d'une ligne que la policy aurait écartée. `like`, `lower`, `unaccent` et les opérateurs de `pg_trgm` ne le sont pas, et `postgres` n'étant pas superutilisateur, rien ne peut être déclaré tel. Sur le stack local, cinq commerces de 10 000 produits, « creme » cherché sous le jeton d'un employé, les deux chemins rendant les mêmes 1 251 lignes : sous `authenticated`, **Seq Scan de toute la table en 417 à 472 ms** (sous-chaîne) et 517 ms (similarité), temps qui croît avec le nombre de commerces ; hors RLS, par l'index trigramme, **8,6 à 9,7 ms**. Sans l'exception, l'index existerait et ne servirait jamais.

Une première mesure, 139 ms contre 2,4 ms, figurait ici. Elle avait été prise sur un texte dont l'accent s'était abîmé en transit : la recherche indexée n'y trouvait aucune ligne, et les 2,4 ms mesuraient une recherche vide. Elle est remplacée, et la raison est écrite pour qu'on ne la reprenne pas.

Une exception n'est pas un précédent. **RÈGLE** — toute fonction `security definer` de `public` qui lit ou écrit une table métier s'inscrit à `merx.rls_exception_registry` par `merx.register_rls_exception()`, avec son garde et sa justification en texte, que la base refuse vide. Le garde vaut `current_tenant` — le corps filtre sur `merx.current_tenant_id()` — ou `super_admin` — le corps exige `merx.is_super_admin()`, pour ce qui crée un commerce et ne peut donc pas en avoir un (`create_tenant`). `supabase/tests/conventions.ts` signale par son nom toute fonction non inscrite, et toute fonction inscrite dont le corps, lu dans `pg_proc`, n'appelle pas le garde déclaré : inscrire `super_admin` sans le garde ne passe pas. Le registre compte cinq entrées à la fin d'E2-04 : `create_tenant`, `create_worker`, `set_user_active`, `register_device`, `search_products`.

### 2.2 Noyau + packs

**Aucun pack en V1.** Le noyau seul couvre le métier cosmétique.

**RÈGLE** — Le noyau ne référence jamais une table de pack. Un pack ajoute ses propres tables et, au plus, des colonnes nullables sur les tables du noyau.

Packs prévus, à construire **uniquement sur demande client avérée** : déclinaisons (teintes, contenances), lots et péremption, compatibilité véhicule, numéros de série. Aucun n'est planifié.

### 2.3 Product / variant

**RÈGLE** — Tout produit possède **toujours** au moins une `variant`, y compris sans pack. La création d'un `product` crée automatiquement une variante par défaut.

**RÈGLE** — Le stock, les prix et les lignes de vente pointent sur `variant_id`, **jamais** sur `product_id`.

Sans cette règle, ajouter les déclinaisons plus tard impose de migrer tout le stock et tout l'historique.

### 2.4 Dépôt unique

**Pas de multi-dépôt.** Aucun écran de sélection de dépôt, aucun transfert, aucune notion de dépôt visible nulle part dans l'interface.

**RÈGLE** — `stock_level` et `stock_movement` portent néanmoins `warehouse_id`, pointant sur une ligne `warehouse` unique créée à l'inscription du commerce. Jamais affichée, jamais modifiable, jamais choisie.

C'est une colonne constante. Elle évite de réécrire l'historique de stock de tous les commerces installés si un client se révélait un jour avoir un dépôt séparé.

### 2.5 Hors-ligne — local-first

**RÈGLE** — L'application doit fonctionner **plusieurs jours** sans réseau, pas quelques heures. Ce n'est pas un cache avec file d'attente.

La base locale est la source de vérité quand l'appareil est hors-ligne. Le serveur réconcilie au retour du réseau.

| Composant | Choix |
|---|---|
| Base locale | SQLite sur l'appareil |
| Moteur de synchronisation | PowerSync sur Supabase |
| Portée synchronisée | Le commerce de l'utilisateur, intégralement |
| Sens | Bidirectionnel |

**RÈGLE** — Ne pas écrire le moteur de synchronisation. PowerSync lit le WAL Postgres et maintient la base SQLite locale. Règles de synchronisation déclaratives, alignées sur la RLS.

**RÈGLE — numérotation.** Les numéros de document sont attribués **localement**, avec un préfixe d'appareil : `BL-A-0001`, `BL-B-0001`. Séquence par `(tenant, device, doc_type, year)`. Le serveur n'attribue aucun numéro.

**RÈGLE — un appareil par commerce en V1.** `[À VALIDER]` Hypothèse retenue pour garder la réconciliation simple. Le schéma supporte plusieurs appareils (préfixe d'appareil, mouvements cumulatifs) mais aucun scénario multi-appareils hors-ligne simultané n'est traité en V1.

**RÈGLE — réconciliation.** Les mouvements de stock et les écritures de grand livre sont en **ajout seul** et s'additionnent : jamais d'écrasement. Les entités de référence (produit, client, prix) suivent la dernière écriture. Un stock négatif après synchronisation est accepté et signalé.

**RÈGLE — affichage.** Hors-ligne, le stock et le solde client sont affichés avec la mention « à la dernière synchronisation », datée. Ne jamais présenter une valeur potentiellement périmée comme certaine.

### 2.6 Charge de saisie

**RÈGLE — principe directeur, prime sur toute autre considération fonctionnelle.** Le seul champ obligatoire à la création d'un produit est le nom. Le seul champ obligatoire à la création d'un client est le nom.

Tout autre champ est facultatif. Une fonctionnalité privée de sa donnée se désactive silencieusement : ni avertissement, ni champ en rouge, ni rappel.

La règle est tenue par la base autant que par l'écran : un formulaire qui ne réclame rien échoue quand même si une colonne est passée NOT NULL. Toute table qui reçoit un formulaire de création s'inscrit par `merx.register_creation_form(table, colonne_de_nom)`, et `supabase/tests/conventions.test.ts` refuse, sur chacune, toute autre colonne obligatoire — NOT NULL sans défaut, ou `check (... is not null)`. `product` y est inscrit depuis E2-02 ; `client` (E6) et `supplier` (E8) le seront à leur création.

**RÈGLE** — Rien ne bloque une vente. Ni un stock à zéro, ni une donnée manquante. Le système signale, il n'interdit pas.

Un vendeur à qui l'outil réclame des informations retourne au carnet.

### 2.7 Stack

| Couche | Choix |
|---|---|
| Front | Vite + React + TypeScript, SPA |
| UI | Tailwind + shadcn/ui |
| Base serveur | PostgreSQL via Supabase |
| Base locale | SQLite via PowerSync |
| Auth | Supabase Auth |
| Livraison | PWA installable |
| Impression | ESC/POS 80 mm en réseau Wi-Fi, plus PDF A4 |

**Pas de Next.js.** Le rendu serveur n'apporte rien ici : tous les écrans sont derrière une authentification et les données sont lues depuis la base **locale**, pas depuis le serveur. Une SPA Vite livrée en PWA est plus simple et hors-ligne par défaut.

**Pas de backend maison, ni .NET ni autre.** L'isolation entre commerces doit être garantie par la base via RLS, pas par des filtres écrits à la main dans des centaines d'endroits. Un filtre oublié dans du code applicatif ne casse rien de visible : la fuite se découvre chez un client. Supabase fournit RLS, authentification et stockage sans code à auditer.

**RÈGLE — tests.** Tout critère d'acceptation vérifiable par machine devient un test automatisé. En particulier l'isolation entre commerces (E0-03) et les 7 jours hors-ligne (E9-02). Ces deux-là ne se vérifient pas à l'œil.

Le Bluetooth depuis une PWA n'est pas fiable. La V1 cible les imprimantes thermiques **réseau**. Si un pilote impose le Bluetooth, cela déclenche un wrapper Capacitor, pas une réécriture.

### 2.8 Langues

Français et arabe, bascule instantanée, RTL complet. Vocabulaire métier réel, pas d'arabe littéraire.

---

## 3. Rôles

Enum `user_role`.

| Rôle | Portée |
|---|---|
| `super_admin` | Tous les commerces. L'éditeur. |
| `owner` | Son commerce, tout. Seul à voir le prix d'achat et la marge. |
| `worker` | Vend, encaisse, gère le stock. Pas de coûts, pas de rapports, pas d'utilisateurs. |

Trois rôles suffisent : un commerce de Derb Omar a un patron et des employés, pas une hiérarchie. L'enum reste extensible si un commerce plus gros veut séparer le magasinier plus tard.

**RÈGLE** — `cost_price` et toute marge sont filtrés **côté serveur**. Les autres rôles ne reçoivent pas le champ dans la réponse API. Masquer dans l'interface n'est pas un contrôle d'accès.

**RÈGLE — placement des coûts.** Une colonne de coût ou de marge ne vit jamais sur une table lue par tous. Elle vit sur une **relation dédiée**, porteuse d'une policy restrictive exigeant la capacité `view_cost`, posée par `merx.apply_capability_restriction()`. `variant` n'a pas de `cost_price` ; `variant_cost` en a un.

La raison est mécanique, et elle ne se contourne pas. PostgREST parle à Postgres sous un seul rôle SQL, `authenticated` : le patron et l'employé sont le même rôle, ils ne diffèrent que par un claim du jeton. Donc les `GRANT` par colonne ne peuvent pas les distinguer ; la RLS est par ligne, pas par colonne ; et une vue `case when merx.can('view_cost') then cost_price end` renvoie `"cost_price": null` — la clé est dans la réponse, c'est du masquage, ce que la RÈGLE ci-dessus refuse. La seule façon d'obtenir l'**absence** de la clé est que la colonne ne soit sur aucune relation qu'un `worker` puisse lire.

Conséquence : l'absence est structurelle, pas conditionnelle. Même un défaut du contrôle de droits ne peut pas faire apparaître un coût dans la réponse d'une table qui n'en porte pas.

**RÈGLE — un seul helper de droits.** Toute vérification de droit passe par `merx.can(capability)`, qui consulte la matrice § 3.1 stockée en données (`merx.role_capability`). Un droit vérifié ailleurs est un droit que la matrice ne gouverne pas. `super_admin` est traité en amont du helper, comme il l'est par la policy `super_admin_all`.

### 3.1 Permissions

| Capacité | owner | worker |
|---|:--:|:--:|
| Voir le catalogue et le stock | ✓ | ✓ |
| Créer / modifier un produit | ✓ | — |
| Voir prix d'achat et marge | ✓ | — |
| Modifier la grille de prix | ✓ | — |
| Créer un bon de vente | ✓ | ✓ |
| Forcer un prix à la ligne | ✓ | ✓* |
| Annuler un document confirmé | ✓ | — |
| Créer / modifier un client | ✓ | ✓ |
| Fixer le plafond de crédit | ✓ | — |
| Dépasser le plafond | ✓ | — |
| Encaisser | ✓ | ✓ |
| Saisir une réception | ✓ | ✓** |
| Compter un inventaire | ✓ | ✓ |
| Valider les écarts | ✓ | — |
| Voir les rapports | ✓ | — |
| Gérer les utilisateurs | ✓ | — |
| Gérer les appareils | ✓ | — |
| Consulter le journal d'audit | ✓ | — |
| Régler les paramètres du commerce | ✓ | — |

\* `worker` peut forcer un prix uniquement au-dessus du `floor_price`. En dessous, refusé — sinon rien n'empêche de vendre à prix coûtant.

\*\* **La réception se saisit à deux mains : le `worker` saisit les quantités reçues, le `owner` saisit les coûts.** `goods_receipt_line.unit_cost` vit donc sur une relation confidentielle, comme `variant_cost` — RÈGLE de placement des coûts, § 3.

Sans cela, la protection de `variant_cost` ne vaut rien : un employé qui lit les lignes de réception recalcule le coût moyen pondéré lui-même. Une donnée protégée dont on laisse fuir les composants n'est pas protégée, elle demande juste une multiplication de plus.

*Décision enregistrée, non implémentée : la relation confidentielle des coûts de réception est construite en E8-03, avec le reste du module Achats.*

**RÈGLE** — Tout forçage de prix, toute annulation, tout dépassement de plafond, toute validation d'écart écrit dans `audit_log`.

---

## 4. Conventions

- Clés primaires : `uuid`.
- Montants : `numeric(12,2)`. **Jamais de flottant.**
- Quantités : `numeric(12,3)`.
- Dates : `timestamptz`, UTC en base, affichage `Africa/Casablanca`.
- Suppression : `deleted_at` sur les tables de référence. Documents et mouvements jamais supprimés, seulement annulés.
- Toute table porte `created_at`, `updated_at`, `created_by`, `device_id`.
- `tenant_id` a pour défaut `merx.current_tenant_id()`, le commerce du jeton, sur toute table conventionnée. L'application n'écrit jamais `tenant_id` ; une valeur étrangère envoyée explicitement reste refusée par le `with check` de `tenant_isolation`. Hors session (migration, peuplement de test), le défaut vaut NULL et la valeur doit être donnée. Arbitré en E2-02 ; contrôlé par `conventions.test.ts`.

**RÈGLE — domaines nommés.** Tout montant se déclare `money_amount`, toute quantité se déclare `quantity`. Ces deux domaines sont définis dans `public` par la migration initiale. Un `numeric` nu dans une table métier est une infraction, au même titre qu'un flottant : la précision ne doit dépendre d'aucune recopie à la main.

**RÈGLE — placement des schémas.** `public` ne contient que le métier : les tables exposées par l'API, et les deux domaines ci-dessus. Tout ce qui outille le schéma — registre des conventions, fonctions `apply_*_conventions()`, trigger `set_updated_at()` — vit dans le schéma `merx`, qui n'est jamais exposé par l'API. Une table métier ne se crée jamais dans `merx` ; un helper ne se crée jamais dans `public`.

Toute table de `public` doit être déclarée par `merx.apply_business_conventions()` ou `merx.apply_reference_conventions()`. Une table qui échappe à ces fonctions échappe aux conventions, et `supabase/tests/conventions.test.ts` la signale.

**RÈGLE — clés étrangères composites.** Toute clé étrangère entre tables métier porte `tenant_id` des deux côtés : `(tenant_id, x) references t (tenant_id, id)`. La table cible porte à cette fin une unicité sur `(tenant_id, id)`. Seule exception : l'ancre `tenant_id → tenant (id)`.

Une clé étrangère ne passe pas par la RLS : Postgres vérifie l'existence de la cible sans policy. Sans `tenant_id` dans la clé, un commerce rattache ses lignes à celles d'un autre ; une cascade chez le voisin détruit alors ses données, et une clé sans cascade empêche le voisin de supprimer les siennes. Avec lui, la ligne visée appartient forcément au même commerce — c'est la contrainte, pas une vérification à ne pas oublier. `created_by` y est soumis comme les autres. Posée en E2-01 ; E3, E4, E6 et E8 en dépendent. `supabase/tests/conventions.test.ts` refuse toute clé qui y déroge, et le générateur de lignes de `supabase/tests/isolation.ts` sait remplir cette forme sans connaître la table.

---

## 5. Modules

| # | Module | Rôle |
|---|---|---|
| M1 | Catalogue | Produits, variantes, prix |
| M2 | Stock | Mouvements, inventaire |
| M3 | Ventes | Devis, bons, retours, impression |
| M4 | Clients | Fiches, crédit |
| M5 | Achats | Fournisseurs, réceptions |
| M6 | Règlements | Encaissements, caisse |
| M7 | Rapports | Lecture seule |
| M8 | Administration | Commerce, utilisateurs, audit |

---

## 6. M1 — Catalogue

**Entités**

`category`
`id, tenant_id, name_fr, name_ar, parent_id, sort_order`

`product`
`id, tenant_id, code, name_fr, name_ar, category_id, brand, photo_url, unit_label, pieces_per_carton, is_active, deleted_at`

- `code` : référence interne, saisie libre, unique par tenant.
- `code_key` : colonne générée, `lower(code)`. C'est la clé du réimport (E2-05), et elle est stockée pour que l'égalité soit `leakproof`, donc utilisable comme condition d'index sous RLS (§ 2.1). Même portée que `product_code_per_tenant`, à la lettre près : rien de plus ne s'y plie.
- `pieces_per_carton` : entier nullable. Utilisé **uniquement** en réception et inventaire. Jamais à l'écran de vente.
- `photo_url` : le chemin de l'objet dans le compartiment Storage **privé** `product-photo`, `{product_id}/{uuid}.jpg` — pas une URL ; l'affichage signe le chemin. Photo réduite par l'appareil à 800 px au plus grand côté, JPEG 0,8 ; le compartiment n'accepte que du JPEG, 1 Mio au plus. Lecture : le produit du dossier doit être visible (RLS de `product`) ; dépôt : la même condition plus `manage_product` ; retrait : `manage_product`, l'isolation venant de la lecture. Arbitré en E2-02.

`variant`
`id, tenant_id, product_id, sku, barcode, sku_printed_at, attributes jsonb, floor_price, is_default, is_active, deleted_at`

- `attributes` : `{}` en V1.
- **La variante par défaut porte l'identifiant de son produit** (`variant.id = product.id`). Une tablette hors-ligne qui crée un produit fabrique sa variante sous le même identifiant que le serveur, sans se concerter avec lui : au retour du réseau, les deux désignent la même ligne (§ 2.5). Arbitré en E2-01.
- `sku` : dérivé de `product.code` à la création, nul si le produit n'a pas de code. Celui de la variante par défaut **suit la référence** quand elle change, tant qu'il n'en a pas divergé (valeur égale à l'ancienne référence, NULL compris) — sinon une référence libérée resterait tenue par l'ancien SKU. Arbitré en E2-02. `code` et `sku` sont uniques par commerce sans égard à la casse, parmi les lignes non supprimées ; espaces de bord retirés et chaîne vide ramenée à nul par la base.
- `barcode` : l'EAN du fabricant, scanné. Même portée d'unicité que `code` et `sku` — `variant_barcode_per_tenant`, par commerce, sans égard à la casse, parmi les variantes vivantes : deux grossistes vendent le même shampooing, donc portent le même EAN, et une unicité globale ferait échouer le second import sans que rien ne l'explique — l'autre ligne est invisible, elle est chez le voisin (§ 2.1). Normalisé comme le SKU, plus le **retour chariot** : une douchette tape le code puis Entrée, et un code porteur d'un CR invisible n'est égal à rien — le scan suivant ne le retrouve pas, et l'unicité ne le voit pas comme un doublon. Arbitré en E2-06.
- `sku_printed_at` : date de la première étiquette imprimée pour cette variante, nulle tant que rien ne l'est. **L'impression fige le SKU** — RÈGLE M1-5 ci-dessous. Posée par l'appareil, jamais effacée ni reculée ; refus `2F004`, celui de l'ajout seul (§ 9, M8-1). Arbitré en E2-06.
- Une variante ne change jamais de produit, et la dernière variante d'un produit ne se supprime pas tant que le produit existe (§ 2.3, « toujours »).
- La suppression douce d'un produit se propage à ses variantes vivantes, à la même date ; sa restauration rétablit celles qui portent exactement cette date.
- `floor_price` : plancher sous lequel un `worker` ne peut descendre. Ce n'est pas un coût — c'est un prix de vente minimum, lisible par tous.

`variant_cost`
`id, tenant_id, variant_id, cost_price`

- Une ligne par `variant`, au plus. Relation **restreinte** par la capacité `view_cost` — RÈGLE de placement des coûts, § 3. Un `worker` n'en lit aucune ligne, et `variant` ne porte pas la colonne : le nom `cost_price` n'apparaît dans aucune réponse qui lui est faite.
- Séparée de `variant` pour cette seule raison. Sans la contrainte de confidentialité, la colonne serait restée sur `variant`.
- Pas de coût connu, pas de ligne : effacer le coût supprime la ligne. Un seul garde, la policy `view_cost`, en lecture comme en écriture ; pas de restriction d'écriture en plus, qui refuserait l'employé avec le même `42501` sans qu'aucun test puisse la distinguer (règle E1-02). Arbitré en E2-03.
- Chaque écriture — création de la ligne, modification du prix, suppression — écrit son entrée `purchase_price_change` dans `audit_log` (RÈGLE M8-1), par trigger : l'écriture passe par PostgREST sans fonction intermédiaire, un contrôle applicatif se contournerait. L'entrée retient `variant_id` et `cost_price`, avant et après ; une mise à jour qui ne les change pas n'écrit rien. Une écriture sans commerce ni auteur dans le jeton est refusée (§ 9, M8-1). Addendum E2-03, à la clôture d'E2-04.

`price_break`
`id, tenant_id, variant_id, min_qty, unit_price`

- `unit_price` est nullable : NULL signifie **prix non renseigné**, et la vente ne propose alors aucun prix automatique — le vendeur le saisit. Jamais 0 par défaut : un oubli ferait vendre gratuitement, sans que rien ne le signale (§ 2.6). Arbitré en E2-03.
- La ligne `min_qty = 1` de la RÈGLE M1-2 est créée par la base pour **toute** variante, sans prix, **sous l'identifiant de sa variante** (`price_break.id = variant.id`) — même raisonnement hors-ligne que la variante par défaut. Elle ne se supprime pas tant que la variante existe, et ne change ni de quantité, ni de variante, ni d'état supprimé : seul son prix se modifie.
- Une quantité inférieure au plus petit `min_qty` — 0,5 face à la ligne à l'unité — ne résout **aucun** palier : pas de prix automatique. Un palier retenu sans prix ne retombe pas sur un palier inférieur. Étendre la ligne à l'unité en dessous de 1 réinterpréterait la RÈGLE M1-2. Arbitré en E2-03.
- La résolution tourne sur l'appareil (§ 2.5) ; la grille se saisit sur un écran à part, `/products/:id/prices`, ouvert depuis la fiche produit.

**Règles**

**RÈGLE M1-1** — Créer un `product` crée toujours une `variant` avec `is_default = true`.

**RÈGLE M1-2** — Prix : prendre la ligne `price_break` de plus grand `min_qty` inférieur ou égal à la quantité demandée. Une ligne `min_qty = 1` est obligatoire.

**RÈGLE M1-3** — Le prix est recalculé **à chaque changement de quantité**, jamais figé à la première saisie. Passer de 8 à 12 fait basculer toute la ligne au palier supérieur.

**RÈGLE M1-4** — Si la quantité est à moins de 20 % du palier suivant, afficher « +2 → 12,00 DH ». Fonction produit, pas décoration.

**RÈGLE M1-5** — Deux sources de code-barres, les deux prises en charge :
- **EAN fabricant** scanné et stocké dans `variant.barcode`. Voie principale en cosmétique : les produits de marque en portent un fiable.
- **Code 128 émis par le système**, encodant `variant.sku`, pour tout ce qui arrive sans code.

La recherche interroge les deux indifféremment.

**Ce qui est imprimé fige ce qui est imprimé** (E2-06). Les deux sources ne s'engagent pas de la même façon : l'EAN vient du carton et le fabricant en répond, tandis qu'un SKU imprimé par le système est une promesse qu'il tient. Une étiquette collée sur un carton doit continuer de désigner la même variante.

- **`sku_printed_at` fige le SKU**, et `merx.follow_product_code()` cesse alors de le faire suivre la référence (§ 6, `variant`). Ce qui est figé est le SKU, **pas la référence** : le patron garde le droit de corriger `product.code`, le champ le plus souvent faux après un import. Refuser le changement de référence l'aurait puni d'une faute de frappe pour toujours ; la divergence référence/SKU, elle, est déjà un état de première classe depuis E2-02.
- **Conséquence assumée : une référence libérée reste tenue par le SKU figé.** Recréer un produit sous l'ancienne référence est refusé par `variant_sku_per_tenant`, non par `product_code_per_tenant` — le code est imprimé sur des cartons, donc il est pris. L'application distingue les deux **au nom de la contrainte** et le dit en clair : « déjà utilisée par un autre produit » enverrait chercher une référence que plus personne ne porte.
- **Une planche ne fige que les SKU qu'elle imprime réellement.** Une étiquette portant l'EAN du fabricant n'engage rien, et la référence de ce produit-là reste librement corrigeable.
- **Un produit sans aucun code reçoit un SKU engendré par l'appareil**, `A-00001` : la lettre de l'appareil (§ 2.5, unique par commerce et jamais recyclée), un tiret, cinq chiffres — largeur fixe, donc l'ordre du texte est celui des nombres. Le serveur n'attribue rien : une étiquette s'imprime au comptoir, parfois sans réseau. Le compteur local **n'est pas l'autorité** — `variant_sku_per_tenant` l'est : un numéro pris fait passer au suivant, et un stockage local vidé repart au-dessus du plus grand SKU connu du serveur, variantes supprimées comprises. Une étiquette collée dans le dépôt tient son numéro même si son produit ne vit plus. Ce n'est pas `document_sequence` (M3-2), qui appartient à E4-02.
- **Lecture par la caméra : `BarcodeDetector` seul**, sans dépendance — le décodage est celui de l'appareil. § 2.6 s'applique à la lettre : API absente, origine en clair, caméra absente ou accès refusé, **le bouton ne s'affiche pas**, rien ne réclame, rien ne redemande, et `getUserMedia` n'est jamais appelé avant un appui. Le champ reste saisissable à la main, ce qui couvre la douchette du comptoir — elle tape comme un clavier. L'API est une hypothèse sur le matériel : à vérifier à la main sur un Android d'entrée de gamme (BACKLOG E2-06), et un repli wasm ne s'ajoutera qu'à ce moment-là.
- **Planche A4 pleine** : 3 × 70 mm par 8 × 37 mm, 24 étiquettes, aucune marge — les colonnes occupent les 210 mm exactement, donc rien à régler d'une imprimante à l'autre. Code 128 dessiné en **SVG** et non en canvas : une planche sort à 300 ou 600 dpi, et des barres de 0,33 mm rendues à la résolution de l'écran ressortent floues, donc illisibles à la douchette. Une valeur que le Code 128 n'encode pas — hors imprimable ASCII, « CRÈME-1 », un nom arabe — ne produit pas d'étiquette, et rien ne réclame de la translittérer (§ 2.6).

**Recherche** (E2-04, point de rupture n° 4). Une seule fonction, `public.search_products(q)`, sert la liste et servira la vente. Elle est `security definer` : c'est l'exception nommée de § 2.1, et elle rend des variantes, sans aucun coût (§ 3).

- **Champs** : nom français, nom arabe, `code` sur le produit ; `sku`, `barcode` sur la variante. Chacun est stocké sous sa forme comparable, en colonne générée (`search_name`, `search_code`, `search_sku`, `search_barcode`) : minuscules, sans accents, arabe sans voyelles brèves ni tatweel, formes d'alif ramenées à ا, ى → ي, ة → ه, ؤ → و, ئ → ي, chiffres arabes ramenés aux chiffres latins (`merx.search_fold()`). Stocké et non recalculé : un pliage coûte 19 µs, et le classement en demandait cinq par candidat — 582 ms pour « creme ».
- **Un mot est trouvé** en sous-chaîne (« 451 » trouve « 4512 »), ou à une faute près : similarité par mot `pg_trgm` ≥ **0,4**, pour un mot d'au moins trois caractères qui n'est pas fait que de chiffres. Tous les mots de la requête doivent être trouvés.
- **Le seuil est 0,4 — ni le défaut de `pg_trgm` (0,6), ni 0,5.** Mesuré en E2-04 : l'omission d'une lettre dans un mot court vaut exactement 0,40 — « crme » pour « creme », « شمبو » pour « شامبو », « صبون » pour « صابون », « عطار » pour « عطر ». C'est la faute courante en arabe, où l'on saute un ا ou un ي. À 0,5, aucun de ces mots ne trouve rien, et le critère « tolérante aux fautes » d'E2-04 n'est plus rempli. Le prix est du bruit : « savn » ramène 1 013 candidats à 0,4 contre 474 à 0,5. Il est borné — les résultats trouvés par faute seule sont classés après tout résultat exact ou partiel, et la liste s'arrête à 50. **Remonter ce seuil pour réduire le bruit fait perdre ces cas-là, pas le bruit seulement.** Hors d'atteinte à 0,4 comme à 0,5 : « sabon » pour « savon » (0,33), « مسكرا » pour « ماسكارا » (0,17).
- **Un mot fait seulement de chiffres** se cherche en sous-chaîne, jamais à une faute près. Mesuré : « 6110000 » coûtait 1 105 ms, chaque code-barres commençant par 611 lui ressemblant en trigrammes ; et « 4521 » vaut 0,40 face à « 4512 » — il le trouverait, ce qui n'est pas une référence partielle, c'est une autre référence.
- **Classement** : référence, SKU ou code-barres égal à la requête ; référence ou SKU qui commence par elle ; qui la contient ; nom qui contient chaque mot ; code-barres qui la contient ; le reste, à une faute près. Puis la similarité, puis le nom. 50 résultats au plus.
- **Requête vide** : les 50 premières variantes par ordre alphabétique. **Requête d'un ou deux caractères** : cherchée en sous-chaîne — un trigramme n'en extrait rien, la recherche passe alors par l'index du commerce. « 45 » trouve.
- **Performance** : moins de 300 ms sur 10 000 références, et surtout l'index utilisé — Bitmap Index Scan sur `product_search` et `variant_search` à partir de trois caractères, index du commerce en dessous, aucun Seq Scan. `supabase/tests/product-search.test.ts` le vérifie sur le plan d'exécution du vrai appel, parmi 40 000 produits d'autres commerces : un chronomètre seul passe même sans index.
- **Ce qui garde l'index utilisé**, trois décisions mesurées en E2-04, chacune tombée d'une assertion de plan rouge :
  - la fonction est en plpgsql, `plan_cache_mode = force_custom_plan` : planifiée en `language sql`, elle ignorait la requête, estimait mal le motif, et lisait tout le commerce sur la branche produit (192 ms pour cette seule branche) ;
  - les index portent `tenant_id` avec le texte (`btree_gin`) : avec un index trigramme seul, les requêtes larges (« creme ») repassent par l'index du commerce plus un filtre. Le sabotage qui le défait est d'abord resté vert sur une exécution où le plan tombait du bon côté ; l'assertion relit désormais le plan d'une session chaude, et il tombe. Avec ou sans `tenant_id` dans l'index, une recherche lit les listes de trigrammes de tous les commerces : à remesurer à plusieurs centaines de commerces ;
  - les index sont en **`fastupdate = off`** : par défaut, GIN met les insertions en liste d'attente jusqu'au vacuum, et le planificateur écarte alors l'index. Mesuré : 12 requêtes sur 12 par l'index sur des index propres, **3 sur 12 juste après l'insertion de 10 000 produits**, 12 sur 12 avec `fastupdate = off`. Un import (E2-05) insère en masse ; **remettre le réglage par défaut fait perdre l'index après chaque import, sans erreur visible.**
- Hors-ligne, la recherche tournera sur l'appareil (E9) : les colonnes générées se synchronisent, la manière de les chercher en SQLite reste à écrire.

**Écrans.** Liste produits, fiche produit, grille de prix, import CSV, génération d'étiquettes.

**Import** (E2-05, point de rupture n° 1). Correspondance de colonnes, prévisualisation, rapport d'erreurs ligne par ligne. C'est le point de rupture de l'adoption : y consacrer plus de soin qu'à tout autre écran.

- **Une fonction, `public.import_products(rows jsonb)`, en `security invoker`.** Une ligne de fichier écrit dans quatre tables — `product`, sa variante, sa ligne `min_qty = 1`, parfois `variant_cost` : depuis l'appareil, ce seraient trois ou quatre requêtes par ligne, sans atomicité entre elles. **RÈGLE** — cette fonction ne devient pas `security definer` : les policies s'y appliquent ligne par ligne, le journal du prix d'achat y reçoit l'auteur du jeton (§ 9, M8-1), et elle n'entre pas au registre des exceptions RLS (§ 2.1).
- **Chaque ligne a son point de sauvegarde** (`begin … exception … end`). Les lignes valides s'importent même si d'autres échouent ; une ligne fautive est annulée entière, et le rapport rend son numéro, le code SQL, le nom de contrainte et le message. Un import tout-ou-rien est inutilisable sur un vrai fichier — il y a toujours une ligne fautive.
- **Par blocs de 50 lignes.** Au-delà de 64 sous-transactions écrivantes, Postgres déborde son cache de sous-transactions et les autres sessions lisent `pg_subtrans` ; `statement_timeout` coupe par ailleurs `authenticated`. Un bloc donne aussi la progression, et une coupure réseau ne perd que le bloc en cours.
- **Réimport sur `code`**, sans égard à la casse, parmi les produits non supprimés — la portée de `product_code_per_tenant`. La clé est stockée : `product.code_key`, colonne générée valant `lower(code)`. Mesuré en E2-05 : écrit `lower(p.code) = any(…)`, le rapprochement coûtait un parcours complet par bloc — 400 ms sur 50 000 lignes, 71 s pour 2 000 lignes — parce que `lower()` n'est pas `leakproof` sous RLS (§ 2.1) ; l'égalité sur une colonne stockée l'est, et l'index sert. 7,1 s après. Surtout pas `merx.search_fold()` ici : il plie les accents, et « CRÈME-1 » et « CREME-1 » sont deux références distinctes.
- **Une mise à jour qui ne change rien n'écrit rien** — ni `updated_at`, ni entrée au journal, rien à réconcilier (§ 2.5) ; **une cellule vide n'efface rien** (§ 2.6). Une ligne sans référence est recréée à chaque import, et l'aperçu le dit : rapprocher par le nom fusionnerait deux produits différents.
- **Ne jamais deviner.** Un prix dont la lecture est ambiguë — « 1.250 » : 1 250 DH ou 1,25 DH ? — est rejeté, avec sa colonne et sa valeur citées ; de même un prix négatif, plus de deux décimales, ou un nombre qu'Excel a écrit en notation scientifique (un EAN de treize chiffres s'affiche ainsi même au format « Standard »). Le taux de rejet n'est pas un argument pour se mettre à deviner : l'erreur se paie au comptoir, au millième près. Le rapport des rejets se télécharge, se corrige et se réimporte tel quel.
- **Un 0 saisi n'est pas une cellule vide.** Les deux donnent « prix non renseigné » (E2-03), et l'aperçu les compte séparément — sinon un commerçant qui a vraiment mis 0 partout ne comprend pas pourquoi rien n'a de prix.
- **Encodage.** UTF-8 strict, puis repli `windows-1256` — qui lit l'arabe *et* les accents français —, et réparation du double encodage (« CrÃ¨me ») même dans un fichier valide. Le choix se corrige à la main à l'aperçu.
- **Performance** : 2 000 lignes en 7,1 à 8,4 s par PostgREST sur le stack local, parmi 20 000 produits d'autres commerces. Et surtout, **l'index de recherche survit à l'import** : les 16 requêtes de la batterie d'E2-04 l'empruntent encore après 10 000 lignes importées, sans vacuum. Avec `fastupdate = on`, 3 sur 16 seulement — d'où le réglage, dont E2-05 a mesuré le coût à l'insertion : de l'ordre de 15 %, et la dépense n'est pas évitée, seulement reportée sur les recherches.

---

## 7. M2 — Stock et inventaire

**Entités**

`warehouse`
`id, tenant_id, name, is_default`
Une seule ligne par commerce, créée automatiquement, jamais exposée.

`stock_level`
`id, tenant_id, variant_id, warehouse_id, quantity`
Unicité sur `(variant_id, warehouse_id)`.

`stock_movement`
`id, tenant_id, variant_id, warehouse_id, movement_type, quantity, source_type, source_id, note, device_id, created_by, created_at`

- `movement_type` : `sale | return | receipt | adjustment | inventory`
- `quantity` signée, négative en sortie.

`inventory_session` + `inventory_line`
`inventory_line : variant_id, counted_qty, system_qty, variance, reason, validated`

**Règles**

**RÈGLE M2-1** — `stock_level` n'est **jamais** écrit directement. Tout passe par un `stock_movement`. `stock_level` est un agrégat maintenu par trigger.

**RÈGLE M2-2** — `stock_movement` est immuable. Une erreur se corrige par un mouvement inverse, jamais par UPDATE ou DELETE. C'est ce qui rend la synchronisation possible.

**RÈGLE M2-3** — Stock négatif autorisé. Signalé, jamais bloquant.

**RÈGLE M2-5** — **L'écriture d'un mouvement est fermée par défaut, ouverte type par type.** La policy d'insertion de `stock_movement` exige une capacité qui dépend de `movement_type`, lue dans `merx.movement_type_capability` et vérifiée par `merx.can()` — § 3, RÈGLE un seul helper. Un type sans capacité inscrite est refusé, par un garde distinct dont le message le nomme.

La table est vide à la création du module : tant qu'aucun écran n'écrit un type de mouvement, personne ne doit pouvoir en écrire un. Chaque story ouvre le type dont elle a besoin, et seulement celui-là — `adjustment` en E3-03, `inventory` en E3-04, `sale` et `return` en E4, `receipt` en E8-02. Sans cela, un employé poste un `adjustment` arbitraire par l'API pendant les deux étapes qui séparent la table de son écran. Arbitré en E3-01.

**RÈGLE M2-4** — En inventaire, saisie en cartons quand `pieces_per_carton` existe, avec conversion automatique. On compte des cartons sur une étagère, pas des pièces.

**Écrans.** État du stock, fiche mouvement d'une variante, session d'inventaire en mode scan, validation des écarts.

---

## 8. M3 — Ventes

**Entités**

`sale_document`
`id, tenant_id, doc_type, doc_number, device_id, client_id, warehouse_id, status, subtotal, discount_total, total, notes, created_by, issued_at`

- `doc_type` : `quote | order | delivery_note`
- `status` : `draft | confirmed | delivered | cancelled`

`sale_line`
`id, tenant_id, sale_document_id, variant_id, quantity, unit_price, price_source, line_discount, line_total`

- `price_source` : `auto | manual`

`document_sequence`
`id, tenant_id, device_id, doc_type, year, last_number`

`return_document` + `return_line`

**Règles**

**RÈGLE M3-1** — Le document par défaut est le **bon de livraison**. Aucune facture fiscale en V1.

**RÈGLE M3-2** — Numérotation **locale**, préfixée par l'appareil : `BL-A-0001`. Séquence par `(tenant, device, doc_type, year)`, sans trou. Attribuée à la confirmation. Le serveur n'attribue rien.

**RÈGLE M3-3** — Un document `confirmed` n'est jamais modifié ni supprimé. On l'annule, ce qui génère les mouvements de stock inverses.

**RÈGLE M3-4** — Une transformation (devis → commande → bon) crée un **nouveau** document lié au précédent, sans muter l'original.

**RÈGLE M3-5** — Le stock est décrémenté à la confirmation du `delivery_note`, pas du devis ni de la commande.

**RÈGLE M3-6** — L'écran de vente accepte trois entrées, aboutissant toutes à la même ligne : scan de code-barres, saisie de la référence, sélection sur grille photo. **Ne pas construire un écran scan-only** : la marchandise n'est pas toujours à portée de main.

**Écrans.** Écran de vente (le plus critique de l'application), liste des documents, détail, retour, aperçu avant impression.

**Cible.** Bon de 10 lignes en moins de 90 secondes. Chaque interaction superflue se paie mille fois par jour.

---

## 9. M4 à M8

### M4 — Clients et crédit

`client`
`id, tenant_id, name, phone, city, address, credit_limit, ice, notes, is_active, deleted_at`

- `ice` : nullable, masqué, inutilisé en V1.

`client_ledger_entry`
`id, tenant_id, client_id, entry_type, amount, source_type, source_id, entry_date, device_id, created_by`

- `entry_type` : `debit | credit`

**RÈGLE M4-1** — Le solde n'est **pas** une colonne. Il se calcule depuis le grand livre.

**RÈGLE M4-2** — Grand livre en ajout seul. Une correction est une écriture inverse. Indispensable à la synchronisation.

**RÈGLE M4-3** — Dépassement de plafond : avertissement bloquant pour `worker`, franchissable par `owner` seul, tracé.

**RÈGLE M4-4** — Relevé de compte exportable en PDF, lisible sur un écran de téléphone.

### M5 — Achats

`supplier`
`id, tenant_id, name, phone, country, notes, is_active`

`goods_receipt`
`id, tenant_id, supplier_id, warehouse_id, receipt_number, device_id, status, received_at`

`goods_receipt_line`
`id, tenant_id, goods_receipt_id, variant_id, quantity`

`goods_receipt_line_cost`
`id, tenant_id, goods_receipt_line_id, unit_cost`

- Relation **restreinte** par `view_cost`, comme `variant_cost` — RÈGLE de placement des coûts, § 3, et note \*\* de § 3.1. Le `worker` saisit les quantités reçues, le `owner` saisit les coûts.
- Séparée pour que la protection de `variant_cost` tienne : un employé qui lirait les lignes de réception recalculerait le coût moyen pondéré lui-même.

**RÈGLE M5-1** — Pas de ventilation de frais annexes en V1. `unit_cost` est saisi directement.

**RÈGLE M5-2** — La validation d'une réception met à jour `variant_cost.cost_price` en coût moyen pondéré, en créant la ligne si elle n'existe pas. Le coût ne vit pas sur `variant` — RÈGLE de placement des coûts, § 3.

L'écriture se fait donc dans une relation qu'un `worker` ne peut pas lire, alors que § 3.1 lui accorde « saisir une réception ». La validation passe par une fonction `security definer` qui recalcule le coût moyen pondéré : l'employé déclenche le calcul sans jamais recevoir son résultat. À traiter en E8 ; ce n'est pas une exception à la règle, c'est sa conséquence.

**RÈGLE M5-3** — Saisie en cartons quand `pieces_per_carton` existe.

### M6 — Règlements

`payment`
`id, tenant_id, direction, client_id, supplier_id, method, amount, payment_date, note, device_id, created_by`

- `direction` : `in | out`
- `method` : `cash` en V1. L'enum prévoit `cheque | bill_of_exchange | transfer | card`, non implémentés.

`payment_allocation`
`id, tenant_id, payment_id, sale_document_id, amount`

`cash_session`
`id, tenant_id, opened_by, opened_at, opening_amount, closed_at, counted_amount, expected_amount, variance`

**RÈGLE M6-1** — Un règlement peut être ventilé sur plusieurs documents. Les paiements partiels sont la norme.

**RÈGLE M6-2** — Chèques et traites hors V1. Ne pas construire le portefeuille d'effets.

### M7 — Rapports

Lecture seule, aucune entité. Doit fonctionner **hors-ligne**, calculé depuis la base locale.

1. Journée : ventes, encaissements, crédit accordé, marge — **`owner` seul pour la marge**
2. Ventes par jour, semaine, mois
3. Top produits par quantité et par chiffre d'affaires
4. Encours clients avec ancienneté (0-30, 31-60, 61-90, 90+)
5. Valorisation du stock
6. Références dormantes

**RÈGLE M7-1** — Tout rapport contenant un coût ou une marge est refusé côté serveur hors rôle `owner`.

**RÈGLE M7-2** — Le rapport de journée est la fonction que le patron ouvrira chaque soir. Doit être instantané et lisible sur téléphone.

### M8 — Administration

`tenant`
`id, business_name, owner_name, phone, city, subscription_status, trial_ends_at, created_at`

`app_user`
`id, tenant_id, auth_user_id, full_name, phone, role, is_active, last_seen_at`

`device`
`id, tenant_id, label, prefix, last_sync_at, is_active`

- `prefix` : lettre unique par commerce, utilisée dans la numérotation. **Attribuée une seule fois** : une lettre libérée par un appareil retiré n'est jamais redonnée, sinon le nouvel appareil recommence une numérotation que l'ancien a déjà écrite sur du papier.
- Un appareil s'enregistre lui-même à la première connexion, sous un identifiant engendré par le client. La lecture de la table exige la capacité `manage_devices` ; l'enregistrement, non — c'est l'employé qui tient la tablette.

`audit_log`
`id, tenant_id, user_id, action, entity_type, entity_id, before jsonb, after jsonb, created_at`

`tenant_setting`
`id, tenant_id, key, value jsonb`

- `key` est l'enum `public.setting_key`. Clés V1 : `print_header` (nom, téléphone et adresse imprimés en tête du bon, un seul objet), `default_language` (`fr` par défaut), `printer_address` (vide par défaut : pas d'imprimante, l'impression thermique ne s'offre pas).
- **Les défauts vivent à un seul endroit : `merx.setting_default`.** Le code applicatif n'en porte aucun. `merx.seed_tenant_settings()` matérialise les lignes manquantes ; `create_tenant()` l'appelle, donc tout commerce a une ligne par clé dès sa création. Toute migration qui ajoute une clé ajoute son défaut et rappelle la fonction sur tous les commerces.
- Lecture ouverte à tout le commerce — l'employé imprime le bon et travaille dans la langue du commerce. Écriture réservée à `manage_settings`, par `merx.apply_write_capability_restriction()`.

**RÈGLE M8-1** — Écrivent obligatoirement dans `audit_log` : forçage de prix, annulation de document, dépassement de plafond, validation d'écart, modification de rôle, changement de prix d'achat.

Ces six actions sont l'enum `public.audit_action` — `price_override`, `document_cancellation`, `credit_limit_override`, `stock_variance_approval`, `role_change`, `purchase_price_change`. Aucune n'est implémentée en E1-04 : elles arrivent avec leurs modules et emploient ces étiquettes-là. `purchase_price_change` est branchée sur `variant_cost` depuis la clôture d'E2-04 (addendum E2-03), par un trigger que pose `merx.apply_audit()` — la même forme servira `goods_receipt_line_cost` en E8-03, et `supabase/tests/conventions.ts` refuse toute relation restreinte par `view_cost` qui n'est pas journalisée. **Hors session, une écriture journalisée est refusée** : sans commerce ni auteur dans le jeton, `merx.log_audit()` lève, et l'écriture avec — `service_role` et `postgres` compris. Seul le harnais de test suspend les triggers, pour peupler et ranger.

**RÈGLE M8-2** — `audit_log` est en ajout seul, pour tous : ni UPDATE, ni DELETE, ni TRUNCATE, `owner` compris. L'unique chemin d'écriture est `merx.log_audit()`, que l'application ne peut pas appeler — `authenticated` n'a ni le privilège d'INSERT sur la table ni celui d'exécuter la fonction. Le commerce et l'auteur y viennent du jeton signé, jamais des paramètres : un journal dont l'appelant choisit la signature ne prouve rien.

La lecture exige `view_audit_log` sur la relation elle-même, comme pour les coûts (§ 3, RÈGLE de placement) : une route masquée se contourne en s'adressant directement à l'API.

---

## 10. Points de rupture

Traiter avec un soin disproportionné.

1. **L'import du catalogue.** Si 2 000 références ne rentrent pas en moins d'une heure, rien d'autre ne compte.
2. **La vitesse de l'écran de vente.** Chaque tap superflu est payé mille fois par jour.
3. **La synchronisation.** Une vente perdue au retour du réseau et la confiance est perdue.
4. **La recherche.** Tolérante aux fautes, en arabe et en français, sur référence partielle.
5. **La visibilité des coûts.** Une seule fuite du prix d'achat vers un vendeur et le patron désinstalle.

---

## 11. Ordre de construction

| # | Contenu | Fin d'étape |
|---|---|---|
| 1 | Schéma, RLS, auth, M8 | Créer un commerce, inviter un utilisateur |
| 2 | M1 catalogue + import CSV | 2 000 références en moins d'1 h |
| 3 | M2 stock et mouvements | Mouvements justes et traçables |
| 4 | M3 vente, en ligne | Bon de 10 lignes en moins de 90 s |
| 5 | Impression thermique + PDF | Sort sur une vraie imprimante |
| 6 | M4 clients et crédit | Solde exact au dirham |
| 7 | M6 encaissement espèces + caisse | Clôture de journée juste |
| 8 | M5 réception | Stock qui entre, coût qui se met à jour |
| 9 | M2 inventaire | Écarts calculés et validés |
| 10 | PowerSync, base locale | Vente pendant 7 jours en mode avion |
| 11 | M7 rapports | Rapport de journée hors-ligne |

**Arrêt obligatoire après l'étape 5.** Aller voir trois commerçants réels. Les étapes 6 à 11 sont arbitrées par ce qu'ils diront, pas par ce document.

**Après la V1**, dans cet ordre et uniquement sur demande client : déclinaisons, chèques et traites, frais annexes à la réception, multi-dépôt.