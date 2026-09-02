import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { readFile, writeFile } from '../../lib/storage.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { loadSessionForMedia } from '../sessions/session.service.js'
import { UNRESOLVED_VIDEO_WHERE, isVideoUnresolved } from '../../lib/photoState.js'
import { workerFetch, readWorkerError } from '../../lib/workerFetch.js'

const VIDEO_SERVICE_URL = process.env.VIDEO_SERVICE_URL ?? 'http://localhost:8005'

// Opts OUT of stripping, and is for one situation only: a deployment that has a
// lawful basis for the soundtrack and processes it as a recording elsewhere.
//
// Left unset — the default — a clip's audio stream is removed at ingest, because
// video capture here carries no voice-consent decision and the worker's /redact
// passes -an regardless. Without the strip a soundtrack nobody screened would
// survive in the ORIGINAL while silently vanishing from the derivative, which is
// the worst of both: unscreened voice data retained, and a derivative that does
// not match the thing it derives from.
//
// Setting this true keeps the audio in the stored original. It does not create a
// consent basis for it; it only says one exists.
const ALLOW_AUDIO = process.env.VIDEO_ALLOW_AUDIO === 'true'

const EXTENSION_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpeg',
}

export function extensionFor(mimeType) {
  return EXTENSION_BY_MIME[String(mimeType).toLowerCase()] ?? 'mp4'
}

// Same shape and same reason as PiiUnavailableError in session.service.js and
// AudioUnavailableError in recording.service.js: "the worker is down" and "the
// worker found nobody" must never collapse into one outcome. A caller that
// swallows this and treats it as "no faces" ships an unredacted clip.
export class VideoUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'VideoUnavailableError'
    this.cause = cause
  }
}

/** Pulls the worker's own explanation out of a failed response. Never throws. */
async function workerDetail(res) {
  try {
    const body = await res.text()
    if (!body) return ''
    try {
      const detail = JSON.parse(body)?.detail
      if (typeof detail === 'string') return ` — ${detail}`
    } catch {
      // Not JSON — a proxy's error page. Truncated so it cannot flood an audit row.
    }
    return ` — ${body.slice(0, 500)}`
  } catch {
    return ''
  }
}

// `form` may be a factory so a retry can rebuild it — a FormData carrying a Blob
// is single-use, and re-sending the same object sends an empty body.
async function callWorker(path, form, { expect = 'json' } = {}) {
  let res
  try {
    res = await workerFetch('video', `${VIDEO_SERVICE_URL}${path}`, {
      body: typeof form === 'function' ? form : () => form,
    })
  } catch (err) {
    throw new VideoUnavailableError(`Video worker unreachable at ${path}`, err)
  }
  if (!res.ok) {
    throw new VideoUnavailableError(
      `Video worker failed at ${path} (${await readWorkerError('video', res)})`,
    )
  }
  if (expect === 'buffer') {
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) {
      throw new VideoUnavailableError(`Video worker returned an empty file from ${path}`)
    }
    return buffer
  }
  return res.json()
}

