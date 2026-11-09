# LESSONS.md

Explanations, measurements and examples behind the rules in `CLAUDE.md`. Each
section here is pointed to by one line there. `CLAUDE.md` is read on every
message and stays short on purpose; this file is read when the one-line
pointer isn't enough.

## Edge runtime en cache

The local Edge runtime serves the cached version of a function after you edit
it. Run `docker restart supabase_edge_runtime_Merx` before any suite that
touches `supabase/functions/`, otherwise a test passes or fails on code that
is no longer yours — and it does so silently, which is the worst way to be
wrong. Same family of trap as `npx supabase db reset`, which replays the
migrations but does not reload `config.toml`: a changed port or a changed
auth hook needs `npx supabase stop && npx supabase start`. In both cases the
process you are questioning is not the one you just edited.

## Ports bloqués

Ports 54279–54478 are reserved by Hyper-V on this machine, and `config.toml`
has been moved out of that range — API 54521, db 54522, shadow 54520, pooler
54529, studio 54523, smtp 54524, analytics 54527. Do not "restore" the usual
Supabase defaults: 54321/54322 fall inside the reserved range and cannot
bind. The test files, `.env.local`, `.env.example` and the `test.env` block
of `vite.config.ts` carry the same numbers; move one and move them all, or
the suite dials a dead port and reports the database as unreachable, which
reads like a broken migration.

## Collision de port

A port collision leaves the stack down, and the message does not say so.
`npx supabase db reset` stops the database container before recreating it;
when the port cannot bind it fails with `LegacyContainerStartError ... bind:
An attempt was made to access a socket in a way forbidden by its access
permissions` and leaves the container stopped. Every command after that
fails for a different-looking reason, and none of them mentions the port.
The recovery is `npx supabase stop && npx supabase start`, never a second
`db reset`. This has cost time twice.

## Code de sortie de db reset

`npx supabase db reset` can exit non-zero after succeeding. The output ends
with `Finished supabase db reset` and the database is fine, but the exit
code says failure. Judge a reset by that line, not by the exit code. Seen in
E2-03 while `supabase_vector_Merx` was restart-looping: a script that
trusted the exit code skipped every run after the second.

## Compte de tests, pas code de sortie

A suite is judged on the test count in its own output, never on the exit
code. `vitest --reporter=basic` — the reporter this project used until
vitest 5 dropped it — now fails at startup with `Failed to load custom
Reporter from basic`, runs **no test at all**, and the background task that
wrapped it still reported `exit code 0`. A green exit meant nothing had run.
Read the `Tests  N passed` line, and if there is no such line, nothing was
measured. Same family as the `db reset` exit code above, and the reason the
sabotage harness parses the count rather than the status.

And a background run whose output goes through a pipe (`npm run test |
tail`) leaves **nothing** behind when it is killed: the partial output dies
in the pipe. Redirect to a file — `npm run test -- --reporter=dot >
"$TEMP/merx-test-run.log" 2>&1` — and the partial is still readable
afterwards. Both seen 2026-10-15, on the E4-01 verification pass.

## Run isolé

A suite is judged on a run that had the machine to itself — nothing else in
flight: no `typecheck`, no `lint`, no second `vitest`. The files run in
parallel against one local Postgres, and a competing run turns lock waits
into timeouts that read like broken code. On the E4-01 closing pass, a full
run shared with `typecheck`, `lint` and a one-file `vitest` came back `16
failed | 1411 passed | 69 skipped`, and its first failure was `Hook timed
out in 300000ms` in `product-search.test.ts`'s `beforeAll` — followed by a
teardown that could no longer delete its warehouse (`violates foreign key
constraint "stock_level_warehouse_id_fkey"`), because the run had been cut
off mid-fixture. Nothing there was a regression; the same tests had been
green on a lone run minutes earlier, and were green again afterwards: `56
files, 1496 tests`.

## Attendre le stack

