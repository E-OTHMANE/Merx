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
- [x] Vite + React + TypeScript en mode strict, livré en PWA
- [x] Tailwind et shadcn/ui installés, un composant de test rendu
- [x] `npm run dev`, `build`, `lint`, `typecheck`, `test` fonctionnent
- [x] Vitest configuré — **tout critère d'acceptation vérifiable par machine devient un test**
- [x] Supabase local démarre via `npx supabase start`
- [x] `npx supabase db reset` reconstruit depuis les migrations
- [x] Arborescence conforme à `CLAUDE.md` : `src/app`, `src/modules`, `src/lib`, `supabase/`

---

### E0-02 — Schéma de base et conventions
**Étape 1** · dépend de E0-01

**En tant que** développeur, **je veux** des conventions appliquées dès la première migration, **afin de** ne pas les rétro-corriger sur 30 tables.

**Critères d'acceptation**
- [x] Toutes les clés primaires en `uuid`, générées par la base
- [x] Montants en `numeric(12,2)`, quantités en `numeric(12,3)` — **aucun flottant nulle part** — *par les domaines `money_amount` et `quantity`, un `numeric` nu étant refusé (SPEC § 4)*
- [x] Dates en `timestamptz`, stockées en UTC
- [x] Toute table métier porte `tenant_id`, `created_at`, `updated_at`, `created_by`, `device_id`
- [x] `updated_at` maintenu par trigger
- [x] Tables de référence : colonne `deleted_at` pour la suppression douce
- [x] Une seule migration initiale, relisible

**Notes** — `SPEC.md` § 4.

---

### E0-03 — Multi-tenant et RLS
**Étape 1** · dépend de E0-02

**En tant qu'**éditeur, **je veux** que deux commerces ne puissent jamais se voir, **afin de** ne pas perdre la totalité de mes clients sur une seule fuite.

**Critères d'acceptation**
- [x] Tables `tenant` et `app_user` créées
- [x] RLS activée sur **toutes** les tables métier, sans exception
- [x] Les policies dérivent `tenant_id` du JWT, jamais d'un paramètre client
- [x] Aucune requête applicative ne filtre `tenant_id` à la main — *hors les fonctions inscrites à `merx.rls_exception_registry`, dont l'exception nommée de SPEC § 2.1 (E2-04)*
- [x] Test automatisé : l'utilisateur du commerce A ne lit ni n'écrit aucune ligne du commerce B, sur chaque table
- [x] Le rôle `super_admin` accède à tous les tenants par une policy distincte et explicite

**Notes** — `SPEC.md` § 2.1. La story n'est pas terminée sans le test d'isolation.

**À instruire — relevé en E2-04, non traité.** Les deux policies permissives de chaque table métier se combinent par OU : le filtre que Postgres applique devient `(tenant_id = merx.current_tenant_id()) OR merx.is_super_admin()`, et aucun index ne sert une telle condition — pas même celui de `tenant_id`. Mesuré sur le stack local, cinq commerces de 10 000 produits, sous le jeton d'un employé : la liste des produits, telle que `listProducts()` la demande, fait un **Seq Scan de toute la table, 410 ms** pour les 9 517 lignes du commerce ; la même requête, `super_admin_all` retirée dans une transaction annulée, passe par l'index du commerce en **13,5 ms**. Toutes les tables métier portent cette paire de policies : toute requête de l'application paie la table entière, tous commerces confondus, et le coût croît avec leur nombre. Le dernier critère ci-dessus — « une policy distincte et explicite » pour `super_admin` — est précisément ce qui produit ce OU ; une correction devra le tenir, et passer le balayage d'isolation. La recherche produit y échappe par l'exception nommée de SPEC § 2.1, pas par une correction.

**Retouche du balayage d'isolation — après E2-04.** Le balayage tourne dans une seule transaction, et ses `select`, `update` et `delete` n'étaient pas protégés par un point de sauvegarde : la première erreur avortait la transaction, et toutes les tables suivantes tombaient sur « current transaction is aborted », pour une régression qui n'était pas la leur. Mesuré sur le sabotage « garde "rien n'a changé" retiré » du journal du prix d'achat : **avant, 27 tests tombés, dont 25 en cascade** — `warehouse` rouge à cause de `variant_cost`. Chaque requête du balayage passe désormais par `attempt()`, donc par un point de sauvegarde, et une erreur se lit dans l'assertion de sa table avec son code. **Après, le même sabotage fait tomber 2 tests, les 2 vraies détections, 0 en cascade.** La propriété dont tout le projet dépend — un garde retiré, un test tombe, et il nomme la bonne table — tient à nouveau, et ne se dégradera plus avec E3, E4 et E6.

---

### E0-04 — Authentification
**Étape 1** · dépend de E0-03

**En tant qu'**utilisateur, **je veux** me connecter, **afin d'**accéder à mon commerce.

**Critères d'acceptation**
- [x] Connexion par email et mot de passe via Supabase Auth — *par téléphone et mot de passe : l'adresse Supabase Auth est dérivée du numéro normalisé (arbitré en E1-01)*
- [x] Session persistante entre les redémarrages de l'application
- [x] Déconnexion vidant la session locale
- [x] Les routes protégées redirigent vers la connexion
- [x] `app_user` lié à `auth.users`, avec `tenant_id` et `role`
- [ ] Écran de connexion utilisable au doigt sur téléphone — *hauteurs tactiles vérifiées en jsdom ; à vérifier à la main, sur un Android d'entrée de gamme*

---

### E0-05 — Rôles et permissions
**Étape 1** · dépend de E0-04

**En tant que** patron, **je veux** que mon employé ne voie pas mes prix d'achat, **afin de** pouvoir mettre l'outil entre ses mains.

**Critères d'acceptation**
- [x] Enum `user_role` : `super_admin`, `owner`, `worker`
- [x] Un helper serveur unique porte toutes les vérifications de droits
- [x] `cost_price` et toute marge sont **retirés de la réponse API** pour `worker` — pas masqués dans l'interface
- [x] Test : un appel API brut par un `worker` ne contient jamais `cost_price`
- [x] L'interface masque les actions interdites, en plus du contrôle serveur
- [x] Matrice de `SPEC.md` § 3.1 entièrement implémentée

