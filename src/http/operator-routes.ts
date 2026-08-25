/**
 * The operator API (SPEC.md features 7 and 8's data half), under static bearer
 * auth from config. Every mutation goes through `withOperator` WITH the
 * configured operator identity, so sql/0004_operator.sql audits it — and
 * suspending a tenant really does demand a live support grant: the API
 * surfaces that refusal as 409 rather than working around it, because the
 * refusal is the feature.
 *
 * Every mutation also lands one line in the JSONL ops ledger (feature 7) —
 * the file is the ops trail, the audit_log table is the tenant-visible truth.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { appendFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Config } from '../config.ts'
import type { Engine } from '../db/engine.ts'
import { withOperator } from '../db/seam.ts'
import { provisionTenant, setTenantState, TENANT_STATES } from '../db/lifecycle.ts'
import { grantSupportAccess, revokeSupportAccess } from '../db/operator.ts'
import { listLiveGrants, listTenants, recentAudit } from '../db/overview.ts'

const ProvisionBody = z.object({
  slug: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
  name: z.string().min(1).max(200),
  ownerEmail: z.email(),
  ownerName: z.string().min(1).max(200),
})

const StateBody = z.object({
  state: z.enum(TENANT_STATES),
  /** Optional one-step path: open a support grant, then change state. */
  reason: z.string().min(1).max(500).optional(),
  ttlMinutes: z.number().int().min(1).max(24 * 60).optional(),
})

const GrantBody = z.object({
  tenantId: z.uuid(),
  reason: z.string().min(1).max(500),
  ttlMinutes: z.number().int().min(1).max(24 * 60),
})

const IdParams = z.object({ id: z.uuid() })

export interface OperatorDeps {
  readonly engine: Engine
  readonly config: Config
  /** Resolved at boot by ensureOperator(); the identity every action audits as. */
  readonly operatorId: string
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The one domain refusal the API maps specially: acting without a time box. */
function isNoGrantRefusal(err: unknown): boolean {
  return message(err).includes('no active support grant')
}

/** A unique-constraint refusal — a provision race or a reused slug, not a 500. */
function isDuplicate(err: unknown): boolean {
  return message(err).includes('duplicate key')
}

export function operatorRoutes(app: FastifyInstance, deps: OperatorDeps): void {
  const { engine, config, operatorId } = deps

  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${config.operator.token}`) {
      await reply.code(401).send({ error: 'unauthorized' })
      return reply
    }
  })

  async function ledger(action: string, detail: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      operatorId,
      action,
      ...detail,
    })
    await appendFile(config.ops.ledgerPath, line + '\n', 'utf8')
  }

  app.get('/tenants', async () => withOperator(engine, (tx) => listTenants(tx)))

  app.post('/tenants', async (request, reply) => {
    const body = ProvisionBody.parse(request.body)
    let tenantId: string
    try {
      tenantId = await withOperator(engine, { operatorId }, (tx) =>
        provisionTenant(tx, {
          slug: body.slug,
          name: body.name,
          ownerEmail: body.ownerEmail,
          ownerName: body.ownerName,
        }),
      )
    } catch (err) {
      if (isDuplicate(err)) {
        return reply.code(409).send({ error: `slug '${body.slug}' is taken` })
      }
      throw err
    }
    await ledger('tenant.provision', { tenantId, slug: body.slug })
    return reply.code(201).send({ id: tenantId })
  })

  app.post('/tenants/:id/state', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = IdParams.parse(request.params)
    const body = StateBody.parse(request.body)
    try {
      await withOperator(engine, { operatorId }, async (tx) => {
        if (body.reason !== undefined) {
          await grantSupportAccess(tx, {
            tenantId: id,
            reason: body.reason,
            ttlMinutes: body.ttlMinutes ?? 15,
          })
        }
        await setTenantState(tx, id, body.state)
      })
    } catch (err) {
      if (isNoGrantRefusal(err)) {
        return reply.code(409).send({ error: 'no active support grant for this tenant' })
      }
      throw err
    }
    await ledger('tenant.state', { tenantId: id, state: body.state })
    return { id, state: body.state }
  })

  app.get('/support-grants', async () => withOperator(engine, (tx) => listLiveGrants(tx)))

  app.post('/support-grants', async (request, reply) => {
    const body = GrantBody.parse(request.body)
    const grantId = await withOperator(engine, { operatorId }, (tx) =>
      grantSupportAccess(tx, body),
    )
    await ledger('support.grant', { grantId, tenantId: body.tenantId, ttl: body.ttlMinutes })
    return reply.code(201).send({ id: grantId })
  })

  app.post('/support-grants/:id/revoke', async (request) => {
    const { id } = IdParams.parse(request.params)
    await withOperator(engine, { operatorId }, (tx) => revokeSupportAccess(tx, id))
    await ledger('support.revoke', { grantId: id })
    return { id, revoked: true }
  })

  app.get('/audit', async () => withOperator(engine, (tx) => recentAudit(tx)))
}
