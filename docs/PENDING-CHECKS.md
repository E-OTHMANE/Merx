# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E5-03 — le PDF A4

- [ ] **Le PDF sur un vrai téléphone.** `npm run pdf:measure` écrit des PDF et
      des PNG d'aperçu dans `.pdf-measure/` — c'est ce qu'il faut **ouvrir sur
      un écran de téléphone**, puisque c'est là que le critère « lisible sans
      zoomer » se tranche. La suite tient le plancher de corps (24 points, soit
      16 px une fois la page ajustée à la largeur) ; elle ne tient pas ce que
      l'œil voit à bout de bras, en plein soleil. À juger : le facteur de rendu
      retenu (2, soit 71 Ko pour une page), la lisibilité du total à 60 points,
      et si cinq lignes par page est le bon compromis ou s'il faut rendre de la
      place en descendant le total.
- [ ] **Le sélecteur de partage natif, et WhatsApp au bout.** Deux plugins
      s'ajoutent à l'enveloppe — `@capacitor/share` et `@capacitor/filesystem` —
      donc **un APK à reconstruire**. Rien de ce chemin n'est mesuré autrement
      que sur des doublons : l'écriture dans le cache de l'application,
      l'ouverture du sélecteur, et le fait que WhatsApp accepte le fichier et
      l'envoie sous son nom. À vérifier aussi : qu'une annulation du sélecteur
      dit bien « Share canceled » sur cette version du plugin — c'est la seule
      prise qu'il donne pour distinguer un geste volontaire d'un échec.
- [ ] **Qu'un lecteur de PDF ordinaire ouvre le fichier.** Il est écrit à la
      main, sans bibliothèque ; `pdf.test.ts` relit la table `xref` offset par
      offset, et les fichiers de `.pdf-measure/` ont été produits par le vrai
      chemin — mais **aucun lecteur tiers ne les a ouverts** : il n'y a ni
      poppler ni visionneuse sur cette machine. À ouvrir dans Acrobat, dans
      Chrome, et dans ce que WhatsApp propose sur Android.

### Depuis E5-03, et qui ne lui appartient pas — le fuseau horaire

- [ ] **Chrome et Node ne sont pas d'accord sur `Africa/Casablanca` à partir
      d'octobre 2026, et cela touche tous les écrans.** Mesuré le 2026-10-23,
      même machine, même instant :

      | instant UTC | Node 24 | Chrome (ICU embarquée) |
      |---|---|---|
      | 2024-06-15 12:00 | 13:00 | 13:00 |
      | 2025-10-20 12:00 | 13:00 | 13:00 |
      | 2026-03-01 12:00 | 12:00 | 12:00 |
      | **2026-10-20 12:00** | **13:00** | **12:00** |

      Les deux moteurs s'accordent jusqu'au Ramadan 2026 puis divergent : Chrome
      laisse le Maroc à UTC+0 après cette date, Node le ramène à UTC+1. Le Maroc
      est à UTC+1 en permanence depuis 2018, sauf pendant le Ramadan : **c'est
      Node qui a raison**, et l'ICU de ce Chrome qui est en retard.

      Ce que cela coûte, et pourquoi ce n'est pas une curiosité : `src/lib/dates.ts`
      impose le fuseau à la main (§ 4) précisément pour ne pas dépendre de
      l'horloge de la tablette — mais il dépend encore de **la table des fuseaux
      du moteur**, qui sur un Android bon marché peut être plus vieille encore.
      Trois conséquences possibles : toutes les dates affichées décalées d'une
      heure, la date du nom de fichier du PDF décalée d'un jour à la frontière,
      et surtout **l'année du numéro de document** (RÈGLE M3-2, calculée en
      `Africa/Casablanca` par l'appareil **et** par le garde de la base) : un bon
      émis le 31 décembre à 23 h 30 sur un appareil à UTC+0 porterait une année
      que le serveur refuserait en `22023`.

      **À faire** : mesurer la même table dans la WebView de l'APK (console
      distante), puis décider — vivre avec, ou cesser de dépendre de la table du
      moteur. C'est une décision d'architecture, pas une correction : elle ne se
      prend pas dans une story d'impression. **Rien n'a été changé.**

### Depuis E5-01 — l'enveloppe Capacitor et le ticket

Rien de ce qui suit n'est mesurable par la suite : il y faut une vraie
imprimante, et des décisions. **L'APK, lui, est construit et éprouvé** — voir
« E5-01, le chemin natif » dans « Faites ».

