/**
 * Test harness for the database layer.
 *
 * `freshEngine()` opens whichever engine the environment selects and brings it
 * up to date; `asTenant()` is the test-only stand-in for the request seam —
 * drop to app_user, publish the tenant context, always roll back.
 */
import { openEngine, type Engine, type Queryable } from '../../src/db/engine.ts'
import { migrate } from '../../src/db/migrate.ts'

export async function freshEngine(): Promise<Engine> {
  const engine = await openEngine()
  await migrate(engine)
  return engine
}

/** Creates a tenant as the owning role (which bypasses RLS) and returns its id. */
export async function seedTenant(engine: Engine, label: string): Promise<string> {
  const slug = `${label}-${Math.floor(Math.random() * 1e9).toString(36)}`
  const rows = await engine.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, label],
  )
  return rows[0].id
}

const ROLLBACK = Symbol('tenant-kernel:test-rollback')

function isRollback(err: unknown): err is { value: unknown } {
  return typeof err === 'object' && err !== null && ROLLBACK in err
}

/**
 * Runs `fn` with the privileges and context of one tenant, then rolls back.
 *
 * This is what every request will do once the real seam lands: SET LOCAL ROLE
 * so the statement runs as a role that owns nothing, then publish app.tenant_id
 * so the policies have something to compare against. Both are transaction-local,
 * so they cannot leak into the next transaction on the same connection.
 */
export async function asTenant<T>(
  engine: Engine,
  tenantId: string,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  try {
    return await engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_user')
      await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      const value = await fn(tx)
      throw { [ROLLBACK]: true, value }
    })
  } catch (err) {
    if (isRollback(err)) return err.value as T
    throw err
  }
}

/** Same, but with no tenant context published at all — the fail-closed case. */
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