The stack is waited on, never assumed up: `until docker exec supabase_db_Merx
pg_isready -U postgres; do sleep 2; done` before any `db reset`. The second
contaminated run of that same pass lost the Docker engine mid-flight —
`Error: connect ECONNREFUSED 127.0.0.1:54522`, then `failed to connect to the
docker API at npipe:////./pipe/dockerDesktopLinuxEngine` — and reported `24
failed | 533 skipped`, every message pointing at the database rather than at
the daemon. A `db reset` fired at a stack that is still starting fails the
same way. Containers also come back from a Docker Desktop restart **without**
`supabase_edge_runtime_Merx`, which has to be started by hand, so chain the
whole thing — edge container, `pg_isready`, `db reset` judged on its
`Finished` line, then the suite — in one command, and read the count at the
end.

## Conteneur et CLI désynchronisés

A container that survives a CLI upgrade serves the old binary against the
new schema. `npx supabase start` reuses a container that already exists — it
does not recreate it at the version the current CLI expects — and the
database, rebuilt by `db reset`, carries the *new* schema. The pair drifts
apart silently. Seen 2026-09-28: the storage container was still
`storage-api:v1.72.1` while the CLI installed the object-versioning schema,
where the plain unique `bname` on `(bucket_id, name)` is replaced by partial
indexes collated `"C"` (`idx_objects_current_version`,
`idx_objects_null_version`). v1.72.1 still issues `insert ... on conflict
(name, bucket_id)`, Postgres can infer no arbiter index for it, and every
photo upload fails `42P10` — reported by the API as
`{"error":"DatabaseError","message":"database error, code: 42P10"}`, a `500`
that reads like a broken policy. The 7 photo tests of `product-form.test.ts`
failed on every run, control run included.

The recovery is **`npx supabase stop --no-backup && npx supabase start`**,
which removes the containers and recreates them at the CLI's own versions
(v1.77.0 here). A `db reset` does not do it, nor does `docker restart` — both
keep the same container. The CLI is pinned exactly in `devDependencies`
(`supabase` at 2.118.0) so `npx` resolves the local binary rather than
fetching the latest: an unpinned `npx supabase` installed a different CLI on
some runs, which is how the two versions drifted in the first place. **When
bumping that pin, run `stop --no-backup` then `start` in the same breath** —
otherwise the containers stay behind and this comes back.

## Montage du lecteur D:

Docker Desktop can lose its mount of the D: drive. The Edge runtime then
cannot start — `mkdir /run/desktop/mnt/host/d: file exists` on `docker
restart`, `failed to copy edge runtime main service into container` on `npx
supabase start` — and every test that calls an Edge Function gets `503`,
which reads like a broken function. `npx supabase stop && npx supabase
start` does not fix it; only restarting Docker Desktop does, and that is the
user's call, not Claude's. Seen in E2-03: 26 tests in `tenant-creation` and
`user-management` failed on every run, the control run included.

## Test sur téléphone réel

Testing on a real phone, same Wi-Fi. On the phone, `localhost` is the phone,
so the app cannot reach an API at `127.0.0.1`. Steps:

1. Find the machine's LAN IPv4 — the Wi-Fi interface that has a default
   gateway (`Get-NetIPConfiguration`), not the `172.x` vEthernet adapters of
   WSL and Hyper-V, which the phone cannot reach.
2. Set `VITE_SUPABASE_URL=http://<LAN-IP>:54521` in `.env.local`.
3. Stop any running dev server, then `npm run dev -- --host`, and open
   `http://<LAN-IP>:5173` on the phone.

No `config.toml` change is needed for password login: Kong publishes 54521
on all interfaces and answers CORS for any origin
(`Access-Control-Allow-Origin: *`, verified 2026-09-11 with a preflight from
the LAN origin). `additional_redirect_urls` only matters for redirect flows.
The Windows firewall must allow Node.js and Docker Desktop inbound on the
active network profile — the Wi-Fi here is `Public`.

Afterwards, put `.env.local` back to `http://127.0.0.1:54521`. The LAN IP
changes with every network; left in place, the app dials an address that no
longer exists, and the failure reads like a broken migration or a stack that
is down.

## Collision de casse

