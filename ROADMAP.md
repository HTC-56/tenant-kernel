# Roadmap — the v1 scoreboard

One row per SPEC.md feature. The planning lane keeps status current; row edits here
are the one permitted exception to append-only docs.

| # | Feature (SPEC.md) | Status | Phase | Note |
|---|---|---|---|---|
| 1 | Tenancy core on Postgres, plain SQL | NOT BUILT | — | |
| 2 | RLS enforcement layer + leak-test suite | NOT BUILT | — | centerpiece |
| 3 | The context seam (withTenant, SET LOCAL) | NOT BUILT | — | |
| 4 | Tenant lifecycle + entitlements | NOT BUILT | — | |
| 5 | Audited operator access | NOT BUILT | — | |
| 6 | Tenant-scoped surface (projects CRUD) | NOT BUILT | — | |
| 7 | Ops surface (/healthz, /metrics, ledger, auth) | NOT BUILT | — | |
| 8 | Operator console | NOT BUILT | — | |
| 9 | Deploy-grade packaging (config, unit, README, dual-engine CI) | NOT BUILT | — | |
| — | docs/PROCESS.md (the loop story) | NOT BUILT | — | written near the end, when there is a ledger to excerpt |

When every row reads SHIPPED and verify.sh is green, the project is done — the
planning lane declares PROJECT SPEC COMPLETE rather than inventing scope.

## Reservations ledger — small deferred calls recorded inside phase specs

*(empty at scaffold; each entry names its home)*
