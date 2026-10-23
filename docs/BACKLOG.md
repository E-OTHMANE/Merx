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
- [x] Aucune requête applicative ne filtre `tenant_id` à la main — *hors les fonctions inscrites à `merx.rls_exception_registry`, dont l'exception nommée de SPEC § 2.1 (E2-04) ; le registre couvre `public` **et** `merx` depuis E4-06, et cinq formes de garde*
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

### E0-06 — Fuseau horaire du Maroc
**Étape 5** · dépend de E4-02 · **passe avant toute autre story**

**En tant que** commerçant, **je veux** que l'heure et la date de mes bons soient
les miennes, **afin de** ne pas remettre un papier faux et de ne pas voir une
vente refusée le 31 décembre au soir.

**Ce qui a été mesuré, et qui ouvre la story.** Le 2026-10-23, même machine,
même instant : Node 24 et Postgres 17.6 rendent 13:00 pour `2026-10-20 12:00Z`
en `Africa/Casablanca`, **Chrome rend 12:00**. Les trois moteurs s'accordent
jusqu'au Ramadan 2026 puis divergent — l'ICU de ce Chrome laisse le Maroc à
UTC+0 après le 2026-02-15 et ne le ramène jamais à UTC+1. Le Maroc est à UTC+1
en permanence depuis 2018, sauf pendant le Ramadan : **c'est Postgres qui a
raison, et le navigateur qui est en retard.**

**Pourquoi ce n'est pas une curiosité d'affichage.** Quatre endroits calculent
l'heure locale, depuis **trois** tables de fuseaux différentes :

| | d'où vient le décalage | ce qui casse |
|---|---|---|
| `src/lib/dates.ts` | ICU du navigateur | l'heure de **chaque** bon, ticket et PDF |
| `src/lib/day.ts` | ICU du navigateur | les bornes de journée des filtres |
| `src/modules/sales/documentNumber.ts` | ICU du navigateur | **l'année du numéro** (RÈGLE M3-2) |
| `20261015120000_document_numbering.sql` | tzdata de Postgres | le garde serveur, qui refuse en `22023` |

C'est le croisement des deux dernières lignes qui coûte une vente : l'appareil
et la base appliquent la **même** règle depuis deux tables qui ne disent pas la
même chose. Un bon émis le 31 décembre à 23 h 30 sur un appareil à UTC+0 porte
une année que le serveur refuse. Et la table le dit elle-même : **en 2029 et en
2030, le 31 décembre tombe pendant le Ramadan**, donc sur une bascule. Le cas
n'est pas un bord théorique, il revient deux fois en cinq ans.

**Critères d'acceptation**
- [ ] Une **seule** fonction porte le décalage du Maroc, dans `src/lib/dates.ts`,
      et elle ne lit **jamais** la table de fuseaux du moteur
- [ ] `dates.ts`, `day.ts` et `documentNumber.ts` en dérivent tous les trois :
      aucun `timeZone: 'Africa/Casablanca'` ne subsiste pour **décider** d'un
      décalage (`Intl` garde la mise en forme, il ne décide plus)
- [ ] **L'année du numéro est calculée par la même fonction des deux côtés**, et
      un test l'éprouve sur le 31 décembre 23 h 30 local, de 2026 à 2030
- [ ] La table est mesurée **jour par jour contre Postgres**, de 2019 à 2031 —
      pas sur un échantillon de dates choisies
- [ ] Les douze instants de bascule exacts sont éprouvés à une seconde avant et
      une seconde après
- [ ] Le défaut de `day.ts` est corrigé : `startOfDay()` prend le décalage de
      **minuit local**, pas celui de midi UTC
- [ ] Un test d'**horizon** rougit quand la table ne couvre plus deux ans devant
- [ ] Une ligne de diagnostic dans les paramètres montre, pour trois instants
      fixes, ce que rend le **moteur** et ce que rend **Merx**, côte à côte
- [ ] Le serveur n'est pas modifié : Postgres est la référence

**La table, telle que Postgres la donne** (transitions à 02:00 UTC ; hors de ces
fenêtres, UTC+1) :

| retour à UTC+0 | retour à UTC+1 | | retour à UTC+0 | retour à UTC+1 |
|---|---|---|---|---|
| 2019-05-05 | 2019-06-09 | | 2026-02-15 | 2026-03-22 |
| 2020-04-19 | 2020-05-31 | | 2027-02-07 | 2027-03-14 |
| 2021-04-11 | 2021-05-16 | | 2028-01-23 | 2028-03-05 |
| 2022-03-27 | 2022-05-08 | | 2029-01-14 | 2029-02-18 |
| 2023-03-19 | 2023-04-23 | | **2029-12-30** | **2030-02-10** |
| 2024-03-10 | 2024-04-14 | | **2030-12-22** | **2031-01-26** |
| 2025-02-23 | 2025-04-06 | | | |

**Fichiers**

| Fichier | Ce qui y change |
|---|---|
| `src/lib/dates.ts` | la table `RAMADAN_UTC_WINDOWS`, `MOROCCO_STANDARD_OFFSET`, et `casablancaOffsetMinutes()` ; `formatDate()`, `formatDateTime()` et `fileDate()` décalent l'instant puis formatent **en UTC** |
| `src/lib/day.ts` | `offsetAt()` lit la fonction ; `startOfDay()` prend le décalage de minuit local |
| `src/modules/sales/documentNumber.ts` | `documentYear()` lit la fonction ; le fichier ne dépend toujours que de `dates.ts`, qui n'importe rien — l'invariant qui permet à un test de base d'importer les deux |
| `src/lib/dates.test.ts` | **neuf** |
| `src/lib/day.test.ts` | les deux jours de bascule de l'année |
| `src/modules/sales/numbering.test.ts` | le 31 décembre 23 h 30 |
| `supabase/tests/timezone.test.ts` | **neuf** — le balayage contre Postgres |
| `src/modules/admin/SettingsScreen.tsx` | la ligne de diagnostic |
| `docs/SPEC.md` § 4 | la RÈGLE ci-dessous |
| `docs/PENDING-CHECKS.md` | la procédure annuelle, et la lecture sur l'appareil |

**Aucune migration** : le serveur ne bouge pas.

**Tests**

- `supabase/tests/timezone.test.ts` — **le test qui compte, et il ne choisit pas
  ses dates** : un balayage jour par jour de 2019 à 2031 à 12 h UTC,
  `casablancaOffsetMinutes()` contre `timezone('Africa/Casablanca', …)`, en une
  requête ; les douze bascules à ± 1 s ; et l'accord sur l'année pour le
  31 décembre 23 h 30 local de 2026 à 2030, côté appareil contre le calcul même
  du garde `merx.require_document_number_shape()`.
- `src/lib/dates.test.ts` — les bords de Ramadan, le 31 décembre 23 h 30, et le
  **test d'horizon** : il rougit quand la table ne couvre plus deux ans devant,
  avec la requête de régénération dans son commentaire. Une table écrite à la
  main a une fin ; autant que ce soit la suite qui le dise, et non un
  commerçant en 2032.
- `src/lib/day.test.ts` — les bornes des deux jours de bascule, là où le défaut
  actuel décale la journée d'une heure.

**Sabotages (2 cas)** — le garde qui tient une ligne ici est **l'accord entre
l'appareil et la base sur l'année du numéro** : c'est lui qui, cassé, refuse un
bon au comptoir.

- `casablancaOffsetMinutes()` rendue à `0` en toute saison ;
- `documentYear()` remise sur `Intl` — et ce cas doit rougir **sans** que le
  balayage de la table bouge, sinon le test d'accord ne mesure pas ce qu'il
  prétend mesurer.

**RÈGLE à poser en SPEC § 4** — *Le décalage du Maroc est une donnée de
l'application, jamais une lecture du moteur. La table se mesure contre Postgres,
elle ne se recopie pas.*

**Et ce que la RÈGLE doit dire de ses propres limites, parce qu'une table gelée
en a deux.**

1. **Les dates de Ramadan de `tzdata` sont des prévisions.** Le Maroc fixe la
   bascule à l'observation de la lune, parfois à un jour près, et l'annonce peu
   avant. La table peut donc se tromper d'un jour une année donnée — et comme
   les assets sont empaquetés dans l'APK (§ 2.7), **elle ne se corrige que par un
   APK**. C'est le prix de l'indépendance vis-à-vis du moteur, et il est payé en
   connaissance de cause : une table à un jour près une année sur cinq vaut
   mieux qu'un moteur à une heure près toute l'année.
2. **La procédure annuelle va dans `PENDING-CHECKS.md`** : dès l'annonce
   officielle de la bascule, régénérer la table, la comparer à Postgres par le
   balayage, publier un APK si elle a bougé.
3. **Le serveur hébergé n'aura pas forcément la même `tzdata` que le stack
   local.** Le même balayage entre donc dans la vérification de mise en ligne,
   joué contre la base hébergée — même famille que la table de correspondance
   de PostgREST, qui se mesure et ne se recopie jamais.

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

**Relevé en E4-04, et à faire ici : l'écran de grille devrait signaler un palier réglé sous le plancher.** Depuis E4-04, `merx.require_floor_price()` refuse toute ligne de vente dont le prix est sous `variant.floor_price`, **quelle que soit `price_source`** — sinon le contrôle se contournerait en posant `auto` (SPEC § 8, RÈGLE M3-8). Conséquence assumée : un palier que le patron a réglé sous son propre plancher rend l'article **invendable par l'employé**, et le refus tombera au comptoir, sur une vente, devant un client — loin de l'écran où la faute a été faite. Le refus est le bon côté de l'erreur, mais la contradiction se voit à la saisie : la grille connaît déjà le plancher (`loadGrid()` le lit), et un palier en dessous mérite d'être dit au patron au moment où il le tape. Pas un blocage — § 2.6 —, un avertissement sur la ligne concernée.

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

**Vérifiée sur le stack local le 2026-10-15** — la story avait été écrite sur un Postgres 16 nu, sans PostgREST ni fonctions Edge. `db reset` passe sur Postgres 17 ; les 25 sabotages ont été rejoués un par un et rougissent tous ; `sale-document.test.ts` et les plans d'E3-02 sont verts. Trois ajouts sont nés de cette passe :

- **`sale-document-api.test.ts`**, les trois chemins vus de PostgREST — `PATCH` sur un document confirmé, annulation par l'API, `POST` direct d'un `sale_cancellation` — sur le modèle de `stock-api.test.ts`, avec les contrôles positifs qui empêchent un refus étranger de tenir lieu de garde.
- **Le statut HTTP, mesuré et non supposé — et corrigé ici.** `42501` sort en `403`, mais **`55006` sortait en `500`** : aucun code de la classe 55 n'est dans la table de correspondance de PostgREST. Ce n'était pas un défaut d'affichage. En E9, PowerSync rejoue les écritures en attente et lit un 5xx comme une panne passagère : il réessaierait sans fin, et la file de l'appareil resterait bloquée sur un refus définitif. Trois autres gardes vivaient avec le même défaut, découverts par l'inventaire : `55000` (tables dérivées), `54000` (26 appareils), `P0002` (ligne introuvable). Tous passent à la famille `PTxxx` de PostgREST, dont les trois chiffres *sont* le statut — `PT409`, `PT422`, `PT400`, `PT404` —, un code par garde, aucun code de Postgres détourné. Migration `20261015090000_refusal_status.sql`, douze fonctions reprises depuis leur dernière définition lue au catalogue. Nouvelle RÈGLE à SPEC § 4, et règle `aucun refus rendu en 5xx` dans `conventions.ts`.
- **`aucun autre écrivain d'un mouvement d'annulation`**, règle de `conventions.ts` : `pg_trigger_depth()` sait qu'un trigger écrit, pas lequel. Toute fonction de `public` ou `merx` autre que `merx.reverse_sale_movements()` qui insère un `sale_cancellation` est nommée. Même forme que l'écrivain unique des tables dérivées, et éprouvée par une fonction témoin.

