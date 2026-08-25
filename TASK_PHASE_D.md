# Phase D — audited operator access

SPEC.md feature 5: *"Operator identity is distinct from tenant users. Support
access to a tenant is granted with a required reason and a TTL; every operator
action lands in an append-only audit table; a tenant can read its own audit
trail (RLS-scoped)."* It pays the Phase C reservation that left `withOperator()`
a bare privileged connection.

**Already committed by the planning lane** (do not rebuild, do not edit):

- **§D1 `sql/0004_operator.sql`** — `operators`, `support_grants`, `audit_log`,
  the append-only trigger and the operator doors.
- **§D2 `src/db/operator.ts`**, the `withOperator(engine, ctx, fn)` overload in
  `src/db/seam.ts`, and three new helpers in `test/helpers/db.ts`.

Every task below is a test file except the last. Grep your `## §D<n>` header,
read that section, build it. Nothing else.

---

## §D0 — facts every task in this phase needs

Read this once; no task should have to go looking.

**Helpers** live in `test/helpers/db.ts`: `freshEngine()`, `seedTenant()`,
`seedUser()`, `seedMembership()`, `seedOperator()`, `seedSupportGrant()`,
`asContext()`, `asOperator()`. Every `seed*` helper runs as the migrating role,
which bypasses RLS, so it can plant rows nobody else could.

- `seedOperator(engine, label)` → operator id.
- `seedSupportGrant(engine, tenantId, operatorId, reason, ttlMinutes)` → grant
  id. **`ttlMinutes` may be negative** — that is how you plant a grant that has
  already lapsed.

**The one thing that will bite you.** Two operator runners exist and they differ:

- `asOperator(engine, operatorId, fn)` **always rolls back**. Use it when you
  are asserting that something is *refused*.
- `withOperator(engine, { operatorId }, fn)` from `../src/db/seam.ts`
  **commits**. Use it whenever a later `it` has to *see* the audit row.

Rolling back an operator action and then asserting the trail contains it is the
one mistake this phase invites. Pick the runner by whether the row must survive.

**Column names.** Raw `engine.query` / `tx.query` returns `snake_case` keys —
`operator_id`, `created_at`, `revoked_at`, `expires_at`, `display_name`. Only
the functions in `src/db/operator.ts` hand back camelCase.

**Cleanup order in `afterAll`**: delete tenants first (audit rows and support
grants cascade away with them), then operators, then users, then
`engine.close()`. An operator with audit history cannot be deleted before its
tenant is — the foreign key has no `ON DELETE` clause on purpose.

**Mirror `test/rls-refusal.test.ts`** for file structure: `freshEngine()` in
`beforeAll`, fixtures, one assertion per `it`, cleanup in `afterAll`.

**Gate, every task**: `pnpm typecheck` + `pnpm test` +
`bash scripts/scrub-check.sh`.

---

## §D1 — sql/0004_operator.sql (committed — reference only)

The index to the rules the rest of the phase tests. Read the file for detail.

- `app_current_operator()` — reads `app.operator_id`, the fourth context
  setting. Unset means NULL means refused.
- `operators` — global, no `tenant_id`, no membership, no role. `SELECT` is
  granted to `app_user`, and the policy `operators_touched_tenant` shows a
  tenant an operator row only once that operator has an `audit_log` row against
  that tenant. No write grant of any kind.
- `support_grants` — `reason` is NOT NULL with a non-blank CHECK, `expires_at`
  is the TTL, `revoked_at` is a timestamp rather than a delete. `SELECT` only,
  scoped to the tenant it names.
- `audit_log` — `SELECT` only, scoped to the acting tenant. The trigger
  `audit_log_no_rewrite` refuses UPDATE and DELETE for everyone, including the
  table owner; the sole exception is the cascade from a tenant that is itself
  being deleted.
- Neither `support_grants` nor `audit_log` carries the 0003 suspension gate —
  deliberately. A tenant that has gone dark is the one that most needs to see
  who is in its account and why.

The error messages, which your `.rejects.toThrow()` calls will match:

