/**
 * The Fastify half of SPEC.md feature 3: session token → user → active tenant,
 * resolved once per request, before any handler runs.
 *
 * The plugin decorates the request with the `RequestContext` the seam needs
 * and nothing more — handlers still go through `withTenant()` for every query,
 * so the plugin grants no data access by itself. Resolution runs on the
 * privileged connection (the bare operator door): it happens before a tenant
 * context exists, which is exactly why sessions are not tenant-scoped rows.
 *
 * Every refusal is the same 401 — missing header, malformed header, unknown
 * token, expired session, revoked membership — because a login prompt that
 * explains WHICH check failed is an oracle.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Engine } from '../db/engine.ts'
import { withOperator, type RequestContext } from '../db/seam.ts'
import { resolveSession } from '../db/sessions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session plugin on /api routes; absent means unauthenticated. */
    tenantCtx: RequestContext | null
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, token, extra] = header.split(' ')
  if (scheme !== 'Bearer' || !token || extra !== undefined) return null
  return token
}

/** Registers the resolution hook on the instance it is given (an /api scope). */
export function sessionPlugin(app: FastifyInstance, engine: Engine): void {
  app.decorateRequest('tenantCtx', null)

  app.addHook('onRequest', async (request, reply) => {
    const token = bearerToken(request)
    if (token === null) {
      await reply.code(401).send({ error: 'unauthorized' })
      return reply
    }
    const session = await withOperator(engine, (tx) => resolveSession(tx, token))
    if (session === null) {
      await reply.code(401).send({ error: 'unauthorized' })
      return reply
    }
    request.tenantCtx = {
      tenantId: session.tenantId,
      userId: session.userId,
      role: session.role,
    }
  })
}
