/**
 * Phase A's whole reason to exist: prove that the database itself refuses
 * cross-tenant access, on whichever engine is configured.
 *
 * `pnpm test` runs this against PGlite. `DATABASE_URL=... pnpm test` runs the
 * exact same assertions against a real Postgres server, and that run is the
 * authoritative one. Nothing here is engine-specific.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { asTenant, asTenantless, freshEngine, seedTenant } from './helpers/db.ts'

let engine: Engine
let alice: string
let bob: string
let bobProject: string

beforeAll(async () => {
  engine = await freshEngine()
  alice = await seedTenant(engine, 'alice')
  bob = await seedTenant(engine, 'bob')

  await engine.query('INSERT INTO projects (tenant_id, name) VALUES ($1, $2)', [alice, 'alice-one'])
  await engine.query('INSERT INTO projects (tenant_id, name) VALUES ($1, $2)', [alice, 'alice-two'])
  const rows = await engine.query<{ id: string }>(
    'INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING id',
    [bob, 'bob-secret'],
  )
  bobProject = rows[0].id
})

afterAll(async () => {
  if (!engine) return
  // Leaves a shared real-Postgres database as we found it. Projects go with the
  // tenant via ON DELETE CASCADE.
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[alice, bob]])
  await engine.close()
})

describe('the enforcement layer is actually installed', () => {
  it('runs as a role that is neither superuser nor a table owner', async () => {
    const [role] = await engine.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      ['app_user'],
    )
    expect(role.rolsuper).toBe(false)
    expect(role.rolbypassrls).toBe(false)

    const owned = await engine.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = 'app_user' AND c.relkind = 'r'`,
    )
    expect(owned).toEqual([])
  })

  it('has ENABLE and FORCE row level security on every tenant-scoped table', async () => {
    const tables = await engine.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('tenants', 'projects')
        ORDER BY relname`,
    )
    expect(tables.map((t) => t.relname)).toEqual(['projects', 'tenants'])
    for (const table of tables) {
      expect(table.relrowsecurity, `${table.relname} ENABLE RLS`).toBe(true)
      expect(table.relforcerowsecurity, `${table.relname} FORCE RLS`).toBe(true)
    }
  })
})

describe('cross-tenant access is refused at the database layer', () => {
  it('SELECT returns only the acting tenant rows', async () => {
    const rows = await asTenant(engine, alice, (tx) =>
      tx.query<{ name: string }>('SELECT name FROM projects ORDER BY name'),
    )
    expect(rows.map((r) => r.name)).toEqual(['alice-one', 'alice-two'])
  })

  it('SELECT cannot reach another tenant rows even when asked for by id', async () => {
    const rows = await asTenant(engine, alice, (tx) =>
      tx.query('SELECT * FROM projects WHERE id = $1', [bobProject]),
    )
    expect(rows).toEqual([])
  })

  it('INSERT of a row belonging to another tenant is rejected', async () => {
    await expect(
      asTenant(engine, alice, (tx) =>
        tx.query('INSERT INTO projects (tenant_id, name) VALUES ($1, $2)', [bob, 'planted']),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('UPDATE of another tenant row changes nothing', async () => {
    const updated = await asTenant(engine, alice, (tx) =>
      tx.query('UPDATE projects SET name = $1 WHERE id = $2 RETURNING id', ['hijacked', bobProject]),
    )
    expect(updated).toEqual([])

    const [survivor] = await engine.query<{ name: string }>('SELECT name FROM projects WHERE id = $1', [bobProject])
    expect(survivor.name).toBe('bob-secret')
  })

  it('DELETE of another tenant row removes nothing', async () => {
    const deleted = await asTenant(engine, alice, (tx) =>
      tx.query('DELETE FROM projects WHERE id = $1 RETURNING id', [bobProject]),
    )
    expect(deleted).toEqual([])

    const still = await engine.query('SELECT id FROM projects WHERE id = $1', [bobProject])
    expect(still).toHaveLength(1)
  })

  it('the tenants table shows a tenant only itself', async () => {
    const rows = await asTenant(engine, alice, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants'))
    expect(rows.map((r) => r.id)).toEqual([alice])
  })
})

describe('missing context fails closed', () => {
  it('shows nothing at all when app.tenant_id was never published', async () => {
    const projects = await asTenantless(engine, (tx) => tx.query('SELECT id FROM projects'))
    const tenants = await asTenantless(engine, (tx) => tx.query('SELECT id FROM tenants'))
    expect(projects).toEqual([])
    expect(tenants).toEqual([])
  })
})