**Notes** — Le test sur la réponse API brute est le cœur de la story. Masquer un champ dans l'interface n'est pas un contrôle d'accès.

---

# E1 — Administration

### E1-01 — Création d'un commerce
**Étape 1** · dépend de E0-05

**En tant qu'**éditeur, **je veux** créer un commerce avec son patron, **afin d'**installer un nouveau client.

**Critères d'acceptation**
- [x] Formulaire `super_admin` : nom du commerce, nom du patron, téléphone, ville
- [x] Crée le `tenant`, le premier `app_user` en `owner`, et un `device` par défaut
- [x] **Crée automatiquement l'unique `warehouse`**, jamais affiché ensuite
- [x] Le patron peut se connecter immédiatement
- [x] Liste des commerces avec date de création et dernière activité

**Notes** — `SPEC.md` § 2.4. Le `warehouse` est une constante invisible.

---

### E1-02 — Gestion des employés
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** créer des comptes pour mes employés, **afin qu'**ils utilisent l'outil sans voir mes marges.

**Critères d'acceptation**
- [x] Le `owner` crée un `worker` : nom, téléphone, mot de passe
- [x] Il peut désactiver un compte sans le supprimer
- [x] Un compte désactivé ne peut plus se connecter
- [x] Un `worker` ne voit pas cet écran
- [x] Le patron ne peut pas se retirer son propre rôle `owner`

---

### E1-03 — Appareils
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** que mes bons soient numérotés sans doublon, **afin de** m'y retrouver.

**Critères d'acceptation**
- [x] Table `device` : `label`, `prefix`, `last_sync_at`, `is_active`
- [x] `prefix` unique par commerce, attribué automatiquement (A, B, C…)
- [x] Un appareil s'enregistre à la première connexion
- [x] Le patron voit ses appareils et leur dernière synchronisation

**Notes** — `SPEC.md` RÈGLE M3-2. Sans préfixe, la numérotation hors-ligne produit des doublons.

---

### E1-04 — Journal d'audit
**Étape 1** · dépend de E0-05

**En tant que** patron, **je veux** savoir qui a fait quoi, **afin de** comprendre un écart.

**Critères d'acceptation**
- [x] Table `audit_log` avec `before` et `after` en `jsonb`
- [x] Un helper unique, appelé par toutes les actions sensibles
- Écrivent obligatoirement dans `audit_log`, une action par ligne (RÈGLE M8-1) :
  - [x] changement de prix d'achat — `purchase_price_change`, par trigger sur `variant_cost` (addendum E2-03, à la clôture d'E2-04) ; `goods_receipt_line_cost` s'y branchera en E8-03
  - [ ] forçage de prix — `price_override`, arrive avec E4-04
  - [ ] annulation de document — `document_cancellation`, arrive avec E4-01
  - [ ] dépassement de plafond — `credit_limit_override`, arrive avec E6-03
  - [ ] validation d'écart d'inventaire — `stock_variance_approval`, arrive avec E3-04
  - [ ] modification de rôle — `role_change` : aucune story ne prévoit encore de modifier un rôle
- [x] Consultation filtrable par utilisateur et par date, `owner` seul
- [x] `audit_log` est en ajout seul : ni modification, ni suppression

**Notes** — `SPEC.md` RÈGLE M8-1.

---

### E1-05 — Paramètres du commerce
**Étape 1** · dépend de E1-01

**En tant que** patron, **je veux** régler ce qui est propre à mon commerce, **afin que** l'outil me corresponde.

**Critères d'acceptation**
- [x] Table `tenant_setting` en clé/valeur `jsonb`
- [x] Réglages V1 : nom et coordonnées à imprimer, langue par défaut, adresse de l'imprimante réseau
- [x] Valeurs par défaut fonctionnelles — l'application marche sans qu'on ouvre cet écran

---

# E2 — Catalogue

L'épique la plus déterminante pour l'adoption.

### E2-01 — Modèle produit / variante
**Étape 2** · dépend de E0-02

**En tant que** développeur, **je veux** la couche variante en place dès le départ, **afin de** ne jamais migrer le stock d'un client en production.

**Critères d'acceptation**
- [x] Tables `category`, `product`, `variant`, `price_break`
- [x] **Créer un `product` crée toujours une `variant` avec `is_default = true`** — par trigger ou dans une transaction serveur
- [x] `product.code` unique par tenant, saisie libre
- [x] `variant.sku` unique par tenant, dérivé de `product.code` s'il n'y a qu'une variante
- [x] `variant.attributes` en `jsonb`, `{}` en V1
- [x] **Aucune** table ne référence `product_id` pour du stock ou du prix
- [x] Test : créer un produit produit exactement une variante

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

**Addendum — le journal du prix d'achat** (relevé à la clôture d'E2-04, branché ensuite). E2-03 a livré `variant_cost` sans l'écriture au journal que la RÈGLE M8-1 exige : c'était une lacune dans du code livré, pas une anticipation sur E8. Migration `20260911160000_purchase_price_audit.sql` :
- trigger `merx.audit_row_change()`, `security definer`, posé par `merx.apply_audit(table, étiquette, colonnes)` et inscrit à `merx.audited_registry` ; création, modification du prix et suppression écrivent chacune leur entrée `purchase_price_change`, avant et après limités à `variant_id` et `cost_price` ; une mise à jour qui ne les change pas n'écrit rien ;
- **hors session, l'écriture est refusée** — `42501` sans commerce, `23502` sans auteur, par `merx.log_audit()` tel qu'E1-04 l'a posé. Arbitré : un journal sans auteur ne doit pas pouvoir exister, et c'est par `service_role` ou `postgres` qu'un incident passerait. Le seul contournement, `session_replication_role = replica`, est réservé au harnais de test (`withoutTriggers`, `supabase/tests/rest.ts`) ;
- deux règles de `conventions.ts` : toute table inscrite porte son trigger, et toute relation restreinte par `view_cost` est journalisée — `goods_receipt_line_cost` (E8-03) sera nommée le jour où elle naîtra sans l'être ;
- `supabase/tests/purchase-price-audit.test.ts` éprouve les trois entrées par le chemin réel, et le refus hors session, code asserté, aucune ligne créée.

