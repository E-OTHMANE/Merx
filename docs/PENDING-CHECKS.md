# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E4-01

- [ ] **Les 26 tests rouges de `tenant-creation` et `user-management`**, tous en
      `503`. Rejoués le 2026-10-15 sur le stack local : Docker Desktop a perdu son
      montage du disque `D:`, le conteneur est `Up` mais le runtime lit
      `Error reading config file 'file:///Merx/supabase/functions/create-tenant/deno.json'.: No such device (os error 19)`,
      et `docker exec … ls /Merx/supabase/functions/` répond `No such device`.
      Famille déjà décrite dans `CLAUDE.md` : seul un redémarrage de Docker Desktop
      le répare, et c'est la main de l'utilisateur. Rien dans ces 26 échecs ne
      touche E4-01.
- [ ] **Aucun test PostgREST pour les documents.** `sale-document.test.ts` parle
      SQL, sous `authenticated` et un jeton. Un `PATCH` sur un document confirmé,
      une annulation par l'API, un `POST` direct de `sale_cancellation` : le code
      et le message qui sortent réellement de PostgREST n'ont pas été lus. Même
      forme que `stock-api.test.ts`.
- [ ] **Concurrence du garde des lignes** (`for share` dans
      `merx.reject_frozen_child_write()`) : une confirmation qui croise l'écriture
      d'une ligne. Aucun test ; un appareil par commerce en V1, donc faible risque
      aujourd'hui, mais non éprouvé.

## Faites

### E4-01, vérifié le 2026-10-15 sur le stack local (Postgres 17)

- [x] **`npx supabase db reset`** — les 20 migrations appliquées, dont
      `20261014090000_sale_cancellation_type.sql` et
      `20261014100000_sale_documents.sql`, terminé sur « Finished supabase db reset ».
- [x] **`npm run typecheck`** — propre, `xlsx` installé ; les trois erreurs de la
      session cloud ont disparu.
- [x] **La suite complète** — 1 465 tests, 1 439 verts, 26 rouges, tous dans les
      deux suites Edge ci-dessus. Les 14 fichiers `src/` qui importent `xlsx` et
      les 5 plans de requête de `stock-consultation` passent.
- [x] **`sale-document.test.ts`** — 93 tests verts avec `stock-consultation`,
      sur Postgres 17.
- [x] **Rôle `postgres` non superutilisateur** — confirmé : sur ce stack
      `pg_roles` donne `rolsuper = f`, `rolbypassrls = t`, comme sur Supabase
      hébergé, et les `alter table … disable trigger` de `sale-document` passent :
      être propriétaire suffit.
