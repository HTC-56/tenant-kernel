/**
 * Phase D: prove that support-grant reason and TTL are real constraints,
 * and that lapsed / revoked grants cannot record actions.
 *
 * Every `it` uses `asOperator`, which rolls back, so no `it` depends on
 * another — except test 5, which plants a lapsed grant outside the rollback
 * and then asserts the refusal inside. The rollback is what keeps the test
 * from leaving debris; the planted grant is the fixture the assertion reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import {
  grantSupportAccess,
  logOperatorAction,
  revokeSupportAccess,
} from '../src/db/operator.ts'
import { asOperator, freshEngine, seedOperator, seedSupportGrant, seedTenant } from './helpers/db.ts'

let engine: Engine
let acme: string
let opal: string

beforeAll(async () => {
  engine = await freshEngine()
  acme = await seedTenant(engine, 'acme')
  opal = await seedOperator(engine, 'opal')
})

afterAll(async () => {
  if (!engine) return
  // Delete tenants first — audit rows and support grants cascade away with
  // them. An operator with audit history cannot be deleted before its
  // tenant (the foreign key has no ON DELETE clause on purpose).
  await engine.query('DELETE FROM tenants WHERE id = $1', [acme])
  await engine.query('DELETE FROM operators WHERE id = $1', [opal])
  await engine.close()
})

describe('grant_support_access gates on context, reason, and TTL', () => {
  it('rejects when no operator is published', async () => {
    await expect(
      engine.transaction((tx) =>
        grantSupportAccess(tx, { tenantId: acme, reason: 'fix', ttlMinutes: 30 }),
      ),
    ).rejects.toThrow(/operator context required/i)
  })

  it('rejects a blank reason (whitespace only)', async () => {
    await expect(
      asOperator(engine, opal, (tx) =>
        grantSupportAccess(tx, { tenantId: acme, reason: '   ', ttlMinutes: 30 }),
      ),
    ).rejects.toThrow(/requires a reason/i)
  })

  it('rejects ttlMinutes of zero', async () => {
    await expect(
      asOperator(engine, opal, (tx) =>
        grantSupportAccess(tx, { tenantId: acme, reason: 'ticket 12', ttlMinutes: 0 }),
      ),
    ).rejects.toThrow(/positive ttl/i)
  })

  it('resolves to a grant id with valid reason and TTL', async () => {
    const grantId = await asOperator(engine, opal, (tx) =>
      grantSupportAccess(tx, { tenantId: acme, reason: 'ticket 12', ttlMinutes: 30 }),
    )
    expect(typeof grantId).toBe('string')
    expect(grantId.length).toBeGreaterThan(0)
  })
})

describe('lapsed and revoked grants cannot record actions', () => {
  it('a lapsed grant (negative TTL) refuses logOperatorAction', async () => {
    // Plant a lapsed grant outside the rollback — seedSupportGrant runs
    // as the migrating role and bypasses RLS, so we can reach the table.
    await seedSupportGrant(engine, acme, opal, 'old', -60)

    await expect(
      asOperator(engine, opal, (tx) =>
        logOperatorAction(tx, acme, 'project.read'),
      ),
    ).rejects.toThrow(/no active support grant/i)
  })

  it('a revoked grant refuses logOperatorAction in the same transaction', async () => {
    // Plant a live grant, revoke it, then try to log — all in one
    // rolled-back transaction so the test is fully self-contained.
    await asOperator(engine, opal, async (tx) => {
      const grantId = await grantSupportAccess(tx, {
        tenantId: acme,
        reason: 'revoked',
        ttlMinutes: 60,
      })
      await revokeSupportAccess(tx, grantId)
      await expect(
        logOperatorAction(tx, acme, 'project.read'),
      ).rejects.toThrow(/no active support grant/i)
    })
  })
})