---

### E4-02 — Numérotation
**Étape 4** · dépend de E4-01, E1-03

**En tant que** patron, **je veux** des numéros sans trou ni doublon, **afin de** retrouver un bon.

**Critères d'acceptation**
- [x] Format `BL-A-26-00001` : type, préfixe d'appareil, année, séquence
- [x] Séquence par `(tenant, device, doc_type, year)`
- [x] Attribué à la confirmation, jamais au brouillon
- [x] **Attribué localement. Le serveur n'attribue aucun numéro.**
- [x] **Aucun trou en fonctionnement normal** — un brouillon ne consomme aucun numéro. Un trou seulement après une collision de l'unicité, où l'appareil enjambe le numéro pris. **Jamais un doublon.**
- [x] Test : deux appareils créant chacun 100 documents ne produisent aucune collision

**Notes** — `SPEC.md` RÈGLE M3-2. Une numérotation serveur rendrait E9 impossible.

**Le format, tranché : `BL-A-26-00001`.** L'année entre dans le numéro — la séquence est annuelle, et sans elle le premier bon de 2027 porterait le texte du premier bon de 2026, ce qui interdisait toute unicité sur `doc_number` (E4-01 n'en avait donc posé aucune). Deux chiffres d'année et cinq de séquence : le raisonnement et le prix de chaque choix sont écrits à SPEC § 8, RÈGLE M3-2, parce que c'est là qu'on viendra les relire. M3-2 garde sa séquence annuelle ; le critère « par `(tenant, device, doc_type, year)` » n'a pas bougé.

**« Aucun trou » a été réécrit, et c'est un arbitrage, pas un assouplissement.** La retente après une collision enjambe le numéro pris : elle crée un trou. Un trou se retrouve — le bon suivant existe, la séquence saute d'un rang, et l'historique reste lisible. Un doublon, lui, met deux papiers du même numéro dans les mains de deux clients, et ne se répare pas : on ne renumérote pas un papier signé. Le critère dit donc ce que le système tient réellement.

**Quand une collision peut-elle arriver, puisque deux appareils ont des lettres distinctes ?** L'unicité porte sur le texte, qui contient la lettre, et une lettre n'est jamais recyclée (E1-03) : deux appareils ne peuvent pas se heurter. Une collision exige donc qu'**un même appareil** produise deux fois le même numéro, et il n'y a que deux chemins :

1. **deux confirmations au même instant sur le même appareil** — deux onglets, un double appui, une écriture rejouée par la couche réseau. Les deux lisent la même borne et composent le même numéro ; l'index refuse la seconde, qui enjambe. C'est le cas réel, et le seul pour lequel la retente existe ;
2. **un numéro posé à la main par l'API** — PostgREST est ouvert au jeton du commerce, et un `PATCH` peut écrire n'importe quel numéro bien formé. L'index est la seule chose qui empêche le doublon ; l'appareil enjambe ensuite.

**Et le troisième cas, qui n'est pas une collision : il est écrit en E9-02.** Un stockage local vidé alors que des confirmations n'étaient pas encore synchronisées ne produit aucun refus côté serveur — les écritures en attente meurent avec le stockage, et ces documents n'arrivent jamais. L'appareil repart alors au-dessus de la borne *connue du serveur* et réimprime des numéros qui existent sur du papier sans exister en base. C'est une perte de documents, strictement pire qu'un trou, et aucun garde de ce côté-ci ne peut la voir : elle se tient par la durabilité de la file d'envoi, donc en E9-02, où elle est maintenant notée.

**La borne se lit dans `document_sequence`, et la table devient dérivée.** E4-01 l'avait posée sans trigger. E4-02 lui en donne un qui ne distribue rien : `merx.advance_document_sequence()` y pose, sur chaque numéro écrit, `greatest(last_number, numéro)`. Le serveur **constate**, il n'attribue pas — M3-2 est intacte —, et un compteur qui ne peut pas reculer est ce qui fait qu'un appareil vidé repart au-dessus de son dernier numéro synchronisé, jamais à `00001` (même leçon que le SKU d'E2-06, où l'autorité est l'index et non le compteur).

**Pourquoi pas `max(doc_number)`, qui serait la lecture évidente : mesuré.** Sous la paire de policies de § 2.1, une comparaison de texte sur `doc_number` n'emprunte aucun index — `textlike` n'est pas `leakproof` —, donc chaque confirmation parcourt toute la table, tous commerces confondus : **222 ms par appel sur 10 000 documents, 493 ms sur 20 000**, sur le chemin d'un bon qu'un client attend debout. La forme par intervalle (`>=` / `<`, tous deux `leakproof`) emprunte l'index — *parfois* : Seq Scan à 10 000 documents, Index Only Scan à 20 000, sur les mêmes données. Un plan qui bascule avec le volume n'est pas une base pour un chemin d'écriture. La borne, elle, est une poignée de lignes par commerce : **3,8 ms**, et son coût ne dépend d'aucun historique. `max(doc_number)` reste la bonne lecture pour la base locale d'E9, où il n'y a ni RLS ni voisin. Les deux plans sont assertés dans `document-numbering.test.ts`, session chauffée (E2-04).

**Ce qui n'est pas ici.** Aucune contrainte « sans trou » en base : il faudrait lire la ligne précédente à chaque écriture, donc sérialiser les confirmations du commerce. La propriété est tenue par la façon dont l'appareil choisit, et éprouvée par le test des 200 documents. Et aucune unicité par `(appareil, type, année)` : le texte contient déjà les trois, l'unicité porte sur lui — « dans ce commerce, ce numéro n'existe qu'une fois ».

**Deux corrections au passage, dans les tests d'E4-01** : `documentIn()` confirme désormais avec un numéro valide (la base l'exige), et le cas du gel de `issued_at` prend un autre instant *de la même année* — `now()` rendait l'horodatage de la transaction, donc une écriture qui ne changeait rien, et une autre année aurait été refusée par le garde de forme à la place du gel. `sale_document.device_id` passe NOT NULL avec sa clé composite : le garde n'a pas de lettre à comparer sans elle.

---

### E4-03 — Écran de vente
**Étape 4** · dépend de E4-01, E2-04

**En tant que** vendeur, **je veux** sortir un bon pendant que le client attend, **afin de** ne pas revenir au carnet.

**Critères d'acceptation**
- [x] **Trois entrées, aboutissant toutes à la même ligne** : scan, saisie de la référence, sélection sur grille photo
- [x] **Pas d'écran scan-only** : la marchandise n'est pas toujours à portée de main
- [x] Ajout d'une ligne : produit, quantité, prix résolu automatiquement
- [x] Modification de quantité et suppression de ligne directes
- [x] Total mis à jour en temps réel
- [ ] Sélection ou création d'un client sans quitter l'écran — **tenu par E6-01**, qui porte déjà ce critère mot pour mot et crée `client` avec `sale_document.client_id`
- [x] **Bon de 10 lignes en moins de 90 secondes**, chronométré — *le budget de gestes est mesuré en suite (31 taps, quantités réelles) ; le chronomètre lui-même est en vérification en attente*
- [x] Utilisable debout, au doigt, d'une seule main — *cibles de 48 px, actions en bas, quantité au clavier numérique ; à l'épreuve du comptoir avec le chronomètre*
- [x] Un stock à zéro n'empêche rien

**Notes** — `SPEC.md` RÈGLE M3-6, point de rupture n° 2. Chaque tap superflu est payé mille fois par jour.

**Le partage avec E4-04, tranché ici.** Il n'existe aucun prix hors de `price_break` — `variant` n'en porte pas, et chaque variante reçoit sa ligne `min_qty = 1` (E2-03). « Prix résolu automatiquement » ne pouvait donc pas être servi autrement : cette story lit les paliers vivants **à l'ajout de la ligne**, puis rejoue `resolvePriceBreak()` — la fonction pure d'E2-03, pas une seconde copie — **à chaque changement de quantité**. Là où la grille ne répond pas (aucun palier applicable, ou palier sans prix), la ligne passe `manual` et le vendeur saisit : ce n'est pas un forçage, c'est une absence de prix, et rien ne bloque une vente (SPEC § 2.6). **E4-04 garde** le forçage d'un prix *qui existe*, l'incitation au palier suivant, le plancher opposé au `worker`, la trace au journal, et la règle d'arrondi écrite en SQL. Le forçage d'E4-04 devra **survivre** à un changement de quantité, ce qui est l'inverse exact de la règle ci-dessus : c'est pourquoi il n'est pas construit en avance.

**L'arrondi est provisoire, et écrit comme tel.** Une quantité à trois décimales par un prix à deux donne cinq décimales ; `src/modules/sales/amounts.ts` revient à deux, demi loin de zéro, **au niveau de la ligne**. Ce n'est pas un choix de style : c'est ce que fait la conversion `numeric` de Postgres, donc la seule règle qui garantisse aujourd'hui que l'appareil et la base disent le même centime. Aucune contrainte de cohérence des totaux n'est ajoutée — c'est E4-04 qui tranche, en SQL, et qui remplacera ce seul endroit.

**Le type de mouvement `sale` reste fermé.** SPEC § 8 et le critère d'E4-05 le disent : la confirmation qui décrémente le stock est E4-05 (RÈGLE M3-5). Aucune capacité neuve, aucune ligne à `merx.movement_type_capability`, les quatre copies de la matrice ne bougent pas. **Conséquence assumée, le temps d'une story : un bon confirmé ici n'écrit aucun mouvement.** L'écran confirme quand même — c'est « sortir un bon » — par `confirmDocument()` d'E4-02, qui pose le numéro et la date.

**Rien n'est écrit pendant la saisie**, et trois appels partent à l'appui : le brouillon, ses lignes **en un seul appel**, puis la confirmation. Dix lignes ne coûtent donc aucun aller-retour, et un bon abandonné ne laisse aucun brouillon — c'est aussi ce qui tient la séquence sans trou (SPEC § 4). Les trois appels **ne sont pas atomiques** : ce qui a abouti est retenu, et un second appui après une coupure confirme le **même** brouillon, sans en créer un second ni redoubler ses lignes. Les totaux sont réécrits avant les lignes, pour qu'une retente parte de la saisie d'aujourd'hui. Mesuré dans `SaleScreen.test.tsx`.