| door | refuses when | message matches |
|---|---|---|
| any operator door | no `app.operator_id` published | `/operator context required/i` |
| any operator door | the published id names nobody | `/operator not found/i` |
| `grant_support_access` | reason is null or blank | `/requires a reason/i` |
| `grant_support_access` | ttl is zero or negative | `/positive ttl/i` |
| `revoke_support_access` | already revoked | `/already revoked/i` |
| `log_operator_action`, `set_tenant_state` | no live grant | `/no active support grant/i` |
| `audit_log` UPDATE or DELETE | always | `/append-only/i` |

---

## §D2 — src/db/operator.ts + the seam overload (committed — reference only)

Six functions, all over a `Queryable`, none managing a transaction.

Operator doors — need `withOperator(engine, { operatorId }, …)`:

- `grantSupportAccess(tx, { tenantId, reason, ttlMinutes })` → grant id
- `revokeSupportAccess(tx, grantId)` → void
- `logOperatorAction(tx, tenantId, action, detail?)` → audit entry id

Tenant doors — need `asContext(engine, { tenantId, … }, …)`, and neither names
a tenant because RLS already did:

- `readAuditTrail(tx, limit?)` → `AuditEntry[]`, newest first, fields
  `id`, `operatorId`, `action`, `reason`, `detail`, `createdAt`
- `readSupportGrants(tx)` → `SupportGrant[]`, newest first, fields `id`,
  `operatorId`, `reason`, `grantedAt`, `expiresAt`, `revokedAt`

`withOperator` keeps its Phase C two-argument form. Given an
`{ operatorId }` context it also publishes `app.operator_id`, which is what
turns `set_tenant_state` into an audited action that demands a live grant.

---

## §D3 — test/operator-identity.test.ts

Create `test/operator-identity.test.ts`. It proves operator identity is a
separate population that a tenant can name only after being touched.

**Mirror `test/rls-refusal.test.ts`** for file structure.

Import `grantSupportAccess` from `../src/db/operator.ts`, `withOperator` from
`../src/db/seam.ts`, and `asContext`, `freshEngine`, `seedMembership`,
`seedOperator`, `seedTenant`, `seedUser` from `./helpers/db.ts`.

Fixtures in `beforeAll`: two tenants `acme` and `beta`; a user `ann` made
`acme`'s `'owner'` with `seedMembership`; one operator `opal`. Then, with
`withOperator` so it **commits**, have `opal` call `grantSupportAccess` on
`acme` with reason `'ticket 12'` and `ttlMinutes` 30. Nothing touches `beta`.

Assert, each in its own `it`:

1. `opal` holds no membership anywhere: `SELECT count(*) FROM memberships WHERE
   user_id = $1` through `engine.query` is 0. Wrap in `Number()`.
2. acting as `acme` (with `ann` and role `'owner'`), `SELECT display_name FROM
   operators` returns exactly one row.
3. acting as `beta` with no user or role, the same query returns zero rows —
   `beta` has never been touched, so the operator directory is invisible to it.
4. acting as `acme`, `INSERT INTO operators (email, display_name) VALUES
   ('x@example.com', 'x')` rejects — there is no write grant. Match
   `/denied|permission/i`.

In `afterAll`, delete the two tenants, then `opal` from `operators`, then `ann`
from `users`, then close.

---

## §D4 — test/support-grant.test.ts

Create `test/support-grant.test.ts`. It proves the reason and the TTL are real
constraints rather than fields.

**Mirror `test/rls-refusal.test.ts`** for file structure.

Import `grantSupportAccess`, `logOperatorAction`, `revokeSupportAccess` from
`../src/db/operator.ts`, and `asOperator`, `freshEngine`, `seedOperator`,
`seedSupportGrant`, `seedTenant` from `./helpers/db.ts`.

Fixtures in `beforeAll`: one tenant `acme`, one operator `opal`. Every `it`
below uses `asOperator`, which rolls back, so no `it` depends on another.

Assert, each in its own `it` — use `await expect(...).rejects.toThrow(...)`:

1. with **no** operator published — plain `engine.transaction((tx) => …)` —
   `grantSupportAccess` rejects with `/operator context required/i`.
