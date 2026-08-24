/**
 * The migrator. Numbered .sql files in sql/ are the work sample, so this stays
 * deliberately tiny: read the directory, skip what is already recorded, apply
 * the rest in one transaction each. Migrations are append-only — a committed
 * file is never edited, a correction is a new file.
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Engine } from './engine.ts'

/** Absolute path of the migrations directory, resolved relative to this file. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../sql/', import.meta.url))

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`

/** Migration file names, lexically sorted — hence the zero-padded numbering. */
export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const entries = await readdir(dir)
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

/**
 * Applies every migration the database has not recorded yet.
 * Returns the versions applied by THIS call, in order — so a second run on an
 * up-to-date database returns [].
 */
export async function migrate(engine: Engine, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await engine.exec(LEDGER)

  const recorded = await engine.query<{ version: string }>('SELECT version FROM schema_migrations')
  const done = new Set(recorded.map((row) => row.version))

  const applied: string[] = []
  for (const version of await listMigrations(dir)) {
    if (done.has(version)) continue
    const script = await readFile(`${dir}${version}`, 'utf8')
    await engine.transaction(async (tx) => {
      await tx.exec(script)
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    })
    applied.push(version)
  }
  return applied
}
