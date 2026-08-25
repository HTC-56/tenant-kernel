/**
 * The tenant API end to end: the session plugin refuses uniformly, and two
 * tenants using the same routes side by side cannot see each other — the
 * SPEC.md feature 6 demo, as inject()ed requests. §E.
 * Gate: typecheck + test + scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asBearer,
  closeServer,
  freshServer,
  seedTenantWithSession,
  type TestServer,
} from './helpers/http.ts'

let server: TestServer
let acme: { tenantId: string; userId: string; token: string }
let rival: { tenantId: string; userId: string; token: string }

beforeAll(async () => {
  server = await freshServer()
  acme = await seedTenantWithSession(server, 'http-acme')
  rival = await seedTenantWithSession(server, 'http-rival')
})

afterAll(async () => {
  await closeServer(server)
})

describe('session plugin — uniform 401', () => {
  it('no Authorization header', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(401)
  })

  it('malformed scheme', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Basic nope' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('unknown token', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: asBearer('0'.repeat(64)),
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('/api/me', () => {
  it('names the resolved user, tenant, role, and seats', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: asBearer(acme.token),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.userId).toBe(acme.userId)
    expect(body.tenantId).toBe(acme.tenantId)
    expect(body.role).toBe('owner')
    expect(body.tenant.state).toBe('active')
    expect(body.seats.used).toBe(1)
  })
})

describe('projects CRUD — two tenants, one route table', () => {
  let acmeProject: string

  it('acme creates and lists a project', async () => {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: asBearer(acme.token),
      payload: { name: 'Skunkworks' },
    })
    expect(created.statusCode).toBe(201)
    acmeProject = created.json().id

    const list = await server.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: asBearer(acme.token),
    })
    expect(list.json().map((p: { id: string }) => p.id)).toContain(acmeProject)
  })

  it("rival's list does not contain acme's project", async () => {
    const list = await server.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: asBearer(rival.token),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().map((p: { id: string }) => p.id)).not.toContain(acmeProject)
  })

  it("rival fetching acme's project BY ID is 404 — same as never existed", async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(rival.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it("rival cannot rename or delete acme's project — 404, nothing changed", async () => {
    const patch = await server.app.inject({
      method: 'PATCH',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(rival.token),
      payload: { name: 'Hijacked' },
    })
    expect(patch.statusCode).toBe(404)

    const del = await server.app.inject({
      method: 'DELETE',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(rival.token),
    })
    expect(del.statusCode).toBe(404)

    const still = await server.app.inject({
      method: 'GET',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(acme.token),
    })
    expect(still.statusCode).toBe(200)
    expect(still.json().name).toBe('Skunkworks')
  })

  it('acme renames and deletes its own project', async () => {
    const patch = await server.app.inject({
      method: 'PATCH',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(acme.token),
      payload: { name: 'Skunkworks II' },
    })
    expect(patch.statusCode).toBe(200)

    const del = await server.app.inject({
      method: 'DELETE',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(acme.token),
    })
    expect(del.statusCode).toBe(204)

    const gone = await server.app.inject({
      method: 'GET',
      url: `/api/projects/${acmeProject}`,
      headers: asBearer(acme.token),
    })
    expect(gone.statusCode).toBe(404)
  })

  it('a malformed project id is a 400, not a query', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/projects/not-a-uuid',
      headers: asBearer(acme.token),
    })
    expect(res.statusCode).toBe(400)
  })

  it('a blank name is a 400 from validation', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: asBearer(acme.token),
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('the tenant half of audited access', () => {
  it('audit trail and support grants read empty, not error', async () => {
    const audit = await server.app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: asBearer(acme.token),
    })
    expect(audit.statusCode).toBe(200)
    expect(Array.isArray(audit.json())).toBe(true)

    const grants = await server.app.inject({
      method: 'GET',
      url: '/api/support-grants',
      headers: asBearer(acme.token),
    })
    expect(grants.statusCode).toBe(200)
    expect(Array.isArray(grants.json())).toBe(true)
  })
})