**Vérifié par sabotage** (5 cas, chacun seul sur une base fraîche ; nombre de tests tombés, vraies détections distinguées de la cascade) :
- **trigger retiré après sa pose** — 10 tombent : les 9 de `purchase-price-audit.test.ts`, chaque entrée manquante nommant `purchase_price_change`, et la règle `tables auditées gardées` ;
- **`apply_audit` jamais appelé** — 10 tombent : les mêmes 9, et la règle `prix d'achat journalisés`. Les deux règles ne tombent jamais ensemble ;
- **garde « rien n'a changé » retiré** — 27 tombent, dont **2 vraies détections** : « une écriture qui ne change pas le prix n'en laisse aucune », et la mise à jour de `variant_cost` du balayage d'isolation (`23502`, aucun auteur). Les 25 autres sont une cascade : ce balayage tourne dans une seule transaction, sans point de sauvegarde autour de ses `update`, et l'erreur l'avorte pour tous les tests suivants ;
- **`security definer` retiré du trigger** — 9 tombent sur 9 : « permission denied for function log_audit », le patron lui-même ne peut plus poser un prix ; le test « sans auteur » reçoit `42501` au lieu de `23502` ;
- **comparaison avant/après remplacée par une condition toujours vraie** — 2 tombent, 2 vraies détections : « la modification du prix » (10.00 → 12.50 n'écrit rien) et « modifier sans jeton », dont le refus disparaît avec l'entrée.

---

### E2-04 — Recherche produit
**Étape 2** · dépend de E2-02

**En tant que** vendeur, **je veux** trouver un produit même en tapant mal, **afin de** ne pas faire attendre le client.

**Critères d'acceptation**
- [x] Recherche simultanée sur nom français, nom arabe, `code`, `sku`, `barcode`
- [x] Tolérante aux fautes et aux accents : « creme » trouve « crème »
- [x] Fonctionne sur référence partielle : « 451 » trouve « 4512 »
- [x] Résultat en moins de 300 ms sur 10 000 références — *mesuré par PostgREST sur le stack local, sans réseau : 76 ms au pire (« creme ») ; une tablette en 3G n'est pas mesurée*
- [x] Résultats en liste **et** en grille photo, au choix — *vérifié en jsdom ; le rendu sur une tablette réelle reste à voir*
- [x] Index base de données en place, testés sur un jeu réaliste de 10 000 lignes — *parmi 40 000 d'autres commerces ; le plan du vrai appel est asserté par `auto_explain`*

**Notes** — Point de rupture n° 4 du spec.

**Tranché en E2-04** — la recherche est `public.search_products(q)`, en `security definer` : **exception nommée à la RÈGLE § 2.1**, parce que sous RLS Postgres n'utilise comme condition d'index que des prédicats `leakproof`, ce que `like`, `unaccent` et `pg_trgm` ne sont pas (mesure et raison : SPEC § 2.1). Le filtre du commerce, en tête du corps, est le seul garde de ce chemin. L'exception est bornée par le registre `merx.rls_exception_registry` : toute fonction `security definer` de `public` qui lit **ou écrit** une table métier s'y inscrit, avec son garde — `current_tenant` ou `super_admin` — et une justification que la base refuse vide ; `conventions.ts` nomme toute fonction non inscrite, et toute fonction dont le corps n'appelle pas le garde déclaré. Les quatre fonctions existantes y sont entrées (`create_tenant` en `super_admin`). Seuil de similarité **0,4**, mots tout en chiffres sans faute, requête vide = 50 premiers par ordre alphabétique, 1 ou 2 caractères par l'index du commerce, pas de filtre `is_active` (raisons et mesures : SPEC § 6, Recherche).

**Constaté en E2-04**, chaque fois par une assertion de plan rouge alors que le chronomètre restait vert :
- une fonction `language sql` est planifiée sans connaître la requête : l'index trigramme était écarté sur la branche produit. D'où plpgsql et `plan_cache_mode = force_custom_plan` ;
- un index GIN met les insertions en liste d'attente jusqu'au vacuum : juste après l'insertion de 10 000 produits, 3 requêtes sur 12 seulement passaient par l'index. D'où `fastupdate = off`. **Mesuré en E2-05** : de l'ordre de 15 % sur l'insertion, et le réglage inverse fait perdre l'index à 13 requêtes sur 16 après un import de 10 000 lignes. Réglage inchangé ;
- `create function … set pg_trgm.*` est refusé à `postgres` tant que la bibliothèque n'est pas chargée dans la session ; la migration la charge explicitement ;
- un générateur de jeu de test dont un modulo partage un facteur avec le nombre de types attache une propriété à des types entiers : tous les shampooings étaient supprimés, et « شمبو » ne trouvait rien. Le jeu mentait, pas la recherche ;
- le balayage d'insertion de `settings.test.ts` recopiait les colonnes générées, et le refus `428C9` masquait celui de la policy : il lit désormais la liste des colonnes insérables dans le catalogue.

**Vérifié par sabotage** (26 cas, chacun seul sur une base fraîche). **Premier passage : 20 attrapés, 6 manqués** — chacun a reçu un test, puis a été rejoué :
- filtre `p.deleted_at` retiré : la propagation de la suppression aux variantes faisait écarter le produit par `v.deleted_at`. Test ajouté, propagation contournée ;
- pliage des alifs, de ة, de ؤ, de ئ retiré : la tolérance aux fautes rattrapait la recherche. Tests directs de `merx.search_fold`, règle par règle ;
- fautes tolérées sur les chiffres : l'absence de 4512 dans les 50 premiers ne prouvait rien. Chaque résultat doit contenir le mot ; test direct de `merx.search_allows_typo` ;
- rang de la référence exacte retiré : aucune référence rivale dans le jeu. Aiguille « Abricot Orvane » (`45129`) ajoutée ;
- `tenant_id` retiré de l'index : resté vert sur une exécution où le plan tombait du bon côté. L'assertion relit désormais le plan d'une session chaude ; tombe sur « creme », « crème », « nivea creme 200 ».

Rejoués : les six tombent. **`plan_cache_mode = force_custom_plan` est le seul garde de la story qu'aucun sabotage ne fait tomber** : même en session chaude, le cache de plans ne bascule pas sur un plan générique en local, sur 10 000 produits. **Gardé, et écrit comme non éprouvé** dans la migration — qu'aucun test ne sache provoquer le plan générique ne veut pas dire que Postgres ne le choisira jamais.

Le filtre du commerce retiré fait tomber les deux tests d'isolation, les assertions de plan, et la règle `security definer inscrite et gardée` de `conventions.ts` — deux détections indépendantes.

---

### E2-05 — Import CSV
**Étape 2** · dépend de E2-03

**En tant que** patron, **je veux** importer mon fichier Excel, **afin de** ne pas ressaisir 2 000 références à la main.

**Critères d'acceptation**
- [x] Dépôt d'un fichier CSV ou XLSX
- [x] Écran de correspondance des colonnes, avec proposition automatique
- [x] Prévisualisation des 20 premières lignes avant validation
- [x] Validation ligne par ligne, avec numéro de ligne et motif d'erreur
- [x] Les lignes valides s'importent même si d'autres échouent ; rapport téléchargeable des rejets
- [x] Import de 2 000 lignes en moins d'une minute — *mesuré par PostgREST sur le stack local, parmi 20 000 produits d'autres commerces : **7,1 à 8,4 s**, soit 3,5 à 4,2 ms par ligne ; une tablette en 3G n'est pas mesurée*
- [x] Gère les cas réels : colonnes vides, doublons de référence, prix en texte (« 15,00 DH »), accents cassés, espaces parasites
- [x] Réimporter le même fichier met à jour au lieu de dupliquer, sur la clé `code`
- [ ] Écran utilisable au doigt, sur un vrai fichier de commerçant — *à vérifier à la main, avec un fichier qui n'est pas engendré par un test*

**Notes** — Point de rupture n° 1. Y consacrer plus de soin qu'à tout autre écran. Le code se fait en deux jours, les cas tordus en deux semaines.

**Tranché en E2-05** — l'import est `public.import_products(rows jsonb)`, **en `security invoker`** : les policies s'appliquent ligne par ligne, le journal du prix d'achat reçoit l'auteur du jeton, et `merx.rls_exception_registry` garde ses cinq entrées. Chaque ligne tourne dans son propre bloc `begin … exception … end`, donc dans son propre point de sauvegarde : **une ligne fautive est annulée seule**, le lot n'est pas tout-ou-rien, et rien d'elle ne subsiste — ni produit sans prix, ni variante orpheline. L'appareil envoie par blocs de 50 lignes : au-delà de 64 sous-transactions écrivantes, Postgres déborde son cache de sous-transactions, et `statement_timeout` coupe `authenticated`. Réimport sur `code`, sans égard à la casse, parmi les produits non supprimés — la portée exacte de `product_code_per_tenant` ; une mise à jour qui ne change rien n'écrit rien (ni `updated_at`, ni entrée au journal) ; une cellule vide n'efface pas ce que la base porte (SPEC § 2.6).

**Tranché aussi** — première occurrence d'une référence en double importée, les suivantes rejetées **en nommant sa ligne** ; prix vide et 0 saisi aboutissent tous deux à « prix non renseigné » (E2-03) mais **se comptent séparément à l'aperçu** ; une ligne sans référence est recréée à chaque import, l'aperçu le dit — un rapprochement par le nom fusionnerait deux produits différents ; un champ illisible **rejette la ligne entière**, et le motif nomme la colonne et cite la valeur ; SheetJS épinglé (0.20.3, intégrité au verrou), chargé à la demande.

**Le refus de deviner.** « 1.250 » vaut 1 250 DH ou 1,25 DH selon la convention du fichier : un facteur mille sur un prix de vente, découvert au comptoir. Un séparateur unique suivi de trois chiffres est donc **rejeté**, motif et valeur cités, comme l'est un prix négatif, un montant à plus de deux décimales, ou un nombre qu'Excel a écrit en notation scientifique — un EAN de treize chiffres s'affiche ainsi même au format « Standard », et la valeur affichée ne porte plus le code. Le taux de rejet n'est pas un argument pour se mettre à deviner.

**Constaté en E2-05** :
- **un parcours complet de `product` par bloc**, soit 400 ms sur 50 000 lignes et **71 s pour 2 000 lignes** : le rapprochement s'écrivait `lower(p.code) = any(...)`, et sous RLS `lower()` n'est pas `leakproof` — la troisième rencontre de la règle d'E2-04. La parade tient sans nouvelle exception : la clé est **stockée** (`product.code_key`, colonne générée) et l'égalité sur une colonne est, elle, `leakproof`. 7,1 s après. `lower(code)` et surtout pas `merx.search_fold()`, qui plierait aussi les accents : « CRÈME-1 » et « CREME-1 » sont deux références distinctes ;
- **`session_replication_role = replica` coupe aussi les clés étrangères**, donc les cascades : le ménage du fichier de test supprimait les produits sans emporter leurs variantes. 283 000 variantes orphelines accumulées, trois autres fichiers dont les lectures larges dépassaient leur délai, et le plan de recherche qui basculait — le tout sans rapport apparent avec l'import. Les triggers ne se suspendent désormais que pour `variant_cost` et `audit_log` ;
- **la mesure de `fastupdate` sabotait la section suivante** : 500 lignes importées en `fastupdate = on` laissent leur liste d'attente, que le seul retour du réglage ne vide pas. `gin_clean_pending_list()` explicite, et c'est accessoirement la démonstration du coût du réglage.

**Les deux dettes laissées par E2-04, réglées** :
- **ce que `fastupdate = off` coûte à l'import** : 500 lignes en 1 729 à 2 466 ms avec `off`, 1 507 à 1 844 ms avec `on` — de l'ordre de 15 %, et la dépense n'est pas évitée, elle est reportée sur les recherches jusqu'au vacuum. **Réglage inchangé** ;
- **après l'import, la recherche passe-t-elle encore par l'index ?** Oui : les 16 requêtes de la batterie d'E2-04 empruntent `product_search` et `variant_search` après un import de 10 000 lignes, sans vacuum. Le sabotage qui remet `fastupdate = on` fait tomber **13 tests sur 17** — 3 requêtes sur 16 seulement gardent l'index. C'est une recherche cassée au moment précis où le commerçant vient de remplir son catalogue et va l'essayer.

**Vérifié par sabotage** (12 cas, chacun seul ; les 7 cas base sur une base fraîche ; vraies détections distinguées de la cascade) :
- **bloc `exception` par ligne retiré** — 1 tombe : l'appel entier échoue, et « importe les bonnes lignes d'un lot mêlé » le voit ;
- **garde `manage_product` retiré** — 1 tombe : l'employé n'est plus refusé par une phrase, il reçoit des rejets ligne à ligne ;
- **`security invoker` passé en `definer`** — 2 détections indépendantes : le test structurel de la story, et la règle `security definer inscrite et gardée` de `conventions.ts` ;
- **garde « rien n'a changé » retiré** — 3 tombent, 1 vraie détection (« n'écrit rien quand rien n'a changé »), les 2 autres par état partagé dans le même `describe` ;
- **clé du réimport rendue sensible à la casse** — 4 tombent, dont « reconnaît la référence sans égard à la casse » et « crée à la première passe, met à jour à la seconde » : la clé pliée ne rencontrait plus rien, chaque import dupliquait ;
- **portée de la clé élargie aux produits supprimés** — 1 tombe : « la référence d'un produit supprimé crée un produit neuf » ;
- **`fastupdate = on`** — 13 tombent (ci-dessus) ;
- côté appareil : **prix ambigu accepté** — 7 tombent, dont les deux « refuse de trancher » ; **notation scientifique acceptée** — 2 ; **détection des doublons retirée** — 1 ; **repli `windows-1256` retiré** — 1 ; **réparation du double encodage retirée** — 1.

---

### E2-06 — Codes-barres
**Étape 2** · dépend de E2-02

**En tant que** vendeur, **je veux** scanner ce qui a un code et étiqueter ce qui n'en a pas, **afin d'**aller vite dans les deux cas.

**Critères d'acceptation**
- [x] Scan d'un EAN fabricant, stocké dans `variant.barcode`
- [x] Génération d'un Code 128 encodant `variant.sku` pour les produits sans code
- [x] La recherche interroge les deux indifféremment
- [x] Impression d'étiquettes en planche A4, quantité paramétrable
- [x] Un `barcode` déjà attribué à une autre variante est refusé avec un message clair
- [ ] Scan d'un vrai EAN à la caméra — *à vérifier à la main, sur un Android d'entrée de gamme ; voir ci-dessous*
- [ ] Planche imprimée sur une vraie imprimante, étiquettes relues à la douchette — *à vérifier à la main : la géométrie (3 × 70 mm, 8 × 37 mm, marge nulle) et la finesse des barres ne se mesurent pas à l'écran*

**À vérifier à la main, sur un vrai téléphone.** `BarcodeDetector` est une hypothèse sur le matériel, pas une certitude : l'API dépend de l'appareil et de ses services Google. Ouvrir la fiche produit sur un Android d'entrée de gamme, en HTTPS ou via `localhost` — sur le LAN en clair, `getUserMedia` n'existe pas et le bouton disparaît, ce qui est le comportement attendu, pas une panne (CLAUDE.md, tester sur un vrai téléphone). Si l'API manque, **alors seulement** ajouter un repli wasm (ZXing) : 300 Ko et un décodage logiciel sur les appareils les plus lents ne se paient pas d'avance.

**Notes** — `SPEC.md` RÈGLE M1-5. En cosmétique les marques portent un EAN fiable : c'est la voie principale.

**Arbitrages rendus** — l'impression fige le SKU par `variant.sku_printed_at`, pas en refusant le changement de référence : la référence reste corrigeable, et une référence libérée reste tenue par le SKU figé, refusée par `variant_sku_per_tenant` avec son propre message. Une planche d'EAN fabricant ne fige rien. Le SKU des produits sans référence est engendré par l'appareil (`A-00001`), sans réseau, le compteur local n'étant jamais l'autorité — l'index unique l'est. Caméra par `BarcodeDetector` seul. Détail dans `SPEC.md` § 6, RÈGLE M1-5.

---

# E3 — Stock

### E3-01 — Mouvements et niveaux
**Étape 3** · dépend de E2-01

**En tant que** patron, **je veux** que chaque mouvement soit traçable, **afin de** comprendre un écart.

**Critères d'acceptation**
- [x] Tables `warehouse`, `stock_level`, `stock_movement`
- [x] `stock_level` unique sur `(variant_id, warehouse_id)`
- [x] **`stock_level` n'est jamais écrit directement** : trigger sur `stock_movement`
- [x] `stock_movement` immuable : ni UPDATE, ni DELETE, refusé au niveau base
- [x] `quantity` signée, négative en sortie
- [x] `movement_type` : `sale | return | receipt | adjustment | inventory`
- [x] `source_type` et `source_id` renvoient au document d'origine
- [x] Test : une série de mouvements produit le `stock_level` attendu

**Notes** — `SPEC.md` RÈGLES M2-1, M2-2. L'immutabilité est ce qui rendra la synchronisation possible en E9. Ne pas l'assouplir.

**Arbitrages rendus** — `stock_level` est la première **table dérivée** : troisième registre à côté de l'ajout seul et de l'audit (`merx.derived_registry`, `merx.apply_derived_from()`), parce qu'un agrégat n'est ni immuable ni simplement journalisé — il n'a aucun écrivain applicatif. Le garde repose sur `pg_trigger_depth()`, qui dit « écrit par un trigger » et non « écrit par le trigger d'agrégat » : le registre nomme donc l'écrivain, et `conventions.ts` refuse toute autre fonction de `public` ou de `merx` qui écrirait dans la table. Refus en `55000`, code d'aucun autre garde du projet.

**L'écriture d'un mouvement est fermée par défaut, ouverte type par type.** `merx.movement_type_capability` est **vide** en E3-01 : aucun écran n'écrit de mouvement, donc personne n'a besoin d'en écrire un, et laisser la porte ouverte deux stories durant laisserait un employé poster un `adjustment` de −1000 par PostgREST. E3-03 ouvrira `adjustment`, E3-04 `inventory`, E4 `sale` et `return`, E8-02 `receipt` — chaque story ouvre son type et seulement le sien. *(Corrigé en E3-03 : il était écrit ici qu'aucune story n'aurait à inventer de capacité, celles de § 3.1 suffisant toutes. La première a dû en ajouter une — `adjust_stock`. Voir la note d'E3-03.)* Deux gardes s'en partagent la charge, avec deux refus distincts : la policy `column_capability_insert` (via `merx.can_move_stock()`, donc via `merx.can()`) répond pour le rôle, le trigger `require_open_movement_type` répond pour le type et le nomme. Chemin d'écriture `restricted`, troisième valeur du registre d'ajout seul.