Two files whose names differ only by case are the same file on this machine.
Windows and macOS have a case-insensitive filesystem; Vite's resolver is
case-sensitive. `src/modules/stock/Quantity.tsx` beside `quantity.ts` meant
`import { Quantity } from '@/modules/stock/Quantity'` resolved to
`quantity.ts`, which exports no component — React got `undefined` and twelve
tests went red on `Element type is invalid`. **`tsc` and `eslint` see
nothing**, because both paths exist; a Linux CI sees nothing either, because
there the two files are genuinely distinct and everything imports
correctly. The failure is local, at runtime, and reads like a broken
component.

Worse, the filesystem hides the cleanup too: `rm QuantityReading.ts` deletes
`quantityReading.ts`, and `echo > QuantityReading.ts` overwrites it. A file
lost that way is gone unless it was committed — this cost the file twice in
E3-02.

`src/test/caseCollision.test.ts` now refuses it on any machine: it reads
`git ls-files` rather than walking the disk, because a case-insensitive walk
cannot see both entries — exactly where the check is needed. Renaming is the
fix; `quantityReading.ts` is the current spelling.

## Typecheck et lint propres

"typecheck and lint clean" is written from the output of the command, in the
same session as the sentence, after the last edit. Not from the last time it
was run, not from the expectation that nothing has changed since, and never
from the test suite being green. A story does not close on a red `typecheck`.

E3-02 did. Its closing note recorded "`typecheck` et `lint` propres"; `npm
run typecheck` returned two errors — `src/modules/stock/levels.ts`
(`GenericStringError[] → EntryRow[]`, cast through `unknown`) and
`supabase/tests/stock-api.test.ts` (`one<T>` with no `QueryResultRow`
constraint) — both in files created by `be59ae7`, the mid-story
machine-change commit, and both still red when E3-03 opened a week later.
Nothing hid them: `tsc -b --noEmit` prints them and exits 2, even with a
`tsbuildinfo` newer than the source (it compares content, not timestamps).
The gate had simply not been re-run after that code arrived, and the suite
being green was read as the whole answer. Fixed in E3-03.

## Coûts sur relation séparée

Cost and margin columns live on their own relation, never on a table
everyone reads. `variant` has no `cost_price`; `variant_cost` does. That
relation carries a restrictive policy requiring `view_cost`, applied by
`merx.apply_capability_restriction()`. PostgREST talks to Postgres as a
single role, so column grants cannot separate `owner` from `worker`, and a
conditional view returns `"cost_price": null` — present, merely masked.
Absence of the key is structural or it is nothing.

## Les quatre copies de la matrice

The matrix has four copies, and a new capability goes into all four. Three
on their own is the mistake that is actually made — E3-03 added
`adjust_stock` to three and the full suite caught the fourth:

1. `merx.role_capability`, seeded by
   `supabase/migrations/20260907090000_permissions.sql` — the only one that
   governs anything;
2. the `Capability` union **and** the `CAPABILITIES` object of
   `src/lib/auth/permissions.ts`, which decide what the interface shows;
3. `supabase/tests/permissions.test.ts`, which compares the two above row by
   row — it fails on a capability added to one side only, so it covers 1
   against 2;
4. `src/lib/auth/permissions.test.ts`, which keeps its **own** lists
   `OWNER_ONLY` and `SHARED` and asserts they cover `CAPABILITIES` exactly.
   Nothing in the database makes it fail, and nothing in the first three
   makes it pass: it only goes red in the front-end project, which `npm run
   test` reaches and a database-only run does not.

So: migration, `permissions.ts`, then the two test files. A capability
missing from the fourth leaves the suite red at the very end of the pass,
long after the schema looked finished.

## Refus en 4xx

A refusal is a 4xx response; 5xx is reserved for a real outage. Every guard
raises a SQLSTATE that PostgREST renders as 4xx — and the status is
*measured* through an actual API call, never read off the code. This is not
API tidiness: in E9, PowerSync replays the writes queued offline and reads a
4xx as a final refusal it abandons and surfaces, a 5xx as a transient outage
it **retries forever**. A legitimate refusal returned as 5xx blocks the
device's whole queue on a write that will never pass, and nothing says so —
every attempt looks like a flaky network.

