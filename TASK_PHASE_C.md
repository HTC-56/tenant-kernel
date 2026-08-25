# Phase C — tenant lifecycle and entitlements

SPEC.md feature 4: *"Provision, invite/accept, role change, suspend/resume.
Entitlement flags (seat cap, feature toggles) enforced at the data layer —
constraints and policies, not UI checks."* It also pays the seat-cap
reservation Phase B recorded.

**Already committed by the planning lane** (do not rebuild, do not edit):

- **§C1 `sql/0003_lifecycle.sql`** — the rules. All of them.
- **§C2 `src/db/lifecycle.ts` + `withOperator()` in `src/db/seam.ts`** — the
  typed doors over those rules.

Every task below is a test file except the last. Grep your `## §C<n>` header,
read that section, build it. Nothing else.

Facts every task in this phase needs, so no task has to go looking:

- Helpers live in `test/helpers/db.ts`: `freshEngine()`, `seedTenant()`,
  `seedUser()`, `seedMembership()`, `asContext()`. The `seed*` helpers run as
  the migrating role, which bypasses RLS, so they can plant rows a tenant never
  could. `asContext(engine, ctx, fn)` publishes `{ tenantId, userId, role }` and
  always rolls back.
- **Mirror `test/rls-refusal.test.ts`** for file structure: `freshEngine()` in
  `beforeAll`, fixtures, then `engine.close()` in `afterAll`.
- In `afterAll`, delete tenants **before** users — memberships cascade from the
  tenant, and a membership row outliving its tenant is what trips the
  last-owner trigger.
- `count()` and `seat_cap` come back as a string on one engine and a number on
  the other. Wrap comparisons in `Number()`.

---

## §C1 — sql/0003_lifecycle.sql (committed — reference only)

The rules the rest of the phase tests. Read the file itself for detail; this is
the index.

- `app_tenant_active()` — is the acting tenant `state = 'active'`? No tenant
  published means false.
- `app_feature_enabled(flag)` — default-ON. A flag counts as disabled only when
  the tenant's `entitlements.features` holds exactly jsonb `false` for it.
- RESTRICTIVE policies on `projects`, `memberships`, `invites` and
  `entitlements` keyed to `app_tenant_active()`. Restrictive policies AND with
  the permissive ones from 0001/0002, so a suspended tenant goes dark on all
  four. `tenants` deliberately has none — a suspended tenant can still read its
  own row and see why. `users` needs none either: its 0002 policy is an EXISTS
  over `memberships`, which is dark, so the people vanish with the rest.
- A RESTRICTIVE `FOR INSERT` policy on `projects` keyed to
  `app_feature_enabled('projects')` — an entitlement that is switched off stops
  new work without hiding old work.
- `enforce_seat_cap()` on `AFTER INSERT ON memberships` — raises
  `seat cap reached: ...` when the row count passes `entitlements.seat_cap`.
- `enforce_last_owner()` on `AFTER UPDATE OR DELETE ON memberships`, `WHEN
  (OLD.role = 'owner')` — raises `last owner: ...`. It steps aside when the
  tenant row is already gone, which is what lets `DELETE FROM tenants` cascade.
- `provision_tenant()`, `set_tenant_state()`, `accept_invite()` — SECURITY
  DEFINER, because each acts on a tenant the caller is not scoped to. Every
  SECURITY DEFINER function in the schema has EXECUTE revoked from PUBLIC;
  only `accept_invite` is granted back, to `app_user`.
- `projects.tenant_id` gains `DEFAULT app_current_tenant()`, matching the
  identity tables.

---

## §C2 — src/db/lifecycle.ts + withOperator (committed — reference only)

`withOperator(engine, fn)` in `src/db/seam.ts` is the privileged door: one
transaction, no tenant context, no drop to `app_user`. It **commits**.

`src/db/lifecycle.ts` holds no rules, only doors over a `Queryable`:

- `provisionTenant(tx, { slug, name, ownerEmail, ownerName })` → tenant id.
  Operator door.
- `setTenantState(tx, tenantId, 'active' | 'suspended')`. Operator door.
- `acceptInvite(tx, token, userId)` → the tenant joined. Callable from a
  tenant-scoped transaction.
- `changeRole(tx, userId, role)` → boolean. Tenant door.
- `removeMember(tx, userId)` → boolean. Tenant door.
- `seatUsage(tx)` → `{ used, cap }`. Tenant door.