**Ordre des gardes.** Les deux gardes d'insertion — celui des tables dérivées et celui du fermé par défaut — sont posés **AFTER**, délibérément : la RLS d'une insertion est vérifiée entre les triggers BEFORE et les AFTER, et en BEFORE ils auraient refusé une ligne destinée au commerce voisin avant `tenant_isolation`, laissant le balayage d'isolation au vert si la policy disparaissait.

**Retouche du balayage d'isolation.** Deux tests mutaient l'état partagé quand le garde qu'ils mesuraient manquait : la suppression de la ligne d'agrégat et la tentative d'insertion réussissaient pour de bon, et les cas suivants tombaient sur un état qu'ils n'avaient pas produit. Les deux passent désormais par un point de sauvegarde relâché dans tous les cas. Mesuré sur deux sabotages : **9 rouges dont 2 en cascade → 7**, et **8 dont 1 → 7**. Même propriété qu'`attempt()` en E2-04 — un garde retiré, un test tombe, et il nomme la bonne table.

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
- [x] Saisie d'une quantité corrigée, générant un `adjustment` de la différence
- [x] Motif obligatoire, en texte libre
- [x] Réservé au `owner`
- [x] Tracé dans `audit_log`

**Notes** — `SPEC.md` RÈGLES M2-5, M8-1 ; § 3.1.

