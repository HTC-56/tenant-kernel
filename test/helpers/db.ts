/**
 * Test harness for the database layer.
 *
 * `freshEngine()` opens whichever engine the environment selects and brings it
 * up to date. The `as*` runners publish a request context exactly the way
 * src/db/seam.ts does — they call into the seam for that, so there is one
 * implementation of context publishing — and then always roll back, which keeps
 * a shared real-Postgres database as clean as an in-process PGlite one.
 *
 * The `seed*` helpers run as the migrating role, which is a superuser and so
 * bypasses RLS; that is how a fixture plants rows a tenant could never plant
 * for itself.
 */
import { openEngine, type Engine, type Queryable } from '../../src/db/engine.ts'
import { migrate } from '../../src/db/migrate.ts'
import { applyContext, type RequestContext, type TenantRole } from '../../src/db/seam.ts'

export async function freshEngine(): Promise<Engine> {
  const engine = await openEngine()
  await migrate(engine)
  return engine
}

/** A random suffix, so fixtures never collide inside a shared database. */
function unique(label: string): string {
  return `${label}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** Creates a tenant as the owning role (which bypasses RLS) and returns its id. */
export async function seedTenant(engine: Engine, label: string): Promise<string> {
  const rows = await engine.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [unique(label), label],
  )
  return rows[0].id
}

/** Creates a global user and returns its id. Email is unique per call. */
export async function seedUser(engine: Engine, label: string): Promise<string> {
  const rows = await engine.query<{ id: string }>(
    'INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id',
    [`${unique(label)}@example.com`, label],
  )
  return rows[0].id
}

/** Joins a user to a tenant with a role, bypassing the admin-gated policy. */
export async function seedMembership(
  engine: Engine,
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<string> {
  const rows = await engine.query<{ id: string }>(
    'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, userId, role],
  )
  return rows[0].id
}

const ROLLBACK = Symbol('tenant-kernel:test-rollback')

function isRollback(err: unknown): err is { value: unknown } {
  return typeof err === 'object' && err !== null && ROLLBACK in err
}

/**
 * Runs `fn` with the privileges and context of one request, then rolls back.
 *
 * Same door as `withTenant()` — `applyContext` is the seam's own publisher —
 * except that this one never commits, so an assertion about a refused write
 * cannot leave debris behind.
 */
export async function asContext<T>(
  engine: Engine,
  ctx: RequestContext,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  try {
    return await engine.transaction(async (tx) => {
      await applyContext(tx, ctx)
      const value = await fn(tx)
      throw { [ROLLBACK]: true, value }
    })
  } catch (err) {
    if (isRollback(err)) return err.value as T
    throw err
  }
}

/** The common case: a tenant with no user and no role published. */
export async function asTenant<T>(
  engine: Engine,
  tenantId: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  return asContext(engine, { tenantId }, fn)
}

/** No context published at all — the fail-closed case. */
export async function asTenantless<T>(engine: Engine, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  try {
    return await engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_user')
      const value = await fn(tx)
      throw { [ROLLBACK]: true, value }
    })
  } catch (err) {
    if (isRollback(err)) return err.value as T
    throw err
  }
}
