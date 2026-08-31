import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import sharp from 'sharp'

import { prisma } from '../../src/config/prisma.js'
import { stampImage, subjectRefFor } from '../../src/lib/imageMetadata.js'
import { identifyImage } from '../../src/modules/provenance/provenance.service.js'

// Reading provenance back out of an image that has left the platform.
//
// lib/imageMetadata.js stamped every exported JPEG and exported readStamp() with
// a docstring promising "the verification endpoint" — which did not exist. Every
// image that ever left carried an answer nobody could ask it for. These tests
// cover the asking.

// Every fixture gets DIFFERENT pixels. A flat-colour image is byte-identical
// across runs, and the content-hash fallback then matches whichever fixture photo
// happens to be oldest rather than this one — a test that passes or fails on row
// order, which is worse than no test.
async function makeJpeg(seed = Math.floor(Math.random() * 1e6)) {
  const width = 64
  const height = 48
  const raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < raw.length; i += 1) raw[i] = (seed * 31 + i * 7) % 256
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
}

// Registers cleanup BEFORE anything is created. seedWorld used to return the
// world and let the caller register t.after with it — so a throw partway through
// seeding left every row made up to that point in the database forever, which is
// exactly what happened the first time this file ran and left 18 orphan fixtures.
async function seedWorld(t) {
  const w = {}
  t.after(() => destroyWorld(w))

  const tag = randomUUID().slice(0, 8)
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const subjectId = randomUUID()
  // Recorded on the world BEFORE the rows exist, so a throw halfway through
  // still leaves destroyWorld something to delete. Registering cleanup around a
  // value that only exists once seeding SUCCEEDS is what left 18 orphan
  // fixtures in the database the first time this file ran.
  Object.assign(w, { tag, projectId, sessionId, subjectId })

  const agent = await prisma.adminUser.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } })
  assert.ok(agent, 'no active admin to own the fixture session')

  await prisma.subject.create({ data: {
    masterUserId: subjectId, group: 'VOLUNTEER', status: 'ACTIVE',
    fullName: `Provenance fixture ${tag}`, email: `prov-${tag}@prism.test`,
    registrationChannel: 'SELF', otpVerifiedAt: new Date(),
    generalTerms: true, piiProcessing: true, biometricMatch: true } })

  await prisma.project.create({ data: {
    id: projectId, name: `Provenance fixture ${tag}`,
    purpose: 'provenance lookup regression fixture', retention: '90 days', status: 'APPROVED' } })

  const consent = await prisma.projectConsent.create({
    data: { subjectId, projectId, status: 'ACTIVE', policyVersion: 'prov-1', signatureHash: randomUUID() },
    select: { consentId: true } })
  w.consentId = consent.consentId

  await prisma.session.create({ data: {
    id: sessionId, code: `PRV-${tag.slice(0, 4).toUpperCase()}`, projectId, agentId: agent.id,
    status: 'ARCHIVED', location: 'Fixture site' } })

  const source = await makeJpeg()
  const photo = await prisma.photo.create({ data: {
    sessionId, storagePath: `sessions/${sessionId}/raw/p.jpg`,
    cameraSource: 'DSLR', sha256: createHash('sha256').update(source).digest('hex'),
    mimeType: 'image/jpeg', sizeBytes: source.length, piiStatus: 'CLEAN' } })

  w.photo = photo

  await prisma.photoSubject.create({
    data: { photoId: photo.id, subjectId, consentId: consent.consentId } })

  const exportJob = await prisma.projectExport.create({
    data: { projectId, requestedByAdminId: agent.id, status: 'READY' },
    select: { id: true } })
  w.exportId = exportJob.id
  w.source = source

  return w
}

async function destroyWorld(w) {
  if (!w.subjectId) return
  await prisma.photoSubject.deleteMany({ where: { subjectId: w.subjectId } })
  if (w.sessionId) await prisma.photo.deleteMany({ where: { sessionId: w.sessionId } })
  if (w.sessionId) await prisma.session.deleteMany({ where: { id: w.sessionId } })
  if (w.exportId) await prisma.projectExport.deleteMany({ where: { id: w.exportId } })
  await prisma.projectConsent.deleteMany({ where: { subjectId: w.subjectId } })
  if (w.projectId) await prisma.project.deleteMany({ where: { id: w.projectId } })
  await prisma.subject.deleteMany({ where: { masterUserId: w.subjectId } })
  // AccessEvents are NOT cleaned up: prism_app has no DELETE on access_events,
  // because the read ledger is append-only by design. The rows this fixture
  // leaves behind are the correct outcome — a lookup that happened and can be
  // read back — not litter.
}

// The whole point of the feature: a file found on a training share resolves to
// the project and session it came from.
test('a stamped export resolves to its project, session and export job', async (t) => {
  const w = await seedWorld(t)

  const { buffer } = await stampImage(w.source, {
    projectId: w.projectId, exportId: w.exportId, photoId: w.photo.id,
    subjectRefs: [subjectRefFor(w.subjectId, w.exportId)],
    consentId: w.consentId, captureSessionId: w.sessionId, redaction: 'REDACTED',
  })

  const result = await identifyImage(buffer, { req: null })

  assert.equal(result.identified, true)
  assert.equal(result.method, 'STAMP')
  assert.equal(result.stamp.signature, 'VALID')
  assert.equal(result.project.id, w.projectId)
  assert.equal(result.session.id, w.sessionId)
  assert.equal(result.session.code.startsWith('PRV-'), true)
  assert.equal(result.export.id, w.exportId)
  assert.equal(result.consent.consentId, w.consentId)
  assert.equal(result.consent.status, 'ACTIVE')
})

