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

Run `npm run typecheck` and `npm run lint` before saying a task is done.

## Layout

```
docs/          SPEC.md, CAHIER-DES-CHARGES.md
src/app/       routes
src/modules/   one folder per module (catalogue, stock, sales, clients, ...)
src/packs/     one folder per pack (variants, batches, vehicles, serials)
src/lib/       db client, auth, offline queue, printing
supabase/      migrations, seed
```

Module code stays inside its own folder. A module may import from `src/lib` and from another module's public `index.ts`, never from its internals.

## Hard constraints

**Money is `numeric(12,2)`. Quantities are `numeric(12,3)`. Never floating point, anywhere.**

**The core never imports from `src/packs/`.** Packs extend the core; the core does not know they exist. A pack may add its own tables and nullable columns on core tables, nothing else.

**Every product always has at least one variant**, including when the `variants` pack is off. Stock, prices and sale lines reference `variant_id`, never `product_id`.

**`stock_level` is never written directly.** All changes go through `stock_movement`, which is append-only. Corrections are reversing movements, never UPDATE or DELETE.

**Document numbers are assigned locally**, with a device prefix (`BL-A-0001`), sequenced per `(tenant, device, doc_type, year)`. The server assigns nothing — numbering must work after days offline.

**Movements and ledger entries are append-only.** Never overwrite; corrections are reversing entries. This is what makes sync work.

**`cost_price` and margin are filtered server-side** and returned only to the `owner` role. Hiding a field in the UI is not access control.

**Cost and margin columns live on their own relation, never on a table everyone reads.** `variant` has no `cost_price`; `variant_cost` does. That relation carries a restrictive policy requiring `view_cost`, applied by `merx.apply_capability_restriction()`. PostgREST talks to Postgres as a single role, so column grants cannot separate `owner` from `worker`, and a conditional view returns `"cost_price": null` — present, merely masked. Absence of the key is structural or it is nothing. See SPEC § 3, RÈGLE de placement des coûts.

**Every permission check goes through `merx.can(capability)`**, which reads the § 3.1 matrix stored in `merx.role_capability`. A right checked anywhere else is a right the matrix does not govern. The front-end copy in `src/lib/auth/permissions.ts` is compared to the database row by row in `supabase/tests/permissions.test.ts` — do not edit one without the other.

**RLS on every business table.** Application queries never filter `tenant_id` by hand.

**A rule guarded at several levels needs one test per level, each bypassing the others.** Otherwise removing the inner guard leaves the suite green — the outer layer masks it — and the hole only surfaces the day someone calls the API without going through the screen. Verified in E1-01: the `merx.is_super_admin()` guard was removed from `create_tenant()` and 18 of 19 tests stayed green, because the Edge Function's own check still held the front door. Only the test that calls the RPC directly went red.

**Two guards on the same path must return distinguishable responses — a different message or a different code.** One test per guard is not enough; the test must be able to tell which guard refused. Where both return the same thing, removing the outer one changes nothing an assertion can see, so its test cannot fail and exists only for form. Verified in E1-02: the Edge Function's role check was removed and 0 tests out of 180 went red — the pre-check and `create_worker()` both answered `403` with the same sentence, word for word. The fix is to give each level its own wording: the outer one is what the user reads, the inner one is only ever seen when something reached the database without going through the outer guard. The same applies to `create_tenant()` (E1-01) and to any guard doubled by a trigger.

**A refusal test asserts the expected error code, not merely that the call failed.** In E1-01 a test passed on `23503` (foreign key) while believing it measured `42501` (authorization): the schema was holding the door and the test took the credit. Where a code is not enough, assert the absence of the effect too — no row created.

**Editing a migration that has already run is allowed only while nothing is deployed and no database runs anywhere else.** Today that holds: `npx supabase db reset` rebuilds from zero and the only database is the local stack. From the first deployment on, a past migration is a record of what a live database has already applied — correcting it in place makes the file and that database disagree, and nothing says so until a rebuild produces a schema no one has ever run. Every correction is then an additive migration, `create or replace` included. This is written down now because the shortcut will be taken out of habit the day it is no longer allowed.

**Any column the isolation sweep must populate needs a machine-readable domain** — an enum or a foreign key, never a `check` constraint with a pattern. `supabase/tests/isolation.ts` derives its values from the Postgres catalogue: it can read an enum's labels and follow a foreign key, but a regex is opaque to it. A column it cannot fill drops its table out of the sweep. This is why `device.prefix` is `public.device_prefix`, not `text check (prefix ~ '^[A-Z]$')`.

## Working style

Build one step of `docs/SPEC.md` section 12 at a time. Do not build ahead into later steps, even when it looks trivial to add.

Before starting a step, state which spec sections you have read and what you plan to change. Wait for confirmation on anything touching the schema.

Prefer boring, obvious code. This codebase is maintained by one person.

When something in the spec is ambiguous, ask. Do not pick an interpretation and continue.