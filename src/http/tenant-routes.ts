/**
 * The tenant-facing API: /api/me, projects CRUD (SPEC.md feature 6), and the
 * tenant half of feature 5 — a tenant reading its own audit trail and support
 * grants. Every handler is one `withTenant()` call; the handlers contain no
 * authorization logic because the policies in sql/ ARE the authorization.
 *
 * A project of another tenant and a project that never existed are both 404 —
 * RLS makes them the same empty result, and the API refuses to know more.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Engine } from '../db/engine.ts'
import { withTenant, type RequestContext } from '../db/seam.ts'
import {
  createProject,
  getProject,
  listProjects,
  removeProject,
  renameProject,
} from '../db/projects.ts'
import { readAuditTrail, readSupportGrants } from '../db/operator.ts'
import { seatUsage } from '../db/lifecycle.ts'

const ProjectBody = z.object({ name: z.string().min(1).max(200) })
const IdParams = z.object({ id: z.uuid() })

/** The session plugin ran first, so a null context here is a programming error. */
function ctxOf(raw: RequestContext | null): RequestContext {
  if (raw === null) throw new Error('tenant-routes: no session context on request')
  return raw
}

export function tenantRoutes(app: FastifyInstance, engine: Engine): void {
  app.get('/me', async (request) => {
    const ctx = ctxOf(request.tenantCtx)
    const [tenant, seats] = await withTenant(engine, ctx, async (tx) => {
      const rows = await tx.query<{ slug: string; name: string; state: string }>(
        'SELECT slug, name, state FROM tenants',
      )
      return [rows[0] ?? null, await seatUsage(tx)] as const
    })
    return {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      role: ctx.role,
      tenant, // null when suspended: the 0003 gate takes even the self-row away
      seats,
    }
  })

  app.get('/projects', async (request) => {
    const ctx = ctxOf(request.tenantCtx)
    return withTenant(engine, ctx, (tx) => listProjects(tx))
  })

  app.post('/projects', async (request, reply) => {
    const ctx = ctxOf(request.tenantCtx)
    const body = ProjectBody.parse(request.body)
    const project = await withTenant(engine, ctx, (tx) => createProject(tx, body.name))
    return reply.code(201).send(project)
  })

  app.get('/projects/:id', async (request, reply) => {
    const ctx = ctxOf(request.tenantCtx)
    const { id } = IdParams.parse(request.params)
    const project = await withTenant(engine, ctx, (tx) => getProject(tx, id))
    if (project === null) return reply.code(404).send({ error: 'not found' })
    return project
  })

  app.patch('/projects/:id', async (request, reply) => {
    const ctx = ctxOf(request.tenantCtx)
    const { id } = IdParams.parse(request.params)
    const body = ProjectBody.parse(request.body)
    const renamed = await withTenant(engine, ctx, (tx) => renameProject(tx, id, body.name))
    if (!renamed) return reply.code(404).send({ error: 'not found' })
    return { id, name: body.name }
  })

  app.delete('/projects/:id', async (request, reply) => {
    const ctx = ctxOf(request.tenantCtx)
    const { id } = IdParams.parse(request.params)
    const removed = await withTenant(engine, ctx, (tx) => removeProject(tx, id))
    if (!removed) return reply.code(404).send({ error: 'not found' })
    return reply.code(204).send()
  })

  app.get('/audit', async (request) => {
    const ctx = ctxOf(request.tenantCtx)
    return withTenant(engine, ctx, (tx) => readAuditTrail(tx))
  })

  app.get('/support-grants', async (request) => {
    const ctx = ctxOf(request.tenantCtx)
    return withTenant(engine, ctx, (tx) => readSupportGrants(tx))
  })
}