// The refs are HMACs under a per-export key. They cannot be inverted, only
// re-derived and compared — so this asserts the re-derivation actually lands on
// the right person rather than on nobody.
test('an export-scoped subject ref resolves back to the person', async (t) => {
  const w = await seedWorld(t)

  const { buffer } = await stampImage(w.source, {
    projectId: w.projectId, exportId: w.exportId, photoId: w.photo.id,
    subjectRefs: [subjectRefFor(w.subjectId, w.exportId)],
    consentId: w.consentId, captureSessionId: w.sessionId, redaction: 'REDACTED',
  })

  const result = await identifyImage(buffer, { req: null })

  assert.equal(result.subjects.identified.length, 1)
  assert.equal(result.subjects.identified[0].subjectId, w.subjectId)
  assert.equal(result.subjects.identified[0].fullName, `Provenance fixture ${w.tag}`)
  assert.equal(result.subjects.unmatchedRefs.length, 0)
})

// A ref keyed to a DIFFERENT export must not resolve, or the per-export keying
// is decorative and two exports could be correlated through this endpoint.
test('a ref from another export does not resolve against this one', async (t) => {
  const w = await seedWorld(t)

  const otherExport = randomUUID()
  const { buffer } = await stampImage(w.source, {
    projectId: w.projectId, exportId: w.exportId, photoId: w.photo.id,
    subjectRefs: [subjectRefFor(w.subjectId, otherExport)],
    consentId: w.consentId, captureSessionId: w.sessionId, redaction: 'REDACTED',
  })

  const result = await identifyImage(buffer, { req: null })
  assert.equal(result.subjects.identified.length, 0, 'a ref keyed to another export resolved anyway')
  assert.equal(result.subjects.unmatchedRefs.length, 1, 'the unresolvable ref was dropped instead of reported')
})

// The most important thing this page can say: the copy in your hand is data that
// outlived the deletion the principal was told was complete.
test('a ref whose subject was erased is reported, not silently dropped', async (t) => {
  const w = await seedWorld(t)

  const { buffer } = await stampImage(w.source, {
    projectId: w.projectId, exportId: w.exportId, photoId: w.photo.id,
    subjectRefs: [subjectRefFor(w.subjectId, w.exportId)],
    consentId: w.consentId, captureSessionId: w.sessionId, redaction: 'REDACTED',
  })

  // The erasure: the link row goes, exactly as purge.service.js destroys it.
  await prisma.photoSubject.deleteMany({ where: { subjectId: w.subjectId } })

  const result = await identifyImage(buffer, { req: null })
  assert.equal(result.subjects.identified.length, 0)
  assert.equal(result.subjects.unmatchedRefs.length, 1, 'an erased subject vanished from the answer entirely')
  // The provenance still resolves — which is what makes the finding actionable.
  assert.equal(result.project.id, w.projectId)
  assert.equal(result.session.id, w.sessionId)
})

// Tampering must be visible, not merely absent.
test('a forged stamp is reported as a bad signature, not as valid', async (t) => {
  const w = await seedWorld(t)

  const { buffer } = await stampImage(w.source, {
    projectId: w.projectId, exportId: w.exportId, photoId: w.photo.id,
    subjectRefs: [], consentId: w.consentId, captureSessionId: w.sessionId, redaction: 'REDACTED',
  })

  // Flip a byte inside the base64url payload segment of the embedded stamp.
  const text = buffer.toString('latin1')
  const m = /PRISM1\.([A-Za-z0-9_-]+)\./.exec(text)
  assert.ok(m, 'the fixture image carries no stamp to forge')
  const body = m[1]
  const forgedBody = body.slice(0, -2) + (body.slice(-2) === 'AA' ? 'AB' : 'AA')
  const forged = Buffer.from(text.replace(body, forgedBody), 'latin1')

  const result = await identifyImage(forged, { req: null })
  assert.notEqual(result.stamp?.signature, 'VALID', 'a forged stamp verified')
})

// An unstamped file is not automatically "not ours" — the original in storage
// never carried a stamp, because the stamp is written at export.
test('an unstamped original is still identified by exact content hash', async (t) => {
  const w = await seedWorld(t)

  const result = await identifyImage(w.source, { req: null })

  assert.equal(result.identified, true)
  assert.equal(result.method, 'CONTENT_HASH')
  assert.equal(result.photo.id, w.photo.id)
  assert.equal(result.session.id, w.sessionId)
  // No exportId means no key to re-derive refs under, so no identities here.
  assert.equal(result.subjects.identified.length, 0)
})

test('a foreign image is reported as unidentifiable rather than guessed at', async (t) => {
  const stranger = await makeJpeg(200)
  const result = await identifyImage(stranger, { req: null })

  assert.equal(result.identified, false)
  assert.ok(result.reason, 'no reason was given for the non-match')
  assert.equal(result.subjects, undefined)
})