2. as `opal`, a reason of `'   '` rejects with `/requires a reason/i`.
3. as `opal`, `ttlMinutes: 0` rejects with `/positive ttl/i`.
4. as `opal`, reason `'ticket 12'` and `ttlMinutes: 30` resolves to a string.
5. plant a lapsed grant with `seedSupportGrant(engine, acme, opal, 'old', -60)`,
   then as `opal` `logOperatorAction(tx, acme, 'project.read')` rejects with
   `/no active support grant/i`.
6. plant a live grant (`ttlMinutes: 60`); as `opal`, calling
   `revokeSupportAccess` on it and then `logOperatorAction` in the **same**
   `asOperator` block makes the second call reject with the same message.

In `afterAll`, delete the tenant, then the operator, then close.

---

## §D5 — test/audit-append-only.test.ts

Create `test/audit-append-only.test.ts`. It proves the audit table cannot be
rewritten — the property that makes the trail worth reading.

**Mirror `test/rls-refusal.test.ts`** for file structure.

Import `grantSupportAccess` from `../src/db/operator.ts`, `withOperator` from
`../src/db/seam.ts`, and `asContext`, `freshEngine`, `seedMembership`,
`seedOperator`, `seedTenant`, `seedUser` from `./helpers/db.ts`.

Fixtures in `beforeAll`: tenant `acme`, user `ann` as its `'owner'`, operator
`opal`. With `withOperator` so it **commits**, have `opal` grant support access
on `acme` (reason `'ticket 12'`, 30 minutes) — that alone writes one
`support.grant` row into `audit_log`.

Assert, each in its own `it`:

1. `SELECT count(*) FROM audit_log` through `engine.query` is at least 1. Wrap
   in `Number()`. This is what makes the next two assertions mean anything — a
   row-level trigger never fires on an empty table.
2. `engine.query("UPDATE audit_log SET action = 'tampered'")` rejects with
   `/append-only/i`. `engine.query` runs as the migrating role, which owns the
   table, so this is the strong version of the claim.
3. `engine.query('DELETE FROM audit_log')` rejects with `/append-only/i`.
4. acting as `acme` (with `ann` and role `'owner'`), an
   `INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'forged')` rejects —
   `app_user` has no write grant. Match `/denied|permission/i`.
5. `DELETE FROM tenants WHERE id = $1` for a throwaway tenant built inline with
   `seedTenant` still resolves: the cascade is the one permitted delete.

In `afterAll`, delete `acme`, then `opal`, then `ann`, then close.

---

## §D6 — test/audit-trail.test.ts

Create `test/audit-trail.test.ts`. It proves the tenant half of feature 5: a
tenant reads its own trail, only its own, and still reads it while suspended.

**Mirror `test/rls-refusal.test.ts`** for file structure.

Import `grantSupportAccess`, `logOperatorAction`, `readAuditTrail` from
`../src/db/operator.ts`, `setTenantState` from `../src/db/lifecycle.ts`,
`withOperator` from `../src/db/seam.ts`, and `asContext`, `freshEngine`,
`seedMembership`, `seedOperator`, `seedTenant`, `seedUser` from
`./helpers/db.ts`.

Fixtures in `beforeAll`: tenants `acme` and `beta`; `ann` as `acme`'s `'owner'`;
operator `opal`. In one **committing** `withOperator` block, have `opal` grant
support access on `acme` (reason `'ticket 12'`, 30 minutes) and then
`logOperatorAction(tx, acme, 'project.read', { count: 1 })`. That leaves `acme`
with exactly two audit rows and `beta` with none.

Let `readAcme` be `asContext(engine, { tenantId: acme, userId: ann, role:
'owner' }, readAuditTrail)`.

Assert, each in its own `it`:

1. `readAcme` returns 2 entries, and their `action` values sorted are
   `['project.read', 'support.grant']`.
2. every entry has `reason` `'ticket 12'` — the action inherits the
   justification its access was granted under.
3. the newest entry is first: `entries[0].action` is `'project.read'`.
4. acting as `beta` with no user or role, `readAuditTrail` returns an empty
   array.
5. suspend `acme` with `engine.transaction((tx) => setTenantState(tx, acme,
   'suspended'))`, then `readAcme` **still** returns 2 entries. Resume it in the
   same `it` so nothing later is affected.

In `afterAll`, delete both tenants, then `opal`, then `ann`, then close.