**Une capacité neuve, `adjust_stock`, `owner` seul.** E3-01 annonçait qu'aucune story n'aurait à en inventer une : faux dès la première. Aucune capacité `owner` seul de § 3.1 ne dit « corriger une quantité » — `approve_stock_variance` est la validation d'un écart d'inventaire (E3-04), et l'emprunter rendrait impossible de retirer l'ajustement sans retirer l'inventaire. La matrice n'a pas été pliée, c'est la RÈGLE M2-5 qui a été corrigée. **Quatre copies bougent ensemble**, et non trois : `merx.role_capability`, le type `Capability` et l'objet `CAPABILITIES` de `src/lib/auth/permissions.ts` (que `supabase/tests/permissions.test.ts` compare ligne à ligne), **et** les listes `OWNER_ONLY`/`SHARED` de `src/lib/auth/permissions.test.ts`, qu'aucune des trois premières ne fait tomber. Oubliée ici, elle n'est apparue qu'à la suite complète ; la règle de `CLAUDE.md` les nomme désormais toutes les quatre.

**Le motif est obligatoire en base, pas seulement à l'écran.** `stock_movement_adjustment_reason` ne regarde que l'`adjustment`. § 2.6 ne s'y applique pas : elle vise les formulaires de création d'entités de référence, et le motif n'est pas un accessoire de l'ajustement — il en est le contenu. À l'écran seulement, un `POST` direct poserait des ajustements anonymes (leçon E1-02).

