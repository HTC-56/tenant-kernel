/**
 * Phase C §C7 — drive src/db/lifecycle.ts end to end: provision a tenant,
 * then redeem an invite into it from another tenant's transaction.
 *
 * Both withOperator and withTenant commit, so we keep all ids and clean up
 * in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { acceptInvite, provisionTenant } from '../src/db/lifecycle.ts'
import { withOperator, withTenant } from '../src/db/seam.ts'
import { asContext, freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let fixtureTenantId: string
let fixtureUserId: string
let joinerId: string

beforeAll(async () => {
  engine = await freshEngine()

  // Fixture tenant — used as the acting context for accept calls
  fixtureTenantId = await seedTenant(engine, 'lifecycle-fixture')
  fixtureUserId = await seedUser(engine, 'lifecycle-fixture-user')
  await seedMembership(engine, fixtureTenantId, fixtureUserId, 'owner')

  // Joiner — the user who will accept the invite
  joinerId = await seedUser(engine, 'lifecycle-joiner')
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[fixtureTenantId, provisionedTenantId]])
  await engine.query('DELETE FROM users WHERE id = ANY($1)', [[fixtureUserId, joinerId]])
  await engine.query(
    "DELETE FROM users WHERE email = 'lifecycle-provisioned-owner@example.com'",
  )
  await engine.close()
})

let provisionedTenantId: string
let inviteToken: string

describe('provisionTenant and acceptInvite drive the lifecycle seam', () => {
  it('provisionTenant creates a tenant, owner, and membership', async () => {
    provisionedTenantId = await withOperator(engine, (tx) =>
      provisionTenant(tx, {
        slug: 'provisioned',
        name: 'Provisioned',
        ownerEmail: 'provisioned-owner@example.com',
        ownerName: 'Provisioned Owner',
      }),
    )
    expect(provisionedTenantId).toBeDefined()

    // Exactly one membership
    const members = await engine.query(
      'SELECT count(*) AS c FROM memberships WHERE tenant_id = $1',
      [provisionedTenantId],
    )
    expect(Number(members[0].c)).toBe(1)

    // Role is owner
    const [row] = await engine.query<{ role: string }>(
      'SELECT role FROM memberships WHERE tenant_id = $1',
      [provisionedTenantId],
    )
    expect(row.role).toBe('owner')

    // Lowercased email in users
    const [user] = await engine.query<{ email: string }>(
      "SELECT email FROM users WHERE display_name = 'Provisioned Owner'",
    )
    expect(user.email).toBe('provisioned-owner@example.com')
  })

  it('the provisioned tenant has an entitlements row with seat_cap 5', async () => {
    const [row] = await engine.query<{ seat_cap: string | number }>(
      'SELECT seat_cap FROM entitlements WHERE tenant_id = $1',
      [provisionedTenantId],
    )
    expect(Number(row.seat_cap)).toBe(5)
  })

  it('acceptInvite joins a user into the provisioned tenant from the fixture tenant', async () => {
    // Plant a pending invite
    const inviteRows = await engine.query<{ id: string }>(
      `INSERT INTO invites (tenant_id, email, role, token, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')
       RETURNING id`,
      [provisionedTenantId, 'joiner@example.com', 'member', 'invite-token-1'],
    )
    inviteToken = inviteRows[0].id

    // Accept from the fixture tenant's context
    const result = await withTenant(engine, { tenantId: fixtureTenantId }, (tx) =>
      acceptInvite(tx, 'invite-token-1', joinerId),
    )
    expect(result).toBe(provisionedTenantId)

    // Invite state is now accepted
    const [inv] = await engine.query<{ state: string }>(
      "SELECT state FROM invites WHERE id = $1",
      [inviteToken],
    )
    expect(inv.state).toBe('accepted')

    // Joiner has a membership in the provisioned tenant
    const [mem] = await engine.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM memberships WHERE tenant_id = $1 AND user_id = $2',
      [provisionedTenantId, joinerId],
    )
    expect(mem.tenant_id).toBe(provisionedTenantId)
  })

  it('re-accepting the same token rejects with /already accepted/i', async () => {
    await expect(
      withTenant(engine, { tenantId: fixtureTenantId }, (tx) =>
        acceptInvite(tx, 'invite-token-1', joinerId),
      ),
    ).rejects.toThrow(/already accepted/i)
  })

  it('an unknown token rejects with /invite not found/i', async () => {
    await expect(
      withTenant(engine, { tenantId: fixtureTenantId }, (tx) =>
        acceptInvite(tx, 'nonexistent-token', joinerId),
      ),
    ).rejects.toThrow(/invite not found/i)
  })

  it('an expired invite rejects with /invite expired/i', async () => {
    // Plant an expired invite
    await engine.query(
      `INSERT INTO invites (tenant_id, email, role, token, expires_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 day')`,
      [provisionedTenantId, 'expired@example.com', 'member', 'expired-token'],
    )

    await expect(
      withTenant(engine, { tenantId: fixtureTenantId }, (tx) =>
        acceptInvite(tx, 'expired-token', joinerId),
      ),
    ).rejects.toThrow(/invite expired/i)
  })
})
