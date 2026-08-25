/**
 * Prove the typed layer over `sql/0004_operator.sql` returns the camelCase
 * shapes the console and ops surface will read, and that a grant survives
 * its own revocation as history.
 *
 * Mirrors `test/rls-refusal.test.ts` for file structure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import {
  grantSupportAccess,
  readSupportGrants,
  revokeSupportAccess,
} from '../src/db/operator.ts'
import { withOperator } from '../src/db/seam.ts'
import {
  asContext,
  freshEngine,
  seedMembership,
  seedOperator,
  seedTenant,
  seedUser,
} from './helpers/db.ts'

let engine: Engine
let acme: string
let ann: string
let opal: string
let grantId: string

beforeAll(async () => {
  engine = await freshEngine()
  acme = await seedTenant(engine, 'acme')
  ann = await seedUser(engine, 'ann')
  await seedMembership(engine, acme, ann, 'owner')
  opal = await seedOperator(engine, 'opal')

  // Grant in a committing withOperator block so the audit row lands.
  ;({ grantId } = await withOperator(
    engine,
    { operatorId: opal },
    async (tx) => {
      const id = await grantSupportAccess(tx, {
        tenantId: acme,
        reason: 'ticket 12',
        ttlMinutes: 30,
      })
      return { grantId: id }
    },
  ))
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = $1', [acme])
  await engine.query('DELETE FROM operators WHERE id = $1', [opal])
  await engine.query('DELETE FROM users WHERE id = $1', [ann])
  await engine.close()
})

describe('readSupportGrants returns camelCase Date fields', () => {
  const readGrants = () =>
    asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readSupportGrants)

  it('returns one grant with the correct reason and operator, revokedAt null', async () => {
    const grants = await readGrants()
    expect(grants).toHaveLength(1)
    const g = grants[0]
    expect(g.reason).toBe('ticket 12')
    expect(g.operatorId).toBe(opal)
    expect(g.revokedAt).toBeNull()
  })

  it('expiresAt is later than grantedAt — both are Date instances', async () => {
    const grants = await readGrants()
    expect(grants[0].grantedAt instanceof Date).toBe(true)
    expect(grants[0].expiresAt instanceof Date).toBe(true)
    expect(grants[0].expiresAt.getTime()).toBeGreaterThan(grants[0].grantedAt.getTime())
  })
})

describe('revocation is history, not absence', () => {
  const readGrants = () =>
    asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, readSupportGrants)

  it('revokes and still returns the grant with a non-null revokedAt', async () => {
    await withOperator(engine, { operatorId: opal }, async (tx) => {
      await revokeSupportAccess(tx, grantId)
    })

    const grants = await readGrants()
    expect(grants).toHaveLength(1)
    expect(grants[0].revokedAt).not.toBeNull()
    expect(grants[0].revokedAt instanceof Date).toBe(true)
  })

  it('a second revoke on the same id rejects with /already revoked/i', async () => {
    await expect(
      withOperator(engine, { operatorId: opal }, async (tx) => {
        await revokeSupportAccess(tx, grantId)
      }),
    ).rejects.toThrow(/already revoked/i)
  })
})
