/**
 * The operator console ships as ONE self-contained page: no framework, no
 * build step, no external request of any kind — the test enforces the
 * "self-contained" clause of SPEC.md feature 8 as text properties. §E.
 * Gate: typecheck + test + scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeServer, freshServer, type TestServer } from './helpers/http.ts'

let server: TestServer
let html: string

beforeAll(async () => {
  server = await freshServer()
  const res = await server.app.inject({ method: 'GET', url: '/operator' })
  expect(res.statusCode).toBe(200)
  html = res.body
})

afterAll(async () => {
  await closeServer(server)
})

describe('GET /operator', () => {
  it('serves html without auth — the data behind it is what the bearer gates', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/operator' })
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('operator console')
  })

  it('references no external URL — no CDN, no fonts, no telemetry', () => {
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']https?:\/\//i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(\s*["']?https?:/i)
  })

  it('carries no framework and no build artifacts', () => {
    expect(html).not.toMatch(/react|vue|angular|svelte|webpack|vite/i)
    expect(html).toContain('<script>')
    expect(html).not.toMatch(/<script[^>]+src=/i)
  })

  it('talks only to its own operator API', () => {
    const fetches = [...html.matchAll(/fetch\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2])
    expect(fetches.length).toBeGreaterThan(0)
    for (const target of fetches) expect(target.startsWith('/operator/api')).toBe(true)
  })
})