**Le dépôt descend dans la base.** `sale_document.warehouse_id` était NOT NULL sans défaut (E4-01) : l'écran aurait dû lire `warehouse` pour vendre, une table que SPEC § 2.4 dit « jamais exposée », et payer un aller-retour de plus au comptoir. `merx.default_warehouse_id()` le pose désormais, en `security invoker` — les deux policies de § 2.1 gouvernent la lecture — avec le filtre `tenant_id = merx.current_tenant_id()` en tête du corps. Aucune inscription à `merx.rls_exception_registry` : rien ne sort de la RLS. **Le balayage d'isolation a appris la règle générale au passage** : une colonne NOT NULL dont le défaut appelle une fonction de `merx` est remplie par le peuplement, qui tourne sans jeton — c'était déjà le cas de `tenant_id`, écrit table par table ; c'est maintenant lu au catalogue.

---

### E4-04 — Résolution du prix
**Étape 4** · dépend de E4-03, E2-03

**En tant que** vendeur, **je veux** que le prix suive la quantité tout seul, **afin de** ne pas me tromper.

**Critères d'acceptation**
- [x] Prix résolu automatiquement depuis `price_break`
- [x] **Recalculé à chaque changement de quantité**, jamais figé à la première saisie
- [x] Passer de 8 à 12 fait basculer **toute la ligne** au palier supérieur, sans la scinder
- [x] À moins de 20 % du palier suivant, afficher l'incitation : « +2 → 12,00 DH »
- [x] Forçage manuel possible, marqué `manual`
- [x] Un `worker` ne peut pas descendre sous `floor_price` : refus avec message
- [x] Tout forçage est tracé dans `audit_log`

**Notes** — `SPEC.md` RÈGLES M1-3, M1-4, et M3-7, M3-8 écrites par cette story. L'incitation au palier est une fonction produit, pas une décoration.

**L'arrondi de `line_total`, tranché — et il cesse d'être affirmé par l'appareil.** `round(quantity × unit_price, 2) − line_discount`, **demi loin de zéro**, **au niveau de la ligne** ; le document somme les totaux de ligne *arrondis*. Demi loin de zéro parce que c'est ce que fait `round(numeric, 2)` de Postgres : toute autre convention obligerait l'appareil à implémenter un arrondi que le SQL écrit naïvement ne fait pas. Le raisonnement et le prix de chaque choix sont à SPEC § 8, RÈGLE M3-7, parce que c'est là qu'on viendra les relire.

Et la règle n'est pas gardée par un `check` : **`line_total` devient une colonne engendrée.** Un `check` aurait laissé l'appareil affirmer le total et se serait contenté de le contredire ; engendrée, la colonne ne lui laisse pas la parole — `saleWrite.ts` ne l'envoie plus, et l'accord sur le centime devient structurel au lieu d'être asserté. Le total de `amounts.ts` ne sert qu'à afficher, et `sale-price.test.ts` **mesure** à chaque passage que les deux tombent sur le même centime, sur la vraie base.

**La cohérence des totaux, en trois pièces.** `line_total` engendrée ; `sale_document_total_consistent` (`total = subtotal − discount_total`, à tout instant) ; et `merx.require_consistent_totals()` pour la somme des lignes, **à la confirmation seulement** — un brouillon s'écrit avant ses lignes (E4-03), et un garde permanent refuserait le brouillon lui-même. Le moment où elle doit être vraie est celui où le contenu se figeait déjà. Les trois lèvent `23514`, rendu 400 et mesuré.

**Les deux sortes de `manual`, distinguées par une colonne et non par une convention.** E4-03 marque `manual` une ligne dont la grille ne donne *aucun* prix ; E4-04 apporte le forçage, qui remplace un prix *qui existe*. Les deux portant `manual`, le journal des forçages aurait compté chaque ligne sans prix pour un forçage. `sale_line.overridden_price` — le prix remplacé, nul autrement — les sépare, et `sale_line_override_shape` tient les trois états. Le gain décisif n'est pas la distinction : c'est que **l'entrée d'audit a enfin son « avant »**, le prix remplacé n'étant nulle part ailleurs sur la ligne.

Elle est **posée par l'appareil, jamais recalculée à l'arrivée** : recalculer `price_break` au moment où la ligne arrive ferait refuser, à la synchronisation, une vente faite hors ligne dont la grille a changé depuis — un refus définitif sur une écriture qui ne passera jamais. Limite assumée : par l'API, un employé peut taire son forçage en laissant la colonne nulle ; il n'échappe pas au plancher, qui ne dépend d'aucune déclaration de l'appareil.

**La trace est posée sur la ligne, à l'écriture du prix forcé — et la note d'ouverture de cette story disait l'inverse.** Journalisée à la transition `draft → confirmed`, l'entrée aurait attribué le forçage à **celui qui confirme** : `merx.log_audit()` prend l'auteur dans le jeton de celui qui écrit (E1-04). Le journal ne pose qu'une question, « qui », et il y aurait répondu faux — le patron qui valide au lieu de l'employé qui a baissé le prix. Posée sur la ligne, le garde du plancher et la trace voient de surcroît le même instant. Et « pas à chaque frappe » était déjà tenu par E4-03 : rien n'est écrit pendant la saisie, les lignes partent en un seul appel à l'appui sur « Enregistrer le bon ». Écrit à SPEC § 8, RÈGLE M3-8, pour que personne ne le « corrige » vers la confirmation. Le mécanisme est celui d'E3-03 et d'E4-01, **sans rien ajouter au helper** : `merx.apply_audit()`, condition de ligne `new.overridden_price is not null`, événements `insert, update`.

**Le plancher ne regarde pas `price_source`.** S'il ne valait que pour `manual`, un employé poserait `auto` par l'API et passerait dessous : le contrôle serait une politesse. Conséquence assumée : un palier réglé *sous* le plancher devient invendable par l'employé — l'écran de grille devrait le signaler au patron à la saisie (noté en E2-03). Aucune capacité ajoutée : `override_price` et `override_price_below_floor` sont à § 3.1 depuis E0-05, qui les y avait posées pour un appelant d'E4 ; les quatre copies de la matrice ne bougent pas.

**Les 20 % de la RÈGLE M1-4 se mesurent sur le palier visé**, non sur la quantité demandée : l'écart doit valoir au plus 20 % de son `min_qty`. Un palier à 12 incite donc depuis 10 et pas depuis 8 — les deux côtés de l'exemple du spec. Un seuil assis sur la quantité dériverait à chaque frappe, alors que le palier est une propriété de la grille. L'incitation se tait si le palier visé n'a pas de prix, ou si ce prix ne vaut pas mieux que celui de la ligne : on n'invite pas quelqu'un à payer davantage.

**Ce qui a bougé ailleurs, et pourquoi.** Les charges de `sale-document.test.ts` et `sale-document-api.test.ts` écrivaient `line_total` à la main et posaient des totaux à zéro sous des documents qu'elles confirment : les deux sont désormais impossibles. Un cas y a changé de sens au passage — `update sale_line set quantity = -1` était refusé par `sale_line_quantity_positive`, et le serait maintenant d'abord par `sale_line_amounts_not_negative`, puisque le total engendré devient négatif avec la quantité ; le prix passe à 0 dans la même instruction pour que la contrainte mesurée reste celle qu'on croit mesurer (même famille que E2-01).

**Ce qui n'est pas ici.** Aucun mouvement de stock (E4-05, RÈGLE M3-5) ; aucune remise — `line_discount` et `discount_total` restent à zéro et aucun écran ne les saisit, mais la règle d'arrondi les porte déjà ; aucun garde sur un palier réglé sous le plancher (c'est l'écran de grille, E2-03).

**Sabotages (7 gardes retirés, un par un ; fichiers concernés seulement) :** tous font rougir au moins un test.

- **trigger `require_floor_price` retiré** — 4 tombent : les trois cas du plancher en SQL (employé refusé, ligne `auto` sous le plancher, modification d'un brouillon) et le 403 mesuré par l'API ;
- **sa condition de capacité seule (`merx.can`)** — 2 tombent, et ce sont les **contrôles positifs** : le patron ne passe plus, ni en SQL ni par l'API. Le garde et son exception tombent donc séparément ;
- **trigger `require_consistent_totals` retiré** — 2 tombent : la confirmation d'un sous-total faux, en SQL et en 400 par l'API. `sale-document.test.ts` reste vert : la somme n'est gardée que là ;
- **expression de `line_total` retirée** (`drop expression`, la colonne redevient ordinaire) — 13 tombent : les six cas d'arrondi, l'accord avec `amounts.ts`, le total qui suit la quantité d'un brouillon, le refus d'une valeur fournie, et les deux confirmations dont la somme dépend des totaux de ligne ;
- **`sale_line_override_shape` retiré** — 3 tombent : les deux formes refusées en SQL, et le 400 de l'API ;
- **condition de ligne du trigger d'audit retirée** — 5 tombent, dont **les deux cas négatifs** qui portent l'arbitrage : une ligne au palier et une ligne sans prix écrivent désormais une entrée. La règle `tables auditées gardées` de `conventions.ts` tombe avec, parce que la clause `when` du catalogue ne correspond plus au registre ;
- **trigger d'audit retiré entièrement** — 4 tombent : les trois entrées attendues, et la même règle de `conventions.ts`, par son autre volet. Les deux cas de ce couple ne tombent jamais sur les mêmes tests.

**Suite complète, machine libre : 64 fichiers, 1 675 tests, tous verts.** `typecheck` et `lint` lus sur la sortie des commandes, après la dernière édition.

---

### E4-05 — Cycle des documents
**Étape 4** · dépend de E4-01

**En tant que** patron, **je veux** transformer un devis en bon, **afin de** ne pas ressaisir.

**Critères d'acceptation**
- [x] Devis → commande → bon de livraison
- [x] **Chaque transformation crée un nouveau document lié**, l'original n'est jamais muté
- [x] Le lien de filiation est consultable dans les deux sens — *la lecture, `documentLineage()` ; son **affichage** est E4-07, qui porte l'écran de détail*
- [x] **Le stock n'est décrémenté qu'à la confirmation du `delivery_note`**, ni au devis ni à la commande
- [x] Modification des lignes possible pendant la transformation

**Notes** — `SPEC.md` RÈGLES M3-4, M3-5.

**Le mouvement `sale` naît de la confirmation, et d'elle seule.** Le type s'ouvre sur `create_sale`, la capacité qu'annonçait l'addendum E4-01 de la RÈGLE M2-5 — aucune capacité nouvelle, les quatre copies de la matrice ne bougent pas. Mais ouvrir la porte à `create_sale` et s'en tenir là aurait fait de l'API un `POST` de mouvements sans écran : un employé y poserait un `sale` de n'importe quel signe, sans document et **sans entrée de journal** (RÈGLE M8-1 n'audite que l'ajustement, l'annulation et le forçage). C'est l'objection d'E4-01 pour `sale_cancellation`, et la réponse est la même, pièce pour pièce : un écrivain déclaré (`merx.write_sale_movements()`, trigger AFTER sur `draft → confirmed` au seul type `delivery_note`, `security invoker`), l'écriture à la main refusée (`merx.require_sale_origin()`, `pg_trigger_depth()`, `42501` rendu 403, sa propre phrase), et une règle de `conventions.ts` qui nomme tout autre écrivain.

