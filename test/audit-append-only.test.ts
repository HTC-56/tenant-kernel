/**
 * Phase D: prove that audit_log is append-only — UPDATE and DELETE refuse
 * even for the table owner, app_user has no write grant, and the cascade
 * from a tenant delete is the one permitted exception.
 *
 * Mirror of `test/rls-refusal.test.ts` for file structure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { grantSupportAccess } from '../src/db/operator.ts'
import { withOperator } from '../src/db/seam.ts'
import {
  asTenant,
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

beforeAll(async () => {
  engine = await freshEngine()
  acme = await seedTenant(engine, 'acme')
  ann = await seedUser(engine, 'ann')
  await seedMembership(engine, acme, ann, 'owner')
  opal = await seedOperator(engine, 'opal')

  // Have opal grant support access on acme — that writes one
  // `support.grant` row into audit_log, so the trigger has rows to guard.
  await withOperator(engine, { operatorId: opal }, async (tx) => {
    await grantSupportAccess(tx, { tenantId: acme, reason: 'ticket 12', ttlMinutes: 30 })
  })
})

afterAll(async () => {
  if (!engine) return
  // Delete tenants first (audit rows and support grants cascade away with them),
  // then operators, then users, then close.
  await engine.query('DELETE FROM tenants WHERE id = $1', [acme])
  await engine.query('DELETE FROM operators WHERE id = $1', [opal])
  await engine.query('DELETE FROM users WHERE id = $1', [ann])
  await engine.close()
})

describe('audit_log refuses UPDATE and DELETE even for the table owner', () => {
  it('has at least one row so the trigger has something to guard', async () => {
    const [{ count }] = await engine.query<{ count: string }>(
      'SELECT count(*) FROM audit_log',
    )
    expect(Number(count)).toBeGreaterThanOrEqual(1)
  })

  it('rejects UPDATE on audit_log with append-only error', async () => {
    await expect(
      engine.query("UPDATE audit_log SET action = 'tampered'"),
    ).rejects.toThrow(/append-only/i)
  })

  it('rejects DELETE on audit_log with append-only error', async () => {
    await expect(engine.query('DELETE FROM audit_log')).rejects.toThrow(
      /append-only/i,
    )
  })
})

describe('app_user cannot insert into audit_log', () => {
  it('INSERT is refused by the missing write grant', async () => {
    await expect(
      asTenant(engine, acme, (tx) =>
        tx.query(
          "INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'forged')",
          [acme],
        ),
      ),
    ).rejects.toThrow(/denied|permission/i)
  })
})

describe('tenant delete cascade still works', () => {
  it('deleting a throwaway tenant resolves without error', async () => {
    const throwaway = await seedTenant(engine, 'throwaway-temp')
    await expect(
      engine.query('DELETE FROM tenants WHERE id = $1', [throwaway]),
    ).resolves.toBeDefined()
  })
})
