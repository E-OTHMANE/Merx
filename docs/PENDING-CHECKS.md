# Vérifications en attente

Ce que les sessions précédentes n'ont **pas pu** vérifier. Chaque session le lit à
l'ouverture et le **rappelle à l'utilisateur** — au début, et à chaque clôture de
story — jusqu'à ce qu'il dise de les faire. Une ligne ne se retire que lorsqu'elle
a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire.

## Ouvertes

### Depuis E4-01 (session cloud sans Docker ni Supabase, 2026-10-14)

La story a été vérifiée sur un Postgres 16 nu, avec des stubs `auth` et `storage`
et un faux service d'authentification — pas sur le stack local.

- [ ] **Commit non poussé.** `5a5b633` (E4-01) n'existe que dans le conteneur de
      cette session : GitHub répondait 403 sur `E-OTHMANE/Merx`. À pousser sur
      `claude/dreamy-goodall-akd2jm`, jamais sur `main`.
- [ ] **`npx supabase db reset` sur le vrai stack** (Postgres 17), avec les deux
      migrations `20261014090000_sale_cancellation_type.sql` et
      `20261014100000_sale_documents.sql`. Juger sur « Finished supabase db reset ».
- [ ] **Les 80 tests rouges et les 24 suites qui ne se chargeaient pas**, à rejouer
      sur le vrai stack : PostgREST, Auth et fonctions Edge absents ici
      (`access-token`, `auth`, `device-registration`, `tenant-creation`,
      `user-management`, `barcodes`, `catalogue`, `permissions`, `price-grid`,
      `product-form`, `product-import`, `product-search`, `purchase-price-audit`,
      `settings`, `stock-api`), les 5 de `stock-consultation` (plans de requête,
      sensibles à la version de Postgres), et les 14 fichiers `src/` qui importent
      `xlsx`, bloqué par le proxy. `docker restart supabase_edge_runtime_Merx`
      avant ceux qui touchent `supabase/functions/`.
- [ ] **`npm run typecheck` avec `xlsx` installé.** Ici, trois erreurs, toutes sur
      `xlsx` introuvable ; aucune dans les fichiers d'E4-01. À relire sur la
      sortie de la commande, pas sur cette ligne.
- [ ] **Aucun test PostgREST pour les documents.** `sale-document.test.ts` parle
      SQL, sous `authenticated` et un jeton. Un `PATCH` sur un document confirmé,
      une annulation par l'API, un `POST` direct de `sale_cancellation` : le code
      et le message qui sortent réellement de PostgREST n'ont pas été lus. Même
      forme que `stock-api.test.ts`.
- [ ] **Concurrence du garde des lignes** (`for share` dans
      `merx.reject_frozen_child_write()`) : une confirmation qui croise l'écriture
      d'une ligne. Aucun test ; un appareil par commerce en V1, donc faible risque
      aujourd'hui, mais non éprouvé.
- [ ] **Rôle `postgres` non superutilisateur.** Ici `postgres` est superutilisateur ;
      sur Supabase il porte seulement BYPASSRLS. Les tests de `sale-document` font
      `alter table … disable trigger` (propriétaire suffit) : à confirmer.