function videoBlob(buffer, mimeType) {
  return new Blob([buffer], { type: mimeType || 'video/mp4' })
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export async function uploadVideo(sessionId, file, admin) {
  const session = await loadSessionForMedia(sessionId, admin)
  // Same gate photos and recordings get. Capturing into an archived session
  // would add data after the roster and its consents were frozen.
  if (!['ACTIVE', 'PROCESSING', 'TAGGING'].includes(session.status)) {
    throw new ApiError(409, `Session is ${session.status} — video cannot be added`)
  }

  // Hashed over what the AGENT HANDED US, not over what we store.
  //
  // The two differ whenever a soundtrack is stripped below, and the difference
  // matters: this hash's job is to make a retried upload of the same file
  // collapse onto the same row, and only the upload's own bytes are stable
  // enough to do that. The muted copy is not — the mp4 muxer stamps timings into
  // the container, so remuxing one source file twice yields two different
  // digests, and hashing that would defeat the unique index it feeds.
  const sha256 = createHash('sha256').update(file.buffer).digest('hex')

  // De-duplicated on content within the session, exactly as photos and
  // recordings are. Without it a retried upload creates a second row over
  // identical bytes and the DSAR item grid double-counts what we hold.
  //
  // Checked BEFORE the worker calls below, not after: a retry of a 200MB clip
  // should cost one database lookup, not a probe plus a full remux.
  const existing = await prisma.videoAsset.findFirst({ where: { sessionId, sha256 } })
  if (existing) return { video: existing, duplicate: true }

  const meta = await callWorker(
    '/probe',
    () => {
      const form = new FormData()
      form.append('file', videoBlob(file.buffer, file.mimetype), file.originalname || 'upload.mp4')
      return form
    },
  )

  // A soundtrack is STRIPPED, not grounds for refusing the clip.
  //
  // The rule it enforces is unchanged and is not negotiable: video capture in
  // this platform carries no voice-consent decision, so audio must never reach
  // storage. What changed is the remedy. Refusing the upload threw away footage
  // that was lawfully captured and correct in every other respect, and it did so
  // at the one moment it could not be fixed — after the shoot, when re-recording
  // means recalling the participants. Removing the stream satisfies the same
  // contract and keeps the video.
  //
  // Done here, before writeFile, so no sealed blob ever contains a voice. The
  // worker owns the ffmpeg call because ffmpeg is a hard dependency of that image
  // and merely an accident of the host on this side.
  let bytes = file.buffer
  let audioStripped = false
  if (meta.has_audio && !ALLOW_AUDIO) {
    bytes = await callWorker(
      '/mute',
      () => {
        const form = new FormData()
        form.append('file', videoBlob(file.buffer, file.mimetype), file.originalname || 'upload.mp4')
        return form
      },
      { expect: 'buffer' },
    )
    audioStripped = true
    logger.info(
      { sessionId, sha256, before: file.buffer.length, after: bytes.length },
      'audio stream removed at ingest — a clip carries no voice-consent decision',
    )
  }

  const video = await prisma.videoAsset.create({
    data: {
      sessionId,
      status: 'PENDING_ANALYSIS',
      storagePath: '',
      // The muted copy is always remuxed to mp4 by the worker, so the stored
      // bytes are no longer whatever container was uploaded and the recorded
      // mime type has to follow them — otherwise extensionFor() names the file
      // .mov while its contents are mp4, and the player is handed a mislabelled
      // stream.
      mimeType: audioStripped ? 'video/mp4' : file.mimetype,
      sha256,
      sizeBytes: bytes.length,
      durationSec: meta.duration_sec ?? null,
      fps: meta.fps ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      frameCount: meta.frame_count ?? 0,
    },
  })

  const relativePath = `sessions/${sessionId}/videos/${video.id}.${extensionFor(video.mimeType)}`
  const { keyId } = await writeFile(relativePath, bytes)

  const updated = await prisma.videoAsset.update({
    where: { id: video.id },
    data: { storagePath: relativePath, encKeyId: keyId },
  })

  await writeAuditLog({
    entityType: 'VideoAsset',
    entityId: video.id,
    action: 'VIDEO_UPLOADED',
    actorId: admin.id,
    payload: {
      sessionId,
      sha256,
      sizeBytes: updated.sizeBytes,
      mimeType: updated.mimeType,
      durationSec: updated.durationSec,
      frameCount: updated.frameCount,
      // Recorded because the stored object is then NOT the object whose digest
      // is in `sha256`, and an auditor comparing the two needs the reason
      // written down rather than inferred.
      audioStripped,
    },
  })

  return { video: updated, duplicate: false }
}

// ---------------------------------------------------------------------------
// Analysis — called from the recognition pass, never from a request
// ---------------------------------------------------------------------------

/**
 * Detects and tracks every face in one clip, persists the tracks, and hands the
 * caller the embeddings to cluster with.
 *
 * Returns `null` rather than throwing when the worker cannot be reached. That is
 * deliberate and is NOT a swallowed error: the clip is parked as DEFERRED, which
 * means no derivative is ever written for it, `readRedactedVideo` 409s, and the
 * handoff refuses to ingest the batch. Throwing instead would fail the whole
 * recognition job and take the session's photos down with a video worker outage.
 *
 * The dangerous case this shape protects against is subtle: a failed analysis
 * leaves NO track boxes, so a redaction pass over it would blur nothing and
 * produce a clip that is unmasked but stamped clean. DEFERRED is what stops
 * `redactVideos` from ever touching it.
 *
 * Embeddings are returned to the caller and never persisted — same invariant
 * FaceDetection holds. They live in the recognition pass's memory, get clustered
 * and matched against the ephemeral session gallery, and die with the function.
 */
export async function analyzeVideo(videoId) {
  const video = await prisma.videoAsset.findUnique({ where: { id: videoId } })
  if (!video) return null

  let result
  try {
    const original = await readFile(video.storagePath)
    const form = new FormData()
    form.append(
      'file',
      videoBlob(original, video.mimeType),
      `${video.id}.${extensionFor(video.mimeType)}`,
    )
    form.append('scan_pii', 'true')
    result = await callWorker('/analyze', form)
  } catch (err) {
    await prisma.videoAsset
      .update({ where: { id: videoId }, data: { status: 'DEFERRED', piiStatus: 'DEFERRED' } })
      .catch(() => {})
    logger.error(
      { err, videoId, sessionId: video.sessionId },
      'video analysis deferred — clip is not serveable and the batch cannot ingest',
    )
    await writeAuditLog({
      entityType: 'VideoAsset',
      entityId: videoId,
      action: 'VIDEO_ANALYSIS_FAILED',
      actorId: null,
      payload: { error: String(err?.message ?? err) },
    })
    return null
  }

  // Reruns must not stack duplicate tracks on top of the previous attempt —
  // same rule the photo pass applies to FaceDetection.
  await prisma.videoFaceTrack.deleteMany({ where: { videoId } })
  await prisma.videoPiiSpan.deleteMany({ where: { videoId } })

  const meta = result.meta ?? {}
  const fps = Number(meta.fps) || video.fps || 25

  const detected = []
  for (const track of result.tracks ?? []) {
    const record = await prisma.videoFaceTrack.create({
      data: {
        videoId,
        trackId: String(track.track_id),
        startFrame: track.start_frame ?? 0,
        endFrame: track.end_frame ?? 0,
        startSec: track.start_sec ?? 0,
        endSec: track.end_sec ?? 0,
        boxes: track.boxes ?? [],
        detScore: track.det_score ?? null,
        embeddedFrames: track.embedded_frames ?? 0,
        repFrame: track.rep_frame ?? null,
      },
    })

    if (track.rep_crop_jpeg_b64) {
      const cropPath = `sessions/${video.sessionId}/faces/${record.id}.jpg`
      await writeFile(cropPath, Buffer.from(track.rep_crop_jpeg_b64, 'base64'))
      await prisma.videoFaceTrack.update({ where: { id: record.id }, data: { cropPath } })
    }

    // A track with no embedding is not identifiable, which is NOT the same as
    // "matched nobody". It is excluded from clustering entirely and therefore
    // never becomes a TAGGED card — so it stays blurred, which is the correct
    // outcome for a face we could not see well enough to recognise.
    if (Array.isArray(track.embedding) && track.embedding.length > 0) {
      detected.push({
        id: record.id,
        kind: 'track',
        detScore: track.det_score ?? 0,
        embedding: track.embedding,
      })
    }
  }

  for (const span of result.pii_spans ?? []) {
    await prisma.videoPiiSpan.create({
      data: {
        videoId,
        startFrame: span.start_frame ?? 0,
        endFrame: span.end_frame ?? 0,
        startSec: Number(((span.start_frame ?? 0) / fps).toFixed(3)),
        endSec: Number(((span.end_frame ?? 0) / fps).toFixed(3)),
        boxes: span.boxes ?? [],
        kind: String(span.kind ?? 'TEXT'),
      },
    })
  }

  const piiCount = (result.pii_spans ?? []).length

  // Best-effort, and deliberately so. The overlay is a review aid; the redaction
  // path does not read it and no access decision depends on it. Letting a failure
  // here throw would park a fully-analysed clip as DEFERRED — which stops the
  // derivative from ever being written and holds the session out of ARCHIVED —
  // over a convenience that is regenerable at any time.
  let detectedPath = null
  try {
    detectedPath = await writeDetectedDerivative(
      { ...video, mimeType: video.mimeType },
      result.tracks,
      result.pii_spans,
    )
  } catch (err) {
    logger.warn(
      { err, videoId, sessionId: video.sessionId },
      'detection overlay could not be written — analysis stands, the tagging screen falls back to track crops',
    )
  }

  await prisma.videoAsset.update({
    where: { id: videoId },
    data: {
      status: 'ANALYZED',
      ...(detectedPath ? { detectedPath } : {}),
      // The clip has been SCANNED for text; whether any was found is what
      // separates MASKED from CLEAN, and neither is DEFERRED. The mask itself is
      // applied later, by redactVideos.
      piiStatus: piiCount > 0 ? 'MASKED' : 'CLEAN',
      durationSec: meta.duration_sec ?? video.durationSec,
      fps: meta.fps ?? video.fps,
      width: meta.width ?? video.width,
      height: meta.height ?? video.height,
      frameCount: meta.frame_count ?? video.frameCount,
    },
  })

  await writeAuditLog({
    entityType: 'VideoAsset',
    entityId: videoId,
    action: 'VIDEO_ANALYZED',
    actorId: null,
    payload: {
      tracks: (result.tracks ?? []).length,
      identifiable: detected.length,
      piiSpans: piiCount,
      framesDetected: result.frames_detected ?? null,
      detectStride: result.detect_stride ?? null,
      gpu: result.gpu ?? null,
    },
  })

  return { tracks: detected, meta }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Turns the stored decisions into the worker's box schedule.
 *
 * `keep` is the set of subject ids still entitled to be visible. A track is
 * blurred unless it is TAGGED to one of them — the same max-privacy rule
 * redactBystanders applies to stills, and for the same reason: UNKNOWN, SKIPPED,
 * PENDING and even NOT_A_FACE all blur, because blurring a declared non-face
 * costs nothing while serving a mislabelled real face is irreversible.
 */
function buildSchedule(tracks, piiSpans, keep) {
  const blur = tracks
    .filter((t) => t.tagStatus !== 'TAGGED' || !t.taggedSubjectId || !keep.has(t.taggedSubjectId))
    .map((t) => ({
      start_frame: t.startFrame,
      end_frame: t.endFrame,
      boxes: Array.isArray(t.boxes) ? t.boxes : [],
    }))
    .filter((r) => r.boxes.length > 0)

  const mosaic = (piiSpans ?? [])
    .map((s) => ({
      start_frame: s.startFrame,
      end_frame: s.endFrame,
      boxes: Array.isArray(s.boxes) ? s.boxes : [],
    }))
    .filter((r) => r.boxes.length > 0)

  return { blur, mosaic }
}

async function writeDerivative(video, schedule) {
  const original = await readFile(video.storagePath)
  const form = new FormData()
  form.append(
    'file',
    videoBlob(original, video.mimeType),
    `${video.id}.${extensionFor(video.mimeType)}`,
  )
  form.append('schedule', JSON.stringify(schedule))

  const redacted = await callWorker('/redact', form, { expect: 'buffer' })

  // Derived from the clip's own session, not from an argument. An imported clip
  // has no session, and `sessions/null/redacted/...` would put a derivative
  // outside the per-session key scope that opens it.
  const redactedPath = video.sessionId
    ? `sessions/${video.sessionId}/redacted/${video.id}.mp4`
    : `subjects/orphan/imports/redacted/${video.id}.mp4`

  await writeFile(redactedPath, redacted)
  return redactedPath
}

/**
 * Writes the detection-overlay copy: every detected box drawn over the frames,
 * labelled with the track it belongs to, and nothing masked.
 *
 * This is what an operator watches BEFORE tagging. A single JPEG crop per track
 * cannot show whether the tracker held one face across an occlusion or quietly
 * merged two people into one track, and that is precisely the error tagging is
 * there to catch — tag a merged track to a consenting subject and both people
 * stay unblurred in the release.
 *
 * Faces are legible in it, so it is stored beside the ORIGINAL and inherits the
 * original's access rules. It is never offered to a data owner and never served
 * by the redacted-video route.
 */
async function writeDetectedDerivative(video, tracks, piiSpans) {
  const original = await readFile(video.storagePath)
  const spec = {
    tracks: [
      ...(tracks ?? []).map((t) => ({
        start_frame: t.start_frame ?? 0,
        end_frame: t.end_frame ?? 0,
        boxes: t.boxes ?? [],
        label: `#${t.track_id}`,
        color: [80, 220, 100], // BGR green — "a face was found here"
      })),
      ...(piiSpans ?? []).map((s) => ({
        start_frame: s.start_frame ?? 0,
        end_frame: s.end_frame ?? 0,
        boxes: s.boxes ?? [],
        label: String(s.kind ?? 'TEXT'),
        color: [60, 180, 250], // BGR amber — printed text, a different decision
      })),
    ],
  }

  const annotated = await callWorker(
    '/annotate',
    () => {
      const form = new FormData()
      form.append(
        'file',
        videoBlob(original, video.mimeType),
        `${video.id}.${extensionFor(video.mimeType)}`,
      )
      form.append('tracks', JSON.stringify(spec))
      return form
    },
    { expect: 'buffer' },
  )

  // Beside the original, NOT under `redacted/`. The path is what a reviewer reads
  // first when asking whether an object is safe to serve, and filing an
  // unmasked clip under `redacted/` would be a lie told by a directory name.
  const detectedPath = video.sessionId
    ? `sessions/${video.sessionId}/videos/detected/${video.id}.mp4`
    : `subjects/orphan/imports/detected/${video.id}.mp4`

  await writeFile(detectedPath, annotated)
  return detectedPath
}

/**
 * Writes a blurred derivative for every analysed clip in the session.
 *
 * A derivative is written even when there is nothing to blur, exactly as
 * redactBystanders does for stills: `redactedPath` being null is what the
 * serving layer reads as "redaction has not happened", so a clean clip with no
 * derivative would be unserveable forever.
 */
export async function redactVideos(sessionId, { videoIds } = {}) {
  const videos = await prisma.videoAsset.findMany({
    where: videoIds ? { id: { in: videoIds } } : { sessionId },
    include: {
      tracks: {
        select: {
          startFrame: true,
          endFrame: true,
          boxes: true,
          tagStatus: true,
          taggedSubjectId: true,
        },
      },
      piiSpans: { select: { startFrame: true, endFrame: true, boxes: true } },
      subjects: { select: { subjectId: true } },
    },
  })

  let written = 0
  let deferred = 0
  let skipped = 0

  for (const video of videos) {
    // A clip whose analysis never succeeded has NO track boxes, so a redaction
    // pass over it would blur nothing and produce an unmasked file stamped
    // clean. It stays DEFERRED with no derivative until a re-analysis fixes it.
    if (video.status === 'DEFERRED' || video.status === 'PENDING_ANALYSIS') {
      skipped += 1
      deferred += 1
      logger.warn(
        { videoId: video.id, sessionId, status: video.status },
        'video not analysed — no derivative written, batch cannot ingest',
      )
      continue
    }

    const keep = new Set(video.subjects.map((s) => s.subjectId))

    try {
      const schedule = buildSchedule(video.tracks, video.piiSpans, keep)
      const redactedPath = await writeDerivative(video, schedule)

      await prisma.videoAsset.update({
        where: { id: video.id },
        data: {
          redactedPath,
          status: 'REDACTED',
          piiStatus: schedule.mosaic.length > 0 ? 'MASKED' : 'CLEAN',
        },
      })
      written += 1
    } catch (err) {
      // Finalize has already committed, so this cannot roll back — but it must
      // not pass either. Parked as DEFERRED: no redactedPath, so nothing can
      // serve it, and the handoff refuses the batch until a retry clears it.
      await prisma.videoAsset
        .update({
          where: { id: video.id },
          data: { status: 'DEFERRED', piiStatus: 'DEFERRED', redactedPath: null },
        })
        .catch(() => {})
      deferred += 1
      logger.error(
        { err, videoId: video.id, sessionId },
        'video redaction deferred — clip is not serveable and the batch cannot ingest',
      )
    }
  }

  if (deferred > 0) {
    logger.warn({ sessionId, deferred, written, skipped }, 'session has deferred video redactions — ingest is blocked')
  }

  return { written, deferred, skipped }
}

/**
 * Rebuilds one clip's derivative from the subjects who are STILL lawfully linked
 * to it. The video twin of rebuildRedactedForRemaining, called by the DSAR purge
 * after an erasing subject's link has been removed.
 *
 * Because the rule is "blur every track not tagged to a remaining subject",
 * removing A's VideoSubject row is by itself enough to make A a bystander here.
 * No list of A's boxes has to be threaded through, so the blur cannot drift out
 * of sync with the links.
 *
 * Ordering constraint the caller must honour: this needs the ORIGINAL, so it has
 * to run before L16 is shredded. The other way round produces a clip that can
 * never be re-redacted again.
 */
export async function rebuildRedactedVideoForRemaining(videoId) {
  const video = await prisma.videoAsset.findUnique({
    where: { id: videoId },
    include: {
      tracks: {
        select: {
          startFrame: true,
          endFrame: true,
          boxes: true,
          tagStatus: true,
          taggedSubjectId: true,
        },
      },
      piiSpans: { select: { startFrame: true, endFrame: true, boxes: true } },
      subjects: { select: { subjectId: true } },
    },
  })
  if (!video) throw new ApiError(404, 'Video not found')

  const remaining = new Set(video.subjects.map((s) => s.subjectId))
  const schedule = buildSchedule(video.tracks, video.piiSpans, remaining)

  let redactedPath
  try {
    redactedPath = await writeDerivative(video, schedule)
  } catch (err) {
    // The existing derivative was built while the erasing subject was still
    // linked, so it still SHOWS them. Leaving it in place would serve an erased
    // person out of a clip they have already left — exactly what invariant 5
    // forbids. Retract it first, then let the purge mark the location FAILED.
    await prisma.videoAsset
      .update({
        where: { id: video.id },
        data: { status: 'DEFERRED', piiStatus: 'DEFERRED', redactedPath: null },
      })
      .catch((updateErr) =>
        logger.error({ err: updateErr, videoId }, 'could not retract stale redacted video derivative'),
      )
    logger.error(
      { err, videoId },
      'video re-redaction failed after erasure — derivative retracted, clip is not serveable',
    )
    throw err
  }

  await prisma.videoAsset.update({
    where: { id: video.id },
    data: {
      redactedPath,
      status: 'REDACTED',
      piiStatus: schedule.mosaic.length > 0 ? 'MASKED' : 'CLEAN',
    },
  })

  return {
    videoId: video.id,
    redactedPath,
    blurredRegions: schedule.blur.length + schedule.mosaic.length,
    remainingSubjects: remaining.size,
  }
}

// Any clip in this session whose masking is unconfirmed. The handoff ingest and
// the retention sweep both ask this rather than re-deriving the rule.
// Counts everything that is not confirmably masked, rather than the three
// failure states it used to list — that list omitted a clip whose status said
// REDACTED but whose derivative was never written, and it omitted PiiStatus
// PENDING entirely.
export async function countDeferredVideos(sessionId) {
  return prisma.videoAsset.count({ where: { sessionId, ...UNRESOLVED_VIDEO_WHERE } })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const PUBLIC_SELECT = {
  id: true,
  sessionId: true,
  mimeType: true,
  sha256: true,
  sizeBytes: true,
  durationSec: true,
  fps: true,
  width: true,
  height: true,
  frameCount: true,
  status: true,
  piiStatus: true,
  createdAt: true,
  // storagePath stays absent: the original is reachable only through the DSAR
  // break-glass path, and nothing in a portal has a reason to know where it is.
  //
  // redactedPath and detectedPath ARE selected, but only so toPublic() can turn
  // them into booleans — they never leave this module as paths. Omitting them
  // entirely was a bug with a visible symptom: SessionVideoPanel gates its player
  // on `Boolean(video.redactedPath)`, which is `undefined` for every row this
  // select produces, so the blurred copy was never offered no matter how well the
  // redaction had gone. The panel reported "still being processed" forever over a
  // clip that had been finished for hours.
  redactedPath: true,
  detectedPath: true,
}

/**
 * Strips the storage paths and replaces them with the only two facts a client
 * legitimately needs from them: whether each derivative exists.
 *
 * A path is not merely uninteresting to a portal, it is a hint about the key
 * scope that opens it. A boolean answers "can I play this yet" without saying
 * anything about where the bytes live.
 */
function toPublic(video) {
  if (!video) return video
  const { redactedPath, detectedPath, ...rest } = video
  return {
    ...rest,
    hasRedacted: Boolean(redactedPath),
    hasDetected: Boolean(detectedPath),
  }
}

export async function listVideos(sessionId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const videos = await prisma.videoAsset.findMany({
    where: { sessionId },
    select: { ...PUBLIC_SELECT, _count: { select: { tracks: true, piiSpans: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return videos.map(toPublic)
}

export async function getVideo(sessionId, videoId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const video = await prisma.videoAsset.findFirst({
    where: { id: videoId, sessionId },
    select: {
      ...PUBLIC_SELECT,
      tracks: {
        select: {
          id: true,
          trackId: true,
          startSec: true,
          endSec: true,
          startFrame: true,
          endFrame: true,
          detScore: true,
          embeddedFrames: true,
          tagStatus: true,
          taggedSubjectId: true,
          clusterId: true,
          cropPath: true,
        },
        orderBy: { startSec: 'asc' },
      },
      piiSpans: { select: { id: true, startSec: true, endSec: true, kind: true } },
    },
  })
  if (!video) throw new ApiError(404, 'Video not found')
  return toPublic(video)
}

export async function readRedactedVideo(sessionId, videoId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const video = await prisma.videoAsset.findFirst({ where: { id: videoId, sessionId } })
  if (!video) throw new ApiError(404, 'Video not found')

  // Fail closed (invariant 8), identical to readRedactedPhoto. A missing
  // derivative means redaction has not succeeded; 409 tells the caller to wait.
  // There is no branch here that reaches for storagePath, and none may be added.
  if (isVideoUnresolved(video)) {
    throw new ApiError(409, 'REDACTION_PENDING — no redacted copy is available for this video yet')
  }
  return { buffer: await readFile(video.redactedPath), mimeType: 'video/mp4' }
}

/**
 * The detection-overlay copy. Faces in it are LEGIBLE — nothing is masked.
 *
 * It therefore carries the original's access rules, not the derivative's, and
 * the route in front of it admits only the roles that may see an unmasked frame
 * during collection. It is emphatically not the thing to serve a data owner.
 */
export async function readDetectedVideo(sessionId, videoId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const video = await prisma.videoAsset.findFirst({ where: { id: videoId, sessionId } })
  if (!video) throw new ApiError(404, 'Video not found')

  if (!video.detectedPath) {
    throw new ApiError(
      409,
      'ANALYSIS_PENDING — no detection overlay has been written for this clip yet',
    )
  }
  return { buffer: await readFile(video.detectedPath), mimeType: 'video/mp4' }
}

export async function readTrackCrop(sessionId, trackId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const track = await prisma.videoFaceTrack.findFirst({
    where: { id: trackId, video: { sessionId } },
    select: { cropPath: true },
  })
  if (!track?.cropPath) throw new ApiError(404, 'Track crop not found')
  return { buffer: await readFile(track.cropPath), mimeType: 'image/jpeg' }
}

// Break-glass binding helper — answers "whose data is this object?" so the
// middleware can refuse an open DSAR being used as a skeleton key for a subject
// it does not name. A clip can lawfully hold several subjects, so this returns
// all of them and the caller checks membership.
export async function subjectsOnVideo(videoId) {
  const links = await prisma.videoSubject.findMany({
    where: { videoId },
    select: { subjectId: true },
  })
  return links.map((l) => l.subjectId)
}
