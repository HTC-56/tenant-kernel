/**
 * Phase C §C8 — prove no SECURITY DEFINER function is executable by PUBLIC.
 *
 * RLS-grants.test.ts proves no table is exposed without RLS; this proves no
 * SECURITY DEFINER function is exposed at all. Postgres grants EXECUTE on
 * every new function to PUBLIC, which on a SECURITY DEFINER function is a
 * privilege escalation, so 0003 revokes it.
 *
 * `pnpm test` runs this against PGlite. `DATABASE_URL=... pnpm test` runs
 * it against a real Postgres server. This file only reads catalogs.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { freshEngine } from './helpers/db.ts'

let engine: Engine

beforeAll(async () => {
  engine = await freshEngine()
})

afterAll(async () => {
  await engine.close()
})

describe('function grants — no SECURITY DEFINER function is executable by PUBLIC', () => {
  it('discovers all SECURITY DEFINER functions in the public schema', async () => {
    const funcs = await engine.query<{
      signature: string
      publicexecute: boolean
      appuserexecute: boolean
    }>(
      `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege('public', p.oid, 'EXECUTE') AS publicexecute,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS appuserexecute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
        ORDER BY signature`,
    )

    // Prove the query works before trusting it
    const signatures = funcs.map((f) => f.signature)
    expect(signatures).toContain('accept_invite(text,uuid)')
    expect(signatures).toContain('provision_tenant(text,text,text,text)')
    expect(signatures).toContain('set_tenant_state(uuid,text)')
    expect(signatures).toContain('tenant_default_entitlements()')
    expect(signatures).toContain('enforce_seat_cap()')
    expect(signatures).toContain('enforce_last_owner()')

    // Every SECURITY DEFINER function has PUBLIC execute = false
    for (const f of funcs) {
      expect(f.publicExecute, `${f.signature} PUBLIC execute`).toBe(false)
    }

    // accept_invite is the one function app_user may execute
    const acceptInvite = funcs.find((f) => f.signature.startsWith('accept_invite'))
    expect(acceptInvite?.appUserExecute, `${acceptInvite?.signature} app_user execute`).toBe(true)

    // Provisioning and suspending are operator-only
    const provisionTenant = funcs.find((f) => f.signature.startsWith('provision_tenant'))
    expect(provisionTenant?.appUserExecute, `${provisionTenant?.signature} app_user execute`).toBe(false)

    const setTenantState = funcs.find((f) => f.signature.startsWith('set_tenant_state'))
    expect(setTenantState?.appUserExecute, `${setTenantState?.signature} app_user execute`).toBe(false)
  })
})
