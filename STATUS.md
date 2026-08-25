# Status

Repo scaffolded 2026-08-24. Nothing built yet. SPEC.md is the product;
DECISIONS.md locks the fence; ROADMAP.md is the scoreboard. The planning lane
authors Phase A from SPEC.md (Phase A must prove the RLS refusal path on both
engines before anything else is built).

Per-phase sections append below as phases ship.

## Phase A — the refusal path

Phase A shipped the dual-engine adapter (PGlite + real Postgres), the SQL
migrator, `sql/0001_tenancy_core.sql`, the nine-assertion refusal proof
(`test/rls-refusal.test.ts`), the catalog coverage check (§A6), the public-repo
scrubber (§A5), CI with both engines (§A7), the README (§A8), and
`verify.sh` (§A9).

What is proven: cross-tenant SELECT, INSERT, UPDATE, and DELETE all refuse on
PGlite, and an unprotected tenant-scoped table now fails the build via the
catalog coverage check.

What is not yet proven locally: the real-Postgres run. The dev box has no
reachable Postgres, so CI's `postgres:16` service-container job carries it.

What is next: the request seam (`withTenant`), users/memberships/invites.

## Phase B — the context seam

Phase B shipped `sql/0002_identity.sql`, `src/db/seam.ts`, `src/db/identity.ts`,
and six new test files. The seam commits transactions, rolls back on a throw,
drops to `app_user` and publishes all three settings. A tenant sees only its
own people. Membership and invite writes need an `admin` or `owner` role. A
table granted to `app_user` without RLS now fails the build.

What is next: audited operator access (SPEC.md feature 5)

## Phase D — audited operator access

Phase D shipped `sql/0004_operator.sql`, `src/db/operator.ts`, the `withOperator(ctx)`
overload in `src/db/seam.ts`, three new test helpers, and five new test files
(`test/operator-identity.test.ts`, `test/support-grant.test.ts`,
`test/audit-append-only.test.ts`, `test/audit-trail.test.ts`,
`test/operator-layer.test.ts`). An operator is not a tenant user and is invisible
to a tenant it has never touched. Support access refuses a blank reason and a
non-positive TTL. An expired or revoked grant cannot record an action. The audit
log refuses UPDATE and DELETE even from its owner. A tenant reads its own trail
and only its own — suspended or not.

What is next: SPEC.md feature 6, the tenant-scoped `projects` CRUD surface, and
then feature 3's remaining half — session-token resolution as a Fastify plugin. — operator identity,
time-boxed support grants with a required reason, and an append-only audit
table a tenant can read for itself.

## Phase C — tenant lifecycle

Phase C shipped `sql/0003_lifecycle.sql`, `src/db/lifecycle.ts`, `withOperator()`
in `src/db/seam.ts`, and six new test files. The seat cap refuses the seat past
the cap, a tenant cannot be left without an owner, a suspended tenant sees none
of its own data but still sees why, a switched-off feature stops new writes
without hiding old rows, and no SECURITY DEFINER function is executable by
PUBLIC.

## Phase E — the served surface, and the divergence

Phase E shipped the second half of feature 3 and features 6–9: `sql/0005_sessions.sql`
with digest-only opaque bearer sessions, the Fastify session plugin
(`src/http/session-plugin.ts`), projects CRUD end to end, the static-bearer
operator API, `/healthz` + `/metrics`, the JSONL ops ledger, the self-contained
operator console with its real-capture hero (`docs/console.png`), YAML config,
the example systemd unit, `pnpm mint-session`, docs/PROCESS.md, and the MIT
LICENSE. The quickstart was verified live: two tenants side by side, the
cross-tenant read refused as 404, a suspension demanding — and receiving — a
reasoned, time-boxed support grant the suspended tenant can read about itself.

The phase also carried the project's one real engine incident: the first
authoritative real-Postgres run (a local `postgres:16` container at publish
prep) failed two feature-flag tests that PGlite had always passed. Root cause:
a `$n::jsonb` parameter cast makes the server declare the parameter jsonb and
the `postgres` driver then re-serializes an encoded string into a jsonb string
scalar. Convention is now `::text::jsonb`; `test/engine-parity.test.ts` pins
it; DECISIONS.md and docs/PROCESS.md carry the record. Suite: 128 tests over
25 files, green on BOTH engines. Phase E was implemented by the frontier lane
directly (operator's order), on the same gates the loop ships under.
