import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { prisma } from '../../src/config/prisma.js'
import { indexSubject } from '../../src/modules/dsar/itemIndex.service.js'
import { getRequestTimeline } from '../../src/modules/dsar/timeline.service.js'
import { coarseStatus, statusesFor, COARSE } from '../../src/modules/dsar/lifecycle.js'
import { listQueue, closeRequest, runDiscoveryForRequest, attachEvidence } from '../../src/modules/dsar/dsar.service.js'
import { requestActions } from '../../src/modules/dsar/itemAction.service.js'
import { listItemsForRequest } from '../../src/modules/dsar/itemSearch.service.js'
import { buildAccessPackage } from '../../src/modules/dsar/export.service.js'
import { writeFile, shredFile, fileExists } from '../../src/lib/storage.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closeItemActionQueue } from '../../src/lib/itemActionQueue.js'

// Phase 7. The stated core pain point is "what requests exist, what state, what
// happened" — so this file drives one request through a realistic working day
// (discovery → search → bulk action → export → close) and then asserts the
// timeline can answer that question afterwards.
//
// The trap it exists to catch: AuditLog stores a hash of each payload and never
// the payload. A timeline built from the chain would be a list of verbs with no
// content. Every "what" below must come from a typed table, with the chain
// attached only as tamper-evidence.
//
// Needs DB, media store and Redis (a REDACT enqueues).
//   node --test tests/integration/dsar-timeline.test.js

const RUN = randomUUID().slice(0, 8)

const ids = {
  admin: randomUUID(),
  project: randomUUID(),
  session: randomUUID(),
  subject: randomUUID(),
  bystander: randomUUID(),
  request: randomUUID(),
  openRequest: randomUUID(),
}

const SOLO_PHOTOS = 3
const SHARED_PHOTOS = 1
const TOTAL_PHOTOS = SOLO_PHOTOS + SHARED_PHOTOS

const dataAdmin = { id: ids.admin, role: 'dataAdmin' }
const dpo = { id: randomUUID(), role: 'dpo' }
const collectionAgent = { id: randomUUID(), role: 'collectionAgent' }
const writtenPaths = []

async function seedSubject(masterUserId, name) {
  await prisma.subject.create({
    data: {
      masterUserId,
      group: 'VOLUNTEER',
      status: 'ACTIVE',
      fullName: `${RUN} ${name}`,
      email: `${name.toLowerCase()}-${RUN}@timeline.test`,
      registrationChannel: 'AGENT',
    },
  })
  return prisma.projectConsent.create({
    data: {
      subjectId: masterUserId,
      projectId: ids.project,
      status: 'ACTIVE',
      policyVersion: 'v1',
      signatureHash: 'test',
    },
  })
}

test.before(async () => {
  await prisma.adminUser.create({
    data: { id: ids.admin, email: `admin-${RUN}@timeline.test`, role: 'dataAdmin', status: 'ACTIVE' },
  })
  await prisma.project.create({
    data: { id: ids.project, name: `timeline ${RUN}`, purpose: 'testing', status: 'ACTIVE', ownerAdminId: ids.admin },
  })

  const consent = await seedSubject(ids.subject, 'Sharmila')
  const bystanderConsent = await seedSubject(ids.bystander, 'Ibrahim')

  await prisma.session.create({
    data: {
      id: ids.session,
      code: `TL-${randomUUID().slice(0, 8)}`,
      projectId: ids.project,
      agentId: ids.admin,
      status: 'ARCHIVED',
    },
  })

  for (let n = 0; n < TOTAL_PHOTOS; n += 1) {
    const redactedPath = `sessions/${ids.session}/redacted/${RUN}-${n}.jpg`
    await writeFile(redactedPath, Buffer.from(`derivative-${RUN}-${n}`.repeat(8), 'utf8'))
    writtenPaths.push(redactedPath)

    const photo = await prisma.photo.create({
      data: {
        sessionId: ids.session,
        storagePath: `sessions/${ids.session}/original/${RUN}-${n}.jpg`,
        redactedPath,
        piiStatus: 'CLEAN',
        cameraSource: 'IPHONE_UPLOAD',
        sha256: `${RUN}-${n}-${randomUUID()}`,
        mimeType: 'image/jpeg',
        sizeBytes: 2048,
        takenAt: new Date(Date.UTC(2026, 6, 20, 9, n)),
      },
    })
    await prisma.photoSubject.create({
      data: { photoId: photo.id, subjectId: ids.subject, consentId: consent.consentId },
    })
    if (n >= SOLO_PHOTOS) {
      await prisma.photoSubject.create({
        data: { photoId: photo.id, subjectId: ids.bystander, consentId: bystanderConsent.consentId },
      })
    }
  }

  await prisma.dsarRequest.createMany({
    data: [
      { id: ids.request, subjectId: ids.subject, type: 'ACCESS', status: 'TRIAGE', channel: 'PORTAL', assignedAdminId: ids.admin, slaDueAt: new Date(Date.now() + 30 * 86_400_000) },
      { id: ids.openRequest, subjectId: ids.bystander, type: 'GRIEVANCE', status: 'RECEIVED', channel: 'PORTAL', slaDueAt: new Date(Date.now() + 30 * 86_400_000) },
    ],
  })

  await indexSubject(ids.subject)
  await indexSubject(ids.bystander)
})

