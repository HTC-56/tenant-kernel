/**
 * The context seam — the only door into tenant data.
 *
 * Every request runs inside `withTenant()`: one transaction that first drops to
 * `app_user` (a role that owns no tables and is not a superuser) and then
 * publishes the request context with `SET LOCAL` semantics, so the policies in
 * sql/ have something to compare against. Because both the role change and the
 * settings are transaction-local, nothing can leak into the next transaction on
 * the same pooled connection.
 *
 * Nothing above this file should ever hold an Engine. Handlers take the
 * `Queryable` the seam hands them; test/seam-only.test.ts enforces that.
 */
import type { Engine, Queryable } from './engine.ts'

/** The membership roles sql/0002_identity.sql will accept. */
export const TENANT_ROLES = ['owner', 'admin', 'member'] as const
export type TenantRole = (typeof TENANT_ROLES)[number]

/**
 * Who this transaction is acting as. `userId` and `role` are optional because
 * some paths legitimately have a tenant but no user yet (accepting an invite,
 * a health probe against a tenant). Absent means "publish nothing", which the
 * policies read as NULL, which refuses.
 */
export interface RequestContext {
  readonly tenantId: string
  readonly userId?: string | null
  readonly role?: TenantRole | null
}

/** The three settings, already validated and flattened to strings for the wire. */
export interface ContextSettings {
  readonly tenantId: string
  readonly userId: string
  readonly role: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`seam: ${field} is not a uuid`)
  }
  return value
}

/**
 * Validates a context and flattens it for `set_config`. Empty string is how a
 * value says "unset": `app_current_tenant()` and friends nullif('') it back to
 * NULL, so an empty setting fails closed exactly like a missing one.
 *
 * Validating here — before any transaction is opened — means a malformed id is
 * a caller error, not a database error seen halfway through a request.
 */
export function normalizeContext(ctx: RequestContext): ContextSettings {
  const tenantId = requireUuid(ctx.tenantId, 'tenantId')
  const userId = ctx.userId == null ? '' : requireUuid(ctx.userId, 'userId')
  const role = ctx.role == null ? '' : ctx.role
  if (role !== '' && !TENANT_ROLES.includes(role)) {
    throw new Error(`seam: role must be one of ${TENANT_ROLES.join(', ')}`)
  }
  return { tenantId, userId, role }
}

async function publish(tx: Queryable, settings: ContextSettings): Promise<void> {
  // Order matters: drop privileges first, so even a failure publishing the
  // settings leaves the transaction as a role that can see nothing.
  await tx.query('SET LOCAL ROLE app_user')
  await tx.query("SELECT set_config('app.tenant_id', $1, true)", [settings.tenantId])
  await tx.query("SELECT set_config('app.user_id', $1, true)", [settings.userId])
  await tx.query("SELECT set_config('app.role', $1, true)", [settings.role])
}

/**
 * Publishes a context onto an already-open transaction. Split out from
 * `withTenant` so the test harness can publish the same context and then roll
 * back — there is one implementation of "how context is published", not two.
 */
export async function applyContext(tx: Queryable, ctx: RequestContext): Promise<void> {
  await publish(tx, normalizeContext(ctx))
}

/**
 * Runs `fn` as one tenant, in one transaction. Commits on return, rolls back on
 * throw. This is the seam: no query path exists outside it.
 */
export async function withTenant<T>(
  engine: Engine,
  ctx: RequestContext,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const settings = normalizeContext(ctx)
  return engine.transaction(async (tx) => {
    await publish(tx, settings)
    return fn(tx)
  })
}
