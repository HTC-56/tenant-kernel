/**
 * The served surface, composed: session-authed tenant API under /api,
 * bearer-authed operator API under /operator/api, the self-contained console
 * at /operator, and the ops pair /healthz + /metrics (SPEC.md features 3 and
 * 6–8). `buildServer` takes an open engine and a validated config and returns
 * a Fastify instance that has not started listening — which is exactly what
 * `fastify.inject()` tests want and what src/index.ts calls `.listen()` on.
 *
 * Metrics are a hand-rolled Prometheus text page: one counter family keyed by
 * (method, route template, status) — route TEMPLATE, so cardinality is bounded
 * by the route table, not by request paths.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ZodError } from 'zod'
import type { Config } from '../config.ts'
import type { Engine } from '../db/engine.ts'
import { withOperator } from '../db/seam.ts'
import { ensureOperator } from '../db/overview.ts'
import { sessionPlugin } from './session-plugin.ts'
import { tenantRoutes } from './tenant-routes.ts'
import { operatorRoutes } from './operator-routes.ts'

const CONSOLE_PATH = fileURLToPath(new URL('../console/console.html', import.meta.url))

export async function buildServer(engine: Engine, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // The configured console identity, pinned to one operator row at boot.
  const operatorId = await withOperator(engine, (tx) =>
    ensureOperator(tx, config.operator.email, config.operator.name),
  )

  // A zod refusal is the caller's malformed request, never a 500.
  app.setErrorHandler(async (err, _request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid request',
        detail: err.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      })
    }
    app.log.error(err)
    return reply.code(500).send({ error: 'internal error' })
  })

  // ------------------------------------------------------------- metrics --
  const startedAt = Date.now()
  const requests = new Map<string, number>()

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched'
    const key = `${request.method}\t${route}\t${reply.statusCode}`
    requests.set(key, (requests.get(key) ?? 0) + 1)
  })

  app.get('/healthz', async () => {
    await withOperator(engine, (tx) => tx.query('SELECT 1'))
    return { ok: true, engine: engine.kind }
  })

  app.get('/metrics', async (_request, reply) => {
    const lines: string[] = [
      '# HELP tenant_kernel_uptime_seconds Seconds since the server started.',
      '# TYPE tenant_kernel_uptime_seconds gauge',
      `tenant_kernel_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(0)}`,
      '# HELP tenant_kernel_http_requests_total Requests served, by route template.',
      '# TYPE tenant_kernel_http_requests_total counter',
    ]
    for (const [key, count] of [...requests.entries()].sort()) {
      const [method, route, status] = key.split('\t')
      lines.push(
        `tenant_kernel_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`,
      )
    }
    return reply.type('text/plain; version=0.0.4').send(lines.join('\n') + '\n')
  })

  // ------------------------------------------------------------- surfaces --
  await app.register(
    async (scope) => {
      sessionPlugin(scope, engine)
      tenantRoutes(scope, engine)
    },
    { prefix: '/api' },
  )

  await app.register(
    async (scope) => {
      operatorRoutes(scope, { engine, config, operatorId })
    },
    { prefix: '/operator/api' },
  )

  // One self-contained file, read per request so a redeploy needs no restart
  // dance; it is small and the console is not a hot path.
  app.get('/operator', async (_request, reply) => {
    const html = await readFile(CONSOLE_PATH, 'utf8')
    return reply.type('text/html; charset=utf-8').send(html)
  })

  return app
}
