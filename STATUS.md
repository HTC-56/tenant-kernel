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

What is next: audited operator access (SPEC.md feature 5) — operator identity,
time-boxed support grants with a required reason, and an append-only audit
table a tenant can read for itself.

## Phase C — tenant lifecycle

Phase C shipped `sql/0003_lifecycle.sql`, `src/db/lifecycle.ts`, `withOperator()`
in `src/db/seam.ts`, and six new test files. The seat cap refuses the seat past
the cap, a tenant cannot be left without an owner, a suspended tenant sees none
of its own data but still sees why, a switched-off feature stops new writes
without hiding old rows, and no SECURITY DEFINER function is executable by
PUBLIC.
