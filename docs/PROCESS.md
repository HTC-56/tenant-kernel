# How this repo was built

tenant-kernel is the third repo in a series built to a fixed process: a
**pre-registered spec** (SPEC.md, scope fenced by non-goals), an **autonomous
loop** doing the building, and gates that run at every phase end — typecheck,
the full test suite, a public-repo scrubber, and a README lint. The process is
part of the work sample: the commit history is the loop's actual trail, not a
squashed reconstruction.

## The loop

Three lanes, all running as systemd timers on one machine:

- **Executor** — a local open-weights model (Qwen3.6-35B-A3B) works through
  `TODO.md` one task at a time. Every session must end in a commit that passes
  the gates, or the task lands in `BLOCKED.md`.
- **Watchdog** — relaunches the executor between sessions; escalates a blocked
  task to a frontier model (Claude), which implements and commits the fix
  itself rather than writing instructions.
- **Planner** — a frontier model authors the next phase's tasks from SPEC.md
  when `TODO.md` runs dry, and flips ROADMAP.md rows. Capped per day; it
  declares the terminal state instead of inventing scope.

28 ledgered sessions built phases A–D: the executor carried every TODO task
(21/21 committed), the frontier lane carried planning and four escalations.
Phase E — the HTTP surface, the console, packaging, and this file — was closed
by the frontier lane directly on the operator's order, on the same gates.

Sanitized ledger excerpt (`loop-ledger.tsv` is the full trail):

```
time              lane  model   result  turns  out_tok  task
2026-08-24T15:53  plan  claude  commit     56   107182  plan next phase
2026-08-24T16:05  loop  qwen    commit     62    20332  §A5 scripts/scrub-check.sh
2026-08-24T16:15  loop  qwen    commit    112    29707  §A6 test/rls-coverage suite
2026-08-25T02:09  loop  qwen    commit     97    15447  §D7 test/operator-layer suite
2026-08-25T02:16  loop  qwen    commit    123    22665  §D8 close Phase D
```

## What the dual-engine gate caught

The engines rule was pre-registered in SPEC.md: PGlite is the zero-setup
default, and a real-Postgres run is authoritative. The repo had no remote
until publish, so CI's Postgres job had never run — every phase had passed on
PGlite alone.

The first real-Postgres run failed two tests. The cause was a genuine
two-driver divergence, not a flake: with a parameter cast written `$2::jsonb`,
the server declares the *parameter* jsonb and the `postgres` driver
re-serializes an already-encoded JSON string into a jsonb **string scalar** —
so `features -> 'projects'` was NULL and a switched-off feature flag read as
on. PGlite sends the parameter as text either way and stores a real object.
The same shape silently corrupted the audit `detail` column on real Postgres.

The fix is a convention — `::text::jsonb`, pinning the parameter's wire type
before the cast — plus `test/engine-parity.test.ts`, which pins the behavior
on whichever engine the suite runs against. The point of recording this here:
the leak-test suite, the seam allowlists, and a hundred-plus green tests did not catch
it; only running the second engine did. "The authoritative run is the real
server" was the single most valuable line in the spec.

## What the gates are

- `pnpm typecheck` + `pnpm test` — 128 assertions including the catalog-driven
  leak suite and source-text seam allowlists.
- `bash scripts/scrub-check.sh` — no private hostnames, no non-documentation
  IPs, no home paths, no key material, in any tracked file.
- README lint — every `pnpm`/`bash` command the README shows must exist.
- CI (`.github/workflows/ci.yml`) — the identical gate on GitHub runners,
  twice: once on PGlite, once against a Postgres 16 service container.
