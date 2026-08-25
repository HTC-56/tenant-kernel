/**
 * The operator API: static bearer gates everything; provisioning audits;
 * suspending WITHOUT a live support grant is refused with 409 — the time box
 * is enforced by sql/0004, the API only surfaces it. §E.
 * Gate: typecheck + test + scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asBearer,
  closeServer,
  freshServer,
  OPERATOR_TOKEN,
  type TestServer,
} from './helpers/http.ts'

let server: TestServer
const slug = `op-acme-${Math.floor(Math.random() * 1e9).toString(36)}`
let tenantId: string

beforeAll(async () => {
  server = await freshServer()
})

afterAll(async () => {
  await closeServer(server)
})

describe('static bearer', () => {
  it('no token is 401', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/operator/api/tenants' })
    expect(res.statusCode).toBe(401)
  })

  it('a tenant session token is NOT an operator token', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/operator/api/tenants',
      headers: asBearer('0'.repeat(64)),
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('provision → list → state', () => {
  it('provisions a tenant and the audit feed shows it', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
      payload: { slug, name: 'Op Acme', ownerEmail: 'owner@example.com', ownerName: 'Owner' },
    })
    expect(created.statusCode).toBe(201)
    tenantId = created.json().id

    const audit = await server.app.inject({
      method: 'GET',
      url: '/operator/api/audit',
      headers: asBearer(OPERATOR_TOKEN),
    })
    const provisioned = audit
      .json()
      .find((e: { tenantId: string; action: string }) => e.tenantId === tenantId)
    expect(provisioned?.action).toBe('tenant.provision')
  })

  it('re-provisioning a taken slug is 409, not a 500', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
      payload: { slug, name: 'Op Acme Again', ownerEmail: 'again@example.com', ownerName: 'Again' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('the tenant table carries state, seats, and live-grant count', async () => {
    const list = await server.app.inject({
      method: 'GET',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
    })
    const row = list.json().find((t: { id: string }) => t.id === tenantId)
    expect(row.slug).toBe(slug)
    expect(row.state).toBe('active')
    expect(row.seatsUsed).toBe(1)
    expect(row.seatCap).toBeGreaterThan(0)
    expect(row.liveGrants).toBe(0)
  })

  it('suspending with NO live grant is refused — 409, state unchanged', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: `/operator/api/tenants/${tenantId}/state`,
      headers: asBearer(OPERATOR_TOKEN),
      payload: { state: 'suspended' },
    })
    expect(res.statusCode).toBe(409)

    const list = await server.app.inject({
      method: 'GET',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
    })
    expect(list.json().find((t: { id: string }) => t.id === tenantId).state).toBe('active')
  })

  it('suspending WITH a reason opens the time box and lands, audited with the reason', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: `/operator/api/tenants/${tenantId}/state`,
      headers: asBearer(OPERATOR_TOKEN),
      payload: { state: 'suspended', reason: 'billing dispute — ticket 4412', ttlMinutes: 15 },
    })
    expect(res.statusCode).toBe(200)

    const audit = await server.app.inject({
      method: 'GET',
      url: '/operator/api/audit',
      headers: asBearer(OPERATOR_TOKEN),
    })
    const entry = audit
      .json()
      .find((e: { tenantId: string; action: string }) => e.tenantId === tenantId && e.action === 'tenant.state')
    expect(entry.reason).toContain('billing dispute')
  })

  it('the open grant is listed live, then revoked away', async () => {
    const live = await server.app.inject({
      method: 'GET',
      url: '/operator/api/support-grants',
      headers: asBearer(OPERATOR_TOKEN),
    })
    const grant = live.json().find((g: { tenantId: string }) => g.tenantId === tenantId)
    expect(grant).toBeDefined()

    const revoke = await server.app.inject({
      method: 'POST',
      url: `/operator/api/support-grants/${grant.id}/revoke`,
      headers: asBearer(OPERATOR_TOKEN),
    })
    expect(revoke.statusCode).toBe(200)

    const after = await server.app.inject({
      method: 'GET',
      url: '/operator/api/support-grants',
      headers: asBearer(OPERATOR_TOKEN),
    })
    expect(after.json().find((g: { id: string }) => g.id === grant.id)).toBeUndefined()
  })

  it('a blank reason on a standalone grant is a 400 from validation', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/operator/api/support-grants',
      headers: asBearer(OPERATOR_TOKEN),
      payload: { tenantId, reason: '', ttlMinutes: 15 },
    })
    expect(res.statusCode).toBe(400)
  })
})
