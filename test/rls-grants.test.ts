/**
 * Discovers every table in the public schema that grants any privilege to
 * `app_user` and asserts that each one has ENABLE + FORCE RLS and at least
 * one policy.
 *
 * `rls-coverage.test.ts` checks tenant-scoped tables (those with a
 * `tenant_id` column). This file catches the global ones — `users`,
 * `schema_migrations` — that lack `tenant_id` but still carry an `app_user`
 * grant. If a developer adds a new table and forgets RLS, the build fails.
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

describe('RLS grants — every table granted to app_user is protected', () => {
  it('discovers tables with app_user grants in the public schema', async () => {
    const tables = await engine.query<{ tablename: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname AS tablename, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.role_table_grants g
           ON g.table_schema = n.nspname AND g.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND g.grantee = 'app_user'
          AND g.table_schema = 'public'
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
        ORDER BY c.relname`,
    )

    // Prove the query works before trusting it
    expect(tables.length).toBeGreaterThanOrEqual(2)
    const names = tables.map((t) => t.tablename)
    expect(names).toContain('users')
    expect(names).toContain('tenants')

    // Every granted table has ENABLE ROW LEVEL SECURITY
    for (const table of tables) {
      expect(table.relrowsecurity, `${table.tablename} ENABLE RLS`).toBe(true)
    }

    // Every granted table has FORCE ROW LEVEL SECURITY
    for (const table of tables) {
      expect(table.relforcerowsecurity, `${table.tablename} FORCE RLS`).toBe(true)
    }

    // Every granted table has at least one policy
    const policies = await engine.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [tables.map((t) => t.tablename)],
    )
    const policiesByTable = new Map<string, string[]>()
    for (const p of policies) {
      policiesByTable.set(p.tablename, [...(policiesByTable.get(p.tablename) ?? []), p.policyname])
    }
    for (const table of tables) {
      const pols = policiesByTable.get(table.tablename) ?? []
      expect(pols.length, `${table.tablename} has at least one policy`).toBeGreaterThanOrEqual(1)
    }
  })
})