- [ ] **Le ticket sur une vraie imprimante** — le plan du § 8 de
      `docs/research/E5-02-arabe-thermique.md`, à faire en une fois :
      - la **largeur de tête réelle** (576 ou 512 ?), qui décide du réglage
        `printer_width` ;
      - **`GS v 0` accepté**, et sinon `ESC *` / `ESC b` avant de renoncer à
        l'image ;
      - la **netteté** au corps retenu (24 points de corps courant, seuil fixe
        à 160) : c'est le genre de valeur qu'aucun écran ne permet de régler ;
      - le **débit** d'un ticket de 60 lignes sur Wi-Fi, et la troncature
        au-delà ;
      - **au moins deux marques**, dont la moins chère trouvée sur place ;
      - et, pour E5-02 : liaison des lettres arabes, sens, et arabe + chiffres
        latins sur la même ligne.
- [ ] **Deux défauts constatés sur l'APK d'essai le 2026-10-22, à diagnostiquer
      — aucun n'a été corrigé, et aucun n'est diagnostiqué.** Le reste de
      l'application marchait, impression comprise.

      1. **La photo d'un produit ne s'affiche pas.** Ce qui est **établi** en
         regardant le stack, et qui épargnera le faux départ : la photo **a
         bien été envoyée** depuis le téléphone (`product-photo`,
         `<id produit>/<uuid>.jpg`, 45 163 octets, `image/jpeg`, 17:39) ; et la
         piste « URL signée bâtie sur `127.0.0.1` » **ne tient pas pour ce
         chemin** — l'API Storage rend un chemin **relatif**
         (`/object/sign/...`) et `supabase-js` le préfixe par l'URL du client,
         donc par celle gravée au build, l'IP du PC. Le contenu mixte est
         douteux lui aussi : les appels XHR en clair passent (connexion, vente,
         impression), et une image est du contenu mixte *passif*, plus permissif
         encore. Restent à examiner : ce que `signedPhotoUrls()` reçoit
         réellement sur l'appareil — elle avale ses erreurs par construction et
         rend la vignette de remplacement en silence (SPEC § 2.6) —, et le
         `photo_url` de la ligne `product`. **À faire avec la console distante
         branchée sur la WebView**, sans quoi on devine.
      2. **Le bouton de scan disparaît au toucher, sans ouvrir la caméra.** Le
         comportement est cohérent avec le code : le bouton ne s'affiche que si
         `BarcodeDetector` existe, et `getUserMedia` n'est appelé **qu'à
         l'appui** (`src/lib/barcode/`). Donc le détecteur est là et c'est la
         caméra qui est refusée — premier suspect, le manifeste, qui ne déclare
         que `INTERNET` : **aucune permission caméra**. À vérifier aussi : ce
         que la WebView empaquetée fait de `BarcodeDetector`, qui n'est pas
         garanti hors de Chrome.

- [ ] **À regarder à l'œil, au comptoir** : le bouton « Imprimer le ticket »
      sous le pouce en bas du détail, et le temps réellement ajouté à une vente.
      Le ticket part bien tout seul (vérifié le 2026-10-22) ; ce qui reste est
      une appréciation de geste, debout, une main occupée.

Et deux conséquences de la décision du 2026-10-20 (SPEC § 2.7), aucune
mesurable par la suite non plus.

- [ ] **PowerSync dans la WebView de Capacitor — le risque le plus grave de ce
      fichier.** Tout le hors-ligne en dépend (SPEC § 2.5, E9), et rien ne dit
      que le SDK web de PowerSync tient dans une WebView Android : il s'appuie
      sur OPFS et sur `wa-sqlite`, dont la prise en charge dans la WebView
      empaquetée n'est pas la même que dans Chrome. **Essai court, avant
      d'ouvrir E9** : une base locale ouverte, une écriture, une relecture après
      redémarrage de l'application. Si ça ne tient pas, le choix se fait entre
      le SDK React Native de PowerSync et un plugin SQLite natif — c'est-à-dire
      une décision d'architecture, et elle ne se prend pas le jour d'E9.
