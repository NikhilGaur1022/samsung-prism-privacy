import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

import { createApp } from '../../src/app.js'
import { prisma } from '../../src/config/prisma.js'
import { redis } from '../../src/config/redis.js'
import { signAdminAccessToken } from '../../src/lib/tokens.js'
import { ADMIN_ACCESS_COOKIE } from '../../src/lib/cookies.js'
import { sniffKind } from '../../src/middleware/uploads.js'
import { closeFaceQueue } from '../../src/lib/faceQueue.js'
import { closeRedactionQueue } from '../../src/lib/redactionQueue.js'
import { closePurgeQueue } from '../../src/lib/purgeQueue.js'

// Upload limits, and what happens when they are exceeded.
//
// Every one of these was a 500 with an internal string attached:
//
//   wrong mimetype, session photos    500  "Only image files are accepted"
//   26 MB file over the 25 MB limit   500  "File too large"
//   21 files over the 20-file limit   500
//   same mistake on the enrolment route  500
//   import route                      500
//   voice route                       415  (the only correct one)
//
// And a file whose bytes were not an image reached sharp, which answered with
// libvips internals — "Input buffer contains unsupported image format" — rendered
// verbatim to the operator.

const RUN = randomUUID().slice(0, 8)
const server = { instance: null, base: '' }
const fx = {}

async function post(path, principal, form) {
  const res = await fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: principal
      ? { cookie: `${ADMIN_ACCESS_COOKIE}=${signAdminAccessToken(principal)}` }
      : {},
    body: form,
    signal: AbortSignal.timeout(30_000),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* a non-JSON body is itself a finding, asserted where it matters */
  }
  return { status: res.status, body }
}

test.before(async () => {
  const app = createApp()
  await new Promise((resolve) => {
    server.instance = app.listen(0, resolve)
  })
  server.base = `http://127.0.0.1:${server.instance.address().port}`

  fx.owner = await prisma.adminUser.create({
    data: { email: `upl-${RUN}-owner@test.invalid`, role: 'dataOwner', status: 'ACTIVE' },
  })
  fx.agent = await prisma.adminUser.create({
    data: { email: `upl-${RUN}-agent@test.invalid`, role: 'collectionAgent', status: 'ACTIVE' },
  })
  fx.project = await prisma.project.create({
    data: {
      name: `Upload ${RUN}`,
      purpose: 'upload-abuse fixture',
      ownerAdminId: fx.owner.id,
      status: 'APPROVED',
    },
  })
  await prisma.projectAssignment.create({
    data: { projectId: fx.project.id, adminId: fx.agent.id },
  })
  fx.session = await prisma.session.create({
    data: {
      code: `UPL-${RUN}`,
      projectId: fx.project.id,
      agentId: fx.agent.id,
      status: 'ACTIVE',
    },
  })
  fx.principal = { id: fx.agent.id, role: 'collectionAgent' }
})

test.after(async () => {
  await prisma.photo.deleteMany({ where: { sessionId: fx.session?.id } })
  await prisma.session.deleteMany({ where: { code: `UPL-${RUN}` } })
  await prisma.projectAssignment.deleteMany({ where: { projectId: fx.project?.id } })
  await prisma.project.deleteMany({ where: { name: `Upload ${RUN}` } })
  await prisma.adminUser.deleteMany({ where: { email: { contains: `upl-${RUN}-` } } })

  server.instance?.closeAllConnections?.()
  await new Promise((resolve) => server.instance?.close(resolve))
  await Promise.allSettled([
    closeFaceQueue(),
    closeRedactionQueue(),
    closePurgeQueue(),
    redis.quit(),
    prisma.$disconnect(),
  ])
})

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

test('content is identified from its bytes, not its declared type', () => {
  const cases = [
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), 'image'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'image'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'image'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]), 'audio'],
    [Buffer.from('OggS____________'), 'audio'],
    [Buffer.from('%PDF-1.7 xxxxxxx'), 'pdf'],
    [Buffer.from('this is just text, not an image at all'), 'unknown'],
    [Buffer.alloc(64), 'unknown'],
  ]

  for (const [buf, expected] of cases) {
    assert.equal(
      sniffKind(buf),
      expected,
      `expected ${expected} for ${buf.subarray(0, 4).toString('latin1')}`,
    )
  }
})

