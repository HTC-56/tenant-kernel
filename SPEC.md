# tenant-kernel — v1 spec

A single-schema Postgres multi-tenancy core where tenant isolation is a
PROVEN property, not a promise: row-level security is the enforcement layer,
the application connects as a role that cannot read across tenants, and a
catalog-driven leak-test suite makes an unprotected table a failing build.
Plus the operator tooling every real SaaS grows: provisioning, entitlements,
time-boxed audited support access. Built end-to-end by an autonomous
local-model coding loop; the commit history is part of the deliverable (see
`docs/PROCESS.md` when it lands).

## v1 features (all of these, nothing more)

1. **Tenancy core on Postgres, plain SQL.** Numbered `.sql` migrations applied
   by a tiny in-repo migrator (no ORM — the SQL is the work sample): tenants,
   users, memberships (owner/admin/member), invites, entitlement flags.
2. **RLS as the enforcement layer — the centerpiece.** Every tenant-scoped
   table gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and policies keyed to
   `current_setting('app.tenant_id')` / `app.user_id` / `app.role`. The app
   connects as a non-superuser role that owns no tables. A catalog-driven
   leak-test suite discovers every tenant-scoped table at runtime and proves
   cross-tenant SELECT / INSERT / UPDATE / DELETE all refuse — a new table
   without policies fails the suite by construction.
3. **The context seam.** One `withTenant()` wrapper runs every request in a
   transaction with `SET LOCAL` of the context settings; no query path exists
   outside the seam (a test enforces that the seam is the only door). Session
   token → user → active tenant resolution as a Fastify plugin.
4. **Tenant lifecycle + entitlements.** Provision, invite/accept, role
   change, suspend/resume. Entitlement flags (seat cap, feature toggles)
   enforced at the data layer — constraints and policies, not UI checks.
5. **Audited operator access.** Operator identity is distinct from tenant
   users. Support access to a tenant is granted with a required reason and a
   TTL; every operator action lands in an append-only audit table; a tenant
   can read its own audit trail (RLS-scoped).
6. **A real tenant-scoped surface.** One minimal `projects` CRUD resource so
   isolation is demonstrable end-to-end: the quickstart runs two tenants side
   by side and shows a cross-tenant read refused live.
7. **Ops surface.** `/healthz`, `/metrics` (Prometheus text), static bearer
   auth on the operator API, JSONL ops ledger.
8. **The operator console.** `GET /operator` — one self-contained HTML page
   (inline CSS/JS, no framework, no build step, no CDN, no web fonts):
   tenant table with state + entitlements, provision form, support-access
   grant with reason + TTL countdown, live audit feed. The README hero
   screenshot.
9. **Deploy-grade packaging.** YAML config; example systemd unit; README
   quickstart (two tenants + a refused cross-tenant read in 5 minutes);
   GitHub Actions CI running the full suite on BOTH engines (below).

## Engines — pre-registered rule

- Default dev/test engine: **PGlite** (`@electric-sql/pglite`, real Postgres
  compiled to WASM, in-process) — `pnpm test` needs zero setup on any box.
- `DATABASE_URL` switches the SAME suite to a real Postgres server; CI runs a
  PGlite job AND a Postgres 16 service-container job. The real-Postgres job
  is authoritative.
- **Phase A must prove the RLS refusal path on both engines before anything
  else is built.** If PGlite cannot enforce a specific case, that case is
  skipped on PGlite with the decision recorded in DECISIONS.md; if PGlite
  cannot enforce RLS at all, tests require `DATABASE_URL` and CI keeps only
  the service-container job — recorded, never silent.

## Non-goals (v1 refuses these)

- No billing/payments, no plans/pricing.
- No SSO, no OAuth, no password reset — opaque bearer session tokens minted
  by a CLI helper and test fixtures. Auth is a seam, not the product.
- No per-tenant schemas, no database-per-tenant. Single schema + RLS IS the
  story.
- No ORM. Plain SQL migrations + a thin typed data layer.
- No UI framework, no build step for the console — React/Vite/Next.js
  anywhere in this repo is a spec bug.
- No background jobs, no email delivery (invites print links), no
  multi-region, no replication.

## Stack & shape

- TypeScript, Fastify, Zod, Vitest, pnpm; `postgres` driver;
  `@electric-sql/pglite` as dev-dependency. Dependency surface deliberately
  tiny — a task that adds a dependency must name it and why.
- Layout: `src/` (server, db, seam, lifecycle, operator, console), `sql/`
  (numbered migrations), `test/` (unit + leak suite + seam tests), `deploy/`
  (systemd unit example, example YAML), `README.md`, `docs/PROCESS.md` —
  "how this repo was built": the autonomous-loop architecture in one page and
  a sanitized ledger excerpt. A real deliverable, not an afterthought.

## Gates

- `pnpm typecheck` + `pnpm test` green at every phase end; the leak suite is
  part of `pnpm test` from the phase that creates the first tenant-scoped
  table onward.
- `bash scripts/scrub-check.sh` green from phase 1: greps the tree for
  private hostnames, non-documentation IPs, absolute home paths, and key
  material. Docs use `localhost` and `192.0.2.x` only.
- `verify.sh` = typecheck + test + scrub-check + README-quickstart lint
  (commands shown in the README must exist in the repo).

## Done means

A stranger clones the repo: `pnpm install && pnpm test` is green with no
database installed (PGlite); pointed at a real Postgres via `DATABASE_URL`,
the same suite is green. The README quickstart stands up two tenants, shows a
cross-tenant read refused at the database layer, grants time-boxed support
access with a reason, and the audit feed shows it. The operator console
breathes. CI badge green on both engine jobs. PROCESS.md tells the loop
story in one page.