- [ ] **La distribution et la mise à jour de l'APK, à trancher avant l'arrêt
      terrain — pas à l'étape 10.** Les assets sont empaquetés dans l'APK
      (décidé avec l'enveloppe) : la mise à jour automatique de la PWA ne joue
      plus, et **chaque correctif pendant la visite des trois commerçants est un
      APK à réinstaller à la main**. À décider : installation manuelle (APK
      transmis, « sources inconnues » à autoriser sur chaque tablette) ou Play
      Store (compte éditeur, revue, délai), et si une mise à jour des seuls
      assets web mérite un mécanisme (Capgo et consorts) ou si l'APK suffit.

### Depuis E4-07

Tout le reste a été rejoué le 2026-10-20 sur le stack local : voir « Faites »
plus bas. Ne reste que ce qu'aucune commande ne mesure.

- [ ] **À regarder à l'œil** : les deux écrans sur une tablette réelle, en arabe
      (RTL — le chevron de la ligne de liste n'existe pas, l'écran n'en a pas
      besoin), le marquage d'un document annulé (le mot, le cadre, le montant
      barré) en plein soleil, la cible de « Documents » sur l'Accueil, et la main
      sur le bouton d'annulation — ce que jsdom ne peut pas atteindre, l'entrée
      du journal étant désormais mesurée sur la requête que l'écran émet.

### Depuis E4-06

- [ ] **Deux retours du même bon qui se croisent, et un retour qui croise
      l'annulation de son bon.** `merx.require_returnable_quantity()` prend un
      verrou `for update` sur le **bon d'origine** avant de compter : c'est la
      seule ligne que les deux chemins traversent, l'annulation du bon étant
      elle-même un UPDATE sur cette ligne. En READ COMMITTED la seconde
      transaction attend le commit de la première, puis voit son retour et
      refuse l'excès. **Rien ne le mesure** : il faudrait deux connexions
      entrelacées, ce que le harnais ne sait pas faire — même limite que les
      deux lignes d'E4-01 et d'E4-02 ci-dessous, et **se ferme avec le même
      harnais, noté en E9-03**. Ce qui est mesuré, et qui est la propriété de
      tous les jours : deux retours **successifs** dont le second dépasse, le
      retour annulé qui libère son registre, le brouillon qui ne le consomme
      pas (`supabase/tests/returns.test.ts`).

### Depuis E4-04

- [ ] **Le plancher d'une vente faite hors ligne.** `merx.require_floor_price()`
      compare au `floor_price` **en vigueur à l'arrivée de la ligne**. Un employé
      vend à 10 DH hors ligne, le patron monte le plancher à 12 entre-temps, et
      à la reconnexion la ligne est refusée en `42501` — donc en 4xx, donc
      définitivement : selon ce que la file fait d'un refus final, la vente est
      bloquée ou perdue. Rien ne le montre aujourd'hui, où tout est en ligne, et
      aucun test ne peut le montrer avant la file d'envoi d'E9. **La décision est
      notée en BACKLOG E9-03** avec ses deux pistes — comparer au plancher en
      vigueur à `issued_at`, ou accepter la ligne et la journaliser. À rappeler
      le jour où E9 s'ouvre : c'est la seule ligne de ce fichier qui est une
      décision en attente, et non une mesure en attente.

### Depuis E4-03

- [ ] **Le chronomètre de l'écran de vente** : un bon de 10 lignes en moins de
      90 secondes, **debout, au comptoir, d'une seule main**, sur un vrai
      Android d'entrée de gamme. C'est le critère du point de rupture n° 2
      (SPEC § 10), et il ne se mesure pas en jsdom : ce que la suite tient est
      le **budget de gestes** — 31 taps pour dix lignes à quantités réelles
      (24, 48, 120…), asserté dans `src/modules/sales/SaleScreen.test.tsx`, et
      qui échoue si un geste s'ajoute. Le temps réel dépend du clavier, du
      réseau et de la main : il se chronomètre. L'utilisateur le fera lui-même.

### Depuis E4-02

- [ ] **Une collision réelle entre deux confirmations simultanées** du même
      appareil (deux onglets, un double appui). C'est le seul chemin par lequel
      l'enjambement se déclenche en fonctionnement normal (BACKLOG E4-02), et il
      n'est éprouvé que par morceaux : la retente est mesurée côté appareil sur
      un refus simulé (`src/modules/sales/numbering.test.ts`), l'unicité est
      mesurée côté base (`document-numbering.test.ts`), mais jamais les deux
      ensemble — il faudrait deux connexions entrelacées, ce que le harnais ne
      sait pas faire. Même limite que la ligne d'E4-01 ci-dessous, et même
      atténuation : un appareil par commerce en V1 (§ 2.5). **Se ferme avec le
      harnais à deux connexions entrelacées, noté en E9-03.**

### Depuis E4-01

