import { beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { freshEngine } from './helpers/db.ts'

let engine: Engine

beforeAll(async () => {
  engine = await freshEngine()
})

describe('debug func privileges', () => {
  it('lists all', async () => {
    const rows = await engine.query(
      `SELECT p.oid::regprocedure::text AS signature,
              has_function_privilege('public', p.oid, 'EXECUTE') AS publicExecute,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS appUserExecute
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prosecdef
        ORDER BY signature`,
    )
    for (const r of rows) console.log(JSON.stringify(r))
  })
})
