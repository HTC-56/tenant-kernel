# Phase B — the context seam

SPEC.md feature 3: *"One `withTenant()` wrapper runs every request in a
transaction with `SET LOCAL` of the context settings; no query path exists
outside the seam (a test enforces that the seam is the only door)."* Plus the
rest of feature 1 — users, memberships, invites, entitlement flags.

**Already committed by the planning lane** (do not rebuild, do not edit):

- **§B1 `sql/0002_identity.sql`** — `users` (global, no tenant_id),
  `memberships`, `invites`, `entitlements`, plus `app_current_user()`,
  `app_current_role()` and `app_is_admin()`. Reads are tenant-scoped; writes to
  memberships and invites additionally require `app_is_admin()`. `tenant_id`
  DEFAULTs to `app_current_tenant()`. `entitlements` is read-only to tenants
  and a trigger creates its row with every tenant.
- **§B2 `src/db/seam.ts`** — `withTenant(engine, ctx, fn)`, `applyContext`,
  `normalizeContext`, `TENANT_ROLES`. `test/helpers/db.ts` now publishes context
  through the seam and gained `asContext()`, `seedUser()`, `seedMembership()`.

The tasks below prove all of that and add the thin typed data layer.

Grep your `## §B<n>` header, read that section, build it. Nothing else.

---

## §B3 — test/identity-rls.test.ts

Create `test/identity-rls.test.ts`. It is to the identity tables what
`test/rls-refusal.test.ts` is to `projects`. **Mirror that file**: same imports
from `./helpers/db.ts`, `freshEngine()` in `beforeAll`, fixture cleanup then
`engine.close()` in `afterAll`.

Fixtures in `beforeAll`, using the helpers (they run as the migrating role, which
bypasses RLS, so they can plant rows a tenant never could):

- two tenants via `seedTenant` — call them alice and bob
- two users via `seedUser` — ann and bill
- `seedMembership(engine, alice, ann, 'owner')` and
  `seedMembership(engine, bob, bill, 'owner')`

Run every acting-as block through `asContext(engine, ctx, fn)`, where `ctx` is
`{ tenantId, userId, role }`. It rolls back, so nothing you write persists.

Assert, each in its own `it`:

1. acting as alice with role `'member'`, `SELECT id FROM users` returns exactly
   `[ann]` — bill exists but is invisible without a shared membership.
2. acting as alice, `SELECT tenant_id FROM memberships` returns one row and it
   is alice's.
3. with role `'member'`, `INSERT INTO memberships (user_id, role)` rejects with
   `/row-level security/i`; with role `'admin'` the same insert succeeds and the
   `RETURNING tenant_id` equals alice — proving the column default filled it.
4. with role `'owner'`, an insert that names bob's id explicitly in `tenant_id`
   still rejects with `/row-level security/i`.
5. acting as alice, `SELECT seat_cap FROM entitlements` returns exactly one row
   with `seat_cap` 5 (the trigger made it), and an `UPDATE entitlements SET
   seat_cap = 999` from inside the tenant rejects — there is no write grant.
6. with role `'member'`, `INSERT INTO invites (email, role, token, expires_at)`
   rejects with `/row-level security/i`; with role `'owner'` it succeeds.
   Use a lowercase email — a CHECK constraint refuses anything else.

In `afterAll`, delete the two tenants by id (memberships, invites and
entitlements cascade) and then the two users, then close the engine.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §B4 — test/rls-grants.test.ts

Create `test/rls-grants.test.ts`. `test/rls-coverage.test.ts` discovers tables by
their `tenant_id` column, so a global table like `users` slips past it. This file
closes that hole with a second rule: **every table `app_user` was granted any
privilege on must be protected.**

**Mirror `test/rls-coverage.test.ts`** for structure — same imports,
`freshEngine()` in `beforeAll`, `engine.close()` in `afterAll`, catalog reads
only, no fixtures.

