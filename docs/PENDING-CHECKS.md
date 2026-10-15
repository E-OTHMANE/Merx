# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E4-01

- [ ] **Concurrence du garde des lignes** (`for share` dans
      `merx.reject_frozen_child_write()`) : une confirmation qui croise l'écriture
      d'une ligne. Aucun test — il faudrait deux connexions qui s'entrelacent, ce
      que le harnais actuel ne sait pas faire. Un appareil par commerce en V1
      (§ 2.5), donc faible risque aujourd'hui, mais non éprouvé.

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
