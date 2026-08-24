/**
 * Thin typed data layer over the identity tables.
 *
 * Every function takes a `Queryable` (the seam's transaction) and never names
 * a tenant — the tenant comes from the transaction's own context. RLS filters
 * the reads, and `tenant_id` DEFAULTs to `app_current_tenant()` on the writes.
 *
 * This is the data layer: no ORM, no eager loading, no transaction management.
 * test/identity-layer.test.ts proves it.
 */
import type { Queryable } from './engine.ts'
import type { TenantRole } from './seam.ts'

/** A membership row, typed for the application. */
export interface Member {
  id: string
  userId: string
  email: string
  displayName: string
  role: string
}

/** A pending invite, typed for the application. */
export interface Invite {
  id: string
  email: string
  role: string
  expiresAt: Date
}

/**
 * List every member of the acting tenant, joined to their user record,
 * ordered by email.
 */
export async function listMembers(tx: Queryable): Promise<Member[]> {
  const rows = await tx.query<{
    id: string
    user_id: string
    email: string
    display_name: string
    role: string
  }>(`
    SELECT m.id, m.user_id, u.email, u.display_name, m.role
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     ORDER BY u.email
  `)
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
  }))
}

/**
 * Add a member to the acting tenant. Names only `user_id` and `role`;
 * `tenant_id` DEFAULTs to `app_current_tenant()`. Returns the new membership id.
 */
export async function addMember(
  tx: Queryable,
  userId: string,
  role: TenantRole,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    'INSERT INTO memberships (user_id, role) VALUES ($1, $2) RETURNING id',
    [userId, role],
  )
  return rows[0].id
}

/**
 * List every pending invite for the acting tenant, ordered by email.
 */
export async function listPendingInvites(tx: Queryable): Promise<Invite[]> {
  const rows = await tx.query<{
    id: string
    email: string
    role: string
    expires_at: Date
  }>('SELECT id, email, role, expires_at FROM invites WHERE state = \'pending\' ORDER BY email')
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    expiresAt: r.expires_at,
  }))
}

/**
 * Create a pending invite for the acting tenant. Names only the four columns
 * that are always supplied at creation time; `tenant_id` DEFAULTs to
 * `app_current_tenant()`. Returns the new invite id.
 */
export async function createInvite(
  tx: Queryable,
  email: string,
  role: TenantRole,
  token: string,
  expiresAt: Date,
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    'INSERT INTO invites (email, role, token, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, role, token, expiresAt],
  )
  return rows[0].id
}
