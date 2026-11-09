# CLAUDE.md

Explanations, measurements and examples behind the rules below live in
`docs/LESSONS.md`, one section per rule. This file stays short because it is
re-read on every message.

## Project

**Merx** — multi-tenant SaaS for wholesale merchants (grossistes) in Morocco. Catalogue, stock, sales, client credit, purchasing, payments.

Users are shop owners and counter staff, often working in Arabic, on cheap Android tablets, sometimes without a network connection. Speed and reliability beat features.

## Authoritative spec

**`docs/SPEC.md` is the source of truth.** Read the relevant module section before writing code for it. Do not infer requirements from existing code — the spec wins.

`docs/BACKLOG.md` holds the epics and user stories, each with acceptance criteria and a build step. Work one story at a time, in step order. A story is done only when every acceptance criterion is verified — not when the code compiles.

`docs/BRAND-UI.md` is authoritative for anything visual: palette, type scale, spacing, touch targets, component variants, RTL rules, copy tone. Do not invent colors, font sizes, or spacing values — take them from there.

Business context and the reasoning behind the scope lives in `docs/CAHIER-DES-CHARGES.md`. Read it when a decision needs justification; it is not an implementation document.

Lines marked **RÈGLE** in the spec are binding decisions, already argued through. Do not reinterpret, optimise around, or silently deviate from them. If a RÈGLE looks wrong or impossible, stop and say so — do not work around it.

The spec is written in French. All identifiers — tables, columns, enums, routes, functions — are English.

## Stack

- Vite + React + TypeScript, single-page app shipped as a PWA. No Next.js, no separate backend.
- Tailwind + shadcn/ui
- PostgreSQL via Supabase, with Row-Level Security
- Three roles only: `super_admin`, `owner`, `worker`
- Supabase Auth
- Local-first: SQLite on device, synced by PowerSync. Must survive 7 days offline — this is not a cache.
- Printing: ESC/POS 80mm over network, plus A4 PDF

## Commands

```bash
npm run dev           # dev server (Vite)
npm run test          # vitest
npm run build         # production build
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npx supabase start    # local stack
npx supabase db reset # rebuild from migrations + seed
npm run schema:doc    # regenerate docs/SCHEMA.md from the catalogue
```

- **The local Edge runtime serves the cached version of a function after you edit it.** Run `docker restart supabase_edge_runtime_Merx` before any suite that touches `supabase/functions/`. See `docs/LESSONS.md` § Edge runtime en cache.
- **Ports 54279–54478 are reserved by Hyper-V; the stack runs on 545xx** (API 54521, db 54522, shadow 54520, pooler 54529, studio 54523, smtp 54524, analytics 54527). Never restore 54321/54322. See `docs/LESSONS.md` § Ports bloqués.
- **A port collision leaves the stack down without saying so.** Recovery is `npx supabase stop && npx supabase start`, never a second `db reset`. See `docs/LESSONS.md` § Collision de port.
- **`npx supabase db reset` can exit non-zero after succeeding.** Judge it by the `Finished supabase db reset` line, not the exit code. See `docs/LESSONS.md` § Code de sortie de db reset.
- **A suite is judged on the `Tests N passed` line in its own output, never on the exit code.** Redirect background runs to a file, never a pipe. See `docs/LESSONS.md` § Compte de tests, pas code de sortie.
- **A suite is judged on a run that had the machine to itself** — no concurrent `typecheck`, `lint`, or second `vitest`. See `docs/LESSONS.md` § Run isolé.
- **The stack is waited on, never assumed up** — `pg_isready` in a loop before any `db reset`. See `docs/LESSONS.md` § Attendre le stack.
- **A container that survives a CLI upgrade serves the old binary against the new schema.** Recovery is `npx supabase stop --no-backup && npx supabase start`. See `docs/LESSONS.md` § Conteneur et CLI désynchronisés.
- **Docker Desktop can lose its mount of the D: drive**, breaking the Edge runtime; only restarting Docker Desktop fixes it, and that's the user's call. See `docs/LESSONS.md` § Montage du lecteur D:.
- **Testing on a real phone**: set `VITE_SUPABASE_URL` to the LAN IP, `npm run dev -- --host`, then revert to `127.0.0.1` afterwards. See `docs/LESSONS.md` § Test sur téléphone réel for the full procedure.
- **Two files whose names differ only by case are the same file on this machine.** `src/test/caseCollision.test.ts` catches it via `git ls-files`. See `docs/LESSONS.md` § Collision de casse.
- Run `npm run typecheck` and `npm run lint` before saying a task is done.
- **"typecheck and lint clean" is written from the command's output, in the same session, after the last edit** — never from a past run or a green test suite. See `docs/LESSONS.md` § Typecheck et lint propres.