Four guards lived several stories in `500` before anyone looked: `55006`
(frozen tables), `55000` (derived tables), `54000` (26 devices), `P0002` (row
not found). None is in PostgREST's mapping table, which defaults to `500`.
They now raise PostgREST's `PTxxx` family, whose three digits *are* the
status: `PT409` frozen, `PT422` derived, `PT400` unsatisfiable, `PT404` not
found — one guard, one code, one sentence, one test, and no Postgres code
bent out of its meaning. Postgres' own 4xx codes stay (`42501 → 403`,
`23503`/`23505 → 409`, `23514`/`23502`/`22023`/`2F004`/`P0001 → 400`).
Enforced by the `aucun refus rendu en 5xx` rule of
`supabase/tests/conventions.ts`, whose admitted list lives in
`supabase/tests/refusalCodes.ts` — one copy. **That list is measured, not
copied:** `supabase/tests/refusal-status.test.ts` raises every admitted code
through PostgREST on every run, and also every code the guards actually
raise, read from the catalogue. The mapping belongs to the PostgREST version
the CLI pins, so when that pin moves the suite goes red by itself. Never
hand-maintain a second copy of it.

## FK composites

Every foreign key between business tables is composite on `tenant_id`:
`(tenant_id, x) references t (tenant_id, id)`, the target carrying `unique
(tenant_id, id)`. A foreign key does not go through RLS, so without it a
tenant can attach its rows to another tenant's, and a cascade on the
neighbour's side destroys its data. Only `tenant_id → tenant (id)` is
exempt.

## Un test par niveau (E1-01)

A rule guarded at several levels needs one test per level, each bypassing
the others. Otherwise removing the inner guard leaves the suite green — the
outer layer masks it — and the hole only surfaces the day someone calls the
API without going through the screen. Verified in E1-01: the
`merx.is_super_admin()` guard was removed from `create_tenant()` and 18 of 19
tests stayed green, because the Edge Function's own check still held the
front door. Only the test that calls the RPC directly went red.

## Réponses distinguables (E1-02)

Two guards on the same path must return distinguishable responses — a
different message or a different code. One test per guard is not enough; the
test must be able to tell which guard refused. Where both return the same
thing, removing the outer one changes nothing an assertion can see, so its
test cannot fail and exists only for form. Verified in E1-02: the Edge
Function's role check was removed and 0 tests out of 180 went red — the
pre-check and `create_worker()` both answered `403` with the same sentence,
word for word. The fix is to give each level its own wording: the outer one
is what the user reads, the inner one is only ever seen when something
reached the database without going through the outer guard. The same
applies to `create_tenant()` (E1-01) and to any guard doubled by a trigger.

## Un cas par branche (E4-06)

A guard with two branches needs, per branch, a case that trips only that
branch. One test per guard is not enough when the guard refuses for two
reasons: if every input that trips branch A also trips branch B, removing A
changes nothing an assertion can see — B refuses in its place, and often
with a message the test does not distinguish. The branch is then untested
however many cases point at the guard.

Verified in E4-06: `merx.require_returnable_quantity()` refuses a return
that exceeds the delivery note's quantities *or* its amounts. Every
excessive return the suite measured — 12 pieces at 9 DH against 10 delivered
— exceeded **both**, so the amount branch answered for the quantity branch,
and removing the quantity condition left the whole suite green. The case
that isolates it returns **more pieces at a lower price**: 12 at 7 DH on a
note of 10 at 9 DH is 84 DH of credit, inside the invoice, while twelve
pieces enter the warehouse having never left it. Same family as the
uniqueness rule above — the thing that refused is not always the thing you
believe you are measuring.

## Policy de la table déclenchée (E2-03)

A trigger that writes to another table gets refused by that table's policy,
not yours — with the same code. When an insert fires a trigger that writes
elsewhere, a refused caller may be stopped by the second table's policy
before yours is ever the one that matters, and both answer `42501`. A
refusal test on such a table asserts the table named in the message — `new
row violates row-level security policy for table "x"` — not the code alone.
Verified in E2-03: with `variant`'s insert policy removed, the
write-restriction sweep in `settings.test.ts` stayed green. Inserting a
variant fires the trigger that creates its `min_qty = 1` row, and
`price_break`'s policy refused the worker in `variant`'s place. A code-only
assertion cannot tell the two apart; the table name in the message can.

