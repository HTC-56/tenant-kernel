/**
 * Phase C §C4 — prove the last-owner trigger protects a tenant from being
 * left without an owner, while still letting it be deleted.
 *
 * Two tenants: acme (one owner, ann) and beta (two owners, cara and dan).
 * Every assertion runs inside `asContext(…, owner)` so nothing leaks across
 * `it` blocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { changeRole, removeMember } from '../src/db/lifecycle.ts'
import { asContext, freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let acmeId: string
let annId: string
let betaId: string
let caraId: string
let danId: string

beforeAll(async () => {
  engine = await freshEngine()

  // acme — exactly one member, ann, role owner
  acmeId = await seedTenant(engine, 'acme')
  annId = await seedUser(engine, 'ann')
  await seedMembership(engine, acmeId, annId, 'owner')

  // beta — two members, both owners
  betaId = await seedTenant(engine, 'beta')
  caraId = await seedUser(engine, 'cara')
  danId = await seedUser(engine, 'dan')
  await seedMembership(engine, betaId, caraId, 'owner')
  await seedMembership(engine, betaId, danId, 'owner')
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[acmeId, betaId]])
  await engine.query('DELETE FROM users WHERE id = ANY($1)', [[annId, caraId, danId]])
  await engine.close()
})

describe('the last-owner trigger prevents stranding a tenant', () => {
  it('demoting acme\'s only owner rejects with /last owner/i', async () => {
    await expect(
      asContext(engine, { tenantId: acmeId, userId: annId, role: 'owner' }, (tx) =>
        changeRole(tx, annId, 'member'),
      ),
    ).rejects.toThrow(/last owner/i)
  })

  it('removing acme\'s only owner rejects with /last owner/i', async () => {
    await expect(
      asContext(engine, { tenantId: acmeId, userId: annId, role: 'owner' }, (tx) =>
        removeMember(tx, annId),
      ),
    ).rejects.toThrow(/last owner/i)
  })

  it('demoting one of beta\'s two owners succeeds — dan is still an owner', async () => {
    const result = await asContext(engine, { tenantId: betaId, userId: caraId, role: 'owner' }, (tx) =>
      changeRole(tx, caraId, 'member'),
    )
    expect(result).toBe(true)
  })

  it('removing a member of another tenant returns false — RLS hides them', async () => {
    const result = await asContext(engine, { tenantId: acmeId, userId: danId, role: 'owner' }, (tx) =>
      removeMember(tx, danId),
    )
    expect(result).toBe(false)
  })

  it('a throwaway tenant with one owner still deletes — CASCADE cleans up memberships', async () => {
    const tid = await seedTenant(engine, 'teardown')
    const uid = await seedUser(engine, 'teardown-owner')
    await seedMembership(engine, tid, uid, 'owner')

    await engine.query('DELETE FROM tenants WHERE id = $1', [tid])

    // tenants row gone
    const tenants = await engine.query('SELECT count(*) AS c FROM tenants WHERE id = $1', [tid])
    expect(Number(tenants[0].c)).toBe(0)

    // membership cascaded away too
    const mems = await engine.query('SELECT count(*) AS c FROM memberships WHERE tenant_id = $1', [tid])
    expect(Number(mems[0].c)).toBe(0)
  })
})