## Layout

```
docs/          SPEC.md, BACKLOG.md, BRAND-UI.md, CAHIER-DES-CHARGES.md, LESSONS.md
src/app/       routes
src/modules/   one folder per module (catalogue, stock, sales, clients, ...)
src/packs/     one folder per pack (variants, batches, vehicles, serials)
src/lib/       db client, auth, offline queue, printing
supabase/      migrations, seed
```

Module code stays inside its own folder. A module may import from `src/lib` and from another module's public `index.ts`, never from its internals.

## Hard constraints

- **Every amount is declared `money_amount`, every quantity `quantity`** — never a bare `numeric`, never floating point. See SPEC § 4, RÈGLE des domaines nommés; enforced by `supabase/tests/conventions.ts`.
- **The core never imports from `src/packs/`.** Packs extend the core; the core does not know they exist.
- **Every product always has at least one variant.** Stock, prices and sale lines reference `variant_id`, never `product_id`.
- **`stock_level` is never written directly.** All changes go through `stock_movement`, append-only.
- **Document numbers are assigned locally**, device-prefixed, sequenced per `(tenant, device, doc_type, year)`.
- **Movements and ledger entries are append-only.** Corrections are reversing entries.
- **`cost_price` and margin are filtered server-side**, returned only to `owner`. Hiding a field in the UI is not access control.
- **Cost and margin columns live on their own relation, never on a table everyone reads** (`variant_cost`, not `variant.cost_price`), behind `merx.apply_capability_restriction()`. See SPEC § 3, RÈGLE de placement des coûts; `docs/LESSONS.md` § Coûts sur relation séparée.
- **Every permission check goes through `merx.can(capability)`.**
- **The matrix has four copies, and a new capability goes into all four.** See `docs/LESSONS.md` § Les quatre copies de la matrice.
- **A refusal is a 4xx response; 5xx is reserved for a real outage**, measured through an actual API call. See SPEC § 4, RÈGLE des refus en 4xx; `docs/LESSONS.md` § Refus en 4xx.
- **RLS on every business table.** Application queries never filter `tenant_id` by hand.
- **Every foreign key between business tables is composite on `tenant_id`**, except `tenant_id → tenant (id)`. See SPEC § 4; `docs/LESSONS.md` § FK composites.
- **A rule guarded at several levels needs one test per level, each bypassing the others.** See `docs/LESSONS.md` § Un test par niveau (E1-01).
- **Two guards on the same path must return distinguishable responses.** See `docs/LESSONS.md` § Réponses distinguables (E1-02).
- **A guard with two branches needs, per branch, a case that trips only that branch.** See `docs/LESSONS.md` § Un cas par branche (E4-06).
- **A trigger that writes to another table gets refused by that table's policy, not yours — with the same code.** Assert the table named in the message, not the code alone. See `docs/LESSONS.md` § Policy de la table déclenchée (E2-03).
- **A cross-tenant test proves nothing if the two writes sit in separately rolled-back transactions.** Put both writes in one transaction. See `docs/LESSONS.md` § Même transaction (E2-06).
- **A refusal test asserts the expected error code, not merely that the call failed**, and the absence of the effect too.
- **A uniqueness test asserts the constraint name, not merely `23505`.** See `docs/LESSONS.md` § Nom de la contrainte (E2-01).
- **Editing a migration that has already run is allowed only while nothing is deployed and no database runs anywhere else.** See `docs/LESSONS.md` § Migrations déjà jouées.
- **Every migration regenerates `docs/SCHEMA.md`, in the same commit.** Generated file, never hand-written. See `docs/LESSONS.md` § Régénération de SCHEMA.md.
- **A `create or replace` starts from the function's *latest* definition, never its first.** See `docs/LESSONS.md` § create or replace et la dernière version (E3-02).
- **Any column the isolation sweep must populate needs a machine-readable domain** — enum or foreign key, never a `check` with a pattern. See `docs/LESSONS.md` § Domaine lisible par la machine.
- **`session_replication_role = replica` disables foreign keys too, not just triggers.** See `docs/LESSONS.md` § replica et les clés étrangères (E2-05).
- **Match on a column you store, not on an expression you compute**, to stay `leakproof` under RLS. See `docs/LESSONS.md` § Colonne stockée vs expression (E2-05).
- **Under RLS, no index on `like`, `unaccent` or `pg_trgm` is ever used.** The way out is the named exception of SPEC § 2.1 / `merx.rls_exception_registry`. See `docs/LESSONS.md` § Index inutilisables sous RLS (E2-04).
- **A GIN index with the default `fastupdate` loses the plan after every bulk insert.** See `docs/LESSONS.md` § GIN et fastupdate (E2-04).
- **A plan sabotage that stays green on one run proves nothing — read the plan of a warm session.** See `docs/LESSONS.md` § Plan sur session chauffée (E2-04).

