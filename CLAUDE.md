# CLAUDE.md

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
```

**The local Edge runtime serves the cached version of a function after you edit it.** Run `docker restart supabase_edge_runtime_Merx` before any suite that touches `supabase/functions/`, otherwise a test passes or fails on code that is no longer yours — and it does so silently, which is the worst way to be wrong. Same family of trap as `npx supabase db reset`, which replays the migrations but does not reload `config.toml`: a changed port or a changed auth hook needs `npx supabase stop && npx supabase start`. In both cases the process you are questioning is not the one you just edited.

**Ports 54279–54478 are reserved by Hyper-V on this machine, and `config.toml` has been moved out of that range** — API 54521, db 54522, shadow 54520, pooler 54529, studio 54523, smtp 54524, analytics 54527. Do not "restore" the usual Supabase defaults: 54321/54322 fall inside the reserved range and cannot bind. The test files, `.env.local`, `.env.example` and the `test.env` block of `vite.config.ts` carry the same numbers; move one and move them all, or the suite dials a dead port and reports the database as unreachable, which reads like a broken migration.

**A port collision leaves the stack down, and the message does not say so.** `npx supabase db reset` stops the database container before recreating it; when the port cannot bind it fails with `LegacyContainerStartError ... bind: An attempt was made to access a socket in a way forbidden by its access permissions` and leaves the container stopped. Every command after that fails for a different-looking reason, and none of them mentions the port. The recovery is `npx supabase stop && npx supabase start`, never a second `db reset`. This has cost time twice.

**`npx supabase db reset` can exit non-zero after succeeding.** The output ends with `Finished supabase db reset` and the database is fine, but the exit code says failure. Judge a reset by that line, not by the exit code. Seen in E2-03 while `supabase_vector_Merx` was restart-looping: a script that trusted the exit code skipped every run after the second.

**Docker Desktop can lose its mount of the D: drive.** The Edge runtime then cannot start — `mkdir /run/desktop/mnt/host/d: file exists` on `docker restart`, `failed to copy edge runtime main service into container` on `npx supabase start` — and every test that calls an Edge Function gets `503`, which reads like a broken function. `npx supabase stop && npx supabase start` does not fix it; only restarting Docker Desktop does, and that is the user's call, not Claude's. Seen in E2-03: 26 tests in `tenant-creation` and `user-management` failed on every run, the control run included.

**Testing on a real phone, same Wi-Fi.** On the phone, `localhost` is the phone, so the app cannot reach an API at `127.0.0.1`. Steps:

1. Find the machine's LAN IPv4 — the Wi-Fi interface that has a default gateway (`Get-NetIPConfiguration`), not the `172.x` vEthernet adapters of WSL and Hyper-V, which the phone cannot reach.
2. Set `VITE_SUPABASE_URL=http://<LAN-IP>:54521` in `.env.local`.
3. Stop any running dev server, then `npm run dev -- --host`, and open `http://<LAN-IP>:5173` on the phone.

No `config.toml` change is needed for password login: Kong publishes 54521 on all interfaces and answers CORS for any origin (`Access-Control-Allow-Origin: *`, verified 2026-09-11 with a preflight from the LAN origin). `additional_redirect_urls` only matters for redirect flows. The Windows firewall must allow Node.js and Docker Desktop inbound on the active network profile — the Wi-Fi here is `Public`.

**Afterwards, put `.env.local` back to `http://127.0.0.1:54521`.** The LAN IP changes with every network; left in place, the app dials an address that no longer exists, and the failure reads like a broken migration or a stack that is down.

Run `npm run typecheck` and `npm run lint` before saying a task is done.

## Layout

```
docs/          SPEC.md, BACKLOG.md, BRAND-UI.md, CAHIER-DES-CHARGES.md
src/app/       routes
src/modules/   one folder per module (catalogue, stock, sales, clients, ...)
src/packs/     one folder per pack (variants, batches, vehicles, serials)
src/lib/       db client, auth, offline queue, printing
supabase/      migrations, seed
```

Module code stays inside its own folder. A module may import from `src/lib` and from another module's public `index.ts`, never from its internals.

## Hard constraints

**Every amount is declared `money_amount`, every quantity `quantity`** — the two domains of `public`, `numeric(12,2)` and `numeric(12,3)`. A bare `numeric` in a business table is an infraction, the same as a float: precision must not depend on anyone copying `(12,2)` correctly. Never floating point, anywhere. See SPEC § 4, RÈGLE des domaines nommés; enforced by `supabase/tests/conventions.ts`.

