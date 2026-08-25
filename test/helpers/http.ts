/**
 * Test harness for the HTTP surface. `freshServer()` stands up a migrated
 * engine and a built Fastify app around a config literal — no YAML file, no
 * listening socket; every request goes through `app.inject()`.
 *
 * The ops ledger writes to a per-suite temp file so a parallel local run and
 * a shared CI box never interleave lines; `closeServer()` removes it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../../src/config.ts'
import type { Engine } from '../../src/db/engine.ts'
import { buildServer } from '../../src/http/server.ts'
import { mintSession } from '../../src/db/sessions.ts'
import { freshEngine, seedMembership, seedTenant, seedUser } from './db.ts'

export const OPERATOR_TOKEN = 'test-operator-token-0123456789abcdef'

export interface TestServer {
  readonly engine: Engine
  readonly app: FastifyInstance
  readonly config: Config
  readonly ledgerDir: string
  readonly ledgerPath: string
}

export async function freshServer(): Promise<TestServer> {
  const engine = await freshEngine()
  const ledgerDir = await mkdtemp(join(tmpdir(), 'tenant-kernel-test-'))
  const ledgerPath = join(ledgerDir, 'ledger.jsonl')
  const config: Config = {
    server: { host: '127.0.0.1', port: 0 },
    operator: { token: OPERATOR_TOKEN, email: 'console@example.com', name: 'Test Operator' },
    ops: { ledgerPath },
  }
  const app = await buildServer(engine, config)
  return { engine, app, config, ledgerDir, ledgerPath }
}

export async function closeServer(server: TestServer): Promise<void> {
  await server.app.close()
  await server.engine.close()
  await rm(server.ledgerDir, { recursive: true, force: true })
}

/** One tenant, one member, one live session — returns ids and the raw token. */
export async function seedTenantWithSession(
  server: TestServer,
  label: string,
  role: 'owner' | 'admin' | 'member' = 'owner',
): Promise<{ tenantId: string; userId: string; token: string }> {
  const tenantId = await seedTenant(server.engine, label)
  const userId = await seedUser(server.engine, label)
  await seedMembership(server.engine, tenantId, userId, role)
  const token = await mintSession(server.engine, userId, tenantId)
  return { tenantId, userId, token }
}

export function asBearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
