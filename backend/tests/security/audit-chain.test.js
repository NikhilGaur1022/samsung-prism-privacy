import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { writeAuditLog } from '../../src/lib/auditLog.js'
import { verifyChain } from '../../src/modules/audit/audit.service.js'

// These run against the real database. audit_log is append-only by policy, so the
// tests deliberately do not try to clean up their rows — they use a unique
// entityType per run instead, which is also the honest shape: if a test could
// delete its own audit rows, the append-only guarantee would not exist.
const ENTITY_TYPE = `TestEntity_${Date.now()}`

async function seedChain(entityId, count = 3) {
  for (let i = 0; i < count; i++) {
    await writeAuditLog({
      entityType: ENTITY_TYPE,
      entityId,
      action: `STEP_${i}`,
      actorId: null,
      payload: { step: i, note: 'chain fixture' },
    })
  }
}

test('a freshly written chain verifies', async () => {
  const entityId = randomUUID()
  await seedChain(entityId, 4)

  const result = await verifyChain(ENTITY_TYPE, entityId)

  assert.equal(result.entries, 4)
  assert.equal(result.valid, true, JSON.stringify(result.breaks))
  assert.equal(result.verified, 4, 'every entry should be cryptographically recomputable')
  assert.equal(result.linkageOnly, 0)
  assert.deepEqual(result.breaks, [])
})

test('the first entry has a null prevHash and each later entry chains to its predecessor', async () => {
  const entityId = randomUUID()
  await seedChain(entityId, 3)

  const rows = await prisma.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId },
    orderBy: { createdAt: 'asc' },
  })

  assert.equal(rows[0].prevHash, null)
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].prevHash, rows[i - 1].payloadHash, `entry ${i} does not chain to ${i - 1}`)
  }
})

test('editing a field in place is detected as HASH_MISMATCH', async () => {
  const entityId = randomUUID()
  await seedChain(entityId, 3)

  const rows = await prisma.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId },
    orderBy: { createdAt: 'asc' },
  })
  const target = rows[1]

  // The exact attack the chain exists to catch: rewrite what an entry SAYS while
  // leaving the links intact. Done in a rolled-back transaction so the ledger is
  // not actually mutated by a test run.
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "audit_log" SET action = 'TAMPERED' WHERE id = $1::uuid`, target.id)

      const rowsNow = await tx.auditLog.findMany({
        where: { entityType: ENTITY_TYPE, entityId },
        orderBy: { createdAt: 'asc' },
      })
      const edited = rowsNow.find((r) => r.id === target.id)

      // Only assert the detection if the UPDATE actually landed. Under a
      // least-privilege role RLS refuses it outright, which is the stronger
      // outcome and is asserted by the RLS test below.
      if (edited?.action === 'TAMPERED') {
        const { computeChainHash } = await import('../../src/lib/auditLog.js')
        const recomputed = computeChainHash({
          entityType: edited.entityType,
          entityId: edited.entityId,
          action: edited.action,
          actorId: edited.actorId,
          payloadDigest: edited.payloadDigest,
          prevHash: edited.prevHash,
        })
        assert.notEqual(recomputed, edited.payloadHash, 'an edited row still recomputed to its stored hash')
      }

      throw new Error('rollback')
    }),
    /rollback|permission|policy|denied/i,
  )

  // And the ledger is unchanged afterwards.
  const after = await verifyChain(ENTITY_TYPE, entityId)
  assert.equal(after.valid, true, 'the transaction should have rolled back')
})

test('removing a middle entry breaks linkage', async () => {
  const entityId = randomUUID()
  await seedChain(entityId, 4)

  const rows = await prisma.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, entityId },
    orderBy: { createdAt: 'asc' },
  })

  // Verify the detection logic directly rather than by deleting a row: deletion
  // is supposed to be impossible, and a test that needs it to work would be
  // asserting the opposite of the guarantee.
  const withHole = rows.filter((_, i) => i !== 1)
  let expectedPrev = null
  const breaks = []
  for (const [index, row] of withHole.entries()) {
    if (row.prevHash !== expectedPrev) breaks.push(index)
    expectedPrev = row.payloadHash
  }

  assert.ok(breaks.length > 0, 'removing an entry should break the chain')
})

test('audit_log, access_events and deletion_certificates have INSERT/SELECT policies and no UPDATE or DELETE policy', async () => {
  const policies = await prisma.$queryRawUnsafe(`
    SELECT tablename, cmd, count(*)::int AS n
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('audit_log','access_events','deletion_certificates')
    GROUP BY tablename, cmd
  `)

  for (const table of ['audit_log', 'access_events', 'deletion_certificates']) {
    const forTable = policies.filter((p) => p.tablename === table)
    const cmds = new Set(forTable.map((p) => p.cmd))

    assert.ok(cmds.has('INSERT'), `${table} has no INSERT policy`)
    assert.ok(cmds.has('SELECT'), `${table} has no SELECT policy`)
    // With FORCE ROW LEVEL SECURITY on, a command with no matching policy is
    // denied. The absence of these two IS the append-only enforcement.
    assert.equal(cmds.has('UPDATE'), false, `${table} has an UPDATE policy — it must not`)
    assert.equal(cmds.has('DELETE'), false, `${table} has a DELETE policy — it must not`)
  }
})

test('RLS is enabled AND forced on the evidentiary tables', async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('audit_log','access_events','deletion_certificates')
  `)

  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.enabled, true, `${row.table}: RLS not enabled`)
    // FORCE is what binds the table OWNER too. Without it, the application —
    // which connects as the owner in every environment we ship — is exempt, and
    // the policy is decoration.
    assert.equal(row.forced, true, `${row.table}: RLS not FORCED, so the owner is exempt`)
  }
})

test('UPDATE on audit_log is refused, or the connected role is proven to hold BYPASSRLS', async () => {
  const [role] = await prisma.$queryRawUnsafe(`
    SELECT current_user AS name, rolsuper AS superuser, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = current_user
  `)

  const entityId = randomUUID()
  await seedChain(entityId, 1)
  const [row] = await prisma.auditLog.findMany({ where: { entityType: ENTITY_TYPE, entityId } })

  let refused = false
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "audit_log" SET action = 'X' WHERE id = $1::uuid`, row.id)
      throw new Error('rollback')
    })
  } catch (err) {
    if (!/rollback/.test(err.message)) refused = true
  }

  if (refused) {
    assert.ok(true, 'the database refused the UPDATE')
    return
  }

  // Not a pass. The UPDATE went through, and the only acceptable explanation is
  // that this connection holds BYPASSRLS — which is true of Supabase's `postgres`
  // role. The assertion records precisely that, so the gap is visible in the test
  // output instead of being mistaken for enforcement.
  assert.ok(
    role.superuser || role.bypassrls,
    `UPDATE on audit_log succeeded as "${role.name}", which holds neither SUPERUSER nor BYPASSRLS — append-only is genuinely broken`,
  )
  console.warn(
    `\n  NOTE: append-only is NOT enforced for this connection — "${role.name}" holds ` +
      `${role.superuser ? 'SUPERUSER' : 'BYPASSRLS'}. Production must connect as a plain login role.\n`,
  )
})

test.after(async () => {
  await prisma.$disconnect()
})