**The core never imports from `src/packs/`.** Packs extend the core; the core does not know they exist. A pack may add its own tables and nullable columns on core tables, nothing else.

**Every product always has at least one variant**, including when the `variants` pack is off. Stock, prices and sale lines reference `variant_id`, never `product_id`.

**`stock_level` is never written directly.** All changes go through `stock_movement`, which is append-only. Corrections are reversing movements, never UPDATE or DELETE.

**Document numbers are assigned locally**, with a device prefix (`BL-A-0001`), sequenced per `(tenant, device, doc_type, year)`. The server assigns nothing — numbering must work after days offline.

**Movements and ledger entries are append-only.** Never overwrite; corrections are reversing entries. This is what makes sync work.

**`cost_price` and margin are filtered server-side** and returned only to the `owner` role. Hiding a field in the UI is not access control.

**Cost and margin columns live on their own relation, never on a table everyone reads.** `variant` has no `cost_price`; `variant_cost` does. That relation carries a restrictive policy requiring `view_cost`, applied by `merx.apply_capability_restriction()`. PostgREST talks to Postgres as a single role, so column grants cannot separate `owner` from `worker`, and a conditional view returns `"cost_price": null` — present, merely masked. Absence of the key is structural or it is nothing. See SPEC § 3, RÈGLE de placement des coûts.

**Every permission check goes through `merx.can(capability)`**, which reads the § 3.1 matrix stored in `merx.role_capability`. A right checked anywhere else is a right the matrix does not govern. The front-end copy in `src/lib/auth/permissions.ts` is compared to the database row by row in `supabase/tests/permissions.test.ts` — do not edit one without the other.

**RLS on every business table.** Application queries never filter `tenant_id` by hand.

**Every foreign key between business tables is composite on `tenant_id`**: `(tenant_id, x) references t (tenant_id, id)`, the target carrying `unique (tenant_id, id)`. A foreign key does not go through RLS, so without it a tenant can attach its rows to another tenant's, and a cascade on the neighbour's side destroys its data. Only `tenant_id → tenant (id)` is exempt. See SPEC § 4; enforced by `supabase/tests/conventions.ts`.

**A rule guarded at several levels needs one test per level, each bypassing the others.** Otherwise removing the inner guard leaves the suite green — the outer layer masks it — and the hole only surfaces the day someone calls the API without going through the screen. Verified in E1-01: the `merx.is_super_admin()` guard was removed from `create_tenant()` and 18 of 19 tests stayed green, because the Edge Function's own check still held the front door. Only the test that calls the RPC directly went red.

**Two guards on the same path must return distinguishable responses — a different message or a different code.** One test per guard is not enough; the test must be able to tell which guard refused. Where both return the same thing, removing the outer one changes nothing an assertion can see, so its test cannot fail and exists only for form. Verified in E1-02: the Edge Function's role check was removed and 0 tests out of 180 went red — the pre-check and `create_worker()` both answered `403` with the same sentence, word for word. The fix is to give each level its own wording: the outer one is what the user reads, the inner one is only ever seen when something reached the database without going through the outer guard. The same applies to `create_tenant()` (E1-01) and to any guard doubled by a trigger.

**A trigger that writes to another table gets refused by that table's policy, not yours — with the same code.** When an insert fires a trigger that writes elsewhere, a refused caller may be stopped by the second table's policy before yours is ever the one that matters, and both answer `42501`. A refusal test on such a table asserts the table named in the message — `new row violates row-level security policy for table "x"` — not the code alone. Verified in E2-03: with `variant`'s insert policy removed, the write-restriction sweep in `settings.test.ts` stayed green. Inserting a variant fires the trigger that creates its `min_qty = 1` row, and `price_break`'s policy refused the worker in `variant`'s place. A code-only assertion cannot tell the two apart; the table name in the message can.

**A refusal test asserts the expected error code, not merely that the call failed.** In E1-01 a test passed on `23503` (foreign key) while believing it measured `42501` (authorization): the schema was holding the door and the test took the credit. Where a code is not enough, assert the absence of the effect too — no row created.

**A uniqueness test asserts the constraint name, not merely `23505`.** Two indexes can refuse the same insertion with the same code, and the one you believe you are measuring is not always the one that refused. Verified in E2-01: with `product_code_per_tenant` removed, the duplicate-code test stayed green — the default variant inherits its `sku` from the product `code`, so `variant_sku_per_tenant` refused in its place. Third occurrence of this family since E1-01.