Discovery query: `SELECT DISTINCT table_name FROM
information_schema.role_table_grants WHERE grantee = 'app_user' AND table_schema
= 'public'`. Then read `relrowsecurity` / `relforcerowsecurity` from `pg_class`
joined to `pg_namespace` for those names, and policies from `pg_policies`
(`schemaname = 'public'`).

Assert:

1. the granted list contains all six of `tenants`, `projects`, `users`,
   `memberships`, `invites`, `entitlements` — this proves the query works before
   anything else trusts it.
2. every granted table has `relrowsecurity` true.
3. every granted table has `relforcerowsecurity` true.
4. every granted table has at least one policy.
5. `schema_migrations` is **not** in the granted list — migration bookkeeping is
   never exposed to the application role.

Put the table name in every assertion message so a failure names the offender.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §B5 — test/seam.test.ts

Create `test/seam.test.ts`. §B3 proves what the database refuses; this proves the
wrapper around it. Import `withTenant` from `../src/db/seam.ts` and
`freshEngine` / `seedTenant` / `seedUser` from `./helpers/db.ts`. Structure
mirrors `test/rls-refusal.test.ts`.

Fixtures: one tenant and one user. Note that `withTenant` **commits** — unlike
the `as*` helpers — so clean up in `afterAll` by deleting the tenant (projects
cascade) and the user.

Assert, each in its own `it`:

1. **commits on return** — inside `withTenant`, `INSERT INTO projects
   (tenant_id, name) ... RETURNING id`, then read that id back with plain
   `engine.query` afterwards and find exactly one row.
2. **rolls back on throw** — inside `withTenant`, insert a project named
   `'doomed'` and then `throw new Error('boom')`. Expect the call to reject with
   `'boom'`, then `engine.query` for that name and find nothing.
3. **publishes all three settings** — inside `withTenant` with a tenantId, a
   userId and role `'owner'`, select
   `current_setting('app.tenant_id', true)`, `current_setting('app.user_id',
   true)` and `current_setting('app.role', true)` (alias each column) and expect
   the three values you passed in.
4. **drops privileges** — in the same kind of block, `SELECT current_user AS
   role_name` returns `'app_user'`.
5. **validates before opening a transaction** — `withTenant` with
   `{ tenantId: 'not-a-uuid' }` rejects with `/not a uuid/i`, and with a role of
   `'wizard'` (cast through `as never` to satisfy the type) rejects with
   `/role must be/i`.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §B6 — src/db/identity.ts and its test

Create `src/db/identity.ts`, the thin typed data layer SPEC.md asks for in place
of an ORM, plus `test/identity-layer.test.ts`.

Every function takes the `Queryable` the seam handed it — **never an `Engine`**,
never a tenant id. The tenant comes from the transaction's own context: RLS
filters the reads, and `tenant_id` DEFAULTs to `app_current_tenant()` on the
writes. Import `type { Queryable }` from `./engine.ts` and `type { TenantRole }`
from `./seam.ts`.

Export exactly these four functions and the two row types they return:

- `listMembers(tx): Promise<Member[]>` — `memberships` joined to `users` on
  `user_id`, ordered by email. `Member` is `{ id, userId, email, displayName,
  role }`.
- `addMember(tx, userId: string, role: TenantRole): Promise<string>` — insert
  naming only `user_id` and `role`, `RETURNING id`.
- `listPendingInvites(tx): Promise<Invite[]>` — invites with `state = 'pending'`,
  ordered by email. `Invite` is `{ id, email, role, expiresAt }`.
- `createInvite(tx, email, role, token, expiresAt: Date): Promise<string>` —
  insert naming only those four columns, `RETURNING id`. A `Date` binds fine on
  both engines.

Postgres returns `snake_case`; map it to the `camelCase` field names above
inside each function. Keep the SQL parameterised with `$1`, `$2`, … — the
pattern is every query in `test/helpers/db.ts`.

`test/identity-layer.test.ts` — mirror `test/rls-refusal.test.ts` for structure.
Fixtures: two tenants, two users, each user an `'owner'` of one tenant. Assert:

