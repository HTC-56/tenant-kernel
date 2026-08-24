# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core on Postgres, plain SQL | SHIPPED | A | tenants + projects migrated; users/memberships/invites/entitlements later |
| 2 | RLS enforcement layer + leak-test suite | SHIPPED | A | centerpiece — refusal proof green on PGlite; catalog coverage check is §A6 |
| 3 | The context seam (withTenant, SET LOCAL) | NOT BUILT | — | a test-only `asTenant()` stands in until the real seam lands |
| 4 | Tenant lifecycle + entitlements | NOT BUILT | — | |
| 5 | Audited operator access | NOT BUILT | — | |
| 6 | Tenant-scoped surface (projects CRUD) | NOT BUILT | — | |
| 7 | Ops surface (/healthz, /metrics, ledger, auth) | NOT BUILT | — | |
| 8 | Operator console | NOT BUILT | — | |
| 9 | Deploy-grade packaging (config, unit, README, dual-engine CI) | PARTIAL | A | CI, README and verify.sh land in A; YAML config, systemd unit, quickstart hero later |
| — | docs/PROCESS.md (the loop story) | NOT BUILT | — | written near the end, when there is a ledger to excerpt |

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
