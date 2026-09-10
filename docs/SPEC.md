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

**RÈGLE — domaines nommés.** Tout montant se déclare `money_amount`, toute quantité se déclare `quantity`. Ces deux domaines sont définis dans `public` par la migration initiale. Un `numeric` nu dans une table métier est une infraction, au même titre qu'un flottant : la précision ne doit dépendre d'aucune recopie à la main.

**RÈGLE — placement des schémas.** `public` ne contient que le métier : les tables exposées par l'API, et les deux domaines ci-dessus. Tout ce qui outille le schéma — registre des conventions, fonctions `apply_*_conventions()`, trigger `set_updated_at()` — vit dans le schéma `merx`, qui n'est jamais exposé par l'API. Une table métier ne se crée jamais dans `merx` ; un helper ne se crée jamais dans `public`.

Toute table de `public` doit être déclarée par `merx.apply_business_conventions()` ou `merx.apply_reference_conventions()`. Une table qui échappe à ces fonctions échappe aux conventions, et `supabase/tests/conventions.test.ts` la signale.

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
- `pieces_per_carton` : entier nullable. Utilisé **uniquement** en réception et inventaire. Jamais à l'écran de vente.

`variant`
`id, tenant_id, product_id, sku, barcode, attributes jsonb, floor_price, is_default, is_active, deleted_at`

- `attributes` : `{}` en V1.
- `floor_price` : plancher sous lequel un `worker` ne peut descendre. Ce n'est pas un coût — c'est un prix de vente minimum, lisible par tous.

`variant_cost`
`id, tenant_id, variant_id, cost_price`

- Une ligne par `variant`, au plus. Relation **restreinte** par la capacité `view_cost` — RÈGLE de placement des coûts, § 3. Un `worker` n'en lit aucune ligne, et `variant` ne porte pas la colonne : le nom `cost_price` n'apparaît dans aucune réponse qui lui est faite.
- Séparée de `variant` pour cette seule raison. Sans la contrainte de confidentialité, la colonne serait restée sur `variant`.

`price_break`
`id, tenant_id, variant_id, min_qty, unit_price`

**Règles**

**RÈGLE M1-1** — Créer un `product` crée toujours une `variant` avec `is_default = true`.

**RÈGLE M1-2** — Prix : prendre la ligne `price_break` de plus grand `min_qty` inférieur ou égal à la quantité demandée. Une ligne `min_qty = 1` est obligatoire.

**RÈGLE M1-3** — Le prix est recalculé **à chaque changement de quantité**, jamais figé à la première saisie. Passer de 8 à 12 fait basculer toute la ligne au palier supérieur.

**RÈGLE M1-4** — Si la quantité est à moins de 20 % du palier suivant, afficher « +2 → 12,00 DH ». Fonction produit, pas décoration.

**RÈGLE M1-5** — Deux sources de code-barres, les deux prises en charge :
- **EAN fabricant** scanné et stocké dans `variant.barcode`. Voie principale en cosmétique : les produits de marque en portent un fiable.
- **Code 128 émis par le système**, encodant `variant.sku`, pour tout ce qui arrive sans code.

La recherche interroge les deux indifféremment.

**Écrans.** Liste produits, fiche produit, grille de prix, import CSV, génération d'étiquettes.

**Import.** Correspondance de colonnes, prévisualisation, rapport d'erreurs ligne par ligne. C'est le point de rupture de l'adoption : y consacrer plus de soin qu'à tout autre écran.

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

Ces six actions sont l'enum `public.audit_action` — `price_override`, `document_cancellation`, `credit_limit_override`, `stock_variance_approval`, `role_change`, `purchase_price_change`. Aucune n'est implémentée en E1-04 : elles arrivent avec leurs modules et emploient ces étiquettes-là.

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