---

## §C3 — test/seat-cap.test.ts

Create `test/seat-cap.test.ts`. It proves the seat cap Phase B deferred.

**Mirror `test/rls-refusal.test.ts`** for file structure. Import `seatUsage`
from `../src/db/lifecycle.ts` and `asContext`, `freshEngine`, `seedMembership`,
`seedTenant`, `seedUser` from `./helpers/db.ts`.

Fixtures in `beforeAll`: one tenant; one user made its `'owner'` with
`seedMembership`; and five more users kept in an array (call them fillers).

Assert, each in its own `it`:

1. the tenant's `entitlements` row has `seat_cap` 5 — read it with plain
   `engine.query`. The trigger from 0002 created that row.
2. four `seedMembership` calls for the first four fillers all resolve: the owner
   plus four is exactly five seats.
3. a fifth `seedMembership`, for the last filler, rejects with `/seat cap/i`.
   Run this after 2 — the `it` order in the file is the order they run in.
4. after `UPDATE entitlements SET seat_cap = 6` through `engine.query`, that
   same `seedMembership` call resolves.
5. inside `asContext(engine, { tenantId, userId: owner, role: 'owner' },
   seatUsage)`, the result is `{ used: 6, cap: 6 }`.

In `afterAll`, delete the tenant, then all six users, then close the engine.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C4 — test/last-owner.test.ts

Create `test/last-owner.test.ts`. It proves that a tenant cannot be left without
an owner, and that the rule still lets a tenant be deleted.

**Mirror `test/rls-refusal.test.ts`** for file structure. Import `changeRole`,
`removeMember` from `../src/db/lifecycle.ts` and `asContext`, `freshEngine`,
`seedMembership`, `seedTenant`, `seedUser` from `./helpers/db.ts`.

Fixtures in `beforeAll` — two tenants, so no `it` depends on another:

- `acme` with exactly one member, `ann`, role `'owner'`
- `beta` with two members, `cara` and `dan`, both `'owner'`

Every acting-as block is `asContext(engine, { tenantId, userId, role: 'owner' },
…)`, which rolls back, so nothing an `it` changes survives it.

Assert, each in its own `it`:

1. acting as acme, `changeRole(tx, ann, 'member')` rejects with `/last owner/i`.
2. acting as acme, `removeMember(tx, ann)` rejects with `/last owner/i`.
3. acting as beta, `changeRole(tx, cara, 'member')` resolves to `true` — dan is
   still an owner.
4. acting as acme, `removeMember(tx, dan)` resolves to `false`. Dan belongs to
   beta, so RLS hides him, and an invisible member is indistinguishable from a
   missing one.
5. a throwaway tenant whose only member is an owner — build it inline with
   `seedTenant`, `seedUser`, `seedMembership` — still deletes: `DELETE FROM
   tenants WHERE id = $1` through `engine.query` resolves.

In `afterAll`, delete acme and beta, then ann, cara and dan, then close.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C5 — test/suspension.test.ts

Create `test/suspension.test.ts`. A suspended tenant loses its data at the
database layer, not through an application check.

**Mirror `test/rls-refusal.test.ts`** for file structure. Import `withOperator`
from `../src/db/seam.ts`, `setTenantState` from `../src/db/lifecycle.ts`, and
`asContext`, `freshEngine`, `seedMembership`, `seedTenant`, `seedUser` from
`./helpers/db.ts`.

Fixtures in `beforeAll`: one tenant, one user as its `'owner'`, and one row
inserted into `projects` with plain `engine.query`.

State changes go through `withOperator(engine, (tx) => setTenantState(tx, …))`
— never `asContext`, which drops to `app_user` and rolls back. `withOperator`
commits, so an `it` that suspends must resume before it ends.

Assert, each in its own `it`:

1. while active, acting as the tenant, `SELECT id FROM projects` returns one
   row.
2. once suspended, acting as the tenant, each of `projects`, `memberships`,
   `invites`, `entitlements` and `users` returns an empty array. Resume at the
   end of the `it`.
3. once suspended, `SELECT state FROM tenants` still returns exactly one row and
   its `state` is `'suspended'`. Resume at the end of the `it`.
4. once suspended, `INSERT INTO projects (name) VALUES ($1)` rejects with
   `/row-level security/i` — note that no `tenant_id` is named, because the
   column defaults to the acting tenant. Resume at the end of the `it`.
