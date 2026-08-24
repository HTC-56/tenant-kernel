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