## Même transaction (E2-06)

A cross-tenant test proves nothing if the two writes sit in separately
rolled-back transactions. Two tenants using the same value is the property;
measuring it needs both rows to exist *at the same instant*. Write A's row
in one aborted transaction and B's in the next, and B never meets A — no
collision is possible, and a constraint that is missing its `tenant_id`
passes exactly like one that has it. Put both writes in **one** transaction.
And read the count back outside RLS (`reset role`): under B's token the
policy shows one row whether or not A's exists, so `1` says nothing.
Verified in E2-06: `variant_barcode_per_tenant` rebuilt without `tenant_id`
— a global uniqueness that would break every second tenant importing a
shared EAN — and the cross-tenant test stayed green; rewritten with both
writes in one transaction, it goes red.

## Nom de la contrainte (E2-01)

A uniqueness test asserts the constraint name, not merely `23505`. Two
indexes can refuse the same insertion with the same code, and the one you
believe you are measuring is not always the one that refused. Verified in
E2-01: with `product_code_per_tenant` removed, the duplicate-code test
stayed green — the default variant inherits its `sku` from the product
`code`, so `variant_sku_per_tenant` refused in its place. Third occurrence of
this family since E1-01.

(The refusal-test rule above it — assert the code, and the absence of the
effect too, not merely that the call failed — is the same family: in E1-01 a
test passed on `23503` (foreign key) while believing it measured `42501`
(authorization): the schema was holding the door and the test took the
credit.)

## Migrations déjà jouées

Editing a migration that has already run is allowed only while nothing is
deployed and no database runs anywhere else. Today that holds: `npx supabase
db reset` rebuilds from zero and the only database is the local stack. From
the first deployment on, a past migration is a record of what a live
database has already applied — correcting it in place makes the file and
that database disagree, and nothing says so until a rebuild produces a
schema no one has ever run. Every correction is then an additive migration,
`create or replace` included. This is written down now because the shortcut
will be taken out of habit the day it is no longer allowed.

## Régénération de SCHEMA.md

Every migration regenerates `docs/SCHEMA.md`, in the same commit. `npx
supabase db reset`, then `npm run schema:doc`, then read the diff — it is
the shortest review of what the migration actually did to the catalogue, and
more than once that diff is where an unintended index, policy or trigger
shows up. The file is **generated, never written by hand**: it is produced
from `pg_catalog` by `supabase/tests/schemaDoc.ts`, so correcting it corrects
nothing — a wrong line there means a migration is missing.
`supabase/tests/schema-doc.test.ts` compares the file on disk to what the
catalogue produces and fails until the two agree, which is why a migration
without its regeneration leaves the suite red. The comparison is against the
**running** database, so it is read after a `db reset`, never before: a
migration edited but not replayed makes the test describe the database you
have, not the one the files say.

## create or replace et la dernière version (E3-02)

A `create or replace` starts from the function's *latest* definition, never
its first. A function is replaced whole, so the body you paste becomes the
whole function: anything a later migration had added and that you did not
carry over is deleted, silently and without error. Read the current body
before rewriting it — `select
pg_get_functiondef('public.f(args)'::regprocedure)` from the running
database, or the most recent migration that touches it (`grep -rln 'function
public.f' supabase/migrations/`, and take the last by filename). Never the
migration that created it.

Verified in E3-02: `create_tenant()` was rewritten from its E1-01 text to
drop one `insert`, which silently undid E1-05's addition of
`merx.seed_tenant_settings()`. The function still compiled, still created
its tenant, its depot, its device and its owner — and stopped seeding the
settings of every new commerce. Nothing failed at migration time;
`settings.test.ts` caught it one step later, reading a setting that was no
longer there. Reading the diff would not have shown it, because the lost
line was in neither the old file nor the new one.