5. after resuming, `SELECT id FROM projects` returns that one row again.
6. `setTenantState(tx, tenantId, 'wizard' as never)` inside `withOperator`
   rejects with `/unknown tenant state/i`.

In `afterAll`, delete the tenant, then the user, then close.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C6 — test/feature-flags.test.ts

Create `test/feature-flags.test.ts`. Feature toggles are default-ON and live in
`entitlements.features`; only an explicit jsonb `false` switches one off.

**Mirror `test/rls-refusal.test.ts`** for file structure. Import `asContext`,
`freshEngine`, `seedMembership`, `seedTenant`, `seedUser` from
`./helpers/db.ts`. No lifecycle import is needed.

Fixtures in `beforeAll`: one tenant, one user as its `'owner'`, one row in
`projects` inserted with plain `engine.query`.

Each `it` sets the flag it needs first, with `engine.query`, so no `it` depends
on another's ordering. The two settings you need are
`UPDATE entitlements SET features = '{}'::jsonb WHERE tenant_id = $1` and the
same with `'{"projects": false}'::jsonb`.

Assert, each in its own `it`:

1. with `features` empty, acting as the tenant,
   `SELECT app_feature_enabled('projects') AS enabled` is `true`, and
   `INSERT INTO projects (name) VALUES ($1)` resolves. (`asContext` rolls back,
   so the row does not survive.)
2. with the flag set to `false`, `app_feature_enabled('projects')` is `false`.
3. with the flag set to `false`, that same insert rejects with
   `/row-level security/i`.
4. with the flag set to `false`, `SELECT id FROM projects` still returns the
   fixture row — the gate stops new work, it does not hide old work.
5. with the flag set to `false`, `app_feature_enabled('something-else')` is
   still `true`. Flags are default-on.

In `afterAll`, delete the tenant, then the user, then close.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C7 — test/lifecycle-layer.test.ts

Create `test/lifecycle-layer.test.ts`. It drives `src/db/lifecycle.ts`
end to end: provision a tenant, then redeem an invite into it.

**Mirror `test/rls-refusal.test.ts`** for file structure. Import `withOperator`,
`withTenant` from `../src/db/seam.ts`, `acceptInvite`, `provisionTenant` from
`../src/db/lifecycle.ts`, and `freshEngine`, `seedMembership`, `seedTenant`,
`seedUser` from `./helpers/db.ts`.

**Both seams commit.** Keep every id you create in module-level variables and
clean all of them up. Fixtures in `beforeAll`: one tenant with one `'owner'`,
used only as the acting context for the accept calls, plus one more user who
will be the joiner.

Assert, each in its own `it`:

1. `provisionTenant` inside `withOperator`, with a slug of your choosing and an
   `ownerEmail` in the `example.com` domain, resolves to an id. Reading back
   with plain `engine.query`, that tenant has exactly one membership, its role
   is `'owner'`, and joining `users` gives the lowercased owner email.
2. the provisioned tenant also has an `entitlements` row with `seat_cap` 5 —
   the 0002 trigger fires for tenants made this way too.
3. plant a pending invite into the provisioned tenant with plain `engine.query`
   (name `tenant_id`, `email`, `role`, `token`, and an `expires_at` of
   `now() + interval '7 days'`). `acceptInvite(tx, token, joiner)` inside
   `withTenant` scoped to the **fixture** tenant resolves to the provisioned
   tenant's id — the invitee needs no membership there. Then the invite's
   `state` reads `'accepted'` and the joiner has a membership in it.
4. redeeming that same token again rejects with `/already accepted/i`, and an
   unknown token rejects with `/invite not found/i`.
5. an invite planted with `expires_at` of `now() - interval '1 day'` rejects
   with `/invite expired/i`.

In `afterAll`, delete the fixture tenant and the provisioned tenant by id, then
the fixture users by id, then the provisioned owner with
`DELETE FROM users WHERE email = $1` — that user was created by the function, so
the test never held its id. Then close.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C8 — test/function-grants.test.ts

Create `test/function-grants.test.ts`. `test/rls-grants.test.ts` proves no table
is exposed without RLS; this proves no SECURITY DEFINER function is exposed at
all. Postgres grants EXECUTE on every new function to PUBLIC, which on a
SECURITY DEFINER function is a privilege escalation, so 0003 revokes it.

