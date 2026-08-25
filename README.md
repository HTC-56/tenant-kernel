# tenant-kernel

[![ci](https://github.com/HTC-56/tenant-kernel/actions/workflows/ci.yml/badge.svg)](https://github.com/HTC-56/tenant-kernel/actions/workflows/ci.yml)

A single-schema Postgres multi-tenancy core where tenant isolation is a proven
property, not a promise: row-level security is the enforcement layer, the
application connects as a role that cannot read across tenants, and a
catalog-driven leak-test suite makes an unprotected table a failing build.

Operator access to tenant data is the other half of the story: it requires a
recorded reason and a time box, every action lands in an append-only audit
table, and **the tenant itself can read what was done to it**.

![Operator console: tenant table with states and entitlements, support grants counting down, and the audit feed tenants can read](docs/console.png)

## Quickstart

```bash
pnpm install
pnpm test
```

The suite (128 tests) runs against an in-process PGlite database — real
Postgres compiled to WASM, so a clone with no database installed proves the
same SQL, policies, and refusals. Pointed at a server, the SAME suite is the
authoritative run:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm test
```

CI runs both, on every push.

## Two tenants, five minutes

Start the server (config example in `deploy/`; the live file is gitignored):

```bash
cp deploy/tenant-kernel.example.yaml tenant-kernel.yaml
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres pnpm serve
```

Provision two tenants through the operator API (the token is the one in your
YAML), then mint a session for each owner:

```bash
curl -X POST localhost:8100/operator/api/tenants \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"acme","name":"Acme Corp","ownerEmail":"amy@acme.example.com","ownerName":"Amy"}'

pnpm mint-session --email amy@acme.example.com --tenant acme
```

Create a project as one tenant, then fetch it as the other:

```bash
curl -X POST localhost:8100/api/projects \
  -H "Authorization: Bearer $ACME_SESSION" -H 'Content-Type: application/json' \
  -d '{"name":"Skunkworks"}'

curl localhost:8100/api/projects/<that-id> -H "Authorization: Bearer $RIVAL_SESSION"
# → 404. Another tenant's project and a project that never existed are the
#   same empty result — the database refused the read, not the application.
```

## How isolation is enforced

The app connects as `app_user`, which owns no tables and is not a superuser.
Every tenant-scoped table carries `ENABLE` + `FORCE ROW LEVEL SECURITY`;
policies compare `tenant_id` against `current_setting('app.tenant_id')`,
published per transaction with `SET LOCAL` inside the `withTenant()` seam —
the only door into tenant data (`test/seam-only.test.ts` greps the source to
keep it the only door). With no context published, a transaction sees nothing.

- `sql/` — the schema and policies ARE the work sample: numbered, append-only
  plain SQL migrations, no ORM.
- `test/rls-refusal.test.ts` — cross-tenant SELECT / INSERT / UPDATE / DELETE
  all refuse, on both engines.
- `test/rls-coverage.test.ts` — discovers every tenant-scoped table from the
  catalogs; a new table without policies fails the build by construction.

## Audited operator access

Operators are not tenant users. Support access to a tenant is opened with a
**required reason and a TTL**; suspending a tenant demands a live grant (the
API surfaces the database's refusal as 409, because the refusal is the
feature); every action lands in an append-only `audit_log` a tenant can read
for itself under RLS — `GET /api/audit`, or the feed in the console at
`GET /operator`.

## The surface

| Route | Auth | What |
|---|---|---|
| `POST/GET/PATCH/DELETE /api/projects[/:id]` | session bearer | the tenant-scoped resource, end to end |
| `GET /api/me`, `/api/audit`, `/api/support-grants` | session bearer | who am I; what was done to my account |
| `GET/POST /operator/api/*` | static bearer | provision, suspend/resume, grants, audit feed |
| `GET /operator` | — (data needs the bearer) | the self-contained console, one HTML file |
| `GET /healthz`, `GET /metrics` | — | liveness + Prometheus text |

Sessions are opaque bearer tokens (only a SHA-256 digest is stored), minted by
`pnpm mint-session` — auth is a seam here, not the product. Operator mutations
also append one line each to a JSONL ops ledger.

## Deploy

`deploy/tenant-kernel.service` is an example systemd unit; `deploy/tenant-kernel.example.yaml`
documents the config. Node 22.18+, pnpm 9, and a Postgres 16 to point
`DATABASE_URL` at are the whole footprint.

## Repo layout

- `src/db/` — engine seam (PGlite/Postgres), migrator, context seam, thin data layers
- `src/http/` — session plugin, tenant routes, operator routes, server
- `src/console/` — the operator console, one self-contained HTML file
- `sql/` — numbered migrations (append-only)
- `test/` — 128 assertions: leak suite, seam allowlists, HTTP end-to-end, engine parity
- `docs/PROCESS.md` — how this repo was built (an autonomous loop, and what its dual-engine gate caught)

## Verify

```bash
bash verify.sh
```

Typecheck, the full suite, the public-repo scrub, and a README-quickstart lint
(every command shown above must exist in the repo).

## License

MIT — see [LICENSE](LICENSE).