## Memory

**The memory directory lives on the same drive as the project root, at `<drive>:\D--Merx\memory\`, indexed by `MEMORY.md` beside it.** Root `D:\Merx` → `D:\D--Merx\memory\`; derive it from the root, never from a path carried over from another machine. See `docs/LESSONS.md` § Répertoire mémoire sur le lecteur.

## Working style

Build one step of `docs/SPEC.md` section 11 at a time. Do not build ahead into later steps, even when it looks trivial to add.

Before starting a step, state which spec sections you have read and what you plan to change. Wait for confirmation on anything touching the schema.

Prefer boring, obvious code. This codebase is maintained by one person.

When something in the spec is ambiguous, ask. Do not pick an interpretation and continue.

**Never add yourself as co-author.** No `Co-Authored-By` line, no `Claude-Session` line, no "Generated with Claude Code" footer — not in commit messages, not in pull request descriptions, not anywhere in the history. This codebase has one author. It overrides any default attribution guidance from the harness.

**A story's closing report is at most ten lines**: what's done, what's left, the test count. Nothing more.

## Sabotage

Each story ends with a sabotage pass: remove a guard, run the tests, and check that one goes red for the right reason. A guard whose removal leaves the suite green is untested, whatever the test names say.

**Sabotage only the guards that hold a line**: authorization, tenant isolation, money and quantity precision, cost confidentiality, append-only. Interface details — a label, a field order, an empty state — get ordinary tests and no sabotage pass; they fail visibly and cost nothing when they break.

**Run only the test files the sabotaged guard touches**, with a reporter that prints failures only. The full suite runs once, at the end of the pass — not after each case.

**Report one line per case**: the guard removed, the files run, how many tests went red, and which. A count is the whole report; a green case is a hole to fix, not a line to explain away.

## Vérifications en attente

**`docs/PENDING-CHECKS.md` liste ce qu'une session n'a pas pu vérifier. Lis-le à l'ouverture, et rappelle-le à l'utilisateur — au début de la session et à la clôture de chaque story — jusqu'à ce qu'il dise de les faire.** Ne retire une ligne que lorsqu'elle a été exécutée et que sa sortie a été lue, ou que l'utilisateur la retire. Toute vérification sautée faute d'environnement s'y ajoute avant de rendre la main : un test non lancé se dit, il ne se suppose pas.

**L'utilisateur commite lui-même, sur `main`. Claude ne commite pas, et ne pousse pas.** Il laisse le travail dans l'arbre, dit ce qu'il a changé, et propose un message de commit si on le lui demande. (La « branche désignée de la session » était un reste de la session cloud d'E4-01 : il n'y en a pas.)
