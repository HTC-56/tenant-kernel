/**
 * Phase C §C5 — prove that suspension is enforced at the database layer.
 *
 * A suspended tenant loses every tenant-scoped table through RESTRICTIVE RLS
 * policies, while its `tenants` row stays readable so the app can render
 * "you are suspended". Resume restores full access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { setTenantState } from '../src/db/lifecycle.ts'
import { withOperator } from '../src/db/seam.ts'
import { asContext, freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let tenantId: string
let userId: string

beforeAll(async () => {
  engine = await freshEngine()

  tenantId = await seedTenant(engine, 'suspended')
  userId = await seedUser(engine, 'suspended-user')
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

describe('suspension is enforced at the database layer', () => {
  it('while active, SELECT id FROM projects returns one row', async () => {
    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ id: string }>('SELECT id FROM projects'),
    )
    expect(rows).toHaveLength(1)
  })

  it('once suspended, projects / memberships / invites / entitlements / users all return empty', async () => {
    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'suspended'))

    const projects = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query('SELECT id FROM projects'),
    )
    expect(projects).toEqual([])

    const memberships = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query('SELECT id FROM memberships'),
    )
    expect(memberships).toEqual([])

    const invites = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query('SELECT id FROM invites'),
    )
    expect(invites).toEqual([])

    const entitlements = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query('SELECT tenant_id FROM entitlements'),
    )
    expect(entitlements).toEqual([])

    const users = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query('SELECT id FROM users'),
    )
    expect(users).toEqual([])

    // Resume so later tests don't inherit this state
    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'active'))
  })

  it('once suspended, SELECT state FROM tenants still returns one row with state = suspended', async () => {
    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'suspended'))

    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ state: string }>('SELECT state FROM tenants'),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('suspended')

    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'active'))
  })

  it('once suspended, INSERT INTO projects rejects with /row-level security/i', async () => {
    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'suspended'))

    await expect(
      asContext(
        engine,
        { tenantId, userId, role: 'owner' },
        (tx) => tx.query('INSERT INTO projects (name) VALUES ($1)', ['planted']),
      ),
    ).rejects.toThrow(/row-level security/i)

    await withOperator(engine, (tx) => setTenantState(tx, tenantId, 'active'))
  })

  it('after resuming, SELECT id FROM projects returns that one row again', async () => {
    // Already resumed in the previous it
    const rows = await asContext(
      engine,
      { tenantId, userId, role: 'owner' },
      (tx) => tx.query<{ id: string }>('SELECT id FROM projects'),
    )
    expect(rows).toHaveLength(1)
  })

  it('setTenantState with an unknown state rejects with /unknown tenant state/i', async () => {
    await expect(
      withOperator(engine, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setTenantState(tx, tenantId, 'wizard' as any),
      ),
    ).rejects.toThrow(/unknown tenant state/i)
  })
})