**Mirror `test/rls-grants.test.ts`**: same imports, `freshEngine()` in
`beforeAll`, `engine.close()` in `afterAll`, catalog reads only, no fixtures.

One query does the discovery. Select from `pg_proc p` joined to `pg_namespace n`
on `n.oid = p.pronamespace`, filtered to `n.nspname = 'public' AND p.prosecdef`.
Take three columns: `p.oid::regprocedure::text` as the signature, and
`has_function_privilege('public', p.oid, 'EXECUTE')` and
`has_function_privilege('app_user', p.oid, 'EXECUTE')` as two booleans.
`'public'` there is the pseudo-role, which is exactly the grantee being tested.

Assert:

1. the discovered signatures include all six of `accept_invite`,
   `provision_tenant`, `set_tenant_state`, `tenant_default_entitlements`,
   `enforce_seat_cap` and `enforce_last_owner` — match on the signature's
   leading name, since each signature carries its argument types. This proves
   the query works before anything else trusts it.
2. every discovered function has the PUBLIC boolean `false`.
3. `accept_invite` has the `app_user` boolean `true` — the one door a tenant
   request may open for itself.
4. `provision_tenant` and `set_tenant_state` both have the `app_user` boolean
   `false`. Provisioning and suspending are operator work.

Put the signature in every assertion message so a failure names the offender.

**Gate**: `pnpm typecheck` + `pnpm test` + `bash scripts/scrub-check.sh`.

---

## §C9 — close the phase: README + STATUS.md + ROADMAP.md

Last task of Phase C. Run `bash verify.sh` first — it must be green before you
write anything here. **Add no new commands to the README**: the quickstart lint
fails on any `pnpm <name>` that is not a `package.json` script.

**README.md** — append one section, `## Tenant lifecycle`, about eight lines:
provisioning, suspend/resume and invite acceptance are SECURITY DEFINER
functions because each acts on a tenant the caller is not scoped to, and only
`accept_invite` is reachable by `app_user`; a suspended tenant goes dark on
every tenant-scoped table while its own `tenants` row stays readable; the seat
cap and the "at least one owner" rule are triggers; feature toggles are
default-on and enforced by a policy. Point at `sql/0003_lifecycle.sql` and
`test/suspension.test.ts`.

**STATUS.md** — append a `## Phase C — tenant lifecycle` section (append only;
never rewrite what is above it). One short paragraph each:

- what shipped: `sql/0003_lifecycle.sql`, `src/db/lifecycle.ts`,
  `withOperator()` in `src/db/seam.ts`, and the six new test files
- what is proven: the seat cap refuses the seat past the cap, a tenant cannot
  be left without an owner, a suspended tenant sees none of its own data but
  still sees why, a switched-off feature stops new writes without hiding old
  rows, and no SECURITY DEFINER function is executable by PUBLIC
- what is next: SPEC.md feature 5, audited operator access — operator identity,
  time-boxed support grants with a required reason, and the append-only audit
  table a tenant can read for itself

**ROADMAP.md** — edit rows (the one permitted exception to append-only):

- row 3 (context seam) — extend the note: `withOperator()` landed in C as the
  privileged door; session-token → user → active-tenant resolution and the
  Fastify plugin still remain.
- row 4 (lifecycle + entitlements) — status `SHIPPED`, phase `B, C`. Note:
  provision, invite/accept, role change and suspend/resume ship in C; seat cap,
  last-owner and feature toggles are enforced by triggers and policies.

Then append two entries to the reservations ledger at the bottom:

- **Operator doors are privileged-connection-only (Phase C).**
  `provision_tenant` and `set_tenant_state` have EXECUTE revoked from PUBLIC
  and are not granted to `app_user`, and `withOperator()` runs as the
  connecting role. Operator identity, the reason-and-TTL grant and the audit
  row are SPEC.md feature 5's phase. Home: `TASK_PHASE_C.md` §C1.
- **`projects` is the first feature-flagged resource (Phase C).** SPEC.md asks
  for feature toggles enforced by policies but names no flag, so the planning
  lane bound the mechanism to `projects`, the one tenant-scoped resource the
  spec names. Flags are default-on; only an explicit jsonb `false` disables
  one. Home: `sql/0003_lifecycle.sql`.

**Gate**: `bash verify.sh` green, then commit the three docs.
