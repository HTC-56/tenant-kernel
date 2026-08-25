/**
 * The sessions data layer: minting is membership-gated, resolution returns
 * exactly a `withTenant` context, and every refusal is the same null. §E.
 * Gate: typecheck + test + scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { mintSession, resolveSession } from '../src/db/sessions.ts'
import { freshEngine, seedMembership, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let tenantId: string
let userId: string

beforeAll(async () => {
  engine = await freshEngine()
  tenantId = await seedTenant(engine, 'sessions-tenant')
  userId = await seedUser(engine, 'sessions-user')
  await seedMembership(engine, tenantId, userId, 'admin')
})

afterAll(async () => {
  await engine.close()
})

describe('sessions — mint and resolve', () => {
  it('a minted token resolves to user, tenant, and CURRENT role', async () => {
    const token = await mintSession(engine, userId, tenantId)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    const session = await resolveSession(engine, token)
    expect(session).toEqual({ userId, tenantId, role: 'admin' })
  })

  it('the raw token is never stored — only its digest is', async () => {
    const token = await mintSession(engine, userId, tenantId)
    const rows = await engine.query<{ token_digest: string }>('SELECT token_digest FROM sessions')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.token_digest).not.toBe(token)
  })

  it('an unknown token resolves to null', async () => {
    expect(await resolveSession(engine, 'f'.repeat(64))).toBeNull()
  })

  it('an expired session resolves to null', async () => {
    const token = await mintSession(engine, userId, tenantId, 30)
    await engine.query("UPDATE sessions SET expires_at = now() - interval '1 minute'")
    expect(await resolveSession(engine, token)).toBeNull()
  })

  it('a revoked membership takes the session with it', async () => {
    const goneTenant = await seedTenant(engine, 'sessions-revoked')
    const goneUser = await seedUser(engine, 'sessions-revoked')
    await seedMembership(engine, goneTenant, goneUser, 'member')
    const token = await mintSession(engine, goneUser, goneTenant)
    expect(await resolveSession(engine, token)).not.toBeNull()
    await engine.query('DELETE FROM memberships WHERE user_id = $1', [goneUser])
    expect(await resolveSession(engine, token)).toBeNull()
  })

  it('minting refuses a user with no membership in that tenant', async () => {
    const outsider = await seedUser(engine, 'sessions-outsider')
    await expect(mintSession(engine, outsider, tenantId)).rejects.toThrow(/not a member/)
  })

  it('a demotion shows on the NEXT resolution, not the next login', async () => {
    const demoTenant = await seedTenant(engine, 'sessions-demote')
    const demoUser = await seedUser(engine, 'sessions-demote')
    await seedMembership(engine, demoTenant, demoUser, 'admin')
    const token = await mintSession(engine, demoUser, demoTenant)
    await engine.query('UPDATE memberships SET role = $1 WHERE user_id = $2', ['member', demoUser])
    const session = await resolveSession(engine, token)
    expect(session?.role).toBe('member')
  })

  it('app_user holds no grant on sessions — the table is infrastructure', async () => {
    const rows = await engine.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM information_schema.role_table_grants
        WHERE table_name = 'sessions' AND grantee IN ('app_user', 'PUBLIC')`,
    )
    expect(Number(rows[0].n)).toBe(0)
  })
})
