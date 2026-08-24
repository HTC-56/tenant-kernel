# tenant-kernel

A single-schema Postgres multi-tenancy core where tenant isolation is a proven
property, not a promise: row-level security is the enforcement layer, the
application connects as a role that cannot read across tenants, and a
catalog-driven leak-test suite makes an unprotected table a failing build.

## Quickstart

```bash
pnpm install
pnpm test
```

The test suite runs against an in-process PGlite database — no external
Postgres needed. PGlite is real Postgres in-process; the same SQL migrations
and queries work here as against the server.

## Run against a real Postgres

```bash
DATABASE_URL=postgres://app_user:pass@127.0.0.1:5432/tenant_kernel pnpm test
```

This is the authoritative run — PGlite covers correctness; a live server
proves the driver and wire protocol.

## How isolation is enforced

The app connects as `app_user`, which owns no tables and is not a superuser.
Every tenant-scoped table is created with `ENABLE ROW LEVEL SECURITY` and
`FORCE ROW LEVEL SECURITY`. Policies compare `tenant_id` against
`current_setting('app.tenant_id')`, published per transaction via `SET LOCAL`
inside the `withTenant()` wrapper. With no context published, a transaction
sees nothing. See `sql/0001_tenancy_core.sql` for the schema and
`test/rls-refusal.test.ts` for the nine-assertion leak test.

## Repo layout

- `src/` — application source, context seam, and migrator
- `sql/` — numbered SQL migrations (append-only)
- `test/` — assertion suite including RLS refusal and coverage tests
- `scripts/` — `scrub-check.sh` for public-repo linting

## Identity and roles

Users are global and become visible to a tenant only through a membership.
Membership and invite writes require `app.role` of `owner` or `admin`.
Entitlements are read-only to tenants. See `sql/0002_identity.sql` for the
schema and `test/identity-rls.test.ts` for the role-gated policy proofs.

## Status

v1 is in progress. See [ROADMAP.md](ROADMAP.md).