## Domaine lisible par la machine

Any column the isolation sweep must populate needs a machine-readable
domain — an enum or a foreign key, never a `check` constraint with a
pattern. `supabase/tests/isolation.ts` derives its values from the Postgres
catalogue: it can read an enum's labels and follow a foreign key, but a
regex is opaque to it. A column it cannot fill drops its table out of the
sweep. This is why `device.prefix` is `public.device_prefix`, not `text
check (prefix ~ '^[A-Z]$')`.

## replica et les clés étrangères (E2-05)

`session_replication_role = replica` disables foreign keys too, not just
triggers. Cascades stop firing, and the rows that should have followed stay
behind — silently, and for good. A test-harness cleanup that deleted
products under it left 283 000 orphan variants across runs in E2-05: three
unrelated files then timed out on wide reads, and the search plan flipped,
none of it pointing at the cause. Suspend triggers only around the writes
that actually need it — an append-only table, an audited one — never around
a delete whose cascade is doing the work.

## Colonne stockée vs expression (E2-05)

Match on a column you store, not on an expression you compute. Under RLS an
index condition must be `leakproof`; `lower(x) = any(...)` is not, so the
index is skipped and every lookup reads the whole table — measured in E2-05
at 400 ms per 50-row batch, 71 s for a 2 000-line import, 7 s once the key
was a stored generated column (`product.code_key`). Equality on a column
(`texteq`) is leakproof, so the stored form is the way out — and the stored
form must fold *exactly* what the matching rule folds, never more:
`merx.search_fold()` also strips accents, and « CRÈME-1 » and « CREME-1 »
are two different references.

## Index inutilisables sous RLS (E2-04)

Under RLS, no index on `like`, `unaccent` or `pg_trgm` is ever used. Postgres
only accepts `leakproof` predicates as index conditions under a row-level
policy, and none of these are; `postgres` is not a superuser, so nothing can
be declared leakproof. The index exists and every query reads the whole
table — all tenants. Measured in E2-04, five tenants of 10,000 products, same
1,251 rows returned by both paths: Seq Scan 417–472 ms under `authenticated`,
8.6–9.7 ms through the trigram index from a `security definer` function. The
way out is the named exception of SPEC § 2.1 and
`merx.rls_exception_registry`, never a quiet definer function. The same
mechanism makes the `OR merx.is_super_admin()` of the two isolation policies
defeat even the `tenant_id` btree: `listProducts()` took 410 ms, 13.5 ms
without `super_admin_all` (BACKLOG E0-03, open).

## GIN et fastupdate (E2-04)

A GIN index with the default `fastupdate` loses the plan after every bulk
insert. New entries wait in a pending list, read in full on every scan until
the next vacuum; the planner counts it and prefers another index. Measured
in E2-04, twelve search queries: 12/12 through the trigram index on clean
indexes, **3/12 right after inserting 10,000 products**, 12/12 again once
the list was flushed, 12/12 immediately with `fastupdate = off`. A test that
seeds then asserts a plan sees this; production after an import does too,
silently.

## Plan sur session chauffée (E2-04)

A plan sabotage that stays green on one run proves nothing — read the plan
of a warm session. Plan choice is borderline and flips between runs on the
same data. In E2-04, removing `tenant_id` from the composite search indexes
stayed green once; I concluded the composite was useless and removed it. The
next run, with the plan read after eight warm-up calls in the same session
— the way a pooled PostgREST connection runs — failed on « creme », «
crème » and « nivea creme 200 », and `tenant_id` went back into the indexes.
A plan assertion warms the session first; a plan sabotage is judged on more
than one run.

## Répertoire mémoire sur le lecteur

The harness announces `C:\Users\<user>\.claude\projects\D--Merx\memory\`
instead of the drive-local directory. On this project that copy is
**stale** — on 2026-10-12 it was four files and several days behind the one
on `D:`, and a memory written there was invisible to every later session.
Read and write the drive-local one; if both exist, the drive-local one wins.

This project moves between machines mid-story, and the drive letter moves
with it. That is the whole reason the rule is written as a derivation and
not as a path.
