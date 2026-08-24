/**
 * Proves that the identity tables (users, memberships, invites, entitlements)
 * enforce row-level security across tenants, and that writes are gated on
 * `app.role`.
 *
 * Mirrors `test/rls-refusal.test.ts` for the `projects` table — same imports,
 * `freshEngine()` in `beforeAll`, fixture cleanup + `engine.close()` in
 * `afterAll`.  Every assertion runs inside `asContext`, which calls into
 * `applyContext` (the seam's own publisher) and then rolls back, so nothing
 * persists between tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import {
  asContext,
  freshEngine,
  seedMembership,
  seedTenant,
  seedUser,
} from './helpers/db.ts'

let engine: Engine
let alice: string
let bob: string
let ann: string
let bill: string

beforeAll(async () => {
  engine = await freshEngine()
  alice = await seedTenant(engine, 'alice')
  bob = await seedTenant(engine, 'bob')
  ann = await seedUser(engine, 'ann')
  bill = await seedUser(engine, 'bill')
  await seedMembership(engine, alice, ann, 'owner')
  await seedMembership(engine, bob, bill, 'owner')
})

describe('identity tables enforce cross-tenant refusal', () => {
  it('SELECT from users returns only users with shared membership', async () => {
    const rows = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'member' },
      (tx) => tx.query<{ id: string }>('SELECT id FROM users'),
    )
    expect(rows.map((r) => r.id)).toEqual([ann])
  })

  it('SELECT from memberships returns only the acting tenant', async () => {
    const rows = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'member' },
      (tx) => tx.query<{ tenant_id: string }>('SELECT tenant_id FROM memberships'),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].tenant_id).toBe(alice)
  })

  it('INSERT into memberships requires admin role; member is refused', async () => {
    await expect(
      asContext(
        engine,
        { tenantId: alice, userId: ann, role: 'member' },
        (tx) =>
          tx.query(
            'INSERT INTO memberships (user_id, role) VALUES ($1, $2)',
            [bill, 'member'],
          ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('INSERT into memberships by admin fills tenant_id default', async () => {
    const rows = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'admin' },
      (tx) =>
        tx.query<{ tenant_id: string }>(
          'INSERT INTO memberships (user_id, role) VALUES ($1, $2) RETURNING tenant_id',
          [bill, 'member'],
        ),
    )
    expect(rows[0].tenant_id).toBe(alice)
  })

  it('INSERT into memberships with another tenant rejects even as owner', async () => {
    await expect(
      asContext(
        engine,
        { tenantId: alice, userId: ann, role: 'owner' },
        (tx) =>
          tx.query(
            'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
            [bob, bill, 'member'],
          ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('entitlements are read-only to tenants', () => {
  it('SELECT seat_cap returns the trigger-created row', async () => {
    const rows = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'member' },
      (tx) => tx.query<{ seat_cap: number }>('SELECT seat_cap FROM entitlements'),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].seat_cap).toBe(5)
  })

  it('UPDATE entitlements is refused — no write grant exists', async () => {
    await expect(
      asContext(
        engine,
        { tenantId: alice, userId: ann, role: 'member' },
        (tx) => tx.query('UPDATE entitlements SET seat_cap = 999'),
      ),
    ).rejects.toThrow()
  })
})

describe('invites are write-gated by role', () => {
  it('INSERT into invites rejects for member', async () => {
    await expect(
      asContext(
        engine,
        { tenantId: alice, userId: ann, role: 'member' },
        (tx) =>
          tx.query(
            'INSERT INTO invites (email, role, token, expires_at) VALUES ($1, $2, $3, $4)',
            ['new@example.com', 'member', crypto.randomUUID(), new Date(Date.now() + 86400000).toISOString()],
          ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('INSERT into invites succeeds for owner', async () => {
    await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'owner' },
      (tx) =>
        tx.query(
          'INSERT INTO invites (email, role, token, expires_at) VALUES ($1, $2, $3, $4)',
          ['new@example.com', 'member', crypto.randomUUID(), new Date(Date.now() + 86400000).toISOString()],
        ),
    )
  })
})

afterAll(async () => {
  if (!engine) return
  // Memberships, invites, and entitlements cascade-delete with tenants.
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[alice, bob]])
  await engine.query('DELETE FROM users WHERE id = ANY($1)', [[ann, bill]])
  await engine.close()
})
