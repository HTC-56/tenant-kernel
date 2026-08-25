/**
 * Prove that the thin typed data layer — `src/db/identity.ts` — works
 * correctly across two tenants, under RLS.
 *
 * Mirrors `test/rls-refusal.test.ts` for structure: two tenants, two users,
 * each user an 'owner' of one tenant. The seed helpers bypass RLS; every
 * assertion runs inside `asContext()` which rolls back, so a refused write
 * cannot leave debris behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Engine } from '../src/db/engine.ts'
import { addMember, createInvite, listMembers, listPendingInvites } from '../src/db/identity.ts'
import { asContext, freshEngine, seedTenant, seedUser } from './helpers/db.ts'

let engine: Engine
let alice: string
let bob: string
let ann: string
let annEmail: string
let bill: string
let billEmail: string

beforeAll(async () => {
  engine = await freshEngine()
  alice = await seedTenant(engine, 'alice')
  bob = await seedTenant(engine, 'bob')
  ann = await seedUser(engine, 'ann')
  bill = await seedUser(engine, 'bill')

  // seedUser appends a unique suffix, so grab the actual emails.
  const [annRow, billRow] = await engine.query<{ email: string }>(
    'SELECT email FROM users WHERE id = ANY($1) ORDER BY email',
    [[ann, bill]],
  )
  annEmail = annRow.email
  billEmail = billRow.email

  // Ann is an owner of Alice's tenant; Bill is an owner of Bob's.
  await engine.query(
    'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
    [alice, ann, 'owner'],
  )
  await engine.query(
    'INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)',
    [bob, bill, 'owner'],
  )
})

afterAll(async () => {
  if (!engine) return
  await engine.query('DELETE FROM tenants WHERE id = ANY($1)', [[alice, bob]])
  await engine.query('DELETE FROM users WHERE id = ANY($1)', [[ann, bill]])
  await engine.close()
})

describe('listMembers', () => {
  it('addMember returns an id and listMembers shows both, ordered by email', async () => {
    const id = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'owner' },
      async (tx) => {
        const newId = await addMember(tx, bill, 'member')
        expect(typeof newId).toBe('string')
        expect(newId).toBeTruthy()

        const members = await listMembers(tx)
        const emails = members.map((m) => m.email)
        // Ann and Bill both belong to alice's tenant now.
        expect(emails).toContain(annEmail)
        expect(emails).toContain(billEmail)
        // Ordered by email: ann < bill.
        expect(emails).toEqual([annEmail, billEmail])
        return newId
      },
    )
    // The id survives as the return value (the transaction itself rolled back).
    expect(typeof id).toBe('string')
  })

  it('listMembers acting as alice never contains bill\'s email', async () => {
    const members = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'owner' },
      listMembers,
    )
    const emails = members.map((m) => m.email)
    expect(emails).toContain(annEmail)
    expect(emails).not.toContain(billEmail)
  })
})

describe('invites', () => {
  it("createInvite as 'owner' returns an id and listPendingInvites shows it", async () => {
    const id = await asContext(
      engine,
      { tenantId: alice, userId: ann, role: 'owner' },
      async (tx) => {
        const newId = await createInvite(tx, 'invite@example.com', 'member', 'tok-1', new Date('2099-01-01'))
        expect(typeof newId).toBe('string')

        const invites = await listPendingInvites(tx)
        const emails = invites.map((i) => i.email)
        expect(emails).toContain('invite@example.com')
        return newId
      },
    )
    expect(typeof id).toBe('string')
  })

  it("as 'member' createInvite is rejected by RLS", async () => {
    // The invites policy reads `app.role`, the setting the seam publishes — not
    // the membership row. So acting as a member is simply a matter of
    // publishing that role; the fixture stays untouched.
    await expect(
      asContext(
        engine,
        { tenantId: bob, userId: bill, role: 'member' },
        async (tx) => {
          await createInvite(tx, 'nobody@example.com', 'member', 'tok-x', new Date('2099-01-01'))
        },
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('two createInvite calls for the same email in one block reject', async () => {
    await expect(
      asContext(
        engine,
        { tenantId: alice, userId: ann, role: 'owner' },
        async (tx) => {
          await createInvite(tx, 'same@example.com', 'member', 'tok-a', new Date('2099-01-01'))
          // Same email, same tenant — UNIQUE index fires on the second.
          await createInvite(tx, 'same@example.com', 'member', 'tok-b', new Date('2099-01-01'))
        },
      ),
    ).rejects.toThrow(/duplicate key|unique/i)
  })
})