**Cette règle-là a dû changer de forme, et c'est l'enseignement de la story.** Celle d'E4-01 cherche le mot `sale_cancellation` au corps des fonctions ; le mot est distinctif. **`sale` ne l'est pas** — il est dans `sale_document`, `sale_line`, `sale_cancellation` —, et la première forme écrite ici cherchait le littéral *transtypé*, `'sale'::public.stock_movement_type`. Elle **se contournait en écrivant moins** : `movement_type = 'sale'` sans transtypage, que Postgres accepte, passait le balayage. Une règle statique qui s'évite par une écriture plus courte ne tient rien. D'où `merx.movement_writer`, un registre, et une règle — `aucun écrivain de mouvement non déclaré` — qui ne lit **aucun littéral de type** : elle demande qui insère dans `stock_movement` et confronte la réponse au registre. Le témoin de `conventions.test.ts` insère un `'sale'` **nu**, et c'est lui qui prouve la différence. Limite résiduelle, écrite : un écrivain *déclaré* pourrait insérer un autre type que celui qu'on lui prête.

**La filiation est une colonne, pas une table de liens.** `sale_document.source_document_id`, auto-référence à clé composite sur `tenant_id`, sans cascade (un document ne se supprime pas, et la suppression d'un brouillon ne doit pas emporter ses enfants) et **sans unicité** : un enfant n'a qu'un parent, un parent a plusieurs enfants. **Oui, un devis peut donner deux commandes et une commande deux bons** — la livraison en deux camions est le cas normal du grossiste. Les deux sens se lisent : le parent par la colonne, les enfants par l'index partiel `sale_document_source`.

**La chaîne vit en données** (`merx.document_transformation`, même geste que `merx.frozen_transition`), et **le saut `devis → bon` est admis** : un client accepte un devis et on le livre. L'interdire forcerait une commande fictive pour le cas le plus courant du comptoir. Rien ne part d'un bon, aucun lien ne remonte. `merx.require_transformation_shape()` tient quatre branches à quatre phrases en `22023` rendu 400 — auto-référence, original brouillon, original annulé, chaîne impossible — et laisse la clé composite répondre pour l'original du voisin (`23503`, rendu 409), sans quoi il tiendrait lieu d'isolation dans le balayage (E3-01).

**L'original n'a rien demandé de neuf pour n'être pas muté** : il est figé depuis sa confirmation (RÈGLE M3-3). La transformation ne crée que la ligne de l'enfant — et l'assertion le dit à l'envers, en vérifiant qu'**aucune écriture ne nomme l'original**.

**Le prix repris n'est pas un forçage de celui qui transforme, et la première version de ce plan se trompait.** Elle recalculait `overridden_price` contre la grille du jour, pour que la ligne « dise » qu'elle s'écarte des paliers. Le trigger d'audit écrit une entrée `price_override` dès que la colonne n'est pas nulle, et `merx.log_audit()` prend l'auteur dans le jeton de **celui qui écrit** (E1-04) : l'employé qui transforme un devis fait par le patron un mois plus tôt se verrait attribuer un forçage qu'il n'a pas décidé. C'est exactement l'erreur de « qui » qu'E4-04 a refusée en déplaçant la trace de la confirmation vers la ligne. Donc `overriddenPrice` est **nul** sur toute ligne reprise ; le journal n'enregistre de cet employé que ce qu'il change lui-même, après coup et à son nom. `price_source` est **mesuré** contre la grille du jour au lieu d'être copié — `auto` si le prix repris est celui du palier, `manual` sinon, ce qui est la vérité : le prix vient d'un papier. Le forçage d'origine reste écrit sur le document d'origine, que la filiation retrouve.

**Le plancher et l'arrondi d'E4-04 s'appliquent aux lignes copiées, et c'est voulu.** Une ligne copiée est une ligne neuve : un devis vieux d'un mois, passé sous un plancher relevé depuis, est refusé. Le refus tombe **au comptoir**, devant un vendeur qui a deux issues immédiates — faire forcer le prix par le patron, ou faire baisser le plancher. C'est l'inverse du cas hors ligne, où le même refus arrive des jours après une vente déjà faite, sans personne pour agir : celui-là est une décision en attente (`PENDING-CHECKS`, E9-03). Et la grille reprend la parole dès que la quantité change : une nouvelle quantité est une nouvelle vente, pas la reprise d'un prix promis.

**Ce qui n'est pas gardé, et qui est une question pour l'arrêt terrain d'E6 :** rien ne compare les quantités des enfants à celles du parent. **Une commande de 100 peut donner deux bons de 100 chacun**, donc une livraison au-delà de la commande reste possible. Le garder exigerait de décider ce qu'on fait d'un reliquat, d'une commande révisée et d'un bon annulé — des règles de gestion qu'on ne devine pas depuis un écran. **À poser aux commerçants** : livre-t-on jamais plus que commandé, et si oui qu'est-ce que le papier doit dire ?

**Côté écran, le minimum qui rende la chaîne atteignable.** Un choix de type (Devis / Commande / Bon) sur l'écran de vente — sans lui, aucun devis ne peut exister, donc la chaîne n'a pas de premier maillon —, sur le patron du `ViewSwitch` existant : BRAND-UI § 8 ne connaît que trois variantes de bouton et aucun « choix segmenté », rien de visuel n'est inventé. Et une route `/sale/from/:documentId` qui reprend les lignes dans ce même écran, où elles se modifient comme celles qu'on vient de taper : écran de **détail**, donc un retour vers Vente et aucune barre d'onglets (BRAND-UI § 13), classé dans `navigation.test.tsx`. **Aucune liste de documents n'est construite** : la recherche d'un bon et son détail sont E4-07, et c'est là que la filiation s'affichera.

**Ce qui a bougé dans les harnais voisins, et pourquoi.** Le type `sale` était fermé : quatre fichiers le posaient à la main pour produire du stock, et `require_sale_origin` les refuse désormais. Ils suspendent nommément ce garde-là, par un `withoutTrigger()` neuf dans `isolation.ts` — et non par `withoutTriggers()`, qui emporterait l'agrégat et les clés étrangères (CLAUDE.md), c'est-à-dire exactement ce que ces fichiers mesurent. `sale-document.test.ts` suspend en plus `write_sale_movements` pendant sa confirmation de harnais : il pose et compte ses propres mouvements, et une addition des deux stories lui ferait mesurer autre chose que l'inversion. Les deux énumérations du registre type → capacité (`sale-document.test.ts`, `stock-movements.test.ts`) gagnent la ligne `sale`, `stock-api.test.ts` cesse de refermer un type que la migration ouvre, et le rangement de `sale-price-api.test.ts` efface les mouvements qu'une confirmation écrit maintenant.

**Sabotages (6 gardes retirés, un par un ; fichiers concernés seulement) :** tous font rougir au moins un test.

- **trigger `write_sale_movements` retiré** — 7 tombent : la décrémentation, la confirmation par l'employé, celle mesurée par l'API, l'inversion exacte de l'annulation et la seconde annulation, et les deux cas de filiation qui vérifient le stock au passage ;
- **sa condition de type seule** (le devis et la commande décrémenteraient) — 6 tombent, et ce sont **les cas négatifs** : devis et commande en SQL, devis par l'API, l'annulation d'un devis qui n'a rien écrit. Le garde et sa condition tombent donc séparément ;
- **garde `require_sale_origin` retiré** — 4 tombent : l'insertion directe par le patron et par l'employé, en SQL et en 403 mesuré. Le type est ouvert aux deux rôles, donc la policy ne refuse personne : il n'y a que lui ;
- **écrivain retiré de `merx.movement_writer`** — 3 tombent : la règle `aucun écrivain de mouvement non déclaré` par ses deux volets (le vrai écrivain nommé, le registre périmé), et l'énumération du registre ;
- **garde `require_transformation_shape` retiré** — 8 tombent : les quatre branches en SQL et trois des quatre en statut mesuré ;
- **clé de filiation reconstruite sans `tenant_id`** — 2 tombent : l'original du voisin, en SQL et en 409 mesuré. Les deux écritures sont dans **une seule** transaction et le comptage se fait hors RLS, sans quoi le cas resterait vert quoi qu'il arrive (CLAUDE.md, E2-06).

**Suite complète, machine libre, base remise à zéro : 68 fichiers, 1 737 tests, tous verts.** `typecheck` et `lint` lus sur la sortie des commandes, après la dernière édition.

---

### E4-06 — Retours
**Étape 4** · dépend de E4-01

**En tant que** vendeur, **je veux** enregistrer un retour, **afin que** le stock et le compte du client soient justes.

**Critères d'acceptation**
- [x] Retour lié à un bon existant, total ou partiel
- [x] Génère les mouvements `return` et remet en stock
- [ ] Génère l'écriture au crédit du client — **tenu par E6-02**, qui porte déjà ce critère mot pour mot et crée `client_ledger_entry` ; `client_id` arrive en E6-01
- [x] Numéroté selon le même schéma que les bons — `RT-A-26-00001`
- [x] Motif saisissable, jamais obligatoire — `sale_document.notes`, « Motif du retour » à l'écran

**Notes** — `SPEC.md` RÈGLES M2-5 (addendum E4-06), M3-2, M3-4, M3-8, et M3-9 écrite par cette story.

**Une étiquette de plus, pas une table à part — et SPEC § 8 perd `return_document` + `return_line`.** Le spec les nommait sans une seule colonne : une intention, pas une décision. L'inventaire de ce que chaque voie oblige à refaire a tranché. Une table à part exigeait une **seconde table dérivée** pour la séquence (clé par `doc_type`, donc l'étiquette suffit) avec son trigger, son écrivain au registre, sa seconde unicité et une seconde borne à lire par l'appareil — jusque dans la base locale d'E9 ; cinq fonctions de numérotation à dupliquer ou à rendre génériques ; le gel, les quatre pièces des totaux, l'annulation, son motif obligatoire et l'entrée `document_cancellation` à recopier ; et une colonne de filiation de plus, que `documentLineage()` ne verrait pas. L'étiquette coûte un label d'enum — donc **deux migrations**, une valeur n'étant pas utilisable dans la transaction qui la crée (E4-01) —, quatre copies de la table des codes à faire bouger, et une correction de doc. Le raisonnement est écrit à SPEC § 8, parce que c'est là qu'on viendra le relire.

**`RT-A-26-00001`, et pas `BR`.** « Bon de retour » appellerait `BR` — et `BL` et `BR` ne diffèrent que d'une lettre sur un numéro qui se dicte au téléphone, ce qui est précisément pourquoi l'année ne fait que deux chiffres (RÈGLE M3-2). `RT` ne partage aucune position avec `BL`, `CM` ni `DV`. La séquence étant clé par `(commerce, appareil, type, année)`, le retour a son propre compteur sans qu'une ligne soit ajoutée à `document_sequence`.