**Editing a migration that has already run is allowed only while nothing is deployed and no database runs anywhere else.** Today that holds: `npx supabase db reset` rebuilds from zero and the only database is the local stack. From the first deployment on, a past migration is a record of what a live database has already applied — correcting it in place makes the file and that database disagree, and nothing says so until a rebuild produces a schema no one has ever run. Every correction is then an additive migration, `create or replace` included. This is written down now because the shortcut will be taken out of habit the day it is no longer allowed.

**Any column the isolation sweep must populate needs a machine-readable domain** — an enum or a foreign key, never a `check` constraint with a pattern. `supabase/tests/isolation.ts` derives its values from the Postgres catalogue: it can read an enum's labels and follow a foreign key, but a regex is opaque to it. A column it cannot fill drops its table out of the sweep. This is why `device.prefix` is `public.device_prefix`, not `text check (prefix ~ '^[A-Z]$')`.

**`session_replication_role = replica` disables foreign keys too, not just triggers.** Cascades stop firing, and the rows that should have followed stay behind — silently, and for good. A test-harness cleanup that deleted products under it left 283 000 orphan variants across runs in E2-05: three unrelated files then timed out on wide reads, and the search plan flipped, none of it pointing at the cause. Suspend triggers only around the writes that actually need it — an append-only table, an audited one — never around a delete whose cascade is doing the work.

**Match on a column you store, not on an expression you compute.** Under RLS an index condition must be `leakproof`; `lower(x) = any(...)` is not, so the index is skipped and every lookup reads the whole table — measured in E2-05 at 400 ms per 50-row batch, 71 s for a 2 000-line import, 7 s once the key was a stored generated column (`product.code_key`). Equality on a column (`texteq`) is leakproof, so the stored form is the way out — and the stored form must fold *exactly* what the matching rule folds, never more: `merx.search_fold()` also strips accents, and « CRÈME-1 » and « CREME-1 » are two different references.

**Under RLS, no index on `like`, `unaccent` or `pg_trgm` is ever used.** Postgres only accepts `leakproof` predicates as index conditions under a row-level policy, and none of these are; `postgres` is not a superuser, so nothing can be declared leakproof. The index exists and every query reads the whole table — all tenants. Measured in E2-04, five tenants of 10,000 products, same 1,251 rows returned by both paths: Seq Scan 417–472 ms under `authenticated`, 8.6–9.7 ms through the trigram index from a `security definer` function. The way out is the named exception of SPEC § 2.1 and `merx.rls_exception_registry`, never a quiet definer function. The same mechanism makes the `OR merx.is_super_admin()` of the two isolation policies defeat even the `tenant_id` btree: `listProducts()` took 410 ms, 13.5 ms without `super_admin_all` (BACKLOG E0-03, open).

**A GIN index with the default `fastupdate` loses the plan after every bulk insert.** New entries wait in a pending list, read in full on every scan until the next vacuum; the planner counts it and prefers another index. Measured in E2-04, twelve search queries: 12/12 through the trigram index on clean indexes, **3/12 right after inserting 10,000 products**, 12/12 again once the list was flushed, 12/12 immediately with `fastupdate = off`. A test that seeds then asserts a plan sees this; production after an import does too, silently.

**A plan sabotage that stays green on one run proves nothing — read the plan of a warm session.** Plan choice is borderline and flips between runs on the same data. In E2-04, removing `tenant_id` from the composite search indexes stayed green once; I concluded the composite was useless and removed it. The next run, with the plan read after eight warm-up calls in the same session — the way a pooled PostgREST connection runs — failed on « creme », « crème » and « nivea creme 200 », and `tenant_id` went back into the indexes. A plan assertion warms the session first; a plan sabotage is judged on more than one run.

## Working style

Build one step of `docs/SPEC.md` section 11 at a time. Do not build ahead into later steps, even when it looks trivial to add.

Before starting a step, state which spec sections you have read and what you plan to change. Wait for confirmation on anything touching the schema.

Prefer boring, obvious code. This codebase is maintained by one person.

When something in the spec is ambiguous, ask. Do not pick an interpretation and continue.

## Sabotage

Each story ends with a sabotage pass: remove a guard, run the tests, and check that one goes red for the right reason. A guard whose removal leaves the suite green is untested, whatever the test names say.

**Sabotage only the guards that hold a line**: authorization, tenant isolation, money and quantity precision, cost confidentiality, append-only. Interface details — a label, a field order, an empty state — get ordinary tests and no sabotage pass; they fail visibly and cost nothing when they break.

**Run only the test files the sabotaged guard touches**, with a reporter that prints failures only. The full suite runs once, at the end of the pass — not after each case.

**Report one line per case**: the guard removed, the files run, how many tests went red, and which. A count is the whole report; a green case is a hole to fix, not a line to explain away.
