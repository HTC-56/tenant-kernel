/**
 * Audited operator access, as a thin typed layer over sql/0004_operator.sql.
 *
 * Like src/db/lifecycle.ts, the rules are not here. "A reason is required" is a
 * NOT NULL column with a non-blank CHECK, "the grant expires" is a timestamp
 * the predicate compares against `now()`, and "the audit log cannot be
 * rewritten" is a BEFORE trigger — read the migration for all three. This file
 * only names the doors, and every function takes the `Queryable` a seam handed
 * it and manages no transaction of its own.
 *
 * Which seam a function needs is again the interesting part:
 *
 *   * `withOperator(engine, { operatorId }, …)` — grantSupportAccess,
 *     revokeSupportAccess and logOperatorAction act across tenants as a named
 *     operator, so they need the operator identity published and nothing else.
 *   * `withTenant` — readAuditTrail and readSupportGrants are the tenant half
 *     of SPEC.md feature 5: a tenant reading what was done to it, under RLS,
 *     so neither names a tenant id at all.
 *
 * Both raw reads come back with snake_case column names on both engines; the
 * mapping to camelCase happens here so nothing above this file has to know.
 */
import type { Queryable } from './engine.ts'

/** Everything a support grant needs: whose account, why, and for how long. */
export interface SupportAccessRequest {
  readonly tenantId: string
  readonly reason: string
  readonly ttlMinutes: number
}

/** One time box on one tenant, as the tenant it names can read it. */
export interface SupportGrant {
  readonly id: string
  readonly operatorId: string
  readonly reason: string
  readonly grantedAt: Date
  readonly expiresAt: Date
  readonly revokedAt: Date | null
}

/** One append-only row of a tenant's own audit trail. */
export interface AuditEntry {
  readonly id: string
  readonly operatorId: string | null
  readonly action: string
  readonly reason: string | null
  readonly detail: Record<string, unknown>
  readonly createdAt: Date
}

interface SupportGrantRow {
  id: string
  operator_id: string
  reason: string
  granted_at: Date
  expires_at: Date
  revoked_at: Date | null
}

interface AuditEntryRow {
  id: string
  operator_id: string | null
  action: string
  reason: string | null
  detail: Record<string, unknown>
  created_at: Date
}

/**
 * Opens a time-boxed support grant on one tenant and records it. Throws when
 * no operator is published, when the operator is unknown, when the reason is
 * blank, when the TTL is not positive, or when the tenant does not exist.
 * Returns the new grant id. Operator door: `withOperator` WITH a context.
 */
export async function grantSupportAccess(
  tx: Queryable,
  req: SupportAccessRequest,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    "SELECT grant_support_access($1, $2, ($3::int * interval '1 minute')) AS id",
    [req.tenantId, req.reason, req.ttlMinutes],
  )
  return rows[0].id
}

/**
 * Closes a grant early. The row is stamped, never removed — a tenant reading
 * its own grants should see that access existed and ended, not see nothing.
 * Throws when the grant is unknown or already revoked. Operator door.
 */
export async function revokeSupportAccess(tx: Queryable, grantId: string): Promise<void> {
  await tx.query('SELECT revoke_support_access($1)', [grantId])
}

/**
 * Records one operator action against one tenant and returns the audit id.
 * Throws when there is no live grant on that tenant — which is the whole
 * point: the time box is what makes an action recordable, so an expired or
 * revoked operator cannot act at all. Operator door.
 */
export async function logOperatorAction(
  tx: Queryable,
  tenantId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    'SELECT log_operator_action($1, $2, $3::jsonb) AS id',
    [tenantId, action, JSON.stringify(detail)],
  )
  return rows[0].id
}

/**
 * The acting tenant's own audit trail, newest first. Read under RLS, so it
 * never names a tenant and a suspended tenant can still read it — the 0003
 * suspension gate is deliberately not applied to this table. Tenant door.
 */
export async function readAuditTrail(tx: Queryable, limit = 50): Promise<AuditEntry[]> {
  const rows = await tx.query<AuditEntryRow>(
    `SELECT id, operator_id, action, reason, detail, created_at
       FROM audit_log
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map((row) => ({
    id: row.id,
    operatorId: row.operator_id,
    action: row.action,
    reason: row.reason,
    detail: row.detail ?? {},
    createdAt: row.created_at,
  }))
}

/**
 * Every support grant ever opened on the acting tenant, newest first, revoked
 * and expired ones included. Tenant door: `withTenant`.
 */
export async function readSupportGrants(tx: Queryable): Promise<SupportGrant[]> {
  const rows = await tx.query<SupportGrantRow>(
    `SELECT id, operator_id, reason, granted_at, expires_at, revoked_at
       FROM support_grants
      ORDER BY granted_at DESC, id DESC`,
  )
  return rows.map((row) => ({
    id: row.id,
    operatorId: row.operator_id,
    reason: row.reason,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }))
}
