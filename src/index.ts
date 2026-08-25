/**
 * The composition root: load config, open the engine, migrate, build the
 * server, listen. This is the one file outside db/engine.ts allowed to call
 * `openEngine` — test/seam-only.test.ts holds that line.
 *
 * `TENANT_KERNEL_CONFIG` names the YAML file (default ./tenant-kernel.yaml);
 * `DATABASE_URL` picks the engine, exactly as it does for `pnpm test`.
 */
import { loadConfig } from './config.ts'
import { openEngine } from './db/engine.ts'
import { migrate } from './db/migrate.ts'
import { buildServer } from './http/server.ts'

const configPath = process.env['TENANT_KERNEL_CONFIG'] ?? 'tenant-kernel.yaml'

const config = await loadConfig(configPath)
const engine = await openEngine()
const applied = await migrate(engine)

const app = await buildServer(engine, config)
const address = await app.listen({ host: config.server.host, port: config.server.port })

console.log(`tenant-kernel: ${engine.kind} engine, ${applied.length} migration(s) applied`)
console.log(`tenant-kernel: listening on ${address} — console at ${address}/operator`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => engine.close())
      .then(() => process.exit(0))
  })
}
