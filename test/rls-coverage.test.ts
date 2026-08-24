/**
 * Discovers every ordinary table in the public schema that carries a
 * `tenant_id` column (plus `tenants` itself) and asserts that each one
 * has ENABLE + FORCE RLS, at least one policy, and no PUBLIC grants.
 *
 * If a developer adds a new tenant-scoped table and forgets to wire RLS,
 * the build fails by construction.
 *
 * `pnpm test` runs this against PGlite. `DATABASE_URL=... pnpm test` runs
 * it against a real Postgres server. This file only reads catalogs — it
 * seeds nothing and cleans up nothing.
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

describe('RLS coverage — every tenant-scoped table is protected', () => {
  it('discovers tables with tenant_id in the public schema', async () => {
    const tables = await engine.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns cs ON cs.table_schema = n.nspname
                                            AND cs.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname != 'schema_migrations'
          AND (cs.column_name = 'tenant_id' OR c.relname = 'tenants')
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
        ORDER BY c.relname`,
    )

    // Prove the query works before trusting it
    expect(tables.length).toBeGreaterThanOrEqual(2)
    const names = tables.map((t) => t.relname)
    expect(names).toContain('tenants')
    expect(names).toContain('projects')

    // Every discovered table has ENABLE ROW LEVEL SECURITY
    for (const table of tables) {
      expect(table.relrowsecurity, `${table.relname} ENABLE RLS`).toBe(true)
    }

    // Every discovered table has FORCE ROW LEVEL SECURITY
    for (const table of tables) {
      expect(table.relforcerowsecurity, `${table.relname} FORCE RLS`).toBe(true)
    }

    // Every discovered table has at least one policy
    const policies = await engine.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [tables.map((t) => t.relname)],
    )
    const policiesByTable = new Map<string, string[]>()
    for (const p of policies) {
      policiesByTable.set(p.tablename, [...(policiesByTable.get(p.tablename) ?? []), p.policyname])
    }
    for (const table of tables) {
      const pols = policiesByTable.get(table.relname) ?? []
      expect(pols.length, `${table.relname} has at least one policy`).toBeGreaterThanOrEqual(1)
    }

    // No discovered table grants any privilege to PUBLIC
    const publicGrants = await engine.query<{ tablename: string }>(
      `SELECT DISTINCT table_name AS tablename FROM information_schema.role_table_grants
       WHERE grantee = 'PUBLIC' AND table_schema = 'public'`,
    )
    const publicTables = new Set(publicGrants.map((g) => g.tablename))
    for (const table of tables) {
      expect(publicTables.has(table.relname), `${table.relname} no PUBLIC grant`).toBe(false)
    }
  })
})
