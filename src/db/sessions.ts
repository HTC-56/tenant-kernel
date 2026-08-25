/**
 * Sessions — the storage half of SPEC.md feature 3's second sentence:
 * "Session token → user → active tenant resolution as a Fastify plugin."
 *
 * Auth is a seam, not the product (SPEC.md non-goals): tokens are opaque
 * random strings minted by the CLI helper and test fixtures, and only their
 * SHA-256 digest is stored. Both functions take a `Queryable` and run on the
 * privileged connection — resolution happens before any tenant context
 * exists, so the bare operator door (`withOperator(engine, fn)`) is the
 * correct seam, and sql/0005_sessions.sql grants `app_user` nothing.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from './engine.ts'
import type { TenantRole } from './seam.ts'
import { TENANT_ROLES } from './seam.ts'

/** What a resolved session authorizes: exactly a `withTenant` context. */
export interface ResolvedSession {
  readonly userId: string
  readonly tenantId: string
  readonly role: TenantRole
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Mints a session for one user acting as one tenant and returns the RAW
 * token — the only time it ever exists outside the caller. Refuses when the
 * user holds no membership in that tenant: a session must never be minted
 * broader than what resolution would honor. Privileged door.
 */
export async function mintSession(
  tx: Queryable,
  userId: string,
  tenantId: string,
  ttlMinutes = 60 * 24,
): Promise<string> {
  if (ttlMinutes <= 0) throw new Error('sessions: ttlMinutes must be positive')
  const member = await tx.query<{ id: string }>(
    'SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2',
    [userId, tenantId],
  )
  if (member.length === 0) throw new Error('sessions: user is not a member of that tenant')

  const token = randomBytes(32).toString('hex')
  await tx.query(
    `INSERT INTO sessions (token_digest, user_id, active_tenant_id, expires_at)
          VALUES ($1, $2, $3, now() + ($4::int * interval '1 minute'))`,
    [digest(token), userId, tenantId, ttlMinutes],
  )
  return token
}

/**
 * Resolves a bearer token to the request context it authorizes, or null.
 * Null covers every refusal the same way — unknown token, expired session,
 * membership since revoked — because a 401 should not say which. The role is
 * read at RESOLUTION time, not mint time: a demotion takes effect on the
 * member's next request, not at their next login. Privileged door.
 */
export async function resolveSession(tx: Queryable, token: string): Promise<ResolvedSession | null> {
  const rows = await tx.query<{ user_id: string; active_tenant_id: string; role: string }>(
    `SELECT s.user_id, s.active_tenant_id, m.role
       FROM sessions s
       JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.active_tenant_id
      WHERE s.token_digest = $1
        AND s.expires_at > now()`,
    [digest(token)],
  )
  if (rows.length === 0) return null
  const role = rows[0].role as TenantRole
  if (!TENANT_ROLES.includes(role)) return null
  return { userId: rows[0].user_id, tenantId: rows[0].active_tenant_id, role }
}
