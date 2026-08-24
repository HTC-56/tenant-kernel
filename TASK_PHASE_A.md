# Phase A — prove the refusal path

SPEC.md pre-registers the rule this phase satisfies: *"Phase A must prove the
RLS refusal path on both engines before anything else is built."*

**Already committed by the planning lane** (do not rebuild, do not edit):
`package.json`, `tsconfig.json`, `vitest.config.ts`, `src/db/engine.ts`,
`src/db/migrate.ts`, `sql/0001_tenancy_core.sql`, `test/helpers/db.ts`,
`test/rls-refusal.test.ts`. Nine refusal assertions are green on PGlite.

The tasks below close the phase: the scrubber, the catalog check that makes an
unprotected table a failing build, CI (which carries the real-Postgres half),
the README, and `verify.sh`.

Grep your `## §A<n>` header, read that section, build it. Nothing else.

---

## §A5 — scripts/scrub-check.sh

Create `scripts/scrub-check.sh`. It is the public-repo gate: this repo will be
published, so a private hostname, LAN IP, home path or key must fail the build.

Scan **tracked files only** — get the list from `git ls-files`. Do not walk the
tree with `grep -r`: that would descend into `node_modules/` and never finish.
Skip `pnpm-lock.yaml`, and skip `scripts/scrub-check.sh` itself (the script
necessarily contains the very patterns it hunts for — exclude it and say so in
a comment, or the gate can never pass).

Fail with exit 1, printing every offending `file:line`, on any of:

- an absolute home path — `/home/` or `/Users/`
- a private LAN IPv4 — `10.`, `192.168.`, or `172.16`–`172.31` octets
- any other literal IPv4 that is **not** `127.0.0.1` and **not** in `192.0.2.`
  (the documentation range DECISIONS.md mandates)
- key material — a `BEGIN ... PRIVATE KEY` header, or an `AKIA` access-key id
- a private hostname suffix — `.local`, `.lan`, or `.internal`

Clean tree: print one OK line and exit 0.

Keep it plain bash — `set -u`, a findings counter, no external tools beyond
`git` and `grep`. Note that `set -e` fights `grep` returning 1 for "no match",
which is the *success* case here; structure around that.

**Gate**: `bash scripts/scrub-check.sh` exits 0 on the current tree, and
`pnpm typecheck` + `pnpm test` are still green.

---

## §A6 — test/rls-coverage.test.ts

Create `test/rls-coverage.test.ts`. This is what makes a future unprotected
table fail the build by construction: instead of naming tables, it **discovers**
them from the Postgres catalog at runtime.

The rule, in one sentence: *every ordinary table in schema `public` that has a
`tenant_id` column — plus `tenants` itself — must be protected.*

Mirror `test/rls-refusal.test.ts` for structure: same imports from
`./helpers/db.ts`, `freshEngine()` in `beforeAll`, `engine.close()` in
`afterAll`. This file only reads catalogs, so it seeds nothing and cleans up
nothing.

Write one discovery query against `pg_class` / `pg_namespace` /
`information_schema.columns` (relkind `'r'`, namespace `public`) returning each
protected table's name, `relrowsecurity` and `relforcerowsecurity`. Exclude
`schema_migrations` — it is bookkeeping, not tenant data.

Assert, in this order:

1. discovery finds at least two tables, and the name list contains both
   `tenants` and `projects` (proves the query works before trusting it)
2. every discovered table has `relrowsecurity` true
3. every discovered table has `relforcerowsecurity` true
4. every discovered table has at least one policy in `pg_policies`
5. no discovered table grants any privilege to `PUBLIC` — check
   `information_schema.role_table_grants` for `grantee = 'PUBLIC'`

Put the table name in each assertion's message so a failure names the offender.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §A7 — .github/workflows/ci.yml

Create `.github/workflows/ci.yml`. SPEC.md requires the suite to run on **both**
engines; this file is where the real-Postgres half is proven, because the dev
box has no Postgres available.

Trigger on `push` and `pull_request`. Two jobs, both on `ubuntu-latest`, both
running the identical steps — checkout, `pnpm/action-setup@v4`,
`actions/setup-node@v4` (node 22, `cache: pnpm`), `pnpm install --frozen-lockfile`,
`pnpm typecheck`, `pnpm test`, `bash scripts/scrub-check.sh`:

