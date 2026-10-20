# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E4-06

- [ ] **Le registre des exceptions RLS étendu à `merx`, non exécuté sur la
      base.** Le moteur Docker s'est arrêté entre la clôture d'E4-06 et cette
      extension (`failed to connect to the docker API at npipe:…`, le
      2026-10-20), et le redémarrer est la décision de l'utilisateur, pas celle
      de Claude (CLAUDE.md). Tout a été écrit depuis les migrations — qui sont
      ce qu'un `db reset` construit — et depuis un balayage hors base
      reproduisant la règle étendue sur les corps de fonction (dix-huit
      fonctions nommées, douze dans `merx`). **Rien de cela n'a tourné contre
      Postgres.** Restent à exécuter et à lire : `npx supabase db reset` avec
      les deux migrations neuves (`20261020090000_rls_exception_guards.sql`,
      `20261020100000_rls_exception_merx.sql`) ; `conventions.test.ts` en
      entier, dont la liste exacte des dix-huit entrées et les six témoins de
      la règle étendue ; et la **suite complète**, seul endroit où une fonction
      `definer` oubliée se verrait. La partie front est verte sans la base —
      40 fichiers, 728 tests —, `typecheck` et `lint` sont propres, et c'est
      tout ce qui a pu être mesuré.

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