test.after(async () => {
  try {
    const packages = await prisma.dsarEvidence.findMany({
      where: { dsarRequestId: ids.request, storagePath: { not: null } },
      select: { storagePath: true },
    })
    for (const p of [...packages.map((p) => p.storagePath), ...writtenPaths]) {
      if (await fileExists(p)) await shredFile(p)
    }
    await prisma.dsarRequest.deleteMany({ where: { id: { in: [ids.request, ids.openRequest] } } })
    await prisma.subject.deleteMany({ where: { masterUserId: { in: [ids.subject, ids.bystander] } } })
    await prisma.session.deleteMany({ where: { id: ids.session } })
    await prisma.project.deleteMany({ where: { id: ids.project } })
    await prisma.adminUser.deleteMany({ where: { id: ids.admin } })
  } finally {
    await Promise.allSettled([closeRedactionQueue(), closeItemActionQueue()])
    await prisma.$disconnect()
  }
})

test('the coarse map covers every DsarStatus exactly once', () => {
  const all = ['RECEIVED', 'TRIAGE', 'DISCOVERY', 'EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED']
  const seen = []
  for (const coarse of Object.values(COARSE)) seen.push(...statusesFor(coarse))
  assert.deepEqual([...seen].sort(), [...all].sort(), 'a status in no tab is a request nobody can find')
  assert.equal(new Set(seen).size, seen.length, 'a status in two tabs would be counted twice')
  assert.equal(coarseStatus('DISCOVERY'), COARSE.IN_PROGRESS)
  assert.equal(coarseStatus('REJECTED'), COARSE.CLOSED)
  // An unmapped value must still land somewhere visible rather than vanish.
  assert.equal(coarseStatus('SOMETHING_NEW'), COARSE.OPEN)
})

test('a request that was worked end to end has every step on its timeline, in order', async () => {
  // ---- discovery -----------------------------------------------------------
  await runDiscoveryForRequest(ids.request, dataAdmin)

  // ---- search (an AccessEvent bound to this request) ------------------------
  await listItemsForRequest(ids.request, dataAdmin, { limit: 10 })

  // ---- bulk action, including a shared frame that must downgrade ------------
  const items = await prisma.subjectDataItem.findMany({
    where: { subjectId: ids.subject, deletedAt: null },
  })
  const batch = await requestActions(
    { dsarRequestId: ids.request, itemIds: items.map((i) => i.id), kind: 'REDACT', reason: 'masking pass before release' },
    dataAdmin,
    { inline: true },
  )

  // ---- evidence + export ---------------------------------------------------
  await attachEvidence(
    ids.request,
    { kind: 'IDENTITY_PROOF', label: 'Passport checked in person', payload: { checkedBy: 'front desk' } },
    dataAdmin,
  )
  await buildAccessPackage(ids.request, dataAdmin, { selection: 'ALL' })

  // ---- close ---------------------------------------------------------------
  await prisma.dsarRequest.update({ where: { id: ids.request }, data: { status: 'REVIEW' } })
  await closeRequest(ids.request, { note: 'Package delivered and acknowledged' }, dataAdmin)

  const timeline = await getRequestTimeline(ids.request, dataAdmin)

  assert.equal(timeline.coarseStatus, COARSE.CLOSED)
  assert.match(timeline.subjectRef, /^SUB-[0-9a-f]{8}$/, 'the timeline must never name the principal')
  assert.equal(JSON.stringify(timeline).includes(ids.subject), false, 'the raw subject id must not appear anywhere')

  const kinds = timeline.entries.map((e) => e.kind)
  for (const expected of ['TRANSITION', 'ITEM_ACTION_BATCH', 'EVIDENCE', 'ACCESS']) {
    assert.ok(kinds.includes(expected), `timeline is missing a ${expected} entry`)
  }

  // Ordered, and the order is the thing an auditor reads it for.
  const times = timeline.entries.map((e) => e.at)
  assert.deepEqual(times, [...times].sort(), 'entries must be time-ordered')

  // The "what", read from typed tables rather than invented from the chain.
  const actionEntry = timeline.entries.find((e) => e.kind === 'ITEM_ACTION_BATCH' && e.refId === batch.batchId)
  assert.ok(actionEntry, 'the bulk action must be one entry, not one per item')
  assert.equal(actionEntry.detail.total, items.length)
  assert.equal(actionEntry.detail.reason, 'masking pass before release')
  assert.equal(actionEntry.actor.id, ids.admin, 'an action with no attributable actor is not an audit trail')

  const evidenceEntries = timeline.entries.filter((e) => e.kind === 'EVIDENCE')
  assert.ok(
    evidenceEntries.some((e) => /identity proof/i.test(e.summary)),
    'evidence content comes from dsar_evidence, which kept it',
  )
  assert.ok(
    evidenceEntries.some((e) => /export package/i.test(e.summary)),
    'the package build must be on the record',
  )
  for (const e of evidenceEntries) assert.equal(typeof e.hash, 'string')

  // The chain is attached as evidence, not mined for content.
  assert.ok(timeline.integrity.auditEntries > 0)
  assert.equal(timeline.integrity.verifyWith, '/api/v1/audit/verify')
  assert.match(timeline.integrity.note, /never the payload/)

  const closed = timeline.entries.filter((e) => e.kind === 'TRANSITION' && e.detail.action === 'DSAR_CLOSED')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].at, timeline.entries[timeline.entries.length - 1].at, 'the close is the last thing that happened')
})

