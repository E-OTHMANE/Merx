# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E4-07

**Tout E4-07 est écrit et rien n'a tourné.** La session était dans le cloud, sans
Docker ni Supabase, et `npm ci` y échoue (`403 Forbidden` sur
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, la dépendance `xlsx`) :
ni `typecheck`, ni `lint`, ni les tests du front n'ont pu être lancés non plus.
Aucune assertion des fichiers ci-dessous n'a été vue verte ni rouge. Aucun
critère d'E4-07 n'est coché dans le BACKLOG.

- [ ] **Rejouer, dans cet ordre, sur le stack local, machine libre** :
      1. `until docker exec supabase_db_Merx pg_isready -U postgres; do sleep 2; done`,
         puis `npx supabase db reset` — jugé sur sa ligne `Finished supabase db reset`,
         pas sur le code de sortie. C'est la première fois que
         `20261021090000_sale_document_list.sql` s'applique ;
      2. `npm run schema:doc`, puis **lire le diff de `docs/SCHEMA.md`**. Le fichier
         a été **corrigé à la main** à partir de la migration (une fonction, un
         index, une exception, « 19 entrées »), ce que la règle du projet interdit
         et que seule l'absence de base excuse. Le moindre écart avec la sortie
         engendrée est une erreur de cette édition, pas du générateur ;
      3. `npm run typecheck` et `npm run lint` — lus sur la sortie, après la
         dernière édition (CLAUDE.md). Points à surveiller : `exactOptionalPropertyTypes`
         sur `DocumentFilter`, l'union de promesses de `DocumentDetailScreen`, et
         les règles `react-hooks` sur les deux écrans ;
      4. les fichiers touchés, un par un : `src/modules/sales/documents.test.ts`,
         `DocumentScreens.test.tsx`, `src/lib/day.test.ts`, `src/app/navigation.test.tsx`,
         `src/modules/admin/audit.test.tsx` (le déplacement de `startOfDay` /
         `endOfDay`), puis `supabase/tests/sale-document-list.test.ts`,
         `sale-document-api.test.ts`, `conventions.test.ts` (dix-neuf entrées),
         `schema-doc.test.ts`, `refusal-status.test.ts` ;
      5. la suite complète, une fois, sur une machine qui a la main — on lit le
         nombre de tests sur la ligne `Tests  N passed`, jamais le code de sortie.
- [ ] **Les plans.** `sale-document-list.test.ts`, dernier `describe`, sème
      40 000 documents et 80 000 lignes et lit quatre plans à trois passages. Ses
      seuils sont des **attentes** écrites sans mesure : un Seq Scan inattendu sur
      la liste, la recherche par chiffres ou par fragment est à lire dans le plan
      avant de toucher quoi que ce soit.
- [ ] **Décision en attente — lignes et filiation.** Si `sale_line` (lecture par
      `sale_document_id`) ou `sale_document` (lecture des enfants par
      `source_document_id`) ressortent en **Seq Scan** sous le jeton d'un employé,
      le correctif prévu est **un index sur la colonne de l'égalité**
      (`sale_line (sale_document_id)`, `sale_document (source_document_id)`), pas
      une seconde fonction `security definer`. **Il n'est pas posé.** Raison
      probable, à vérifier au plan : `sale_line_document` et `sale_document_source`
      commencent par `tenant_id`, et la policy `tenant_id = … OR merx.is_super_admin()`
      ne laisse pas servir cette colonne de condition d'index (BACKLOG E0-03, ouverte).
      Les messages d'échec des trois tests concernés renvoient ici.
- [ ] **Preuve que l'exception se justifie.** Les deux derniers tests de plan
      exigent que la lecture **directe** (tri par `issued_at`, égalité sur
      `doc_number`) soit en Seq Scan. S'ils ne le sont pas, `list_sale_documents()`
      ne se justifie plus par le plan : elle reste nécessaire pour l'auteur et
      l'appareil, mais sa justification (`merx.rls_exception_registry`, SPEC § 2.1)
      est à réécrire.
- [ ] **Sabotages prévus, non lancés** (fichiers : `sale-document-list.test.ts`
      et `sale-document-api.test.ts` seulement ; une ligne par cas au rapport) :
      1. *garde de capacité retiré* (`if not merx.can('create_sale')` supprimé) —
         attendu rouge : `refuse une session sans create_sale…` (SQL) et
         `refuse un compte sans commerce en 403…` (API). Les deux seuls tests qui
         atteignent ce garde sans passer par l'autre ;
      2. *filtre de commerce retiré* (`d.tenant_id = home_tenant` supprimé de la
         clause `where`) — attendu rouge : `à numéro égal, ne rend que celui de son
         commerce`, `ne rend aucun document du voisin` (×2), `rend zéro ligne… le
         détail`, `ne rend rien non plus pour l'appareil du voisin`, et le cas du
         voisin de l'API. **Condition de validité** : les deux commerces portent
         `BL-A-26-00042` dans **une seule** transaction (`beforeAll`), et le
         comptage se fait hors RLS (`le voisin a bien ses documents…`) ; sans cela
         le cas resterait vert quoi qu'il arrive (CLAUDE.md, E2-06) ;
      3. *index de la liste retiré* (`drop index sale_document_tenant_recent`) —
         attendu rouge : `liste les plus récents par l'index du tri…` et `porte
         l'index du tri…`. **Jugé sur plusieurs runs**, pas sur un : un plan
         borderline flotte (CLAUDE.md, E2-04) ; le fichier lit déjà trois passages
         par plan, il en faut aussi plusieurs exécutions du fichier.
- [ ] **Deux assertions qui dépendent de la machine.** `src/lib/day.test.ts` attend
      `+00:00` le 1er mars 2026 (Ramadan, UTC+0 au Maroc) : ça dépend des données
      de fuseau d'ICU. Et les tests d'écran attendent `06/10/2026 09:00` pour
      08:00 UTC, comme `stock.test.tsx` — même formateur, mêmes réserves.
- [ ] **« Annulation… tracée »** (critère 4) repose sur E4-01 : l'entrée
      `document_cancellation` est écrite par la base et mesurée dans
      `sale-document.test.ts`. E4-07 ne l'a pas re-mesurée — l'écran appelle
      `UPDATE`, il n'écrit rien au journal. À confirmer en lisant le journal après
      une annulation faite depuis l'écran, sur un vrai navigateur.
- [ ] **À regarder à l'œil** : les deux écrans sur une tablette réelle, en arabe
      (RTL — le chevron de la ligne de liste n'existe pas, l'écran n'en a pas
      besoin), le marquage d'un document annulé (le mot, le cadre, le montant
      barré) en plein soleil, et la cible de « Documents » sur l'Accueil.

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
