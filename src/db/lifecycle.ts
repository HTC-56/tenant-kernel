/**
 * The tenant lifecycle, as a thin typed layer over sql/0003_lifecycle.sql.
 *
 * The rules are not here. A seat cap is a trigger, a suspended tenant is a
 * RESTRICTIVE policy, "a tenant keeps at least one owner" is a trigger — read
 * the migration for all three. This file only names the doors, in the same
 * shape as src/db/identity.ts: every function takes the `Queryable` a seam
 * handed it and none of them manages a transaction.
 *
 * Two seams feed it, and which one a function needs is the interesting part:
 *
 *   * `withTenant` — changeRole, removeMember and seatUsage act inside one
 *     tenant, so RLS scopes them and they never name a tenant id at all.
 *   * `withOperator` — provisionTenant and setTenantState create or re-state a
 *     tenant the caller is not scoped to, so they must name one.
 *
 * `acceptInvite` is the odd one: the invitee has no membership in the inviting
 * tenant yet, so no tenant context could authorize it. The token is the
 * capability, `accept_invite()` checks every precondition itself, and it is the
 * one SECURITY DEFINER function a tenant request may execute.
 */
import type { Queryable } from './engine.ts'
import type { TenantRole } from './seam.ts'

/** The two states sql/0001_tenancy_core.sql's CHECK constraint accepts. */
export const TENANT_STATES = ['active', 'suspended'] as const
export type TenantState = (typeof TENANT_STATES)[number]

/** Everything provisioning a tenant needs: the tenant, and its first owner. */
export interface ProvisionRequest {
  readonly slug: string
  readonly name: string
  readonly ownerEmail: string
  readonly ownerName: string
}

/** What a tenant is using against what it is entitled to. */
export interface SeatUsage {
  readonly used: number
  readonly cap: number
}

/**
 * Creates a tenant, its first owner (an existing user with that email is
 * reused — users are global) and the owner membership, in one statement.
 * Returns the new tenant id. Operator door: run it inside `withOperator`.
 */
export async function provisionTenant(tx: Queryable, req: ProvisionRequest): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    'SELECT provision_tenant($1, $2, $3, $4) AS id',
    [req.slug, req.name, req.ownerEmail, req.ownerName],
  )
  return rows[0].id
}

/**
 * Suspends or resumes a tenant. Suspension is not a flag the application
 * checks: it takes the tenant's own data out of reach at the database layer.
 * Operator door: run it inside `withOperator`.
 */
export async function setTenantState(
  tx: Queryable,
  tenantId: string,
  state: TenantState,
): Promise<void> {
  await tx.query('SELECT set_tenant_state($1, $2)', [tenantId, state])
}

/**
 * Redeems an invite token for a user and returns the tenant they joined.
 * Throws if the token is unknown, already used, expired, or belongs to a
 * suspended tenant. Safe to call from a tenant request — it is the one
 * SECURITY DEFINER function granted to `app_user`.
 */
export async function acceptInvite(tx: Queryable, token: string, userId: string): Promise<string> {
  const rows = await tx.query<{ tenant_id: string }>(
    'SELECT accept_invite($1, $2) AS tenant_id',
    [token, userId],
  )
  return rows[0].tenant_id
}

/**
 * Changes one member's role inside the acting tenant. Returns false when no
 * such member is visible — which, under RLS, is also what a member of another
 * tenant looks like. Throws when the change would strand the tenant without an
 * owner. Tenant door: `withTenant`, with an `owner` or `admin` role published.
 */
export async function changeRole(tx: Queryable, userId: string, role: TenantRole): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'UPDATE memberships SET role = $2 WHERE user_id = $1 RETURNING id',
    [userId, role],
  )
  return rows.length > 0
}

/**
 * Removes one member from the acting tenant, freeing their seat. Returns false
 * when no such member is visible. Throws when they are the last owner.
 * Tenant door: `withTenant`, with an `owner` or `admin` role published.
 */
export async function removeMember(tx: Queryable, userId: string): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM memberships WHERE user_id = $1 RETURNING id',
    [userId],
  )
  return rows.length > 0
}

/**
 * Seats used and seats allowed for the acting tenant. Both halves are read
 * under RLS, so neither names a tenant; a suspended tenant sees nothing and
 * gets zeroes. count() comes back as a bigint, which both drivers hand over as
 * a string — hence the Number().
 */
export async function seatUsage(tx: Queryable): Promise<SeatUsage> {
  const rows = await tx.query<{ used: string | number; cap: string | number | null }>(`
    SELECT (SELECT count(*) FROM memberships)          AS used,
           (SELECT max(seat_cap) FROM entitlements)    AS cap
  `)
  return { used: Number(rows[0].used ?? 0), cap: Number(rows[0].cap ?? 0) }
}