- **`pglite`** — no services, no `DATABASE_URL`. Proves a clone with no database
  installed is green.
- **`postgres`** — a `postgres:16` service container with
  `POSTGRES_PASSWORD`, port 5432 mapped, and a `pg_isready` health check with
  retries. Sets `DATABASE_URL` to a `postgres://` url on `127.0.0.1:5432` for
  the test step. Name this job so it reads as the authoritative one.

Only `127.0.0.1` may appear as a host — §A5's scrubber rejects anything else.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`
(the workflow itself runs on GitHub, not locally).

---

## §A8 — README.md

Create `README.md`. Under 120 lines. Every command it shows must actually exist
in the repo — §A9's lint will enforce that, so do not invent script names.

Sections, in order:

1. Title and a short paragraph on what this is. Take the framing from SPEC.md's
   opening paragraph — isolation as a *proven* property, RLS as the enforcement
   layer. Do not invent claims about features that are not built yet.
2. **Quickstart** — `pnpm install` then `pnpm test`, with one line noting the
   suite needs no database installed because PGlite is real Postgres in-process.
3. **Run the same suite against a real Postgres** — the `DATABASE_URL=...`
   invocation, host `127.0.0.1` only, and one line saying that run is the
   authoritative one.
4. **How isolation is enforced** — about six lines: the app runs as `app_user`,
   which owns no tables and is not a superuser; every tenant-scoped table is
   `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies compare `tenant_id` against
   `app.tenant_id`, published per transaction with `SET LOCAL`; with no context
   published a transaction sees nothing. Point at `sql/0001_tenancy_core.sql`
   and `test/rls-refusal.test.ts`.
5. **Repo layout** — one line each for `src/`, `sql/`, `test/`, `scripts/`.
6. **Status** — one line pointing at `ROADMAP.md`; say v1 is in progress.

No screenshot yet (the console is a later phase). No badge yet.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §A9 — verify.sh

Create `verify.sh` at the repo root. DECISIONS.md defines it as
*typecheck + test + scrub-check + the README-quickstart lint*. Plain bash, no
new dependencies.

Run four steps in order, printing a labelled line per step, and exit non-zero on
the first failure:

1. `pnpm typecheck`
2. `pnpm test`
3. `bash scripts/scrub-check.sh`
4. the README-quickstart lint, below

**The lint.** Pull every line inside a fenced code block in `README.md` that
starts with `pnpm ` or `bash ` (a leading `DATABASE_URL=...` assignment before
`pnpm` still counts — strip it). Then:

- for `pnpm <name>`, `<name>` must be a key under `"scripts"` in `package.json`
  (`install` is the one exemption — it is built into pnpm)
- for `bash <path>`, `<path>` must be an existing file

Print each command checked and whether it resolved; fail with exit 1 listing any
that did not. This is what stops the README drifting from the repo.

**Gate**: `bash verify.sh` exits 0.

---

## §A10 — close the phase: STATUS.md + ROADMAP.md

Last task of Phase A. Run `bash verify.sh` first — it must be green before you
write anything here.

**STATUS.md** — append a `## Phase A — the refusal path` section (append only;
never rewrite what is above it). Cover, in a short paragraph each:

- what shipped: the dual-engine adapter, the migrator, `0001_tenancy_core.sql`,
  the nine-assertion refusal proof, the catalog coverage check, the scrubber,
  CI, README, `verify.sh`
- what is proven: cross-tenant SELECT / INSERT / UPDATE / DELETE all refuse on
  PGlite, and an unprotected tenant-scoped table now fails the build
- what is **not** yet proven locally: the real-Postgres run. The dev box has no
  reachable Postgres, so CI's `postgres` job carries it — say so plainly
- what is next: the request seam (`withTenant`), users/memberships/invites

**ROADMAP.md** — edit rows (row edits are the one permitted exception to
append-only). Set row 1 (tenancy core) and row 2 (RLS + leak-test suite) to
`SHIPPED` / `A`. Leave rows 3–8 as they are — this phase did not build them.
Row 9 (packaging) stays partial: note that CI and `verify.sh` landed in A while
config, systemd unit and the quickstart hero remain.

**Gate**: `bash verify.sh` green, then commit both docs.
