/**
 * Phase C §C3 — prove the seat cap trigger enforces the entitlements row.
 *
 * Five seats fill, the sixth rejects with a seat-cap error, raising the cap
 * lets it in, and seatUsage agrees with the final state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { seatUsage } from '../src/db/lifecycle.ts'
import { asContext, freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let tenantId: string
let ownerId: string
const fillerIds: string[] = []

beforeAll(async () => {
  engine = await freshEngine()
  tenantId = await seedTenant(engine, 'seatcap')
  ownerId = await seedUser(engine, 'seatcap-owner')
  await seedMembership(engine, tenantId, ownerId, 'owner')

  for (let i = 1; i <= 5; i++) {
    fillerIds.push(await seedUser(engine, `seatcap-filler-${i}`))
  }
})

afterAll(async () => {
  if (!engine) return
  // Delete tenants first — memberships cascade from the tenant, and a
  // membership row outliving its tenant trips the last-owner trigger.
  await engine.query('DELETE FROM tenants WHERE id = $1', [tenantId])
  await engine.query('DELETE FROM users WHERE id = ANY($1)', [[ownerId, ...fillerIds]])
  await engine.close()
})

describe('the seat cap trigger enforces entitlements.seat_cap', () => {
  it('the entitlements row has seat_cap 5', async () => {
    const rows = await engine.query<{ seat_cap: string | number }>(
      'SELECT seat_cap FROM entitlements',
    )
    expect(Number(rows[0].seat_cap)).toBe(5)
  })

  it('adding four fillers succeeds — owner + four = five seats', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        seedMembership(engine, tenantId, fillerIds[i], 'member'),
      ).resolves.toBeDefined()
    }
  })

  it('adding the fifth filler rejects with seat cap error', async () => {
    await expect(
      seedMembership(engine, tenantId, fillerIds[4], 'member'),
    ).rejects.toThrow(/seat cap/i)
  })

  it('raising seat_cap to 6 lets the fifth filler in', async () => {
    await engine.query('UPDATE entitlements SET seat_cap = 6')
    await expect(
      seedMembership(engine, tenantId, fillerIds[4], 'member'),
    ).resolves.toBeDefined()
  })

  it('seatUsage reports { used: 6, cap: 6 } inside the owner context', async () => {
    const usage = await asContext(
      engine,
      { tenantId, userId: ownerId, role: 'owner' as const },
      seatUsage,
    )
    expect(usage).toEqual({ used: 6, cap: 6 })
  })
})
