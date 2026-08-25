/**
 * Phase C §C6 — prove that feature flags default to ON and that only an
 * explicit jsonb `false` switches one off, without hiding existing rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { asContext, freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let tenantId: string
let userId: string

beforeAll(async () => {
  engine = await freshEngine()

  tenantId = await seedTenant(engine, 'featureflags')
  userId = await seedUser(engine, 'featureflags-user')
  await seedMembership(engine, tenantId, userId, 'owner')

  await engine.query(
    'INSERT INTO projects (tenant_id, name) VALUES ($1, $2)',
    [tenantId, 'project-one'],
  )
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = $1', [tenantId])
  await engine.query('DELETE FROM users WHERE id = $1', [userId])
  await engine.close()
})

function setFlags(tid: string, flags: string): Promise<Record<string, unknown>[]> {
  return engine.query(
    // ::text::jsonb — the inner cast pins the PARAMETER's wire type to text.
    // With a bare ::jsonb the server declares the parameter jsonb and the
    // postgres.js driver re-serializes the already-encoded string into a
    // jsonb string scalar; PGlite sends text either way. Recorded in
    // DECISIONS.md as the one engine divergence found by the dual-engine CI.
    'UPDATE entitlements SET features = $2::text::jsonb WHERE tenant_id = $1',
    [tid, flags],
  )
}

describe('feature flags default to ON', () => {
  it('empty features — app_feature_enabled(projects) is true', async () => {
    await setFlags(tenantId, '{}')

    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ enabled: boolean }>("SELECT app_feature_enabled('projects') AS enabled"),
    )
    expect(rows[0].enabled).toBe(true)
  })

  it('empty features — INSERT INTO projects resolves', async () => {
    await setFlags(tenantId, '{}')

    await expect(
      asContext(
        engine,
        { tenantId, userId, role: 'owner' },
        (tx) => tx.query("INSERT INTO projects (name) VALUES ($1)", ['temporary']),
      ),
    ).resolves.toBeDefined()
  })

  it('projects: false — app_feature_enabled(projects) is false', async () => {
    await setFlags(tenantId, '{"projects": false}')

    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ enabled: boolean }>("SELECT app_feature_enabled('projects') AS enabled"),
    )
    expect(rows[0].enabled).toBe(false)
  })

  it('projects: false — INSERT INTO projects rejects with /row-level security/i', async () => {
    await setFlags(tenantId, '{"projects": false}')

    await expect(
      asContext(
        engine,
        { tenantId, userId, role: 'owner' },
        (tx) => tx.query("INSERT INTO projects (name) VALUES ($1)", ['blocked']),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('projects: false — SELECT id FROM projects still returns the fixture row', async () => {
    await setFlags(tenantId, '{"projects": false}')

    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ id: string }>('SELECT id FROM projects'),
    )
    expect(rows).toHaveLength(1)
  })

  it('projects: false — app_feature_enabled(something-else) is still true', async () => {
    await setFlags(tenantId, '{"projects": false}')

    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ enabled: boolean }>("SELECT app_feature_enabled('something-else') AS enabled"),
    )
    expect(rows[0].enabled).toBe(true)
  })
})
