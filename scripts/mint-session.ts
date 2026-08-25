/**
 * Mints an opaque bearer session token — the CLI half of SPEC.md's "no SSO,
 * no OAuth" non-goal. Auth is a seam: this helper and the test fixtures are
 * the only mints, and the raw token is printed exactly once.
 *
 *   pnpm mint-session -- --email owner@example.com --tenant acme [--ttl 1440]
 *
 * `DATABASE_URL` picks the engine, exactly as it does for `pnpm test` and
 * `pnpm serve` — run it against the same database the server is on.
 */
import { parseArgs } from 'node:util'
import { openEngine } from '../src/db/engine.ts'
import { migrate } from '../src/db/migrate.ts'
import { withOperator } from '../src/db/seam.ts'
import { mintSession } from '../src/db/sessions.ts'

// pnpm forwards a literal `--` separator when one is typed; drop it so both
// `pnpm mint-session --email …` and `pnpm mint-session -- --email …` work.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'))

const { values } = parseArgs({
  args: argv,
  options: {
    email: { type: 'string' },
    tenant: { type: 'string' },
    ttl: { type: 'string', default: '1440' },
  },
})

if (!values.email || !values.tenant) {
  console.error('usage: pnpm mint-session -- --email <email> --tenant <slug> [--ttl <minutes>]')
  process.exit(2)
}
const email = values.email
const tenantSlug = values.tenant

const engine = await openEngine()
try {
  await migrate(engine)
  const token = await withOperator(engine, async (tx) => {
    const users = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase(),
    ])
    if (users.length === 0) throw new Error(`no user with email ${email}`)
    const tenants = await tx.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [
      tenantSlug,
    ])
    if (tenants.length === 0) throw new Error(`no tenant with slug ${tenantSlug}`)
    return mintSession(tx, users[0].id, tenants[0].id, Number(values.ttl))
  })
  console.log(token)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await engine.close()
}