1. inside one `asContext(engine, { tenantId: alice, userId: ann, role: 'owner' },
   ...)` block, `addMember` returns an id and a following `listMembers` on the
   same `tx` shows both people, ordered by email.
2. `listMembers` acting as alice never contains bill's email.
3. `createInvite` as `'owner'` returns an id and `listPendingInvites` on the same
   `tx` shows that email; as `'member'` `createInvite` rejects with
   `/row-level security/i`.
4. two `createInvite` calls for the same lowercase email in one block reject with
   `/duplicate key|unique/i` — one live invite per address per tenant is an
   index, not a UI rule.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §B7 — test/seam-only.test.ts

Create `test/seam-only.test.ts`. SPEC.md feature 3 requires a test that *"the
seam is the only door"*. This one reads source text, not a database, so it needs
no engine and no `beforeAll`.

Resolve the source directory the way `src/db/migrate.ts` resolves
`MIGRATIONS_DIR` — `fileURLToPath(new URL('../src/', import.meta.url))` — then
collect every `.ts` file under it with `readdir(dir, { recursive: true })` from
`node:fs/promises` and read each one. Keep each file's repo-relative path
(`src/…`) so failures name the offender.

Assert:

1. the scan finds at least four `.ts` files and one of them is `src/db/seam.ts` —
   a scan that finds nothing must not pass.
2. `openEngine(` appears only in `src/db/engine.ts`.
3. `.transaction(` appears only in `src/db/engine.ts`, `src/db/migrate.ts` and
   `src/db/seam.ts`.
4. `SET LOCAL ROLE` appears only in `src/db/seam.ts`.
5. `set_config('app.` appears only in `src/db/seam.ts`.

Write each rule as an allowlist: build the list of files containing the string,
and expect it to equal the allowed list. This test file itself contains all of
those strings, which is fine — it lives in `test/`, and the scan only walks
`src/`.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §B8 — close the phase: README + STATUS.md + ROADMAP.md

Last task of Phase B. Run `bash verify.sh` first — it must be green before you
write anything here. **Add no new commands to the README**: the quickstart lint
fails on any `pnpm <name>` that is not a `package.json` script.

**README.md** — append one short section, `## Identity and roles`, about six
lines: users are global and become visible to a tenant only through a
membership; membership and invite writes require `app.role` of `owner` or
`admin`; entitlements are read-only to tenants. Point at
`sql/0002_identity.sql` and `test/identity-rls.test.ts`.

**STATUS.md** — append a `## Phase B — the context seam` section (append only;
never rewrite what is above it). One short paragraph each:

- what shipped: `0002_identity.sql`, `src/db/seam.ts`, `src/db/identity.ts`, and
  the four new test files
- what is proven: the seam commits, rolls back, drops to `app_user` and
  publishes all three settings; a tenant sees only its own people; membership
  and invite writes need an admin role; a table granted to `app_user` without
  RLS now fails the build
- what is next: tenant lifecycle (provision, invite/accept, role change,
  suspend/resume) and seat-cap enforcement

**ROADMAP.md** — edit rows (the one permitted exception to append-only). The
planning lane already set rows 3 and 4 to `PARTIAL` / `B` when it committed §B1
and §B2. Your job is to make their notes true of the finished phase:

- row 2 — extend the note: the grants-based coverage check
  (`test/rls-grants.test.ts`) landed in B
- row 3 (context seam) — note that `withTenant` and `test/seam-only.test.ts`
  are proven, and that session-token → user → active-tenant resolution and the
  Fastify plugin still remain
- row 4 (lifecycle + entitlements) — note that role-gated policies are proven by
  `test/identity-rls.test.ts`, and that lifecycle operations still remain

Then append one entry to the reservations ledger at the bottom: **seat-cap
enforcement deferred (Phase B).** The `entitlements.seat_cap` column ships with
no trigger enforcing it, because the operator write path that would set it does
not exist yet; the lifecycle phase enforces it. Home: `TASK_PHASE_B.md` §B1.

**Gate**: `bash verify.sh` green, then commit the three docs.