- [ ] **Concurrence du garde des lignes** (`for share` dans
      `merx.reject_frozen_child_write()`) : une confirmation qui croise l'écriture
      d'une ligne. Aucun test — il faudrait deux connexions qui s'entrelacent, ce
      que le harnais actuel ne sait pas faire. Un appareil par commerce en V1
      (§ 2.5), donc faible risque aujourd'hui, mais non éprouvé. **Se ferme avec
      le même harnais, noté en E9-03.**

## Faites

### Le montage du disque `D:` perdu par Docker, réparé le 2026-10-23

- [x] **26 rouges d'environnement, puis 46 verts.** Le disque externe débranché
      puis rebranché en cours de session a fait perdre à Docker Desktop son
      montage de `D:` ; le conteneur Edge ne pouvait plus lire ses fonctions,
      et `tenant-creation.test.ts` et `user-management.test.ts` rendaient
      `expected 503 to be 201` — 26 cas, sur la suite complète du jour
      (88 fichiers, 2 081 tests, 2 055 verts, 656 s). Signature lue dans les
      logs, non supposée : `mkdir /run/desktop/mnt/host/d: file exists`, puis
      `No such device (os error 19)`.

      Ni `docker restart` ni `npx supabase stop && start` ne réparent : seul un
      redémarrage de Docker Desktop le fait, et il faut ensuite **relancer
      `supabase_edge_runtime_Merx` à la main** — il ne revient pas tout seul,
      exactement comme CLAUDE.md le décrit. Fait, puis `pg_isready` attendu,
      puis les deux fichiers rejoués : **46 verts, 0 rouge**, 22,7 s.

      La suite d'E5-03 est donc entièrement verte, mesurée en deux temps parce
      que l'environnement a cédé au milieu : 2 055 verts sur la passe complète,
      et les 26 restants verts après réparation.

### E5-01, le chemin natif, vérifié le 2026-10-22 sur un téléphone

L'APK d'essai, construit par GitHub Actions et dirigé sur le stack local du PC,
a imprimé un bon vers l'imprimante de laboratoire. C'est le niveau 4 du plan de
test d'E5-01 : le seul qui traverse le plugin, le socket Android et le Wi-Fi.

- [x] **L'APK se construit et se lance.** Donc `capacitor-tcp-socket@7.1.1`,
      dont le pair est `@capacitor/core >= 7`, **tient sur Capacitor 8.5.3** :
      le repli prévu — quatre méthodes à réécrire en Kotlin — ne sert pas.
- [x] **L'APK contre l'imprimante de laboratoire** (`npm run printer:fake` sur
      le PC, `printer_address` = `<IP du PC>:9100` sur le téléphone) :
      **BL-B-26-00001**, ticket correct, montants justes. Le préfixe `B` est le
      sien : le téléphone s'est enregistré comme second appareil du commerce,
      et sa séquence est repartie de 1 — RÈGLE de numérotation locale, § 2.5.
- [x] Et, par la même occasion : le contenu mixte et le trafic en clair
      autorisés par la variante debug suffisent à joindre Supabase sur l'IP du
      PC depuis `https://localhost`.

Ce que ce passage **ne dit pas** : qu'une imprimante accepte le flux. Aucune
imprimante ne l'a reçu — la ligne reste ouverte plus haut.

### E4-07, vérifiée le 2026-10-20 sur le stack local

La story avait été écrite dans une session cloud, sans Docker ni Supabase, et
`npm ci` y échouait : aucune de ses assertions n'avait été vue verte ni rouge.
Tout a été rejoué ici, dans l'ordre que cette section prescrivait.

- [x] **`npx supabase db reset`** — les 21 migrations appliquées, dont
      `20261021090000_sale_document_list.sql` pour la première fois, terminé sur
      « Finished supabase db reset ».
- [x] **`npm run schema:doc`** — **diff vide**. Le fichier corrigé à la main
      depuis la migration était identique à la sortie du générateur, « 19
      entrées » comprise. Le seul écart apparu ensuite vient de la correction des
      montants (`money_amount` → `text` sur les trois colonnes rendues), et il est
      engendré.
- [x] **`npm run typecheck` et `npm run lint`** — propres, lus sur la sortie des
      commandes, après la dernière édition. `exactOptionalPropertyTypes` sur
      `DocumentFilter`, l'union de promesses de `DocumentDetailScreen` et les
      règles `react-hooks` des deux écrans : rien à corriger. Un seul rouge, sur
      une édition de cette session (`no-useless-escape`), corrigé.