---

## §D7 — test/operator-layer.test.ts

Create `test/operator-layer.test.ts`. It proves the typed layer returns the
camelCase shapes the console and the ops surface will read, and that a grant
survives its own revocation as history.

**Mirror `test/rls-refusal.test.ts`** for file structure.

Import `grantSupportAccess`, `readSupportGrants`, `revokeSupportAccess` from
`../src/db/operator.ts`, `withOperator` from `../src/db/seam.ts`, and
`asContext`, `freshEngine`, `seedMembership`, `seedOperator`, `seedTenant`,
`seedUser` from `./helpers/db.ts`.

Fixtures in `beforeAll`: tenant `acme`, `ann` as its `'owner'`, operator `opal`.
In one **committing** `withOperator` block, `opal` grants support access on
`acme` (reason `'ticket 12'`, 30 minutes); keep the returned grant id.

Let `readGrants` be `asContext(engine, { tenantId: acme, userId: ann, role:
'owner' }, readSupportGrants)`.

Assert, each in its own `it`:

1. `readGrants` returns one grant whose `reason` is `'ticket 12'`, whose
   `operatorId` equals `opal`, and whose `revokedAt` is `null`.
2. that grant's `expiresAt` is later than its `grantedAt` — compare with
   `.getTime()`; both come back as `Date`.
3. in a **committing** `withOperator` block, `revokeSupportAccess(tx, grantId)`
   resolves; afterwards `readGrants` still returns one grant, now with a
   non-null `revokedAt`. Revocation is history, not an absence.
4. a second `revokeSupportAccess` on the same id, in an `asOperator` block,
   rejects with `/already revoked/i`.

In `afterAll`, delete the tenant, then `opal`, then `ann`, then close.

---

## §D8 — close the phase: README + STATUS.md + ROADMAP.md

Last task of Phase D. Run `bash verify.sh` first — it must be green before you
write anything here. **Add no new commands to the README**: the quickstart lint
fails on any `pnpm <name>` that is not a `package.json` script.

**README.md** — append one section, `## Audited operator access`, about eight
lines: operator identity is a separate population with no membership and no
role, published as a fourth context setting `app.operator_id` by
`withOperator()`; support access to a tenant needs a non-blank reason and a
positive TTL, and revocation is a timestamp rather than a delete; every operator
action lands in `audit_log`, which a `BEFORE UPDATE OR DELETE` trigger makes
append-only even for the table owner; a tenant reads its own trail under RLS,
including while suspended. Point at `sql/0004_operator.sql` and
`test/audit-append-only.test.ts`.

**STATUS.md** — append a `## Phase D — audited operator access` section (append
only; never rewrite what is above it). One short paragraph each:

- what shipped: `sql/0004_operator.sql`, `src/db/operator.ts`, the
  `withOperator(ctx)` overload in `src/db/seam.ts`, three new test helpers, and
  the five new test files
- what is proven: an operator is not a tenant user and is invisible to a tenant
  it has never touched, support access refuses a blank reason and a
  non-positive TTL, an expired or revoked grant cannot record an action, the
  audit log refuses UPDATE and DELETE even from its owner, and a tenant reads
  its own trail and only its own — suspended or not
- what is next: SPEC.md feature 6, the tenant-scoped `projects` CRUD surface,
  and then feature 3's remaining half — session-token resolution as a Fastify
  plugin

**ROADMAP.md** — edit rows (the one permitted exception to append-only):

- row 5 (Audited operator access) — status `SHIPPED`, phase `D`. Note: operator
  identity, reason-and-TTL support grants and an append-only audit table a
  tenant can read for itself.

Then append one entry to the reservations ledger at the bottom:

- **The operator lane is opt-in at the SQL layer (Phase D).** Publishing
  `app.operator_id` is what makes `set_tenant_state` demand a live support
  grant and write an audit row; with no operator published the door behaves
  exactly as Phase C shipped it, which is what a migration and a test fixture
  are. Making an operator identity mandatory belongs to the phase that puts an
  authenticated operator API in front of these functions. Home:
  `sql/0004_operator.sql`.

**Gate**: `bash verify.sh` green, then commit the three docs.
