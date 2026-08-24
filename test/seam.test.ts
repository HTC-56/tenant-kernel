/**
 * Prove that `withTenant()` — the only door into tenant data — does the right
 * thing with transactions, settings, privileges, and validation.
 *
 * §B3 proved what the database refuses; this proves the wrapper around it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { withTenant } from '../src/db/seam.ts'
import { freshEngine, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let tenantId: string
let userId: string

beforeAll(async () => {
  engine = await freshEngine()
  tenantId = await seedTenant(engine, 'seam-tenant')
  userId = await seedUser(engine, 'seam-user')
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = $1', [tenantId])
  await engine.query('DELETE FROM users WHERE id = $1', [userId])
  await engine.close()
})

describe('withTenant', () => {
  it('commits on return', async () => {
    // Insert a project inside withTenant and verify it survives after.
    await withTenant(engine, { tenantId }, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        'INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id',
        [tenantId, 'committed-project'],
      )
      const insertedId = rows[0].id

      // Inside the same transaction, the row is visible.
      const check = await tx.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1',
        [insertedId],
      )
      expect(check).toHaveLength(1)
    })

    // After withTenant returns, the row is still there (committed).
    const surviving = await engine.query<{ id: string }>(
      'SELECT id FROM projects WHERE name = $1',
      ['committed-project'],
    )
    expect(surviving).toHaveLength(1)
  })

  it('rolls back on throw', async () => {
    await expect(
      withTenant(engine, { tenantId }, async (tx) => {
        await tx.query(
          'INSERT INTO projects (tenant_id, name) VALUES ($1, $2)',
          [tenantId, 'doomed'],
        )
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The insert is gone — rolled back.
    const surviving = await engine.query<{ id: string }>(
      'SELECT id FROM projects WHERE name = $1',
      ['doomed'],
    )
    expect(surviving).toEqual([])
  })

  it('publishes all three settings', async () => {
    const rows = await withTenant(
      engine,
      { tenantId, userId, role: 'owner' },
      async (tx) =>
        tx.query<{
          tenant_id: string
          user_id: string
          role: string
        }>(
          `SELECT
             current_setting('app.tenant_id', true) AS tenant_id,
             current_setting('app.user_id', true) AS user_id,
             current_setting('app.role', true) AS role`,
        ),
    )

    expect(rows[0].tenant_id).toBe(tenantId)
    expect(rows[0].user_id).toBe(userId)
    expect(rows[0].role).toBe('owner')
  })

  it('drops privileges', async () => {
    const rows = await withTenant(
      engine,
      { tenantId, userId, role: 'owner' },
      async (tx) => tx.query<{ role_name: string }>('SELECT current_user AS role_name'),
    )

    expect(rows[0].role_name).toBe('app_user')
  })

  it('validates before opening a transaction', async () => {
    // Bad tenantId — not a uuid.
    await expect(
      withTenant(
        engine,
        { tenantId: 'not-a-uuid' } as never,
        async () => ({}) as never,
      ),
    ).rejects.toThrow(/not a uuid/)

    // Bad role — not in TENANT_ROLES.
    await expect(
      withTenant(
        engine,
        { tenantId, role: 'wizard' as never },
        async () => ({}) as never,
      ),
    ).rejects.toThrow(/role must be/i)
  })
})
