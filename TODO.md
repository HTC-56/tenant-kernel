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

- [x] **§A6** Write `test/rls-coverage.test.ts`: discover tenant-scoped tables
  from the catalog and assert each has ENABLE+FORCE RLS, a policy, no PUBLIC
  grant. Mirror `test/rls-refusal.test.ts`. Spec: §A6. Gate: typecheck + test + scrub.

- [x] **§A7** Write `.github/workflows/ci.yml`: two jobs running identical steps
  — PGlite (no database) and an authoritative `postgres:16` service container via
  `DATABASE_URL`. Spec: §A7. Gate: typecheck + test + scrub.

- [x] **§A8** Write `README.md` (<120 lines): quickstart, the real-Postgres run,
  how isolation is enforced, layout, status. Every command shown must exist.
  Spec: §A8. Gate: typecheck + test + scrub.

- [x] **§A9** Write `verify.sh`: typecheck + test + scrub-check + the
  README-quickstart lint (every `pnpm`/`bash` command in the README resolves).
  Spec: §A9. Gate: `bash verify.sh` exits 0.

- [x] **§A10** Close Phase A: append a Phase A section to STATUS.md and flip the
  ROADMAP.md rows this phase shipped. Spec: §A10. Gate: `bash verify.sh` green
  first, then commit both docs.

## Phase B: the context seam — see TASK_PHASE_B.md

`sql/0002_identity.sql` (§B1) and `src/db/seam.ts` (§B2) are already committed
by the planning lane — do not rebuild them. These tasks prove them and add the
thin typed data layer. Grep your section header in TASK_PHASE_B.md, read it,
build that and nothing else.

- [x] **§B3** Write `test/identity-rls.test.ts`: cross-tenant refusal and
  role-gated writes on the identity tables. Mirror `test/rls-refusal.test.ts`.
  Spec: TASK_PHASE_B.md §B3. Gate: typecheck + test + scrub.

- [x] **§B4** Write `test/rls-grants.test.ts`: every table granted to `app_user`
  must have ENABLE+FORCE RLS and a policy — catches global tables like `users`.
  Mirror `test/rls-coverage.test.ts`. Spec: §B4. Gate: typecheck + test + scrub.

- [x] **§B5** Write `test/seam.test.ts`: `withTenant` commits, rolls back on a
  throw, publishes all three settings, drops to `app_user`, rejects a bad id.
  Spec: §B5. Gate: typecheck + test + scrub.

- [x] **§B6** Write `src/db/identity.ts` — four functions over a `Queryable`,
  none of them naming a tenant — plus `test/identity-layer.test.ts`.
  Spec: §B6. Gate: typecheck + test + scrub.

- [x] **§B7** Write `test/seam-only.test.ts`: scan `src/` and assert only the
  seam opens transactions, sets the role, or publishes `app.*` settings.
  Spec: §B7. Gate: typecheck + test + scrub.

- [x] **§B8** Close Phase B: append a README section on identity and roles, a
  STATUS.md Phase B section, and bring the ROADMAP.md rows and reservations
  ledger current. Spec: §B8. Gate: `bash verify.sh` green first.

## Phase C: tenant lifecycle and entitlements — see TASK_PHASE_C.md

`sql/0003_lifecycle.sql` (§C1) and `src/db/lifecycle.ts` + `withOperator()`
(§C2) are already committed by the planning lane — do not rebuild them. These
tasks prove them. Grep your section header in TASK_PHASE_C.md, read it, build
that and nothing else.

- [x] **§C3** Write `test/seat-cap.test.ts`: five seats fill, the sixth rejects
  with `/seat cap/i`, raising the cap lets it in, `seatUsage` agrees.
  Spec: TASK_PHASE_C.md §C3. Gate: typecheck + test + scrub.

- [x] **§C4** Write `test/last-owner.test.ts`: demoting or removing a tenant's
  only owner rejects; with two owners it succeeds; deleting the tenant still
  cascades. Spec: §C4. Gate: typecheck + test + scrub.

- [x] **§C5** Write `test/suspension.test.ts`: a suspended tenant sees none of
  its own data but still reads its `tenants` row; resume restores it.
  Spec: §C5. Gate: typecheck + test + scrub.

- [x] **§C6** Write `test/feature-flags.test.ts`: flags are default-on; an
  explicit jsonb `false` refuses new projects without hiding old ones.
  Spec: §C6. Gate: typecheck + test + scrub.

- [x] **§C7** Write `test/lifecycle-layer.test.ts`: provision a tenant with its
  owner, then redeem an invite into it from another tenant's transaction.
  Spec: §C7. Gate: typecheck + test + scrub.

- [x] **§C8** Write `test/function-grants.test.ts`: no SECURITY DEFINER function
  is executable by PUBLIC; only `accept_invite` reaches `app_user`. Mirror
  `test/rls-grants.test.ts`. Spec: §C8. Gate: typecheck + test + scrub.

- [x] **§C9** Close Phase C: append a README lifecycle section and a STATUS.md
  Phase C section, flip the ROADMAP.md rows and add two reservations.
  Spec: §C9. Gate: `bash verify.sh` green first.

## Phase D: audited operator access — see TASK_PHASE_D.md

`sql/0004_operator.sql` (§D1) and `src/db/operator.ts` + the
`withOperator(ctx)` overload and three new test helpers (§D2) are already
committed by the planning lane — do not rebuild them. These tasks prove them.
**Read `## §D0` in TASK_PHASE_D.md first** — it carries the facts every task
here needs, including the one runner distinction that will bite you. Then grep
your own section, read it, build that and nothing else.

- [x] **§D3** Write `test/operator-identity.test.ts`: an operator holds no
  membership, is invisible to a tenant it never touched, visible to one it did,
  and unwritable. Spec: TASK_PHASE_D.md §D3. Gate: typecheck + test + scrub.

- [x] **§D4** Write `test/support-grant.test.ts`: a grant needs an operator, a
  non-blank reason and a positive TTL; a lapsed or revoked grant cannot record
  an action. Spec: §D4. Gate: typecheck + test + scrub.

- [x] **§D5** Write `test/audit-append-only.test.ts`: UPDATE and DELETE on
  `audit_log` refuse even for the table owner, `app_user` cannot insert, and a
  tenant delete still cascades. Spec: §D5. Gate: typecheck + test + scrub.

- [ ] **§D6** Write `test/audit-trail.test.ts`: a tenant reads its own trail
  newest-first with the grant's reason, sees none of another's, and still reads
  it while suspended. Spec: §D6. Gate: typecheck + test + scrub.

- [ ] **§D7** Write `test/operator-layer.test.ts`: `readSupportGrants` returns
  camelCase `Date` fields, and a revoked grant survives as history with a
  non-null `revokedAt`. Spec: §D7. Gate: typecheck + test + scrub.

- [ ] **§D8** Close Phase D: append a README operator-access section and a
  STATUS.md Phase D section, flip the ROADMAP.md row 5 and add one reservation.
  Spec: §D8. Gate: `bash verify.sh` green first.