**Une correction de doc, assumée.** SPEC § 8, RÈGLE M3-4 écrivait « rien ne part d'un bon de livraison », et `transform.ts` portait la phrase « un bon de livraison est la fin du cycle ». Un retour part d'un bon. La RÈGLE elle-même est intacte — une transformation crée un nouveau document lié, sans muter l'original — ; c'est la note d'arbitrage d'E4-05 qui devient fausse, et elle est corrigée là où elle était écrite. `TRANSFORM_TARGET[delivery_note]` reste **nul** : un retour n'est pas le pas suivant d'une chaîne de vente, c'est le geste inverse, et il a sa propre porte.

**RÈGLE M3-9, deux branches et deux phrases.** `merx.require_returnable_quantity()`, à la confirmation d'un retour : ni plus de quantité, ni plus d'avoir que le bon n'en portait, retours précédents déduits, **par variante**. La seconde branche n'est pas une politesse — sans elle un `POST` crédite 120 DH pour 90 DH de marchandise et la première ne voit rien passer. `PT400`, « demande impossible à satisfaire », dont les trois chiffres *sont* le statut : pas `22023`, la quantité étant bien formée. Comptent comme « déjà rendu » les retours `confirmed` ou `delivered` : pas les brouillons — un retour abandonné bloquerait le bon pour toujours —, pas les annulés, dont le stock est reparti.

**Deux retours qui se croisent : un verrou, et il n'est pas mesuré.** Le garde prend un `for update` sur le **bon d'origine** avant de compter — la seule ligne que les deux chemins traversent —, et en READ COMMITTED la seconde transaction attend le commit de la première puis voit son retour. Même raisonnement que le `for share` d'E4-01. Le mesurer demande deux connexions entrelacées, ce que le harnais ne sait pas faire : troisième ligne de cette famille dans `docs/PENDING-CHECKS.md`, rattachée au même harnais noté en E9-03. Ce qui **est** mesuré : deux retours successifs dont le second dépasse, le retour annulé qui libère son registre, le brouillon qui ne le consomme pas.

**Un trou que le quatrième type ouvrait, fermé ici.** Un bon de 10 confirmé (−10), un retour de 3 (+3), puis l'annulation du bon : `reverse_sale_movements()` inverse ses mouvements `sale` (+10), le stock finit à **+3 de trop**, les pièces rendues comptées deux fois, et l'avoir du retour survit à une vente qui n'existe plus. `merx.require_no_active_return()` refuse donc l'annulation d'un bon qui porte un retour non annulé, en `PT409` rendu 409, **avec le numéro du retour dans la phrase** : « annulez vos retours » sans dire lesquels n'apprend rien. Le patron annule ses retours, puis son bon — et non une cascade d'office, qui déciderait à sa place et qui est exactement ce que l'ajout seul refuse (RÈGLE M2-2). Le verrou du garde précédent sert ici aussi : l'annulation est un UPDATE sur la ligne du bon, donc elle ne peut pas croiser un retour en cours de confirmation.

**Et `sale_cancellation` s'élargit, d'une phrase.** Il inverse désormais ce qu'une confirmation avait écrit — `sale` pour un bon, `return` pour un retour — : sans quoi un retour annulé gardait le stock qu'il avait rendu, conséquence directe du choix de l'étiquette, donc à fermer dans cette story. Le filtre reste un filtre (un `sale_cancellation` ne se réinverse jamais). Un septième type `return_cancellation` aurait coûté un label, deux migrations, un garde d'origine, une entrée au registre et une ligne de capacité pour une seule différence : le signe.

**Le plancher ne gouverne pas un avoir**, et c'est un garde d'E4-04 qu'il a fallu toucher. Le prix d'une ligne de retour est celui du papier — c'est ce que le client a payé —, et `merx.require_floor_price()`, posé sur `sale_line` sans regarder le document, aurait refusé un retour d'un bon ancien passé sous un plancher relevé depuis : un refus de vente appliqué à un remboursement. Il lit donc `doc_type` **dans le même `select`** que `floor_price` — une jointure, pas un aller-retour de plus sur le chemin des dix lignes au comptoir — et sort tôt sur un retour. La ligne est `manual` avec `overridden_price` nul : le prix vient d'un papier, pas de la grille, donc aucune entrée `price_override` au journal, ce qui est juste — personne n'a forcé quoi que ce soit.

**Le registre est tenu par variante, et non par ligne d'origine.** Le commerçant rapporte « cinq de ce produit », pas « cinq de la ligne 3 ». Un bon portant deux lignes de la même variante à deux prix n'arrive que par l'API — l'écran de vente fusionne (E4-03) — et la ligne de retour prend alors le **plus bas** des deux prix : l'avoir ne dépasse jamais ce qui a été facturé, donc la branche avoir ne refuse aucun retour total légitime. Limite écrite plutôt que tue : ce bon-là se rembourse au plus bas des deux prix.

**Un écran à part, et non un mode de l'écran de vente.** La vente cherche, scanne, parcourt une grille photo, résout un prix, force un prix, incite au palier suivant ; un retour ne fait aucune de ces choses — ses lignes viennent du bon et de nulle part ailleurs, et son prix est celui du papier. Greffer un mode sur `SaleScreen` aurait demandé de masquer presque tout l'écran. `ReturnScreen` vit donc à part, sur la route `/sale/return/:documentId` : écran de détail, un retour vers Vente, aucune barre d'onglets (BRAND-UI § 13), rangé dans `navigation.test.tsx`. Les trois appels d'E4-03 sont les mêmes — brouillon, lignes en un seul appel, confirmation —, et une quantité tapée au-delà du bon **reste affichée** : la ligne le dit et « Enregistrer » se refuse, on ne réécrit pas sous les doigts de quelqu'un.

