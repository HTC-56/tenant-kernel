/**
 * The one engine divergence the dual-engine gate has caught, pinned as a
 * regression: a parameter cast with a bare `::jsonb` makes the server declare
 * the PARAMETER jsonb, and postgres.js then re-serializes an already-encoded
 * string into a jsonb string scalar — PGlite sends text either way and parses
 * an object. The repo convention is `::text::jsonb` (pin the wire type, then
 * cast); this file proves the convention round-trips on the CURRENT engine and
 * that the audit detail path really stores objects. §E, DECISIONS.md.
 * Gate: typecheck + test + scrub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { logOperatorAction } from '../src/db/operator.ts'
import {
  asOperator,
  freshEngine,
  seedOperator,
  seedSupportGrant,
  seedTenant,
} from './helpers/db.ts'

let engine: Engine

beforeAll(async () => {
  engine = await freshEngine()
})

afterAll(async () => {
  await engine.close()
})

describe('parameter wire-type parity', () => {
  it('::text::jsonb round-trips an encoded object into a REAL object', async () => {
    const rows = await engine.query<{ v: boolean; kind: string }>(
      `SELECT $1::text::jsonb -> 'k' = 'true'::jsonb AS v,
              jsonb_typeof($1::text::jsonb)          AS kind`,
      ['{"k": true}'],
    )
    expect(rows[0].kind).toBe('object')
    expect(rows[0].v).toBe(true)
  })

  it('audit detail is stored as an object — indexable, not an encoded string', async () => {
    const tenantId = await seedTenant(engine, 'parity')
    const operatorId = await seedOperator(engine, 'parity-op')
    await seedSupportGrant(engine, tenantId, operatorId, 'parity check', 10)

    await asOperator(engine, operatorId, async (tx) => {
      await logOperatorAction(tx, tenantId, 'parity.check', { ticket: 4412 })
      const rows = await tx.query<{ kind: string; ticket: string | number }>(
        `SELECT jsonb_typeof(detail) AS kind, detail ->> 'ticket' AS ticket
           FROM audit_log
          WHERE tenant_id = $1 AND action = 'parity.check'`,
        [tenantId],
      )
      expect(rows[0].kind).toBe('object')
      expect(String(rows[0].ticket)).toBe('4412')
    })
  })
})
