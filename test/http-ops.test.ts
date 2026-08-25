/**
 * The ops surface: /healthz proves the database answers, /metrics renders
 * Prometheus text keyed by route TEMPLATE, and every operator mutation lands
 * one parseable JSONL line in the ops ledger. §E.
 * Gate: typecheck + test + scrub.
 */
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  asBearer,
  closeServer,
  freshServer,
  OPERATOR_TOKEN,
  type TestServer,
} from './helpers/http.ts'

let server: TestServer

beforeAll(async () => {
  server = await freshServer()
})

afterAll(async () => {
  await closeServer(server)
})

describe('/healthz', () => {
  it('answers ok and names the engine', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, engine: server.engine.kind })
  })
})

describe('/metrics', () => {
  it('renders Prometheus text with route templates, not raw paths', async () => {
    await server.app.inject({
      method: 'GET',
      url: '/api/projects/2c8e7f00-0000-4000-8000-000000000000',
      headers: asBearer('0'.repeat(64)),
    })
    const res = await server.app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('# TYPE tenant_kernel_http_requests_total counter')
    expect(res.body).toContain('route="/api/projects/:id"')
    expect(res.body).not.toContain('2c8e7f00')
    expect(res.body).toContain('tenant_kernel_uptime_seconds')
  })
})

describe('the JSONL ops ledger', () => {
  it('one operator mutation, one parseable line', async () => {
    const slug = `ops-ledger-${Math.floor(Math.random() * 1e9).toString(36)}`
    const created = await server.app.inject({
      method: 'POST',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
      payload: { slug, name: 'Ledger Co', ownerEmail: 'ops@example.com', ownerName: 'Ops' },
    })
    expect(created.statusCode).toBe(201)

    const lines = (await readFile(server.ledgerPath, 'utf8')).trim().split('\n')
    const entries = lines.map((line) => JSON.parse(line))
    const entry = entries.find((e) => e.slug === slug)
    expect(entry.action).toBe('tenant.provision')
    expect(entry.tenantId).toBe(created.json().id)
    expect(typeof entry.operatorId).toBe('string')
    expect(new Date(entry.ts).getTime()).toBeGreaterThan(0)
  })

  it('reads are not ledgered — the file is a mutation trail', async () => {
    const before = (await readFile(server.ledgerPath, 'utf8')).trim().split('\n').length
    await server.app.inject({
      method: 'GET',
      url: '/operator/api/tenants',
      headers: asBearer(OPERATOR_TOKEN),
    })
    const after = (await readFile(server.ledgerPath, 'utf8')).trim().split('\n').length
    expect(after).toBe(before)
  })
})