**Ce qui n'est pas ici.** L'écriture au crédit (E6-02, où le critère est inscrit avec ce qu'E4-06 lui laisse de concret) ; la liste et le détail des retours, qui sont E4-07 comme pour les bons ; aucune capacité neuve — `return` s'ouvre sur `create_sale`, les quatre copies de la matrice ne bougent pas ; aucune entrée de journal neuve, la RÈGLE M8-1 n'auditant que l'ajustement, l'annulation et le forçage.

**Ce qui a bougé dans les harnais voisins, et pourquoi.** `require_return_origin` refuse l'insertion directe d'un `return` : les deux fichiers qui en posaient à la main pour produire du stock suspendent nommément ce garde-là, par le `withoutTrigger()` d'E4-05 et non par `withoutTriggers()`, qui emporterait l'agrégat et les clés étrangères (CLAUDE.md). Le cas d'E4-01 qui mesurait le **filtre de type** de l'inversion employait un mouvement `return` comme contre-exemple — ce qu'E4-06 inverse désormais : il emploie un `receipt` (E8-02), un type qu'aucune confirmation n'écrit. Les énumérations de registre gagnent leur ligne : `movement_writer` (trois écrivains), `movement_type_capability` (`return` sur `create_sale`), `document_transformation` (bon → retour), les étiquettes de `sale_doc_type` (quatre) et la table des codes (`RT`).

**Sabotages (12 gardes retirés, un par un ; fichiers concernés seulement, reporter qui n'imprime que les échecs) :** tous font rougir au moins un test — mais pas du premier coup, et c'est le passage qui a appris quelque chose.

- **garde `require_returnable_quantity` retiré** — 6 tombent : les deux excès en SQL, le registre par variante, le cumul des retours précédents, et les deux statuts mesurés par l'API ;
- **sa branche quantité seule** — **0 au premier essai, et c'était un trou.** Tous les retours excessifs que la suite mesurait dépassaient *aussi* en montant : la branche avoir refusait à la place de la branche retirée, avec une phrase que l'assertion ne distinguait pas (même famille que les unicités d'E2-01). Un cas neuf l'isole — **douze pièces à 7 DH sur un bon de 10 à 9 DH**, 84 DH d'avoir dans les clous et douze pièces entrées au dépôt sans en être sorties — et la branche tombe seule, 1 rouge ;
- **sa branche avoir seule** — 2 tombent : l'avoir gonflé en SQL et son 400 mesuré. Les deux branches tombent donc séparément ;
- **contrainte `sale_document_return_has_source` retirée** — 2 tombent : le retour issu de rien, en SQL et en 400 mesuré. Le nom de la contrainte est asserté, pas seulement le code ;
- **trigger `write_return_movements` retiré** — 12 tombent : tout ce qui repose sur du stock revenu, jusqu'à l'annulation et au plancher ;
- **sa condition de type seule** — 21 tombent, et ce sont **les cas négatifs** : un devis, une commande et un bon confirmés rendraient du stock. `sale-lifecycle.test.ts` tombe avec, ce qui est le signe qu'on cherchait — la condition vit dans le `when` du trigger, donc au catalogue ;
- **garde `require_return_origin` retiré** — 4 tombent : l'insertion directe par le patron et par l'employé, en SQL et en 403 mesuré. Le type est ouvert aux deux rôles, donc la policy ne refuse personne : il n'y a que lui ;
- **écrivain retiré de `merx.movement_writer`** — 4 tombent : la règle `aucun écrivain de mouvement non déclaré` par ses deux volets, et les deux énumérations du registre ;
- **`('return', 'create_sale')` retiré de `merx.movement_type_capability`** — 23 tombent : plus aucun retour ne se confirme, et les deux énumérations « n'ouvre que les types dont une story a livré l'écran » tombent avec ;
- **filtre de `reverse_sale_movements` ramené à `'sale'`** — 3 tombent : le retour annulé qui garde son stock, et le registre qui ne se libère pas. C'est le trou que l'étiquette ouvrait ;
- **exemption de plancher du retour retirée** — 1 tombe : le retour d'un bon passé sous un plancher relevé depuis. `sale-price.test.ts` reste vert, ce qui est la preuve que l'exemption ne desserre rien pour la vente ;
- **garde `require_no_active_return` retiré** — 2 tombent : l'annulation d'un bon sous un retour vivant, en SQL et en 409 mesuré.

**Le registre des exceptions RLS couvre `merx`, et ce n'était pas « à instruire ».** La première version de cette note renvoyait le trou à une story future ; il se ferme ici. Le balayage de `conventions.ts` ne lisait que `public` — les seules fonctions que PostgREST expose —, ce qui confondait **inappelable** et **inoffensive** : `security definer` s'exécute sous `postgres`, qui porte BYPASSRLS, quel que soit le schéma, et un garde de trigger de `merx` qui oublierait son filtre lirait chez le voisin sans que rien ne le nomme. Chaque épique en ajoutera, donc la règle devait monter avant eux, pas après.

**Et la règle étendue en a nommé douze, pas six.** Les six gardes de trigger d'E4 attendus, plus six fonctions qui se bornent autrement — et le registre devait pouvoir le dire. D'où trois formes de garde de plus, chacune **contrôlée au corps**, parce qu'une forme invérifiable serait une case à cocher et non un garde (l'objection faite à `super_admin` en E2-04) :

- **`row_tenant`** — la forme demandée : le garde se borne à la **ligne écrite**, `new.tenant_id`, et non au commerce du jeton. Les deux ne sont pas interchangeables : le `with check` de `tenant_isolation` a déjà forcé la ligne au commerce du jeton avant que le garde parle, alors qu'un garde filtrant sur `merx.current_tenant_id()` cesserait de garder le jour où une migration écrirait sans jeton. Sept entrées — les six gardes d'E4-02 à E4-06, et `merx.open_default_warehouse()`, trigger sur `tenant` dont la ligne *est* le commerce : `new.id` n'est admis que là, et c'est le **catalogue** qui dit sur quelle table le trigger est posé, pas la fonction qui le prétend ;
- **`argument_tenant`** — `merx.next_device_prefix()` et `merx.seed_tenant_settings()` reçoivent le commerce en argument ; ce sont leurs appelantes inscrites qui portent le droit. La règle exige qu'un argument « tenant » soit nommé au corps : recevoir le commerce et ne pas s'en servir est exactement la faute à attraper ;
- **`auth_identity`** — `merx.current_app_user()` et `merx.custom_access_token()` **trouvent** le commerce ; s'y borner serait circulaire, et le hook d'authentification tourne hors session, avant qu'un commerce existe dans le jeton. Ce qui les borne est l'identité : `auth.uid()`, ou l'identifiant de l'événement.

`merx.log_audit()` prend `current_tenant`, qu'elle avait déjà. Le registre porte désormais le **schéma** — sa clé était le nom nu, et deux fonctions homonymes se seraient confondues, c'est-à-dire qu'une entrée aurait couvert une fonction qui n'est pas celle qu'on croit : la faute même que ces règles existent pour attraper. Dix-huit entrées, énumérées exactement dans `conventions.test.ts`.

**Sabotage de la règle étendue — six témoins, chacun avec son jumeau conforme ; six morceaux de la règle retirés, un par un, `conventions.test.ts` seul.** Tous font rougir au moins un test.

- **portée ramenée à `public`** — 5 tombent, et ce sont **tous les témoins de `merx`** : celui que l'arbitrage demandait (une fonction de `merx`, `definer`, qui lit `product` **sans filtre de commerce** — invisible avant l'extension) et les quatre formes de garde. C'est la mesure de l'extension elle-même ;
- **volet `row_tenant` retiré** — 2 tombent : le garde qui ne borne rien, et `new.id` hors d'un trigger sur `tenant` ;
- **exception `new.id` pour un trigger sur `tenant` retirée** — 2 tombent, dont **le contrôle positif sur le schéma réel** : `merx.open_default_warehouse()` se fait nommer, ce qui est exactement ce que l'exception existe pour éviter ;
- **volet `argument_tenant` retiré** — 1 tombe : la fonction qui reçoit le commerce et ne s'en sert pas ;
- **volet `auth_identity` retiré** — 1 tombe : la fonction qu'aucune identité ne borne ;
- **volet inverse ramené à `public`** — 3 tombent : une entrée de `merx` dont la fonction a disparu n'est plus nommée, et masquerait la prochaine du même nom.

Le jumeau conforme de chaque témoin — qui lit la même table en se bornant comme il le déclare — n'est jamais signalé : une règle qui nommerait toute fonction `definer` de `merx` passerait les cas négatifs aussi.

**Vérifiée sur le stack local le 2026-10-20**, le moteur Docker ayant été arrêté le temps d'écrire cette extension : `db reset` applique les deux migrations et finit sur sa ligne `Finished` ; `conventions.test.ts` est vert, liste des dix-huit entrées comprise ; les six sabotages ci-dessus ont été rejoués un par un. **Suite complète, machine libre, base remise à zéro : 72 fichiers, 1 810 tests, tous verts.** `typecheck` et `lint` lus sur la sortie des commandes, après la dernière édition.

**Suite complète, machine libre, base remise à zéro : 72 fichiers, 1 804 tests, tous verts** à la clôture de la story — 1 810 après les six témoins de la règle étendue ci-dessus. `typecheck` et `lint` lus sur la sortie des commandes, après la dernière édition.

**Une correction de voisinage, trouvée par cette passe-là.** `sale-lifecycle.test.ts` comparait les deux enfants d'une commande **dans l'ordre**, et le harnais les range par `created_at` — qui vaut `now()`, l'instant de la *transaction* : deux documents créés dans la même transaction le portent à l'identique, et rien ne les ordonne. Le cas passait par la chance de l'ordre physique des lignes depuis E4-05, et il a fini par tomber. Il compare désormais sans ordre : ce qu'il mesure est qu'un parent porte **les deux** enfants (RÈGLE M3-4), pas lequel vient d'abord.

**Et une cinquième copie de la table des codes, trouvée elle aussi par la suite complète.** La note d'ouverture en comptait quatre ; `src/modules/sales/numbering.test.ts` tenait la sienne (« couvrent les trois types, et rien de plus »), et elle n'est rouge que dans le projet front — comme la quatrième copie de la matrice des capacités (CLAUDE.md, E3-03). Elle en couvre quatre désormais.

---

### E4-07 — Liste et consultation
**Étape 4** · dépend de E4-01

**En tant que** patron, **je veux** retrouver un bon, **afin de** régler un litige.

**Critères d'acceptation**
- [ ] Liste filtrable par date, client, statut, type, appareil — *date, statut, type, appareil : vérifiés le 2026-10-20 sur le stack local. **Client : tenu par E6-01** — `sale_document.client_id` naît avec la table `client`, aucun paramètre ni colonne ici.*
- [x] Recherche par numéro — *trois formes : numéro entier, chiffres seuls, fragment*
- [x] Détail affichant les lignes, les totaux, l'auteur, l'appareil et l'horodatage
- [x] Annulation réservée au `owner`, avec motif, tracée — *l'entrée `document_cancellation` relue après l'annulation émise par la requête de l'écran, auteur compris*
- [x] Un document annulé reste visible, clairement marqué — *le mot « Annulé » dans un cadre et le montant barré ; le rendu en plein soleil reste à voir à l'œil (`PENDING-CHECKS`)*

**Notes** — **La filiation s'affiche ici.** E4-05 a livré sa lecture dans les deux sens (`documentLineage()`, module Ventes) et s'est arrêtée là : l'écran où l'accrocher est ce détail-ci, et le construire là-bas aurait été bâtir en avance. Le détail porte donc le document d'origine et ce qui en est issu, avec un lien vers chacun — et un parent peut avoir **plusieurs** enfants (RÈGLE M3-4).

**La story a été écrite dans une session sans base, et rejouée le 2026-10-20 sur le stack local.** Rien de ce qui suit n'était mesuré au moment de l'écriture ; trois attentes du premier jet se sont révélées fausses, et deux choix ont été corrigés. `docs/SCHEMA.md`, corrigé à la main faute de base, s'est révélé **identique** à la sortie du générateur — le seul écart apparu après coup vient de la correction des montants.

**Les plans, mesurés sur 40 000 documents et 80 000 lignes, quatre commerces, trois passages chacun en session chaude.** Les quatre lectures de la liste passent par un index, aucun parcours séquentiel : la liste par `sale_document_tenant_recent` (Incremental Sort), le numéro entier par `sale_document_number_per_tenant`, les chiffres par `sale_document_tenant_id_idx` (Bitmap), le fragment par l'index du tri.

**Les deux index prévus en secours n'ont pas été posés, parce qu'ils ne servaient à rien.** La crainte écrite était que `sale_line_document` et `sale_document_source`, commençant tous deux par `tenant_id`, ne puissent pas servir sous la policy `OR merx.is_super_admin()` (E0-03) — d'où un index sur la seule colonne de l'égalité, en secours. Mesuré : les lignes sortent par `sale_line_document`, le parent par `sale_document_pkey`, les enfants par `sale_document_source`, tous en Index Scan sur les trois passages. Une colonne non-première **peut** porter la condition d'index ; ce qui bloque sous RLS est le `leakproof` (`like`, `unaccent`, `pg_trgm`), pas la position. Aucun index neuf, aucune seconde fonction `security definer`.

**L'exception § 2.1 se justifie par la liste, et par elle seule — la story en attendait plus.** La lecture directe que PostgREST émet pour la liste (tri sur `issued_at`, `limit 101`) est bien en **Seq Scan** sur les trois passages : `list_sale_documents()` tient. Mais la recherche directe d'un numéro, dont le premier jet affirmait qu'elle parcourait aussi la table, **sert son index** (`sale_document_number_per_tenant`, Index Scan) : `texteq` est leakproof — l'égalité sur une colonne stockée de CLAUDE.md —, donc la policy ne l'empêche pas de servir de condition d'index, et le `OR merx.is_super_admin()` ne reste qu'un filtre sur l'unique ligne touchée. Le test dit désormais l'inverse de ce qu'il disait, et le registre n'a pas eu à changer : sa justification ne nomme que la liste, plus l'auteur et l'appareil que `app_user` et `device` refusent.

**Trois choix du premier jet corrigés.**

- **Les montants sortent en `text`, plus en `numeric`.** PostgREST rend un `numeric` en **nombre JSON**, que le navigateur relit en `double` avant que l'écran ne le remette en chaîne : exact à cette échelle, et c'est pourtant le flottant que la RÈGLE des domaines nommés interdit (SPEC § 4), sans rien qui le garde demain. La preuve était dans le test lui-même, qui attendait `'1250.5'` pour `1250.50` : les centimes étaient déjà perdus de la représentation. Mesuré sur le corps de la réponse HTTP, guillemets compris — une assertion sur `typeof` passerait aussi sur un nombre relu puis reconverti.
- **Le filtre par appareil est rendu à l'employé, avec les seules lettres.** Le premier jet le lui refusait, en comptant sur une recherche par fragment (« -B- ») qu'il n'a aucun moyen d'apprendre. La voie la moins chère n'a demandé **ni paramètre neuf, ni fonction neuve, ni lecture de `device`** : chaque ligne de la liste porte déjà son `device_id` à côté de son `device_prefix`, et la paire suffit à filtrer par le même `p_device_id` que le patron. L'employé voit « B », le patron « B — Tablette 2 ». Les lettres s'accumulent au fil des chargements : filtré sur « B », la page ne porte plus que des « B », et une liste rebâtie à chaque chargement perdrait le moyen d'en sortir.
- **« Annulation… tracée » est mesurée, et non plus déduite d'E4-01.** L'écran n'écrit rien au journal : il émet un seul `PATCH`, et c'est la base qui en tire l'entrée. Le cas rejoue cette requête, forme comprise, et relit l'entrée `document_cancellation` — son action, son entité, son motif et son **auteur**. Ce qu'il ne distingue pas, et ne peut pas : l'auteur du créateur du bon, `cancel_document` n'étant qu'au patron, qui est aussi celui qui a créé le document du montage.

**Sabotages (3 gardes retirés, un par un ; `sale-document-list.test.ts` et `sale-document-api.test.ts` seulement) :** aucun n'est resté vert.

- **garde de capacité retiré** (`if not merx.can('create_sale')`) — **2 tombent**, et ce sont les deux seuls qui atteignent ce garde sans passer par l'autre : `refuse une session sans create_sale, avec sa propre phrase` (SQL) et `refuse un compte sans commerce en 403, avec la phrase du premier garde` (API) ;
- **filtre de commerce retiré** (`d.tenant_id = home_tenant`) — **24 tombent**, dont les six cas d'isolation visés : `à numéro égal, ne rend que celui de son commerce`, `ne rend aucun document du voisin` (sous `owner` et sous `worker`), `rend zéro ligne… pour le détail d'un document du voisin`, `ne rend rien non plus pour l'appareil du voisin`, et le cas du voisin par l'API. Les deux commerces portent `BL-A-26-00042` dans **une seule** transaction et le comptage se fait hors RLS, sans quoi le cas resterait vert quoi qu'il arrive (CLAUDE.md, E2-06) ;
- **index du tri retiré** (`drop index sale_document_tenant_recent`) — **12 tombent à chacun des trois passages du fichier**, dont les deux visés : `porte l'index du tri sur la même expression que la fonction` et `liste les plus récents par l'index du tri, sans parcours séquentiel`. Jugé sur plusieurs exécutions, un plan borderline flottant d'un run à l'autre (CLAUDE.md, E2-04).

**Suite complète, machine libre, base remise à zéro : 77 fichiers, 1 938 tests, tous verts**, 362 s. `typecheck` et `lint` lus sur la sortie des commandes, après la dernière édition.

---

# E5 — Impression

### E5-01 — Bon thermique 80 mm
**Étape 5** · dépend de E4-03

**En tant que** vendeur, **je veux** remettre un papier au client, **afin qu'**il ait sa preuve.

**Critères d'acceptation**
- [ ] Impression ESC/POS sur imprimante **réseau Wi-Fi** — *tenu jusqu'au matériel : le 2026-10-22, l'APK d'essai a imprimé `BL-B-26-00001` depuis un téléphone vers l'imprimante de laboratoire, en traversant le plugin, le socket Android et le Wi-Fi. **Aucune imprimante n'a encore reçu le flux** : `docs/PENDING-CHECKS.md`*
- [x] Adresse configurée dans les paramètres du commerce
- [x] Contient : nom et coordonnées du commerce, numéro du bon, date et heure, client, lignes avec quantité et prix, total — *le client est M4 (étape 6) : le champ existe, vide, et sa ligne ne s'imprime pas*
- [x] Échec d'impression non bloquant : le bon reste enregistré, réimpression possible
- [x] Réimpression depuis le détail du document

**Notes** — `SPEC.md` § 2.7. Bluetooth exclu en V1.

---

**La décision d'architecture a précédé la story, et elle est à SPEC § 2.7.** Une
PWA n'ouvre pas de socket TCP vers le port 9100 : l'application est enveloppée
en **Capacitor** pour Android, et le ticket est **rendu en image** (canvas,
1 bit, `GS v 0`), ce qui règle l'arabe d'E5-02 par construction plutôt que par
un second chemin. Les quatre voies écartées — relais LAN, agent sortant,
ePOS-Print/WebPRNT, WebUSB/BLE — sont dans la SPEC avec leur raison.

**Le plugin est `capacitor-tcp-socket` (7.1.1, MIT, publié le 2026-06-17)**, un
transport nu : connecter, envoyer en base64, fermer. Les plugins « thermal
printer » du marché embarquent l'encodeur, donc la mise en page, donc l'arabe —
qu'aucun ne sait faire. L'ESC/POS, la mise en page et le seuillage restent en
TypeScript, où ils se testent. Repli prévu si le plugin se tient mal : quatre
méthodes à réécrire en Kotlin.

**`printer_width` est un réglage, pas une constante** (migrations
`20261022090000` et `20261022100000`, défaut 576, écran à trois choix). Les
assets étant empaquetés dans l'APK, une constante fausse se corrigerait par un
APK à réinstaller chez chaque commerçant ; un réglage se corrige depuis
l'écran. Le patron n'a rien à régler : un commerce naît à 576.

**Quatre niveaux de test, parce qu'aucun n'a d'imprimante.** (1) l'encodeur
octet par octet — en-tête `GS v 0`, bandes de 200 lignes, aucune commande
coupée entre deux lots ; (2) la mise en page lue comme une **liste de tracés**,
sans canvas : chaque donnée du critère, les colonnes, ce qui disparaît quand une
donnée manque ; (3) **l'imprimante de laboratoire** — un serveur TCP qui reçoit
le ticket et le **redécode** (`loopback.test.ts`), et `npm run printer:fake` qui
en écrit le PNG ; (4) l'APK sur une tablette contre ce même serveur, qui reste à
faire. Le décodeur du niveau 3 est réécrit, jamais repris de l'encodeur : bâti
dessus, il annulerait ses propres erreurs.

**Ce que jsdom ne peut pas atteindre** : le contexte 2D. `canvas.ts` est donc le
seul fichier du module sans test — la liaison des glyphes appartient au moteur
de texte et se juge sur du papier (E5-02).

**Sabotages (3 gardes retirés, un par un) :** aucun n'est resté vert.

- **montant du ticket passé par un flottant** (`Number(x).toFixed(2)` au lieu de
  `moneyText()`) — **5 tombent** dans `ticket.test.ts`, dont celui qui vise la
  règle : `imprime les montants en dirhams groupés, depuis le texte stocké` ;
- **transport rendu au navigateur** (`nativeTransport()` sans le test de
  plateforme) — **2 tombent** : `ne rend aucun transport au navigateur` et
  `n'annonce aucune impression thermique`. Les quatre fichiers d'écran sont
  restés verts, et c'est attendu : ils **remplacent** `thermalPrinting()` pour
  pouvoir montrer le bouton. La RÈGLE de SPEC § 2.7 n'est donc tenue que par ces
  deux cas-là — à ne pas supprimer en croyant les écrans couverts ;
- **transparent non composé sur le papier** (`rasterize()`) — **1 tombe** :
  `traite le transparent comme du papier`. Le cas vaut un rouleau : un canvas
  jamais rempli sortirait entièrement noir.

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
- [x] Génération PDF d'un bon, d'un devis — *les quatre types sortent du même générateur, un `sale_document` étant un `sale_document` (§ 8)*
- [ ] Génération PDF d'un **relevé** — *dépend d'E6-02 : à l'étape 5 il n'existe aucun solde à relever. Voir les notes*
- [x] **Lisible sur un écran de téléphone sans zoomer**
- [x] Partage via l'API native de partage de l'appareil — *mesuré sur doublons ; le sélecteur réel demande un APK (`docs/PENDING-CHECKS.md`)*
- [x] Nom de fichier explicite : `BL-A-26-00042-2026-09-04.pdf` — *critère corrigé, voir les notes*
- [x] Généré localement, sans appel serveur

**Notes** — `SPEC.md` § 2.7 (RÈGLE du PDF présent partout), § 2.6, § 4, § 8 ; `BRAND-UI.md` § 6 et § 7.

**Le PDF est une image, comme le ticket, et pour la même raison.** Dans un PDF,
un texte est une suite de codes de glyphes **déjà choisis** : le format n'a pas
de moteur de mise en forme. Un PDF texte en arabe demanderait de réordonner le
bidi, de choisir les formes contextuelles, d'appliquer la ligature lam-alef,
puis d'incorporer et sous-ensembler la police en CID — c'est-à-dire de
réécrire un moteur de façonnage. Aucune bibliothèque de l'arbre ne le fait
(`pdf-lib` et `jspdf` incorporent des polices, elles ne façonnent pas), et
c'est exactement le piège qu'écarte la RÈGLE de § 2.7. Le navigateur façonne,
le PDF ne transporte que des points : **une seule voie de rendu** pour le
français et pour l'arabe, et E5-02 tenue par construction ici aussi.

**Ni les octets ni la mise en page du ticket, pourtant.** Le ticket seuille en
1 bit pour une tête thermique ; un écran a des gris, et un corps de 24 points
seuillé sort crénelé — la page part donc en **gris 8 bits** (`/DeviceGray`,
`/FlateDecode`). Et 72 mm en une colonne n'est pas 210 mm : `page.ts` est un
second metteur en page, qui partage de l'autre `wrapText()`, le type `Measure`
et le vocabulaire des tracés.

**Aucune dépendance PDF.** Un PDF dont chaque page est une image tient en un
catalogue, un nœud de pages et trois objets par page ; `jspdf` pèserait 150 ko
dans l'APK **sans résoudre** ce qui a décidé de la forme. La seule difficulté
du format est la table `xref` — une liste d'offsets en octets, dont un seul
faux rend le fichier inouvrable sans message ; `pdf.test.ts` la relit et
vérifie que chaque offset tombe sur « N 0 obj ».

**L'échelle se dérive, elle ne s'invente pas.** A4 fait 595 points de large,
un téléphone montre ~390 px de viewport : une page ajustée à la largeur se
voit à 595/390 = 1,53. Pour qu'un corps paraisse au plancher de BRAND-UI § 6
(16 px, « plancher absolu pour toute donnée ») il doit faire 24 points. L'échelle
de BRAND-UI est donc reprise **× 1,5** : 60 / 33 / 27 / 24 / 21 / 20. Deux
conséquences assumées : la page est **paginée** (cinq lignes par page), et il
n'y a **pas de tableau à quatre colonnes** — à 24 points les colonnes de
montants mangent 330 des 547 points utiles, et il resterait quinze caractères
pour un nom de produit. L'A4 lisible au téléphone a le budget de colonnes d'un
ticket, pas celui d'une facture de bureau. `page.test.ts` asserte le plancher
plutôt que de s'en remettre à l'œil.

**La marge est à 24 points (8,5 mm), et c'est la mesure qui l'a décidé.** À 36,
une page ne tenait que **quatre** lignes : un bon de cinq sortait sur deux
pages dont la seconde ne portait que le total, et pesait le double sur une
liaison 3G. Le support premier est un écran ; ce qu'une marge étroite risque
sur une vraie feuille est de rogner le pied de page, jamais une donnée.

**La résolution, mesurée et non estimée.** La taille dépend des **pixels** que
le navigateur dessine — l'anticrénelage est ce que `deflate` comprime — et
jsdom n'a pas de contexte 2D : `npm run pdf:measure` sert donc la page à un
Chrome sans fenêtre par le serveur Vite et lit le résultat par le protocole
DevTools. Même famille que `npm run printer:fake`. Mesuré le 2026-10-23 :

| facteur | une page (5 lignes) | deux pages (10 lignes) | arabe, une page |
|---|---|---|---|
| 1 | 27,6 Ko | 48,7 Ko | 27,1 Ko |
| 1,5 | 47,8 Ko | 83,7 Ko | 44,3 Ko |
| **2** | **70,7 Ko** | **125,0 Ko** | **66,4 Ko** |
| 3 | 118,0 Ko | 207,9 Ko | 110,6 Ko |

**Retenu : 2.** Un téléphone à 390 px de viewport et densité 3 montre ~1 170
points physiques en travers, une tablette d'entrée de gamme 1 200 ; A4 rendu à
2 fait 1 190 points, donc point pour point. À 1,5 l'image est agrandie d'un
tiers et le corps de 24 perd son anticrénelage ; à 3 le fichier double sans
que rien ne se voie. 71 Ko reste loin du plafond de 300 Ko que la story s'est
donné. L'arabe ne coûte rien de plus — les glyphes liés portent moins d'encre
que le français.

**Le nom de fichier : le critère était faux, il a été corrigé.** Il écrivait
`BL-A-0042-2026-09-04.pdf` ; ce numéro n'existe pas. E4-02 a arbitré
`BL-A-26-00042` (RÈGLE M3-2 : code du type, lettre de l'appareil, année sur
deux chiffres, séquence sur cinq), et le critère lui est antérieur. Inventer un
second format de numéro pour un nom de fichier aurait été pire que corriger le
critère. La date est celle d'`issued_at` lue en `Africa/Casablanca`, comme
l'année du numéro, et en ISO parce qu'un dossier de téléchargements trie par
nom.

**Trois voies de partage, et le bouton ne disparaît jamais.** L'enveloppe
Android écrit dans le cache (`@capacitor/filesystem`) et ouvre le sélecteur
natif (`@capacitor/share`) — la WebView n'implémente pas la Web Share API,
d'où le plugin ; un navigateur mobile passe par `navigator.share()` avec
fichier ; partout ailleurs le fichier descend dans les téléchargements.
Contrairement au ticket, rien à charger pour savoir si l'action s'offre : la
RÈGLE de § 2.7 veut le PDF présent partout. Même porte que le ticket pour ce
qui s'exporte — un numéro, et pas annulé : un papier se perd, un fichier se
transmet encore des mois après.

**Le relevé reste décoché, et c'est une forme, pas un oubli.** Un relevé
demande `client` (E6-01) et `client_ledger_entry` (E6-02) : à l'étape 5 il n'y
a aucun solde à relever, et le servir à moitié aurait été construire par
avance. E6-04 dépend déjà d'E5-03 et porte « export PDF lisible sur téléphone »
et « partageable en un geste » : **le relevé s'y sert**, par un
`layoutStatement()` posé à côté de `layoutDocumentPages()`, sur le moteur de
cette story. Même traitement que le critère de retour d'E4-06, renvoyé ici en
E6-02.

**Ce que `canvas.ts` reste** : le seul fichier du module sans test. jsdom n'a ni
contexte 2D ni `ImageData` — vérifié, pas supposé. Ce qui s'y juge se juge sur
un écran, et les PNG d'aperçu de `npm run pdf:measure` sont là pour ça.

**Sabotages (2 gardes retirés, un par un) :** aucun n'est resté vert. Les
détails d'interface — libellés, ordre des colonnes, pagination, nom de
fichier — ont des tests ordinaires et pas de passe de sabotage : ils échouent
visiblement et ne coûtent rien quand ils cassent.

- **montant de la page passé par un flottant** (`Number(x).toFixed(2)` au lieu
  de `moneyText()`, aux cinq endroits) — `page.test.ts`, `sales/pdf.test.ts`,
  `DocumentScreens.test.tsx` : **6 tombent**, toutes dans `page.test.ts`, dont
  celle qui vise la règle : `imprime les montants en dirhams groupés, depuis le
  texte stocké` ;
- **transparent non composé sur le papier** (`grayscale()`) —
  `raster.test.ts`, `pdf.test.ts` : **2 tombent**, `traite le transparent comme
  du papier` et `compose un noir à moitié transparent sur le blanc`. Le cas
  vaut un client : un canvas jamais rempli enverrait une page entièrement
  noire, et bien plus lourde par-dessus.

**Suite complète, 2026-10-23 : 88 fichiers, 2 081 tests, 2 055 verts, 26 rouges,
656 s — et les 26 sont l'environnement, pas la story.** Tous dans
`tenant-creation.test.ts` et `user-management.test.ts`, tous `expected 503 to be
201` : Docker Desktop avait perdu son montage du disque `D:`, ce que les logs du
conteneur disent mot pour mot (`mkdir /run/desktop/mnt/host/d: file exists`,
puis `Error reading config file 'file:///Merx/supabase/functions/create-tenant/deno.json'.:
No such device (os error 19)`). C'est la panne décrite dans CLAUDE.md, diagnostiquée
et non supposée ; aucun de ces 26 ne touche un fichier d'E5-03.

**Docker Desktop redémarré, le conteneur Edge relancé à la main — il ne revient
pas tout seul — et `pg_isready` attendu, les deux fichiers rejoués rendent
`2 fichiers, 46 tests, 0 rouge`, 22,7 s. La suite est donc entièrement verte,
mesurée en deux temps parce que l'environnement a cédé au milieu.**

`typecheck` et `lint` propres,
lus sur la sortie des commandes, après la dernière édition ; les 21 fichiers de
`src/lib/printing` et `src/modules/sales`, 345 tests, verts au même moment.

**Une trouvaille hors périmètre, à ne pas perdre :** Chrome et Node ne sont pas
d'accord sur le fuseau marocain à partir d'octobre 2026. Voir
`docs/PENDING-CHECKS.md` — cela touche `src/lib/dates.ts`, donc tous les
écrans et l'année du numéro de document, pas seulement ce PDF.

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
- [ ] Un retour génère automatiquement le crédit — **le critère d'E4-06 est ici**, et il y est arrivé avec ce que cette story-là a tranché (voir les notes)
- [ ] Solde exact au dirham, vérifié sur un scénario de 50 opérations mêlant ventes, retours et paiements partiels

**Notes** — `SPEC.md` RÈGLES M4-1, M4-2. L'ajout seul est ce qui rendra la synchronisation possible.

**Ce qu'E4-06 laisse ici, et qui n'est pas une intention mais une forme.** Un retour est un `sale_document` de type `return` (SPEC § 8) : le crédit s'accroche donc à la **même table** et à la **même transition** que le débit d'un bon confirmé — `draft → confirmed`, un trigger par type, comme `merx.write_sale_movements()` et `merx.write_return_movements()` le font déjà pour le stock. Trois conséquences à tenir :

- le montant du crédit est le `total` du retour, borné par la RÈGLE M3-9 : un retour ne crédite jamais plus que le bon n'a facturé, et c'est la base qui le tient, pas l'écran ;
- un retour **annulé** demande son écriture **inverse** au grand livre (RÈGLE M4-2), comme son annulation inverse déjà ses mouvements de stock. Un bon qui porte un retour vivant ne s'annule pas (`merx.require_no_active_return()`), donc l'ordre est toujours : retour d'abord, bon ensuite — et le grand livre le suit dans cet ordre ;
- `client_id` arrive en E6-01, avec sa clé composite. Tant qu'il n'existe pas, un retour n'a **aucun** client à créditer : c'est pour cela que le critère d'E4-06 est resté décoché là-bas plutôt que d'y être servi à moitié.

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

**Relevé en E4-04, et à traiter ici : la synchronisation ne doit jamais renvoyer `sale_line.line_total`.** C'est une colonne **engendrée** depuis E4-04 (RÈGLE M3-7), et Postgres refuse toute valeur fournie pour une telle colonne — `428C9`, « cannot insert a non-DEFAULT value into column ». Un refus que rien ne rattrape : ce n'est pas un garde, c'est la colonne qui n'accepte pas d'être écrite, et la file de l'appareil resterait bloquée dessus pour toujours (§ 4, RÈGLE des refus en 4xx). Les règles de synchronisation doivent donc **exclure la colonne en écriture** et la recevoir en lecture seule, comme `product.code_key` et les colonnes `search_*` d'E2-04, qui sont dans le même cas. À vérifier au moment où les règles s'écrivent, et pas après : le symptôme serait une file muette.

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

**Relevé en E4-02, et à traiter ici : un stockage local vidé avec des confirmations non synchronisées perd des documents, et réimprime leurs numéros.** La numérotation locale tient parce que l'appareil repart au-dessus de la borne connue du serveur (`document_sequence`, constatée). Mais un bon confirmé hors ligne vit d'abord dans la file d'envoi : si le stockage est vidé avant la remontée, ce bon n'arrive jamais, et le serveur ne saura jamais que son numéro a été imprimé. L'appareil réattribue alors `BL-A-26-00051` à une autre vente, et deux papiers portent le même numéro — dont un sans ligne en base. **Aucune collision n'est observable côté serveur**, et aucun garde d'E4-02 ne peut le voir : ce n'est pas un trou dans la séquence, c'est une perte de documents, et c'est strictement plus grave. La propriété à tenir est la **durabilité de la file d'envoi** : le critère « aucune perte, aucun doublon » ci-dessus se mesure donc aussi sur ce scénario — 200 documents créés hors ligne, l'application fermée brutalement, puis reconnexion, et rien de perdu.

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

**Le harnais doit apprendre à entrelacer deux connexions, et c'est ici que ça se paie.** Le critère « deux appareils hors ligne vendant le même stock » ne se mesure pas sur une connexion unique : il faut deux sessions ouvertes en même temps, dont on ordonne les pas — A lit, B écrit, A écrit — pour que les deux écritures se rencontrent *avant* le commit de l'une d'elles. Tout le reste de la suite tient dans **une** transaction annulée à la fin, ce qui est précisément ce qui l'empêche : deux écritures posées dans deux transactions annulées séparément ne se croisent jamais (la leçon d'E2-06, et la raison pour laquelle le cas inter-commerces d'E4-02 écrit ses deux lignes dans une seule transaction).

**Les deux lignes ouvertes de `docs/PENDING-CHECKS.md` se ferment avec ce harnais**, et avec rien d'autre :

- la concurrence du garde des lignes (`for share` dans `merx.reject_frozen_child_write()`, E4-01) — une confirmation qui croise l'écriture d'une ligne ;
- une collision réelle entre deux confirmations simultanées du même appareil (E4-02) — le seul chemin par lequel l'enjambement se déclenche en fonctionnement normal.

Les deux sont aujourd'hui éprouvées par morceaux, chacune de son côté de la frontière. Quand cette story se construira, les reprendre d'un bloc — c'est l'outil qui manque, pas la règle.

**Et une décision à prendre ici, relevée en E4-04 : le plancher d'une vente faite hors ligne.** `merx.require_floor_price()` compare `unit_price` au `floor_price` **en vigueur à l'arrivée de la ligne** (SPEC § 8, RÈGLE M3-8). Un employé vend à 10 DH hors ligne, le patron monte le plancher à 12 entre-temps, et à la reconnexion la ligne est refusée — en `42501`, donc en 4xx, donc **définitivement** : selon ce que la file fait d'un refus final, la vente est bloquée ou perdue. C'est exactement le défaut pour lequel `overridden_price` n'est *pas* recalculée à l'arrivée (§ 8) ; le plancher, lui, ne pouvait pas s'en passer, parce que c'est le garde qui tient l'argent et qu'il ne peut pas dépendre d'une déclaration de l'appareil.

Deux pistes, et ce n'est pas tranché :

- **comparer au plancher en vigueur à `issued_at`**, ce qui demande d'historiser `variant.floor_price` — une table de plus, et une question de cohérence temporelle qui ne se limiterait pas au plancher ;
- **accepter la ligne et la journaliser** : le refus devient une alerte au patron plutôt qu'un rejet. Un bon déjà remis au client n'est de toute façon pas annulable par un refus de synchronisation — le papier existe.

La seconde est probablement la bonne, et c'est précisément pourquoi elle se décide ici, avec le reste de la réconciliation, et non en E4-04 où tout est en ligne.

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
- [x] Onglets livrés : Accueil et Produits ; Vente s'y est ajoutée en E4-03, en position 2. Clients et Rapports arrivent avec E6-01 et E10-01 — pas avant
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