**Septième étiquette d'`audit_action`, `stock_adjustment`.** Le mouvement ne suffisait pas comme trace : lu par tout le commerce, noyé parmi les ventes, `created_by` fourni par le client. Deux migrations, parce qu'une valeur d'enum n'est pas utilisable dans la transaction qui la crée. `merx.apply_audit()` gagne une condition de ligne et dérive ses événements de `merx.append_only_registry` — une table en ajout seul ne reçoit qu'un `AFTER INSERT`, et un `when (new....)` ne se pose pas sur un DELETE. La clause posée est relue du catalogue et inscrite au registre, que `conventions.ts` confronte au trigger réel.

**`stock_movement.created_by` prend pour défaut `merx.current_app_user()`** : le jeton ne porte pas l'identifiant `app_user`, l'écran ne peut donc pas le remplir, et l'historique d'E3-02 aurait affiché « Auteur inconnu » sur le mouvement le plus sensible de la table.

**La différence est calculée sur le niveau lu à l'écran.** Une vente concurrente entre la lecture et l'écriture décale le résultat du nombre saisi : assumé — un appareil par commerce en V1 (§ 2.5), mouvements additifs, et une correction se corrige par une autre correction (M2-2). Aucun verrou n'est construit en avance pour E10.

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
- [x] Tables `sale_document`, `sale_line`, `document_sequence`
- [x] `doc_type` : `quote | order | delivery_note`. **Aucune facture fiscale.**
- [x] `status` : `draft | confirmed | delivered | cancelled`
- [x] Un document `confirmed` ne peut être ni modifié ni supprimé, contrainte en base
- [x] L'annulation passe le statut à `cancelled` et génère les mouvements de stock inverses
- [x] `price_source` par ligne : `auto | manual`

