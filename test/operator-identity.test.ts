/**
 * Prove operator identity is a separate population: an operator holds no
 * membership, is invisible to tenants it never touched, visible to one it did,
 * and unwritable through the operator directory.
 *
 * Mirror of `test/rls-refusal.test.ts` — `freshEngine()` in `beforeAll`, one
 * assertion per `it`, cleanup in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { grantSupportAccess } from '../src/db/operator.ts'
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
  opal = await seedOperator(engine, 'opal')

  // Make ann the owner of acme.
  await seedMembership(engine, acme, ann, 'owner')

  // Grant opal operator access to acme (commits, so later assertions see it).
  await withOperator(engine, { operatorId: opal }, async (tx) => {
    await grantSupportAccess(tx, { tenantId: acme, reason: 'ticket 12', ttlMinutes: 30 })
  })
  // Nothing touches beta — the operator directory must be invisible to it.
})

afterAll(async () => {
  if (!engine) return
  // Delete tenants first (audit rows and support grants cascade away with them),
  // then opal from operators, then ann from users, then close.
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[acme, beta]])
  await engine.query('DELETE FROM operators WHERE id = $1', [opal])
  await engine.query('DELETE FROM users WHERE id = $1', [ann])
  await engine.close()
})

describe('operator identity is a separate population', () => {
  it('holds no membership anywhere', async () => {
    const rows = await engine.query<{ count: number }>(
      'SELECT count(*) FROM memberships WHERE user_id = $1',
      [opal],
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  it('acme sees exactly one operator row', async () => {
    const rows = await asContext(
      engine,
      { tenantId: acme, userId: ann, role: 'owner' },
      (tx) => tx.query<{ display_name: string }>('SELECT display_name FROM operators'),
    )
    expect(rows.map((r) => r.display_name)).toEqual(['opal'])
  })

  it('beta sees zero operator rows — never touched', async () => {
    const rows = await asContext(engine, { tenantId: beta }, (tx) =>
      tx.query<{ display_name: string }>('SELECT display_name FROM operators'),
    )
    expect(rows).toHaveLength(0)
  })

  it('acme cannot insert into operators — no write grant', async () => {
    await expect(
      asContext(engine, { tenantId: acme, userId: ann, role: 'owner' }, (tx) =>
        tx.query("INSERT INTO operators (email, display_name) VALUES ('x@example.com', 'x')"),
      ),
    ).rejects.toThrow(/denied|permission/i)
  })
})
