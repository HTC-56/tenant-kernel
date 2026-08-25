/**
 * Thin typed data layer over `projects` — the one real tenant-scoped resource
 * (SPEC.md feature 6), in the same shape as src/db/identity.ts: every function
 * takes the `Queryable` a seam handed it, never names a tenant, and manages no
 * transaction. RLS scopes the reads; `tenant_id` DEFAULTs to
 * `app_current_tenant()` on the insert.
 *
 * "Not visible" and "belongs to another tenant" are indistinguishable on
 * purpose — both come back as an empty result, which the HTTP layer renders
 * as 404. That equivalence IS the isolation demo.
 */
import type { Queryable } from './engine.ts'

/** A project row, typed for the application. */
export interface Project {
  id: string
  name: string
  createdAt: Date
}

interface ProjectRow {
  id: string
  name: string
  created_at: Date
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, createdAt: row.created_at }
}

/** Every project of the acting tenant, newest first. */
export async function listProjects(tx: Queryable): Promise<Project[]> {
  const rows = await tx.query<ProjectRow>(
    'SELECT id, name, created_at FROM projects ORDER BY created_at DESC, id DESC',
  )
  return rows.map(toProject)
}

/** One project of the acting tenant, or null — another tenant's id is null too. */
export async function getProject(tx: Queryable, id: string): Promise<Project | null> {
  const rows = await tx.query<ProjectRow>(
    'SELECT id, name, created_at FROM projects WHERE id = $1',
    [id],
  )
  return rows.length === 0 ? null : toProject(rows[0])
}

/**
 * Creates a project for the acting tenant. Names only `name`; `tenant_id`
 * DEFAULTs to `app_current_tenant()`, so a tenantless transaction refuses at
 * the NOT NULL rather than writing an orphan.
 */
export async function createProject(tx: Queryable, name: string): Promise<Project> {
  const rows = await tx.query<ProjectRow>(
    'INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at',
    [name],
  )
  return toProject(rows[0])
}

/** Renames one project. False when no such project is visible. */
export async function renameProject(tx: Queryable, id: string, name: string): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'UPDATE projects SET name = $2 WHERE id = $1 RETURNING id',
    [id, name],
  )
  return rows.length > 0
}

/** Removes one project. False when no such project is visible. */
export async function removeProject(tx: Queryable, id: string): Promise<boolean> {
  const rows = await tx.query<{ id: string }>(
    'DELETE FROM projects WHERE id = $1 RETURNING id',
    [id],
  )
  return rows.length > 0
}
