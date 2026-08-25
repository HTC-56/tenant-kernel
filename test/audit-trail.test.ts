/**
 * Phase D: prove the tenant half of feature 5 — a tenant reads its own audit
 * trail, only its own, and can still read it while suspended.
 *
 * Mirror of `test/rls-refusal.test.ts` for file structure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { grantSupportAccess, logOperatorAction, readAuditTrail } from '../src/db/operator.ts'
import { setTenantState } from '../src/db/lifecycle.ts'
import { withOperator } from '../src/db/seam.ts'
import {
  asContext,
  asTenant,
  freshEngine,
  seedMembership,
  seedOperator,
  seedTenant,
  seedUser,
} from './helpers/db.ts'

let engine: Engine
let acme: string
let beta: string
let ann: string
let opal: string

beforeAll(async () => {
  engine = await freshEngine()
  acme = await seedTenant(engine, 'acme')
  beta = await seedTenant(engine, 'beta')
  ann = await seedUser(engine, 'ann')
  await seedMembership(engine, acme, ann, 'owner')
  opal = await seedOperator(engine, 'opal')

  // Have opal grant support access on acme and log an action — in one
  // committing `withOperator` block, so both rows land together.
  await withOperator(engine, { operatorId: opal }, async (tx) => {
    await grantSupportAccess(tx, { tenantId: acme, reason: 'ticket 12', ttlMinutes: 30 })
  })
  // Separate transaction so the audit row gets a later timestamp.
  await withOperator(engine, { operatorId: opal }, async (tx) => {
    await logOperatorAction(tx, acme, 'project.read', { count: 1 })
  })
})

afterAll(async () => {
  if (!engine) return
  // Delete tenants first (audit rows and support grants cascade away),
  // then operators, then users, then close.
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[acme, beta]])
  await engine.query('DELETE FROM operators WHERE id = $1', [opal])
  await engine.query('DELETE FROM users WHERE id = $1', [ann])
  await engine.close()
})

describe('the audit trail shows one tenant\'s own entries, newest first', () => {
  it('readAcme returns 2 entries with actions sorted to ["project.read", "support.grant"]', async () => {
    const entries = await asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readAuditTrail)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.action).sort()).toEqual(['project.read', 'support.grant'])
  })

  it('every entry has reason "ticket 12" — the action inherits the grant\'s justification', async () => {
    const entries = await asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readAuditTrail)
    for (const entry of entries) {
      expect(entry.reason).toBe('ticket 12')
    }
  })

  it('the newest entry is first: entries[0].action is "project.read"', async () => {
    const entries = await asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readAuditTrail)
    expect(entries[0].action).toBe('project.read')
  })

  it('beta with no user or role reads an empty array', async () => {
    const entries = await asContext(engine, { tenantId: beta }, readAuditTrail)
    expect(entries).toEqual([])
  })
})

describe('a suspended tenant can still read its audit trail', () => {
  it('readAcme returns 2 entries while suspended, then resumes', async () => {
    // Suspend acme.
    await engine.transaction(async (tx) => {
      await setTenantState(tx, acme, 'suspended')
    })

    // The trail is still readable.
    const entries = await asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readAuditTrail)
    expect(entries).toHaveLength(2)

    // Resume so nothing later is affected.
    await engine.transaction(async (tx) => {
      await setTenantState(tx, acme, 'active')
    })
  })
})