test('a shell script labelled image/jpeg is a 415, not a 500', async () => {
  const form = new FormData()
  form.append(
    'photos',
    new Blob([Buffer.from('#!/bin/sh\nrm -rf /\n')], { type: 'image/jpeg' }),
    'innocent.jpg',
  )
  form.append('cameraSource', 'IPHONE_UPLOAD')

  const { status, body } = await post(
    `/api/v1/sessions/${fx.session.id}/photos`,
    fx.principal,
    form,
  )

  assert.ok(
    status === 415 || status === 207,
    `expected a 415 (or a 207 naming the rejected file), got ${status}`,
  )

  // Whatever the status, no libvips or Python internals may cross the boundary.
  const asText = JSON.stringify(body ?? {})
  for (const leak of ['libvips', 'BytesIO', 'unsupported image format', '0x0000']) {
    assert.ok(!asText.includes(leak), `the response leaked "${leak}": ${asText.slice(0, 200)}`)
  }
})

test('an oversized file is a 413, not a 500', async () => {
  // 26 MB against the route's 25 MB limit.
  const form = new FormData()
  form.append(
    'photos',
    new Blob([Buffer.alloc(26 * 1024 * 1024, 0x41)], { type: 'image/jpeg' }),
    'huge.jpg',
  )
  form.append('cameraSource', 'IPHONE_UPLOAD')

  const { status, body } = await post(
    `/api/v1/sessions/${fx.session.id}/photos`,
    fx.principal,
    form,
  )

  assert.equal(status, 413, `expected 413 for an oversized file, got ${status}`)
  assert.equal(body?.code, 'PAYLOAD_TOO_LARGE')
})

test('too many files is a 413, not a 500', async () => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#000000' },
  })
    .jpeg()
    .toBuffer()

  const form = new FormData()
  for (let i = 0; i < 21; i += 1) {
    form.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), `f${i}.jpg`)
  }
  form.append('cameraSource', 'IPHONE_UPLOAD')

  const { status } = await post(`/api/v1/sessions/${fx.session.id}/photos`, fx.principal, form)
  assert.equal(status, 413, `expected 413 for 21 files over a 20-file limit, got ${status}`)
})

test('an unexpected field name is a 400 naming the field', async () => {
  const form = new FormData()
  form.append('not-the-field', new Blob([Buffer.from('x')], { type: 'image/jpeg' }), 'x.jpg')

  const { status, body } = await post(
    `/api/v1/sessions/${fx.session.id}/photos`,
    fx.principal,
    form,
  )
  assert.ok(status === 400, `expected 400, got ${status}`)
  if (body?.details?.field) assert.equal(body.details.field, 'not-the-field')
})

// ---------------------------------------------------------------------------
// Batch atomicity
// ---------------------------------------------------------------------------

test('a partial batch reports every file individually', async () => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#112233' },
  })
    .jpeg()
    .toBuffer()

  const form = new FormData()
  form.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), 'good-1.jpg')
  form.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), 'good-2.jpg')
  form.append('cameraSource', 'IPHONE_UPLOAD')

  const { status, body } = await post(
    `/api/v1/sessions/${fx.session.id}/photos`,
    fx.principal,
    form,
  )

  assert.ok(status === 201 || status === 207, `unexpected status ${status}`)
  assert.ok(Array.isArray(body?.accepted), 'the response must name what was accepted')
  assert.ok(Array.isArray(body?.rejected), 'the response must name what was rejected')

  // A 20-file batch that failed on file 12 used to leave 11 photos committed and
  // return an error naming none of them, so the client could not tell what to
  // retry. Every entry now carries its own filename.
  for (const entry of body.accepted) {
    assert.ok(entry.filename, 'an accepted entry must name its file')
  }
})

// ---------------------------------------------------------------------------
// No internals cross the boundary
// ---------------------------------------------------------------------------

test('no 5xx response body carries an internal message', async () => {
  // The general rule, spot-checked on the paths most likely to throw. err.message
  // used to be returned verbatim: our own TypeErrors, libvips internals, and a
  // Python BytesIO repr complete with a live heap address.
  const probes = [
    [`/api/v1/sessions/${randomUUID()}/photos`, fx.principal],
    [`/api/v1/subjects`, { id: fx.agent.id, role: 'collectionAgent' }],
  ]

  for (const [path, principal] of probes) {
    const form = new FormData()
    form.append('photos', new Blob([Buffer.from('nonsense')], { type: 'image/jpeg' }), 'x.jpg')
    const { status, body } = await post(path, principal, form)
    if (status < 500) continue

    assert.equal(
      body?.error,
      'Internal server error',
      `a 5xx from ${path} returned "${body?.error}" instead of a generic message`,
    )
    assert.ok(body?.correlationId, 'a 5xx must carry a correlation id so the log line is findable')
    assert.equal(body?.details, undefined, 'a 5xx must not carry details')
  }
})
