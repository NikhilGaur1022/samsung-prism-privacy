import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { recordAccess } from '../../lib/accessLog.js'
import { createZip } from '../../lib/zip.js'
import { logger } from '../../lib/logger.js'
import { buildPersonRedacted } from '../sessions/session.service.js'

// What the principal sees before they destroy it.
//
// An erasure is the one irreversible act in this system, and until now it ran on
// a DPO's approval alone: the person who asked for it was never shown what "it"
// covered. They were asked to trust a count. This module is the review step —
// every frame they appear in, for the project they are erasing from, rendered so
// that THEIR face is the visible one and everyone else's is blurred.
//
// The inversion is deliberate and is the whole privacy argument:
//
//   in this package    their face visible, every other face redacted
//   after the erasure  their face redacted, every other face left alone
//
// Handing a requester unredacted frames of third parties would itself be a
// disclosure breach — the other people in that frame did not ask for anything and
// have no idea this request exists. So the package answers "which pictures of ME
// are you holding" without answering "and who else is in them".
//
// The access rule this respects, from session.service.js:2036: there is no
// subject-facing counterpart to readPersonRedactedPhoto, because "serving frames
// straight to a session cookie was a read channel over the dataset with no
// approval step". That reasoning is kept intact here. Every function below is
// reachable only through a DSAR request that (a) belongs to the caller, (b) is an
// ERASE, and (c) has been through discovery — so the frames are exactly the ones
// an operator has already scoped, and never the dataset at large.

/**
 * Loads the request and proves the caller may see its package.
 *
 * Ownership is checked against the subject id off the verified token, never off
 * anything in the URL. A request belonging to somebody else is a 404 rather than
 * a 403: confirming that an id exists is itself a fact about another person.
 */
async function loadReviewableRequest(requestId, subjectId, { forConfirm = false } = {}) {
  const request = await prisma.dsarRequest.findFirst({
    where: { id: requestId, subjectId },
    select: {
      id: true,
      subjectId: true,
      projectId: true,
      type: true,
      status: true,
      subjectConfirmedAt: true,
      createdAt: true,
      project: { select: { id: true, name: true } },
    },
  })
  if (!request) throw new ApiError(404, 'Request not found')

  if (request.type !== 'ERASE') {
    throw new ApiError(
      409,
      `This review step belongs to an erasure request. This one is ${request.type}; an access request is served through the §11 package instead.`,
    )
  }

  // Before discovery there is no scoped answer to "which frames" — only the whole
  // dataset, which is precisely what must not be browsable.
  if (['RECEIVED', 'TRIAGE'].includes(request.status)) {
    throw new ApiError(
      409,
      'This request has not been through discovery yet. The material it covers is not known, so there is nothing to review.',
    )
  }
  if (request.status === 'REJECTED') {
    throw new ApiError(409, 'This request was rejected. There is nothing to erase.')
  }

  if (forConfirm) {
    if (request.subjectConfirmedAt) {
      throw new ApiError(409, 'You have already confirmed this erasure.')
    }
    // After EXECUTING the destruction has begun; a confirmation then would be a
    // signature on something already done.
    if (request.status !== 'DISCOVERY') {
      throw new ApiError(
        409,
        `This erasure is already ${request.status.toLowerCase()} and can no longer be confirmed.`,
      )
    }
  }

  return request
}

/**
 * The frames in scope: every photo this subject is linked to, narrowed to the
 * request's project when it names one.
 *
 * Scoping is by the LINK, not by the photo, for the same reason erasure is: a
 * photo is in scope because this person is in it and consented to it, and the
 * link is the record of that.
 *
 * Narrowed by CONSENT ID, matching discovery.service.js exactly, and that match
 * is the point. Scoping this by `photo.session.projectId` instead reads more
 * naturally and is wrong in the way that matters: the purge erases what discovery
 * found, so any frame this screen shows that discovery would not have found is a
 * frame the principal is told is being erased and which then quietly survives.
 * A review that overstates the action is worse than no review.
 */