- [x] **Les fichiers de la story, un par un** — 110 verts côté front
      (`documents.test.ts`, `DocumentScreens.test.tsx`, `day.test.ts`,
      `navigation.test.tsx`, `audit.test.tsx`), puis 177 côté base
      (`sale-document-list.test.ts`, `sale-document-api.test.ts`,
      `conventions.test.ts` — dix-neuf entrées —, `schema-doc.test.ts`,
      `refusal-status.test.ts`), dont **4 rouges au premier passage**, tous dans
      le dernier `describe` : deux attentes de plan fausses et deux délais de
      5 s dépassés par 27 exécutions d'un Seq Scan de 40 000 lignes. Corrigés sur
      la mesure, pas sur l'attente ; 179 verts ensuite, les deux cas neufs
      compris.
- [x] **Les quatre plans, et les cinq autres du même `describe`** — lus trois
      fois chacun en session chaude, sur 40 000 documents et 80 000 lignes.
      Stables aux trois passages. Détail et conclusions en BACKLOG E4-07 :
      aucun index neuf à poser, la liste directe bien en Seq Scan, et la
      recherche directe d'un numéro qui **sert** son index — contre ce
      qu'attendait la story.
- [x] **La décision en attente sur les lignes et la filiation** — tranchée par la
      mesure : `sale_line_document`, `sale_document_pkey` et
      `sale_document_source` servent tous les trois en Index Scan sous le jeton
      d'un employé. Les deux index de secours ne sont pas posés, et il n'y a plus
      de raison de les poser.
- [x] **La justification de l'exception § 2.1** — tenue pour la liste, retirée
      pour la recherche par numéro. Le registre n'a pas eu à changer : il ne
      nommait que la liste.
- [x] **Les trois sabotages** — aucun resté vert : 2 rouges pour le garde de
      capacité, 24 pour le filtre de commerce, 12 à chacun des trois passages
      pour l'index du tri. Une ligne par cas en BACKLOG E4-07.
- [x] **Les deux assertions qui dépendent de la machine** — vertes ici :
      `src/lib/day.test.ts` rend bien `+00:00` au 1er mars 2026, et les écrans
      affichent `06/10/2026 09:00` pour 08:00 UTC.
- [x] **« Annulation… tracée »** — mesurée, et non plus déduite d'E4-01 : la
      requête que `cancelDocument()` émet est rejouée par l'API, puis l'entrée
      `document_cancellation` relue — action, entité, motif et auteur. Reste la
      main sur le bouton, dans la ligne d'œil ci-dessus.
- [x] **La suite complète**, machine libre, base remise à zéro — **77 fichiers,
      1 938 tests, tous verts**, 362 s.

### E4-01, vérifiée le 2026-10-15 sur le stack local (Postgres 17)

La story avait été écrite sur un Postgres 16 nu, avec des stubs `auth` et
`storage` — ni PostgREST, ni fonctions Edge, ni `xlsx`. Tout a été rejoué ici.

- [x] **`npx supabase db reset`** — les 20 migrations appliquées, dont
      `20261014090000_sale_cancellation_type.sql` et
      `20261014100000_sale_documents.sql`, terminé sur « Finished supabase db reset ».
- [x] **La suite complète** — **55 fichiers, 1 475 tests, tous verts**, 489 s,
      base remise à zéro après la passe de sabotage. Les 26 rouges de
      `tenant-creation` et `user-management` étaient le montage du disque `D:`
      perdu par Docker Desktop (`No such device`) : **46 verts** après son
      redémarrage. Les 14 fichiers `src/` qui importent `xlsx` et les 5 plans de
      requête de `stock-consultation` passent.
- [x] **`npm run typecheck` et `npm run lint`** — propres, lus sur la sortie des
      commandes, après la dernière édition.
- [x] **Les tests PostgREST des documents** — `sale-document-api.test.ts`, 8
      tests : `PATCH` sur un document confirmé, annulation par l'API (patron,
      employé, voisin), `POST` direct d'un `sale_cancellation` (patron, employé).
      Statuts réellement rendus, mesurés : `42501 → 403` et, après la
      correction du 2026-10-15, `PT409 → 409` pour les gardes des tables
      figées (voir SPEC § 4, RÈGLE des refus en 4xx).
- [x] **Les 25 sabotages** rejoués un par un, fichiers concernés seulement :
      aucun n'est resté vert.
- [x] **Rôle `postgres` non superutilisateur** — confirmé : sur ce stack
      `pg_roles` donne `rolsuper = f`, `rolbypassrls = t`, comme sur Supabase
      hébergé, et les `alter table … disable trigger` de `sale-document` passent :
      être propriétaire suffit.
