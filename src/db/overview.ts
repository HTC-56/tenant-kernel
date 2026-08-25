/**
 * Privileged cross-tenant reads for the operator surface (SPEC.md features 7
 * and 8). These are the only reads in the repo that see more than one tenant,
 * and they exist so the console can render its tenant table and audit feed —
 * they run on the privileged connection (operator door) and are never reachable
 * from a tenant request.
 *
 * Same discipline as the other db/ files: every function takes a `Queryable`
 * and manages no transaction.
 */
import type { Queryable } from './engine.ts'

/** One row of the console's tenant table. */
export interface TenantOverview {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly state: string
  readonly createdAt: Date
  readonly seatsUsed: number
  readonly seatCap: number
  readonly features: Record<string, unknown>
  /** Live (unexpired, unrevoked) support grants open on this tenant right now. */
  readonly liveGrants: number
}

/** One audit row as the operator feed shows it — tenant slug joined in. */
export interface AuditFeedEntry {
  readonly id: string
  readonly tenantId: string
  readonly tenantSlug: string
  readonly operatorId: string | null
  readonly action: string
  readonly reason: string | null
  readonly detail: Record<string, unknown>
  readonly createdAt: Date
}

/** Every tenant with its seat usage, entitlements, and live-grant count. */
export async function listTenants(tx: Queryable): Promise<TenantOverview[]> {
  const rows = await tx.query<{
    id: string
    slug: string
    name: string
    state: string
    created_at: Date
    seats_used: string | number
    seat_cap: string | number | null
    features: Record<string, unknown> | null
    live_grants: string | number
  }>(`
    SELECT t.id, t.slug, t.name, t.state, t.created_at,
           (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id)  AS seats_used,
           e.seat_cap,
           e.features,
           (SELECT count(*) FROM support_grants g
             WHERE g.tenant_id = t.id
               AND g.revoked_at IS NULL
               AND g.expires_at > now())                                  AS live_grants
      FROM tenants t
      LEFT JOIN entitlements e ON e.tenant_id = t.id
     ORDER BY t.created_at DESC, t.id DESC
  `)
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    state: r.state,
    createdAt: r.created_at,
    seatsUsed: Number(r.seats_used ?? 0),
    seatCap: Number(r.seat_cap ?? 0),
    features: r.features ?? {},
    liveGrants: Number(r.live_grants ?? 0),
  }))
}

/** The cross-tenant audit feed, newest first. */
export async function recentAudit(tx: Queryable, limit = 50): Promise<AuditFeedEntry[]> {
  const rows = await tx.query<{
    id: string
    tenant_id: string
    slug: string
    operator_id: string | null
    action: string
    reason: string | null
    detail: Record<string, unknown> | null
    created_at: Date
  }>(
    `SELECT a.id, a.tenant_id, t.slug, a.operator_id, a.action, a.reason, a.detail, a.created_at
       FROM audit_log a
       JOIN tenants t ON t.id = a.tenant_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    tenantSlug: r.slug,
    operatorId: r.operator_id,
    action: r.action,
    reason: r.reason,
    detail: r.detail ?? {},
    createdAt: r.created_at,
  }))
}

/** One live support grant, as the console's countdown list shows it. */
export interface LiveGrant {
  readonly id: string
  readonly tenantId: string
  readonly tenantSlug: string
  readonly operatorId: string
  readonly reason: string
  readonly grantedAt: Date
  readonly expiresAt: Date
}

/** Every unexpired, unrevoked support grant, soonest to lapse first. */
export async function listLiveGrants(tx: Queryable): Promise<LiveGrant[]> {
  const rows = await tx.query<{
    id: string
    tenant_id: string
    slug: string
    operator_id: string
    reason: string
    granted_at: Date
    expires_at: Date
  }>(`
    SELECT g.id, g.tenant_id, t.slug, g.operator_id, g.reason, g.granted_at, g.expires_at
      FROM support_grants g
      JOIN tenants t ON t.id = g.tenant_id
     WHERE g.revoked_at IS NULL
       AND g.expires_at > now()
     ORDER BY g.expires_at ASC, g.id DESC
  `)
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    tenantSlug: r.slug,
    operatorId: r.operator_id,
    reason: r.reason,
    grantedAt: r.granted_at,
    expiresAt: r.expires_at,
  }))
}

/**
 * Finds or creates the operator row the configured console identity maps to.
 * Runs once at boot; the email is the natural key, so a redeploy with the
 * same config reuses the same operator id and the audit trail stays one line.
 */
export async function ensureOperator(
  tx: Queryable,
  email: string,
  displayName: string,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO operators (email, display_name)
          VALUES (lower($1), $2)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
    [email, displayName],
  )
  return rows[0].id
}