**Notes** — `SPEC.md` RÈGLES M3-1, M3-3.

**Un mécanisme neuf, pas `apply_append_only()`.** Le garde de l'ajout seul vaut pour toute la table (privilèges retirés, refus sans condition) ; un brouillon doit rester modifiable et `confirmed → cancelled` est un UPDATE. Son registre est aussi ce que `isolation.ts` lit pour inverser son contrôle positif : y inscrire `sale_document` aurait fait attendre « UPDATE refusé » sur des brouillons. D'où `merx.frozen_registry` + `merx.apply_frozen_when()` (cinq gardes : naissance, mise à jour, suppression, TRUNCATE, lignes de l'enfant), SQLSTATE `55006`, transitions en données (`merx.frozen_transition`). La mise à jour refuse de trois façons distinctes — transition non déclarée, contenu changé sous un statut figé, colonne étrangère à la transition — chacune sa phrase. Les colonnes qui ont changé sont calculées sur `to_jsonb(new)` contre `to_jsonb(old)` : une colonne ajoutée plus tard, `client_id` en E6-01, est figée d'office.

**Lecture de M3-3, écrite à SPEC § 8 : le contenu est figé, le statut avance.** `draft → confirmed` (libre : le brouillon reçoit son numéro, sa date, ses totaux), `confirmed → delivered`, `confirmed → cancelled`, `delivered → cancelled` ; `cancelled` est terminal. Un document naît brouillon. Un brouillon — et lui seul — se supprime, avec ses lignes (SPEC § 4 corrigé).

**Un sixième type de mouvement, `sale_cancellation`, ouvert sur `cancel_document`** (`owner` seul, aucune capacité neuve). `sale` et `return` s'ouvriront sur `create_sale` en E4-05/E4-06 parce que les employés les écrivent, et un type n'a qu'une capacité ; les ouvrir maintenant, ou les rattacher à `cancel_document` en attendant, ferait de l'API un `POST` de mouvements sans écran, ou ferait mentir la matrice (même objection qu'`adjust_stock`, E3-03). `sale`, `return`, `receipt`, `inventory` restent fermés. SPEC § 7 et la RÈGLE M2-5 sont corrigés dans la même story. Deux migrations — une valeur d'enum n'est pas utilisable dans la transaction qui la crée.

**Le mouvement `sale_cancellation` ne s'écrit pas à la main.** Ouvert au patron, il lui aurait permis de corriger un stock sans motif et **sans entrée de journal** — l'`adjustment` est audité, lui pas. `merx.require_cancellation_origin()` refuse toute insertion directe par `pg_trigger_depth()`, comme le garde des tables dérivées ; AFTER, pour ne pas refuser avant la policy. Limite : le garde ne dit pas *quel* trigger écrit, seulement qu'un trigger écrit — une seconde fonction qui insérerait ce type passerait. `reverse_sale_movements()` est la seule aujourd'hui.

**L'annulation, en deux gardes, deux phrases.** `merx.require_cancel_capability()` exige `cancel_document` sur la transition elle-même — sans lui, un employé annulerait un devis, qui n'a aucun mouvement pour qu'une policy se prononce. `merx.reverse_sale_movements()` (`security invoker`, donc la policy du type s'applique) écrit l'inverse des mouvements `sale` **écrits** pour le document, pas un recalcul depuis les lignes. Un test par niveau, qui contourne l'autre.

**Le motif, `cancellation_reason`, est obligatoire en base** (`sale_document_cancellation_reason`) : sans lui, une annulation par l'API serait anonyme et l'entrée de journal n'aurait rien à retenir — même raisonnement que le motif d'un ajustement. SPEC § 8 le liste désormais.

**`document_cancellation`, tracée.** L'étiquette existait depuis E1-04, mais `merx.apply_audit()` refusait une condition de ligne sur une table qui n'est pas en ajout seul. Elle gagne `only_events` (ici `update`) ; le registre d'audit retient les événements posés, que `conventions.ts` compare au trigger réel au lieu de les dériver.

**Laissé pour plus tard, et écrit là où ça se décidera :** `client_id` (E6-01), l'année dans le numéro et l'unicité de `doc_number` (E4-02), l'arrondi de `line_total` et les contraintes de cohérence des totaux (E4-04), l'écriture des mouvements `sale` à la confirmation (E4-05). `document_sequence` n'a ni fonction ni trigger : le serveur n'attribue rien.

**Sabotages (25 gardes retirés, un par un) :** tous font rougir au moins un test. Les gardes de la table figée (naissance, mise à jour dans ses trois branches, suppression, TRUNCATE par trigger et par privilège, lignes), la transition ajoutée à la liste, le droit d'annuler, l'inversion et son filtre de type, le motif, l'ouverture du type et sa capacité, le garde d'origine, la policy des mouvements, le trigger d'audit et sa condition, les trois clés composites, l'unicité et le `NOT NULL` de `document_sequence`, `quantity > 0`. Un cas est resté vert à la première passe — `TRUNCATE ... cascade` sur `sale_document` était refusé par le garde de `sale_line`, avec la même phrase ; le test exige maintenant que le message nomme la table.

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

**À trancher ici, relevé en E4-01 : le format n'a pas d'année.** `BL-A-0001` ne porte pas l'année, alors que la séquence est annuelle `(tenant, device, doc_type, year)`. Le premier bon de 2027 serait `BL-A-0001`, comme celui de 2026 : collision de texte, et aucune unicité sur `doc_number` ne peut être posée tant que ce n'est pas réglé. E4-01 n'en pose donc aucune. E4-02 choisit : soit l'année dans le numéro (`BL-A-2027-0001`), soit une séquence qui ne repart pas à zéro au 1er janvier — et corrige alors M3-2 et le critère « par `(tenant, device, doc_type, year)` » en conséquence. Le numéro est attribué par l'appareil, à la confirmation, dans la transition `draft → confirmed` que le garde de `sale_document` laisse écrire (le contenu d'un brouillon est libre jusqu'à elle).

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

**À trancher ici, relevé en E4-01 : la règle d'arrondi de `line_total`.** Une quantité à 3 décimales (`numeric(12,3)`) multipliée par un prix à 2 (`numeric(12,2)`) donne 5 décimales, et le spec n'écrit nulle part comment on revient à 2 : arrondi au plus proche, demi vers le haut ou vers le pair, au niveau de la ligne ou du document. E4-01 ne pose donc **aucune contrainte de cohérence des totaux** (`total = subtotal - discount_total`, `line_total = quantity × unit_price - line_discount`, somme des lignes). Cette règle se tranche avant toute contrainte de ce genre, puis s'écrit à un seul endroit — en SQL, car les documents sont figés en base et le total qui s'imprime doit être celui qui est stocké.

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

**À faire ici, relevé en E4-01 : `sale_document.client_id`.** Le spec (§ 8) liste `client_id` sur `sale_document`, mais la table `client` n'existe pas à l'étape 4. E4-01 **omet la colonne** plutôt que de la poser sans clé : un `client_id` sans clé composite laisserait passer l'identifiant d'un autre commerce, ce que la RÈGLE de § 4 existe pour empêcher. La migration de cette story crée `client` (avec `unique (tenant_id, id)`), **puis ajoute `sale_document.client_id uuid` nullable avec sa clé composite `(tenant_id, client_id) references client (tenant_id, id)`, dans le même geste** — jamais la colonne seule. Le garde « figé » de `sale_document` compare la ligne entière hors statut : la colonne neuve y entre d'office, un document confirmé ne change pas de client. Le balayage d'isolation et `conventions.ts` la prennent d'eux-mêmes.

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
- [ ] Cibles tactiles d'au moins 48 px (BRAND-UI § 7)
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

### E11-04 — Navigation
**Continu** · dépend de E0-05, E2-02

**En tant que** commerçant, **je veux** passer d'un écran à l'autre au pouce et revenir d'où je viens, **afin de** ne jamais rester coincé dans un écran.

Trois constats d'un essai sur un vrai Android : aucun retour, aucun accueil, aucun moyen de naviguer au téléphone. Aucune story ne les couvrait, ni BRAND-UI.

**Critères d'acceptation**
- [x] Barre d'onglets en bas des écrans de premier niveau ; chaque onglet porte une icône **et** un libellé ; cinq onglets au plus
- [x] Le premier onglet est l'Accueil ; aucun autre bouton « accueil »
- [x] Un onglet dont la capacité manque ne s'affiche pas — par `useCan()`, aucune comparaison de rôle, aucun cas particulier
- [x] Onglets livrés : Accueil et Produits. Vente, Clients et Rapports arrivent avec E4-03, E6-01 et E10-01 — pas avant
- [x] L'onglet actif se distingue par la couleur **et** le fond (encre 600 sur encre 100), et porte `aria-current="page"` ; l'inactif est en papier 600
- [x] Chaque écran de détail porte un retour dans son en-tête, chevron et nom du parent, vers le parent désigné — jamais l'historique
- [x] **Un onglet ou un retour, jamais les deux, jamais aucun** — vérifié route par route, et toute route ajoutée sans être classée fait tomber le test
- [x] Le chevron se retourne en RTL ; propriétés logiques uniquement — *la classe est vérifiée en jsdom ; le retournement lui-même, à l'œil, avec le critère suivant*
- [x] Employés, appareils, journal et paramètres dans le bloc « Gestion du commerce » de l'Accueil, chaque lien derrière sa capacité
- [x] Les routes gardent leur `RequireCapability` : un onglet masqué n'est pas un contrôle d'accès — un test par niveau, chacun contournant l'autre
- [ ] Testé à la main sur un Android d'entrée de gamme, en LTR et en `dir="rtl"`

**Notes** — `BRAND-UI.md` § 13, et § 5 corrigé (icônes inactives en papier 600). Toute story qui ajoute un écran le range : un onglet, ou un retour vers son parent.

**Sabotages** — neuf, chacun rejoué deux fois sur toute la suite front (398 tests) ; chacun fait tomber le test qui le mesure, et lui seul, sauf le filtre du lien Employés, que deux tests tiennent :

| Sabotage | Tombe |
|---|---|
| Filtre de capacité retiré de la barre | « ne montre pas un onglet dont la capacité manque » |
| Filtre retiré du lien Employés de l'Accueil | `users.test` « n'offre le lien qu'à qui a la capacité » et « le bloc n'existe pas pour un employé » |
| `RequireCapability` retiré de `/products` | « renvoie à l'Accueil qui tape l'URL d'un onglet interdit » |
| Classe active rendue inconditionnelle | « marque l'onglet actif, et lui seul » |
| `/devices` placé sous la barre | « /devices porte un retour… et aucune barre » |
| Mauvais parent sur Nouvel employé | « /users/new porte un retour vers son parent » |
| Classe `rtl:` retirée du chevron | « le chevron du retour se retourne en RTL » |
| Retour retiré des Paramètres | « /settings porte un retour… » |
| Route `/stock` ajoutée sans classement | « classe chaque route déclarée dans routes.tsx » |

Les deux gardes de `/products` se distinguent : l'onglet absent se lit à l'Accueil sans visiter la route, le garde de route par une redirection sur l'URL tapée. Le sabotage « `end` retiré de l'onglet Accueil », prévu au plan, a été abandonné : React Router n'active jamais un `NavLink` vers `/` sur un autre chemin, `end` ou non — il serait resté vert sans rien mesurer.

---

## Questions non tranchées

À décider hors de ce document. Aucune ne bloque avant l'étape 10.

1. Un ou plusieurs appareils par commerce — hypothèse V1 : un seul
2. Onboarding du catalogue facturé, offert, ou vendu en prestation
3. Nombre de pilotes avant ouverture commerciale — recommandation : trois
4. Structure juridique et encaissement des abonnements
5. Qui répond au téléphone quand un vendeur est bloqué un samedi à 11 h