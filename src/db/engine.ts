/**
 * The two-engine seam.
 *
 * Everything above this file speaks one narrow interface, so the identical test
 * suite proves the identical properties against PGlite (real Postgres compiled
 * to WASM, in-process, zero setup) and against a real Postgres server. The
 * real-Postgres run is the authoritative one; PGlite is what makes `pnpm test`
 * work on a clone with no database installed.
 */
import { PGlite } from '@electric-sql/pglite'
import postgres from 'postgres'

export type EngineKind = 'pglite' | 'postgres'

/** Anything you can run SQL against — an engine, or a transaction on one. */
export interface Queryable {
  /** Parameterised single statement. Placeholders are $1, $2, … on both engines. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** Multi-statement script, no parameters. Used for migrations. */
  exec(sql: string): Promise<void>
}

export interface Engine extends Queryable {
  readonly kind: EngineKind
  /** Runs `fn` in a transaction. A throw rolls back and propagates. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

class PGliteEngine implements Engine {
  readonly kind: EngineKind = 'pglite'
  private readonly db: PGlite

  constructor(db: PGlite) {
    this.db = db
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, params as unknown[])
    return result.rows
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql)
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    let captured: T
    await this.db.transaction(async (tx) => {
      captured = await fn({
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const result = await tx.query<R>(sql, params as unknown[])
          return result.rows
        },
        exec: async (sql: string) => {
          await tx.exec(sql)
        },
      })
    })
    return captured!
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}

class PostgresEngine implements Engine {
  readonly kind: EngineKind = 'postgres'
  private readonly sql: postgres.Sql

  constructor(sql: postgres.Sql) {
    this.sql = sql
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(sql, params as never[])
    return [...rows] as T[]
  }

  async exec(sql: string): Promise<void> {
    // .simple() uses the simple query protocol, which is what lets a single
    // call carry a whole multi-statement migration script.
    await this.sql.unsafe(sql).simple()
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      return fn({
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const rows = await tx.unsafe(sql, params as never[])
          return [...rows] as R[]
        },
        exec: async (sql: string) => {
          await tx.unsafe(sql).simple()
        },
      })
    })) as T
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}

/**
 * Opens the engine named by `DATABASE_URL`, or an in-memory PGlite when that is
 * unset. Passing an explicit url wins over the environment.
 */
export async function openEngine(url = process.env['DATABASE_URL']): Promise<Engine> {
  if (url && url.trim() !== '') {
    return new PostgresEngine(postgres(url, { max: 1, onnotice: () => {} }))
  }
  return new PGliteEngine(await PGlite.create())
}