test('closing is refused while an item action is still in flight', async () => {
  await prisma.dsarRequest.update({ where: { id: ids.openRequest }, data: { status: 'REVIEW' } })

  const item = await prisma.subjectDataItem.findFirst({ where: { subjectId: ids.bystander, deletedAt: null } })
  assert.ok(item, 'the bystander needs at least one item')

  // Recorded but never executed — exactly the state a queued bulk action is in
  // between the click and the worker picking it up.
  const stuck = await prisma.dsarItemAction.create({
    data: {
      dsarRequestId: ids.openRequest,
      itemId: item.id,
      kind: 'REDACT',
      status: 'REQUESTED',
      requestedByAdminId: ids.admin,
      batchId: randomUUID(),
    },
  })

  await assert.rejects(
    () => closeRequest(ids.openRequest, { note: 'closing early' }, dataAdmin),
    (err) => err.statusCode === 409 && /have not finished/.test(err.message),
    'a closed request would report the obligation as met while the work is still running',
  )

  const still = await prisma.dsarRequest.findUnique({ where: { id: ids.openRequest } })
  assert.equal(still.status, 'REVIEW', 'the refused close must not have moved the request')

  // Once it lands, the close goes through.
  await prisma.dsarItemAction.update({
    where: { id: stuck.id },
    data: { status: 'DONE', completedAt: new Date() },
  })
  const closed = await closeRequest(ids.openRequest, { note: 'action landed' }, dataAdmin)
  assert.equal(closed.status, 'CLOSED')
  assert.equal(closed.coarseStatus, COARSE.CLOSED)

  const closureEvidence = await prisma.dsarEvidence.findFirst({
    where: { dsarRequestId: ids.openRequest, label: { startsWith: 'Closure' } },
  })
  assert.ok(closureEvidence, 'a close must leave evidence of who closed it and why')
  assert.equal(closureEvidence.payload.closedBy, ids.admin)
})

test('an erasure still cannot be closed without a certificate', async () => {
  const erase = await prisma.dsarRequest.create({
    data: {
      subjectId: ids.subject,
      type: 'ERASE',
      status: 'REVIEW',
      channel: 'PORTAL',
      slaDueAt: new Date(Date.now() + 30 * 86_400_000),
    },
  })
  try {
    await assert.rejects(
      () => closeRequest(erase.id, { note: 'done' }, dataAdmin),
      (err) => err.statusCode === 409 && /certificate/i.test(err.message),
    )
  } finally {
    await prisma.dsarRequest.delete({ where: { id: erase.id } })
  }
})

test('the queue reports coarse tabs, counters and a keyset cursor', async () => {
  const page = await listQueue({ admin: dataAdmin }, { limit: 1 })

  assert.ok(Array.isArray(page.items))
  assert.equal(page.items.length, 1, 'the limit must be honoured')
  assert.ok(page.nextCursor, 'a full page must hand back a cursor')
  assert.ok(page.counts.OPEN + page.counts.IN_PROGRESS + page.counts.CLOSED > 0)
  assert.equal(typeof page.items[0].coarseStatus, 'string')
  assert.ok(page.items[0].counters, 'the dashboard needs per-request counters')

  const second = await listQueue({ admin: dataAdmin }, { limit: 1, cursor: page.nextCursor })
  assert.notEqual(second.items[0]?.id, page.items[0].id, 'the cursor must advance')

  const closedOnly = await listQueue({ admin: dataAdmin }, { coarse: 'CLOSED', limit: 200 })
  for (const r of closedOnly.items) {
    assert.ok(['CLOSED', 'REJECTED'].includes(r.status), `${r.status} is not a closed status`)
  }
  assert.ok(closedOnly.items.some((r) => r.id === ids.request), 'the request closed above should be in the Closed tab')
})

test('the dpo reads the timeline pseudonymously; a collection agent cannot read it at all', async () => {
  const asDpo = await getRequestTimeline(ids.request, dpo)
  assert.match(asDpo.subjectRef, /^SUB-/)
  assert.equal(asDpo.subjectId, undefined)

  await assert.rejects(
    () => getRequestTimeline(ids.request, collectionAgent),
    (err) => err.statusCode === 403,
  )
})
