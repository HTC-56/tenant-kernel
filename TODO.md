# Loop tasks

Ordered; each is one short session. Work the first unchecked box. Each task is
fully specced in ONE greppable section of its phase doc (`TASK_PHASE_A.md` §A1,
§A2, …) — grep your section, read it, build it.

*(no tasks yet — the planning lane authors Phase A from SPEC.md)*

## Phase A: prove the refusal path — see TASK_PHASE_A.md

The engine adapter, migrator, first migration and the nine-assertion refusal
proof are already committed. These tasks close the phase. Grep your section
header in TASK_PHASE_A.md, read it, build that and nothing else.

- [x] |- **§A5** Write `scripts/scrub-check.sh`: public-repo scrubber over
  `git ls-files` only — home paths, LAN IPs, key material, private hostnames.
  Spec: TASK_PHASE_A.md §A5. Gate: it exits 0, plus `pnpm typecheck` + `pnpm test`.

- [ ] **§A6** Write `test/rls-coverage.test.ts`: discover tenant-scoped tables
  from the catalog and assert each has ENABLE+FORCE RLS, a policy, no PUBLIC
  grant. Mirror `test/rls-refusal.test.ts`. Spec: §A6. Gate: typecheck + test + scrub.

- [ ] **§A7** Write `.github/workflows/ci.yml`: two jobs running identical steps
  — PGlite (no database) and an authoritative `postgres:16` service container via
  `DATABASE_URL`. Spec: §A7. Gate: typecheck + test + scrub.

- [ ] **§A8** Write `README.md` (<120 lines): quickstart, the real-Postgres run,
  how isolation is enforced, layout, status. Every command shown must exist.
  Spec: §A8. Gate: typecheck + test + scrub.

- [ ] **§A9** Write `verify.sh`: typecheck + test + scrub-check + the
  README-quickstart lint (every `pnpm`/`bash` command in the README resolves).
  Spec: §A9. Gate: `bash verify.sh` exits 0.

- [ ] **§A10** Close Phase A: append a Phase A section to STATUS.md and flip the
  ROADMAP.md rows this phase shipped. Spec: §A10. Gate: `bash verify.sh` green
  first, then commit both docs.