async function scopedLinks(request) {
  const byConsent = request.projectId
    ? {
        consentId: {
          in: (
            await prisma.projectConsent.findMany({
              where: { subjectId: request.subjectId, projectId: request.projectId },
              select: { consentId: true },
            })
          ).map((c) => c.consentId),
        },
      }
    : {}

  return prisma.photoSubject.findMany({
    where: {
      subjectId: request.subjectId,
      ...byConsent,
    },
    select: {
      id: true,
      photoId: true,
      photo: {
        select: {
          id: true,
          sessionId: true,
          createdAt: true,
          piiStatus: true,
          session: { select: { id: true, code: true, projectId: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  })
}

/**
 * The manifest the review screen renders: what is in scope, and what will happen
 * to each frame.
 *
 * `willBeDeleted` is derived per photo from the links that remain: this subject
 * is the last one on it, so nothing survives the removal of their link and the
 * frame goes entirely. Otherwise the frame is kept for the others and rebuilt
 * with this person blurred. It is a projection, not a promise — purge.service
 * re-derives it at execution time from the links as they stand then, because
 * somebody else may withdraw in between.
 */
export async function listErasurePackage(requestId, subjectId) {
  const request = await loadReviewableRequest(requestId, subjectId)
  const links = await scopedLinks(request)

  const photoIds = links.map((l) => l.photoId)
  const others = photoIds.length
    ? await prisma.photoSubject.groupBy({
        by: ['photoId'],
        where: { photoId: { in: photoIds }, subjectId: { not: subjectId } },
        _count: { _all: true },
      })
    : []
  const otherCount = new Map(others.map((o) => [o.photoId, o._count._all]))

  const items = links.map((link) => {
    const remaining = otherCount.get(link.photoId) ?? 0
    return {
      photoId: link.photoId,
      sessionId: link.photo.sessionId,
      sessionCode: link.photo.session?.code ?? null,
      capturedAt: link.photo.createdAt,
      othersInFrame: remaining,
      willBeDeleted: remaining === 0,
    }
  })

  const deleting = items.filter((i) => i.willBeDeleted).length

  return {
    requestId: request.id,
    status: request.status,
    confirmedAt: request.subjectConfirmedAt,
    project: request.project ?? null,
    // Named so the screen can say "12 photos: 3 deleted, 9 with your face
    // removed" rather than making the principal count tiles.
    counts: {
      total: items.length,
      willBeDeleted: deleting,
      willBeRedacted: items.length - deleting,
    },
    items,
  }
}

/**
 * One frame from the package, with every other face blurred.
 *
 * Re-scoped on every call. Holding a photo id from a listing is not authority to
 * read it — the id has to still be in THIS request's scope at read time, or a
 * principal could keep reading a frame after their link to it was removed.
 */
export async function readErasurePackagePhoto(requestId, subjectId, photoId, { req } = {}) {
  const request = await loadReviewableRequest(requestId, subjectId)

  // Membership is decided by the SAME query that built the listing, not by a
  // second one written to look equivalent. Two scoping rules that drift apart is
  // how a frame becomes readable here that the listing never offered.
  const links = await scopedLinks(request)
  const link = links.find((l) => l.photoId === photoId)
  if (!link) throw new ApiError(404, 'That photo is not part of this request')

  // Invariant 6: the AccessEvent is written before anything is decrypted. This is
  // a read of personal data by the principal themselves, which is still a read.
  await recordAccess({
    objectType: 'ERASURE_REVIEW_PHOTO',
    objectId: photoId,
    action: 'VIEW',
    purpose: 'DSAR_ERASURE_REVIEW',
    dsarRequestId: requestId,
    // The actor is resolved from the verified token by actorFromRequest, not
    // passed in: an actor id supplied by the caller is an actor id the caller
    // chose, and this row is evidence.
    req,
  })

  return buildPersonRedacted(link.photo.sessionId, photoId, subjectId)
}

/**
 * The whole package as a ZIP.
 *
 * Built on demand rather than stored. It is derived entirely from material we
 * already hold, so caching it would mean keeping a second copy of the
 * principal's face around for the sake of a download that happens once — and
 * that copy would then need its own erasure path.
 */
export async function buildErasurePackageZip(requestId, subjectId, { req } = {}) {
  const request = await loadReviewableRequest(requestId, subjectId)
  const links = await scopedLinks(request)

  if (links.length === 0) {
    throw new ApiError(404, 'There are no photos of you in the scope of this request.')
  }

  await recordAccess({
    objectType: 'ERASURE_REVIEW_PACKAGE',
    objectId: requestId,
    action: 'EXPORT',
    purpose: 'DSAR_ERASURE_REVIEW',
    dsarRequestId: requestId,
    req,
  })

  const files = []
  const failed = []
  for (const link of links) {
    try {
      const { buffer } = await buildPersonRedacted(link.photo.sessionId, link.photoId, subjectId)
      files.push({ name: `photos/${link.photoId}.jpg`, data: buffer })
    } catch (err) {
      // One unreadable frame must not cost the principal the other forty. It is
      // named in the manifest instead, so the archive never silently understates
      // what is held.
      logger.error({ err, photoId: link.photoId, requestId }, 'erasure package: frame could not be rendered')
      failed.push(link.photoId)
    }
  }

  const manifest = {
    requestId: request.id,
    generatedAt: new Date().toISOString(),
    project: request.project ?? null,
    photoCount: files.length,
    unavailable: failed,
    note:
      'Every face in these images except your own has been blurred. This is what we hold of you in this project. ' +
      'If you confirm the erasure, the frames where you are the only participant are destroyed, and in the rest your face is blurred out while the other participants remain.',
  }
  files.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) })

  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'ERASURE_PACKAGE_DOWNLOADED',
    actorId: null,
    payload: { photoCount: files.length - 1, unavailable: failed.length },
  })

  return {
    buffer: createZip(files),
    filename: `prism-erasure-review-${requestId}.zip`,
  }
}

