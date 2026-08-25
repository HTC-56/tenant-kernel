# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core on Postgres, plain SQL | SHIPPED | A, B | tenants + projects in A; users, memberships, invites and entitlement flags in B |
| 2 | RLS enforcement layer + leak-test suite | SHIPPED | A | centerpiece — refusal proof green on PGlite; catalog coverage check is §A6; grants-based coverage check (`test/rls-grants.test.ts`) landed in B |
| 3 | The context seam (withTenant, SET LOCAL) | SHIPPED | B, C, E | `withTenant()`, `withOperator()` (carrying an `app.operator_id` identity since D) and `test/seam-only.test.ts` are proven; E adds session-token → user → active-tenant resolution as the Fastify plugin (`src/http/session-plugin.ts`) |
| 4 | Tenant lifecycle + entitlements | SHIPPED | B, C | provision, invite/accept, role change and suspend/resume ship in C; seat cap, last-owner and feature toggles are enforced by triggers and policies |
| 5 | Audited operator access | SHIPPED | D | operator identity, reason-and-TTL support grants and an append-only audit table a tenant can read for itself |
| 6 | Tenant-scoped surface (projects CRUD) | SHIPPED | E | `/api/projects` end to end; another tenant's id and a nonexistent id are the same 404 (`test/http-tenant-api.test.ts`) |
| 7 | Ops surface (/healthz, /metrics, ledger, auth) | SHIPPED | E | Prometheus text by route template; JSONL ops ledger per operator mutation; static bearer on `/operator/api` |
| 8 | Operator console | SHIPPED | E | one self-contained HTML file; self-containment enforced by `test/console.test.ts`; hero = real staged capture (`docs/console.png`) |
| 9 | Deploy-grade packaging (config, unit, README, dual-engine CI) | SHIPPED | A, E | zod-validated YAML config, example systemd unit, `pnpm mint-session`, README quickstart verified live, CI green on both engine jobs |
| — | docs/PROCESS.md (the loop story) | SHIPPED | E | includes what the dual-engine gate caught (the `::jsonb` parameter divergence) |

When every row reads SHIPPED and verify.sh is green, the project is done — the
planning lane declares PROJECT SPEC COMPLETE rather than inventing scope.

## Reservations ledger — small deferred calls recorded inside phase specs

*(empty at scaffold; each entry names its home)*

- **Real-Postgres proof deferred to CI (Phase A).** SPEC.md asks Phase A to
  prove the refusal path on both engines. PGlite is proven locally — all nine
  assertions green. The real-Postgres half could not be run on the dev box:
  no client installed, no permission on the docker socket, and the two local
  servers require credentials this project does not hold. The `postgres:16`
  service-container job carries it instead, which is what SPEC.md already
  calls authoritative. Home: `TASK_PHASE_A.md` §A7. Not a spec fallback —
  no case was skipped, only relocated.
- **Migrations assume an owner-or-superuser role (Phase A).** `FORCE ROW LEVEL
  SECURITY` binds the table owner too, so the role that runs migrations and
  test seeds must be able to bypass RLS. CI connects as `postgres`. If a
  deployment ever migrates as a non-superuser owner, that needs its own call.
  Home: `sql/0001_tenancy_core.sql`.
- **Coverage check proves protection, not behaviour (Phase A).** §A6 asserts
  every discovered tenant-scoped table has ENABLE+FORCE RLS, a policy and no
  PUBLIC grant. Driving real cross-tenant CRUD against every discovered table
  is reserved for the phase that adds the second tenant-scoped table.
  Home: `TASK_PHASE_A.md` §A6.
- **Seat-cap enforcement deferred (Phase B).** The `entitlements.seat_cap` column
  ships with no trigger enforcing it, because the operator write path that would
  set it does not exist yet; the lifecycle phase enforces it. Home:
  `TASK_PHASE_B.md` §B1.
- **Operator doors are privileged-connection-only (Phase C).** `provision_tenant`
  and `set_tenant_state` have EXECUTE revoked from PUBLIC and are not granted to
  `app_user`, and `withOperator()` runs as the connecting role. Operator
  identity, the reason-and-TTL grant and the audit row are SPEC.md feature 5's
  phase. Home: `TASK_PHASE_C.md` §C1.
- **`projects` is the first feature-flagged resource (Phase C).** SPEC.md asks
  for feature toggles enforced by policies but names no flag, so the planning
  lane bound the mechanism to `projects`, the one tenant-scoped resource the
  spec names. Flags are default-on; only an explicit jsonb `false` disables
  one. Home: `sql/0003_lifecycle.sql`.
- **The operator lane is opt-in at the SQL layer (Phase D).** Publishing
  `app.operator_id` is what makes `set_tenant_state` demand a live support
  grant and write an audit row; with no operator published the door behaves
  exactly as Phase C shipped it, which is what a migration and a test fixture
  are. Making an operator identity mandatory belongs to the phase that puts an
  authenticated operator API in front of these functions. Home:
  `sql/0004_operator.sql`.
- **Real-Postgres proof: carried out at publish prep (Phase E).** The Phase A
  reservation relocated the authoritative run to CI; before the repo went
  public it was run locally against a `postgres:16` container instead — and it
  failed: the `::jsonb` parameter double-encoding divergence (see DECISIONS.md
  and docs/PROCESS.md). Fixed as the `::text::jsonb` convention, pinned by
  `test/engine-parity.test.ts`. The reservation's bet ("CI carries it") would
  have gone red on the first public push; running it pre-publish was the call.
  Home: `test/engine-parity.test.ts`.
- **The console page is served unauthenticated (Phase E).** `GET /operator`
  returns static HTML; every byte of data behind it requires the static
  bearer, which the page holds in memory only. Gating the HTML itself would
  add a login surface to a demo console without protecting anything the API
  does not already protect. Home: `src/http/server.ts`.
- **`sessions` is deliberately outside the tenant-scoped set (Phase E).** The
  column is named `active_tenant_id` because the row is global infrastructure
  (resolution happens before tenant context exists), so the catalog-driven
  coverage suite — which discovers by a literal `tenant_id` column — is right
  not to claim it. `app_user` holds no grant on it; RLS is enabled with no
  policies as a fail-closed backstop. Home: `sql/0005_sessions.sql`.