/**
 * The principal presses Erase.
 *
 * This is the authorisation for everything that follows, so it records who and
 * when, and it records the scope as the principal understood it — the counts they
 * were shown. If the material later differs from that projection, the audit row
 * is what shows the discrepancy.
 */
export async function confirmErasure(requestId, subjectId) {
  const request = await loadReviewableRequest(requestId, subjectId, { forConfirm: true })
  const summary = await listErasurePackage(requestId, subjectId)

  const updated = await prisma.dsarRequest.update({
    where: { id: requestId },
    data: { subjectConfirmedAt: new Date() },
    select: { id: true, status: true, subjectConfirmedAt: true },
  })

  // Two records, because they answer two different questions and neither can
  // answer the other's.
  //
  // DsarEvidence holds the payload IN FULL. That is the whole reason the table
  // exists — audit_log stores a hash and no payload (invariant 7), so it can show
  // that a confirmation happened and cannot show what was confirmed. The
  // authorisation for an irreversible act has to be provable to a regulator, and
  // "they agreed to something, we kept the hash" is not proof of scope.
  const evidencePayload = {
    projectId: request.projectId,
    // The counts as the principal saw them at the moment they agreed. If the
    // purge later reports different figures, this is what makes the discrepancy
    // visible instead of deniable.
    countsShown: summary.counts,
    photoIds: summary.items.map((i) => i.photoId),
    confirmedAt: updated.subjectConfirmedAt.toISOString(),
  }

  await prisma.dsarEvidence.create({
    data: {
      dsarRequestId: requestId,
      kind: 'APPROVAL',
      label: `Principal confirmed erasure — ${summary.counts.willBeDeleted} to delete, ${summary.counts.willBeRedacted} to redact`,
      payload: evidencePayload,
      contentHash: createHash('sha256').update(JSON.stringify(evidencePayload)).digest('hex'),
      // Null: no admin did this. The principal did, and the actor is recorded on
      // the audit row and the request's own timestamp.
      createdByAdminId: null,
    },
  })

  // And the audit row, for the tamper-evident chain.
  await writeAuditLog({
    entityType: 'DsarRequest',
    entityId: requestId,
    action: 'ERASURE_CONFIRMED_BY_SUBJECT',
    actorId: null,
    payload: evidencePayload,
  })

  logger.info(
    { requestId, subjectId, counts: summary.counts },
    'data principal confirmed erasure — execution is now unblocked',
  )

  return { request: updated, counts: summary.counts }
}
