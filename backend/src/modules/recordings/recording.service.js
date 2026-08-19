import { createHash } from 'node:crypto'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { readFile, writeFile, shredFile, fileExists } from '../../lib/storage.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible } from '../../lib/consent.js'
import { logger } from '../../lib/logger.js'
import { loadSessionForMedia } from '../sessions/session.service.js'
import { indexRecording } from '../dsar/itemIndex.service.js'
import { resolveVoiceEmbedding } from '../enrollment/voiceEnrollment.service.js'
import {
  createVoiceGallery,
  addVoiceEnrollmentPoints,
  searchVoiceGallery,
  destroyVoiceGallery,
} from '../../lib/voiceGallery.js'

const AUDIO_SERVICE_URL = process.env.AUDIO_SERVICE_URL ?? 'http://localhost:8003'

// Cosine similarity a diarised speaker must reach against an enrolled voice
// print before we will say it is that person. Mirrors the worker's old
// SIMILARITY_THRESHOLD default so the migration to the gallery does not silently
// change who gets identified; it is env-tunable because the right value depends
// on room acoustics, and it is read here rather than in voiceGallery.js so the
// one place that turns a score into an identity is the one that can see consent.
//
// The default is carried over, not calibrated. 0.10 is well below published
// ECAPA operating points, and it errs in the direction that costs the most: a
// bystander who happens to score above it is accepted as an enrolled subject and
// their voice survives the redaction. Measure it against real session audio and
// raise it before this pipeline is trusted with anything.
const VOICE_MATCH_THRESHOLD = Number(process.env.VOICE_MATCH_THRESHOLD ?? 0.10)

// Extensions the container format maps to on disk. The prototype hardcoded .wav
// for every upload, so an m4a was written under a name that lies about its
// bytes — which matters the moment anything other than the worker opens it.
const EXTENSION_BY_MIME = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

export function extensionFor(mimeType) {
  return EXTENSION_BY_MIME[String(mimeType).toLowerCase()] ?? 'bin'
}

// Same shape as PiiUnavailableError in session.service.js, and for the same
// reason: "the worker is down" and "the worker found nothing" must never be
// collapsed into one outcome. A caller that swallows this and treats it as
// "no PII / no bystanders" would ship an unredacted recording.
export class AudioUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'AudioUnavailableError'
    this.cause = cause
  }
}

/**
 * Pulls the worker's own explanation out of a failed response.
 *
 * Without this the backend recorded only a bare status, and the one sentence
 * that says WHY — "HF_TOKEN is not set", "Unreadable audio", "Diarization
 * failed" — stayed in the worker's console where nothing collects it. A 502
 * from /analyze has at least four distinct causes and the status alone
 * separates none of them; the audit row written on failure then carries a
 * message no one can act on.
 *
 * Never throws. This runs on a path that is already failing, and losing the
 * status because the body could not be read would be the worse trade.
 */
async function workerDetail(res) {
  try {
    const body = await res.text()
    if (!body) return ''
    try {
      const detail = JSON.parse(body)?.detail
      if (typeof detail === 'string') return ` — ${detail}`
    } catch {
      // Not JSON — a proxy's HTML page, say. The raw text is still better than
      // nothing, truncated so an error page cannot flood the audit payload.
    }
    return ` — ${body.slice(0, 500)}`
  } catch {
    return ''
  }
}

async function callAnalyze(buffer, filename) {
  const form = new FormData()
  form.append('main_audio', new Blob([buffer]), filename)

  let res
  try {
    res = await fetch(`${AUDIO_SERVICE_URL}/api/v1/analyze`, { method: 'POST', body: form })
  } catch (err) {
    throw new AudioUnavailableError(`Audio worker unreachable while analyzing ${filename}`, err)
  }
  if (!res.ok) {
    throw new AudioUnavailableError(
      `Audio worker returned ${res.status} while analyzing ${filename}${await workerDetail(res)}`,
    )
  }
  return res.json()
}

async function callRedact(buffer, filename, intervals) {
  const form = new FormData()
  form.append('main_audio', new Blob([buffer]), filename)
  form.append('intervals', JSON.stringify(intervals))

  let res
  try {
    res = await fetch(`${AUDIO_SERVICE_URL}/api/v1/redact`, { method: 'POST', body: form })
  } catch (err) {
    throw new AudioUnavailableError(`Audio worker unreachable while redacting ${filename}`, err)
  }
  if (!res.ok) {
    throw new AudioUnavailableError(
      `Audio worker returned ${res.status} while redacting ${filename}${await workerDetail(res)}`,
    )
  }
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Loads a recording, having first proved the caller may touch its session.
 *
 * Every function below goes through this. The prototype called
 * `prisma.session.findUnique` directly, which meant the router's role check was
 * the ONLY check — so any collectionAgent could upload to, analyse, redact and
 * download any other agent's session audio by guessing a uuid. The photo paths
 * have never had that hole because they all route through loadSession().
 */
async function loadRecording(sessionId, recordingId, admin) {
  await loadSessionForMedia(sessionId, admin)
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw new ApiError(404, 'Recording not found')
  return recording
}

// Step 1: the agent uploads the raw session recording. Stored under
// sessions/<sid>/audio/ so storage.js's existing scopeForPath rule
// ("sessions/<sid>/... -> session-scoped DEK") applies unchanged — the same key
// family that already protects photos (L2) now covers audio (L14).
export async function uploadRecording(sessionId, file, admin) {
  const session = await loadSessionForMedia(sessionId, admin)
  // Same gate photos get. Capturing into an archived session would add data
  // after the point the roster and its consents were frozen.
  if (!['ACTIVE', 'PROCESSING', 'TAGGING'].includes(session.status)) {
    throw new ApiError(409, `Session is ${session.status} — audio cannot be added`)
  }

  const sha256 = createHash('sha256').update(file.buffer).digest('hex')

  // De-duplicated on content within the session, exactly as photos are. Without
  // it a retried upload creates a second Recording row pointing at identical
  // bytes, and the DSAR item grid double-counts what we hold.
  const existing = await prisma.recording.findFirst({ where: { sessionId, sha256 } })
  if (existing) return { recording: existing, duplicate: true }

  const recording = await prisma.recording.create({
    data: {
      sessionId,
      status: 'PENDING_ANALYSIS',
      storagePath: '',
      mimeType: file.mimetype,
      sha256,
      sizeBytes: file.size ?? file.buffer.length,
    },
  })

  const relativePath = `sessions/${sessionId}/audio/${recording.id}.${extensionFor(file.mimetype)}`
  const { keyId } = await writeFile(relativePath, file.buffer)

  const updated = await prisma.recording.update({
    where: { id: recording.id },
    data: { storagePath: relativePath, encKeyId: keyId },
  })

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recording.id,
    action: 'RECORDING_UPLOADED',
    actorId: admin.id,
    payload: { sessionId, sha256, sizeBytes: updated.sizeBytes, mimeType: updated.mimeType },
  })

  return { recording: updated, duplicate: false }
}

/**
 * Resolves every matched speaker against real consent in ONE pair of queries.
 *
 * The prototype issued two queries per speaker inside the loop; a ten-speaker
 * recording was twenty round trips to Supabase before a single row was written.
 */
async function resolveSpeakerConsent(matches, projectId) {
  const muids = [...new Set(matches.map((m) => m.matched_muid).filter(Boolean))]
  if (muids.length === 0) return new Map()

  const [subjects, consents] = await Promise.all([
    prisma.subject.findMany({
      where: { masterUserId: { in: muids } },
      select: { masterUserId: true, status: true },
    }),
    prisma.projectConsent.findMany({
      where: { subjectId: { in: muids }, projectId },
      select: { consentId: true, subjectId: true, status: true },
    }),
  ])

  const consentBySubject = new Map(consents.map((c) => [c.subjectId, c]))
  const resolved = new Map()

  for (const subject of subjects) {
    const consent = consentBySubject.get(subject.masterUserId) ?? null
    resolved.set(subject.masterUserId, {
      eligible: isEligible(consentVerdict(subject, consent)),
      consentId: consent?.consentId ?? null,
    })
  }

  return resolved
}

/**
 * Loads the session roster's enrolled voice prints into an ephemeral Qdrant
 * collection for the length of one analyze call. The audio twin of
 * buildSessionGallery(), and deliberately the same shape including the three
 * outcome buckets.
 *
 * `broken` is separated from `notEnrolled` for the reason the face path learned
 * the hard way: downstream they look identical — the person matches nothing and
 * gets muted — but one is a fact about the roster an agent can fix by enrolling
 * someone, and the other is a fault in this service. Filing a fault under
 * "nobody enrolled" is how an empty gallery once got reported as a clean run.
 */
async function buildRecordingVoiceGallery(recordingId, sessionId) {
  const participants = await prisma.sessionParticipant.findMany({
    where: { sessionId },
    include: {
      subject: {
        select: {
          masterUserId: true,
          fullName: true,
          voiceEnrollments: { where: { deletedAt: null } },
        },
      },
    },
  })

  try {
    await createVoiceGallery(recordingId)
  } catch (err) {
    // Not "match nothing and mute everyone". A gallery that could not be built
    // means identity was never checked, and "we could not check" is not "there
    // was nobody to recognise" — the same distinction AudioUnavailableError
    // exists to protect. The caller turns this into DEFERRED.
    throw new AudioUnavailableError(
      `Voice gallery unavailable for recording ${recordingId} — is Qdrant running?`,
      err,
    )
  }

  const enrolled = []
  const notEnrolled = []
  const broken = []
  const points = []

  for (const participant of participants) {
    const enrollments = participant.subject.voiceEnrollments
    if (enrollments.length === 0) {
      notEnrolled.push({
        subjectId: participant.subjectId,
        fullName: participant.subject.fullName,
      })
      continue
    }

    let added = 0
    for (const enrollment of enrollments) {
      try {
        const embedding = await resolveVoiceEmbedding(enrollment)
        points.push({ embedding, subjectId: participant.subjectId, enrollmentId: enrollment.id })
        added += 1
      } catch (err) {
        // One unreadable clip is not fatal — this person's other clips still
        // carry them, and a subject with no usable clip lands in `broken`.
        logger.warn(
          { err, enrollmentId: enrollment.id, recordingId },
          'skipping voice enrollment in gallery build',
        )
      }
    }

    if (added > 0) enrolled.push(participant.subjectId)
    else broken.push({ subjectId: participant.subjectId, fullName: participant.subject.fullName })
  }

  try {
    await addVoiceEnrollmentPoints(recordingId, points)
  } catch (err) {
    throw new AudioUnavailableError(
      `Voice gallery could not be loaded for recording ${recordingId}`,
      err,
    )
  }

  return { enrolled, notEnrolled, broken, points: points.length }
}

// Step 2: detection only. Calls /analyze, stores the raw findings as
// AudioSegment rows, and separately computes+stores the KEEP/REDACT decision
// from project_consent_matrix — the audio-worker never sees consent data, so
// this function is the one and only place that joins the two.
export async function analyzeRecording(sessionId, recordingId, admin) {
  const session = await loadSessionForMedia(sessionId, admin)
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw new ApiError(404, 'Recording not found')

  const original = await readFile(recording.storagePath)

  let result
  let gallery
  let matches
  try {
    // Built BEFORE the worker call so a missing gallery costs nothing: diarising
    // a long recording and only then discovering there is nobody to compare it
    // against wastes minutes of GPU on a run that is going to DEFER anyway.
    gallery = await buildRecordingVoiceGallery(recordingId, sessionId)

    result = await callAnalyze(original, `${recordingId}.${extensionFor(recording.mimeType)}`)

    // Identity resolution, which used to happen inside the worker against
    // snippets uploaded with the request. The worker now returns one vector per
    // diarised speaker slot and the search happens here, against persisted
    // enrollments, on the side of the wire that can see consent.
    matches = []
    for (const speaker of result.speaker_embeddings ?? []) {
      if (!Array.isArray(speaker.embedding)) {
        // Too short to embed, or embedding failed. Either way this slot is not
        // identifiable, which resolveSpeakerConsent reads as no match and the
        // decision loop below turns into REDACT_VOICE.
        matches.push({ speaker_id: speaker.speaker_id, matched_muid: null, score: 0 })
        continue
      }
      const { subjectId, score } = await searchVoiceGallery(
        recordingId,
        speaker.embedding,
        VOICE_MATCH_THRESHOLD,
      )
      matches.push({ speaker_id: speaker.speaker_id, matched_muid: subjectId, score })
    }
  } catch (err) {
    // Fail closed, same rule as image PII (invariant 8): a recording that could
    // not be analysed is DEFERRED, not silently treated as clean.
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'DEFERRED' } })
    await writeAuditLog({
      entityType: 'Recording',
      entityId: recordingId,
      action: 'RECORDING_ANALYSIS_FAILED',
      actorId: admin.id,
      payload: { error: err.message },
    })
    throw err
  } finally {
    // Best-effort teardown on every path, success or DEFER. The collection holds
    // re-derived biometric vectors and has no reason to outlive the one call it
    // was built for; cleanupOrphanVoiceGalleries() is the backstop for a process
    // that dies before reaching here.
    await destroyVoiceGallery(recordingId)
  }

  const resolved = await resolveSpeakerConsent(matches, session.projectId)

  // One decision per diarised speaker slot, then expanded to one row per
  // utterance so the redact step has exact intervals — the same granularity as
  // FaceDetection rows per photo.
  const decisionBySpeaker = new Map()
  for (const match of matches) {
    const hit = match.matched_muid ? resolved.get(match.matched_muid) : null
    const keep = Boolean(hit?.eligible)
    decisionBySpeaker.set(match.speaker_id, {
      action: keep ? 'KEEP' : 'REDACT_VOICE',
      // Why, in the row itself. The timeline shows this verbatim next to every
      // muted span, and "matched someone whose consent does not cover this" and
      // "matched nobody at all" are the two outcomes an agent most needs told
      // apart — they look identical in the action alone.
      reason: keep
        ? 'CONSENTED_SPEAKER'
        : match.matched_muid
          ? 'CONSENT_INELIGIBLE'
          : 'UNIDENTIFIED_SPEAKER',
      subjectId: keep ? match.matched_muid : null,
      consentId: keep ? hit.consentId : null,
      matchScore: match.score ?? null,
    })
  }

  const utteranceRows = (result.segments ?? []).map((seg) => {
    // An unmatched speaker slot has no decision at all — default to muting.
    // Defaulting the other way would release a voice nobody consented for.
    const decision = decisionBySpeaker.get(seg.speaker_id) ?? {
      action: 'REDACT_VOICE',
      subjectId: null,
      consentId: null,
      matchScore: null,
    }
    return {
      recordingId,
      speakerId: seg.speaker_id,
      subjectId: decision.subjectId,
      consentId: decision.consentId,
      startSec: seg.start,
      endSec: seg.end,
      action: decision.action,
      reason: decision.reason,
      piiType: null,
      matchScore: decision.matchScore,
    }
  })

  // PII spans are muted unconditionally, whoever is speaking — matching the
  // image pipeline, where text masking is not gated by biometric consent either
  // (docs/01_PRIVACY_DATAFLOW.md Phase D).
  const piiRows = (result.pii_spans ?? []).map((span) => ({
    recordingId,
    speakerId: span.speaker_id ?? 'UNKNOWN',
    subjectId: null,
    consentId: null,
    startSec: span.start,
    endSec: span.end,
    action: 'REDACT_PII',
    reason: `PII_${span.type || 'DETECTED'}_FOUND`,
    piiType: span.type ?? null,
    matchScore: null,
  }))

  const durationSec = utteranceRows.reduce((max, r) => Math.max(max, r.endSec), 0) || null

  await prisma.$transaction([
    prisma.audioSegment.deleteMany({ where: { recordingId } }),
    prisma.audioSegment.createMany({ data: [...utteranceRows, ...piiRows] }),
    prisma.recording.update({
      where: { id: recordingId },
      data: { status: 'ANALYZED', durationSec },
    }),
  ])

  // The DSAR index is refreshed here, not left to the next discovery walk. An
  // analysed recording is data we hold about every speaker it identified, and it
  // has to be listable and erasable from the moment that is true.
  //
  // Non-fatal for the same reason discovery's refresh is: the index is a
  // rebuildable projection, and failing the analysis because it could not be
  // written would leave the recording UNanalysed and therefore unredactable —
  // strictly worse. It is logged under a fixed alert key, never swallowed.
  try {
    await indexRecording(recordingId)
  } catch (err) {
    logger.error(
      { alert: 'ITEM_INDEX_REFRESH_FAILED', err, recordingId, at: 'analyzeRecording' },
      'item index refresh failed after audio analysis — DSAR completeness may be stale until the next discovery',
    )
  }

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recordingId,
    action: 'RECORDING_ANALYZED',
    actorId: admin.id,
    payload: {
      segments: utteranceRows.length,
      piiSpans: piiRows.length,
      speakersIdentified: [...decisionBySpeaker.values()].filter((d) => d.subjectId).length,
      speakersMuted: [...decisionBySpeaker.values()].filter((d) => !d.subjectId).length,
      // The gallery this run was actually judged against. Without it "everyone
      // was muted" is unreadable after the fact: it could mean nobody on the
      // roster had enrolled a voice, or that every clip failed to load, and
      // those call for opposite responses. `broken` being non-zero is the one
      // that means something here is wrong.
      gallery: {
        points: gallery.points,
        enrolled: gallery.enrolled.length,
        notEnrolled: gallery.notEnrolled.length,
        broken: gallery.broken.length,
      },
    },
  })

  if (gallery.broken.length > 0) {
    logger.warn(
      { alert: 'VOICE_GALLERY_BROKEN', recordingId, subjects: gallery.broken },
      'voice enrollments exist for these subjects but none could be loaded — they will have been muted as unidentified',
    )
  }

  // `gallery` travels back with the segments so the agent sees WHY someone was
  // muted at the moment they see the mute, not only in a log nobody opens.
  return {
    segments: await prisma.audioSegment.findMany({
      where: { recordingId },
      orderBy: { startSec: 'asc' },
    }),
    gallery,
  }
}

/** The mute list for a recording, as it stands right now. */
async function muteIntervalsFor(recordingId) {
  const segments = await prisma.audioSegment.findMany({
    where: { recordingId, action: { in: ['REDACT_VOICE', 'REDACT_PII'] } },
    select: { startSec: true, endSec: true },
    orderBy: { startSec: 'asc' },
  })
  return segments.map((s) => ({ start: s.startSec, end: s.endSec }))
}

// Step 3: execution. Reads the stored AudioSegment decisions (not fresh
// detection — analyze and redact are deliberately two calls, see
// ai-core/audio-worker/README.md), builds the mute-interval list, and asks the
// worker to produce the redacted file. The worker never sees a subject id or a
// consent status, only start/end seconds — the same separation as /redact on the
// image side, which takes bboxes it did not compute.
export async function redactRecording(sessionId, recordingId, admin) {
  const recording = await loadRecording(sessionId, recordingId, admin)
  if (recording.status !== 'ANALYZED') {
    throw new ApiError(409, `Recording is ${recording.status} — it has not been analyzed yet`)
  }

  const intervals = await muteIntervalsFor(recordingId)
  const original = await readFile(recording.storagePath)
  const ext = extensionFor(recording.mimeType)

  let redactedBuffer
  try {
    redactedBuffer = await callRedact(original, `${recordingId}.${ext}`, intervals)
  } catch (err) {
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'DEFERRED' } })
    await writeAuditLog({
      entityType: 'Recording',
      entityId: recordingId,
      action: 'RECORDING_REDACTION_FAILED',
      actorId: admin.id,
      payload: { error: err.message },
    })
    throw err
  }

  const redactedPath = `sessions/${sessionId}/audio/${recordingId}.redacted.${ext}`
  await writeFile(redactedPath, redactedBuffer)

  const updated = await prisma.recording.update({
    where: { id: recordingId },
    data: { status: 'REDACTED', redactedPath },
  })

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recordingId,
    action: 'RECORDING_REDACTED',
    actorId: admin.id,
    payload: {
      recordingId,
      sessionId,
      intervalsMuted: intervals.length,
      redactionManifest: segments.map((s) => ({
        speakerId: s.speakerId,
        subjectId: s.subjectId,
        consentId: s.consentId,
        startSec: s.startSec,
        endSec: s.endSec,
        action: s.action,
        reason: s.reason || (s.action === 'REDACT_VOICE' ? 'UNIDENTIFIED_SPEAKER' : `PII_${s.piiType || 'DETECTED'}_FOUND`),
        piiType: s.piiType,
      })),
    },
  })

  return updated
}

/**
 * Rebuilds a recording's muted derivative after one speaker has erased.
 *
 * Called by the purge worker's L15 handler, and the exact audio counterpart of
 * `rebuildRedactedForRemaining` for photos — including its failure posture. The
 * existing derivative was built while the erasing subject still had consent, so
 * it still CARRIES THEIR VOICE. Leaving it in place on failure would serve an
 * erased person's speech out of a recording they have already left, so the
 * derivative is retracted first and the caller is allowed to fail.
 *
 * By the time this runs the SEGMENT phase has already stripped the subject's
 * attribution and flipped those spans to REDACT_VOICE, so "mute everything that
 * is not a remaining speaker's KEEP" needs no knowledge of who erased.
 */
export async function rebuildRedactedForRemainingSpeakers(recordingId) {
  const recording = await prisma.recording.findUnique({ where: { id: recordingId } })
  if (!recording) throw new ApiError(404, 'Recording not found')

  const intervals = await muteIntervalsFor(recordingId)
  const ext = extensionFor(recording.mimeType)

  let rebuilt
  try {
    const original = await readFile(recording.storagePath)
    rebuilt = await callRedact(original, `${recordingId}.${ext}`, intervals)
  } catch (err) {
    await prisma.recording
      .update({ where: { id: recordingId }, data: { status: 'DEFERRED', redactedPath: null } })
      .catch((updateErr) =>
        logger.error({ err: updateErr, recordingId }, 'could not retract stale redacted recording'),
      )
    logger.error(
      { err, recordingId, reason: err instanceof AudioUnavailableError ? 'AUDIO_WORKER' : 'REDACTION' },
      're-mute failed after erasure — derivative retracted, recording is not serveable',
    )
    throw err
  }

  const redactedPath = recording.redactedPath ?? `sessions/${recording.sessionId}/audio/${recordingId}.redacted.${ext}`
  await writeFile(redactedPath, rebuilt)

  await prisma.recording.update({
    where: { id: recordingId },
    data: { redactedPath, status: 'REDACTED' },
  })

  return { recordingId, redactedPath, mutedIntervals: intervals.length }
}

/**
 * Destroys a recording outright. Only reached when the erasing subject was the
 * last identified speaker on it — the multi-speaker case is re-muted above.
 */
export async function destroyRecording(recordingId) {
  const recording = await prisma.recording.findUnique({ where: { id: recordingId } })
  if (!recording) return { destroyed: false }

  for (const path of [recording.storagePath, recording.redactedPath]) {
    if (path && (await fileExists(path))) await shredFile(path)
  }
  await prisma.recording.delete({ where: { id: recordingId } })

  return { destroyed: true }
}

// Powers the session detail page's Audio section — a list, so it stays cheap on
// a long session.
export async function listRecordings(sessionId, admin) {
  await loadSessionForMedia(sessionId, admin)
  return prisma.recording.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    include: { segments: { orderBy: { startSec: 'asc' } } },
  })
}

export async function getRecording(sessionId, recordingId, admin) {
  const recording = await loadRecording(sessionId, recordingId, admin)
  const segments = await prisma.audioSegment.findMany({
    where: { recordingId },
    orderBy: { startSec: 'asc' },
  })
  return { recording, segments }
}

// The unredacted recording, for the agent working the timeline before the
// session is archived. It goes through loadRecording — and therefore
// loadSessionForMedia — for the same reason every other media read does: the
// route's role floor says which ROLES may ask, and only the service can say
// whether THIS caller owns THIS session. readFile() is storage.js's, so the
// session DEK is applied here exactly as it is for the redacted copy; reading
// recording.storagePath off the disk directly would hand back ciphertext.
export async function readRawRecording(sessionId, recordingId, admin) {
  const recording = await loadRecording(sessionId, recordingId, admin)
  const buffer = await readFile(recording.storagePath)
  return { buffer, mimeType: recording.mimeType }
}

// The agent's manual corrections from the timeline, replacing the analysed
// decisions wholesale. Deliberately a full replace rather than a patch: the
// mute list the redact step reads is the segment table, so a partial write that
// left a stale REDACT row behind would mute speech the agent had just cleared,
// and a dropped one would release speech they had just muted.
//
// This is the one path where a human overrides a consent-derived decision, so
// it writes its own audit action — RECORDING_ANALYZED tells you the pipeline
// decided something, and that must never be confused with a person deciding it.
export async function saveSegments(sessionId, recordingId, segmentList, admin) {
  await loadRecording(sessionId, recordingId, admin)

  const rows = segmentList.map((seg) => {
    if (!(seg.endSec > seg.startSec)) {
      throw new ApiError(400, `Invalid interval: [${seg.startSec}, ${seg.endSec}]`)
    }
    return {
      recordingId,
      speakerId: seg.speakerId || 'MANUAL',
      subjectId: seg.subjectId ?? null,
      consentId: seg.consentId ?? null,
      startSec: seg.startSec,
      endSec: seg.endSec,
      action: seg.action,
      reason:
        seg.reason ??
        (seg.action === 'KEEP'
          ? 'AGENT_MANUAL_KEEP'
          : seg.action === 'REDACT_VOICE'
            ? 'AGENT_MANUAL_REDACTION'
            : 'AGENT_MANUAL_PII_REDACTION'),
      piiType: seg.piiType ?? null,
      matchScore: typeof seg.matchScore === 'number' ? seg.matchScore : null,
    }
  })

  await prisma.$transaction([
    prisma.audioSegment.deleteMany({ where: { recordingId } }),
    prisma.audioSegment.createMany({ data: rows }),
    prisma.recording.update({ where: { id: recordingId }, data: { status: 'ANALYZED' } }),
  ])

  // Same reasoning as in analyzeRecording: who is audible in this recording has
  // just changed, so what DSAR can find and erase has to change with it.
  try {
    await indexRecording(recordingId)
  } catch (err) {
    logger.error(
      { alert: 'ITEM_INDEX_REFRESH_FAILED', err, recordingId, at: 'saveSegments' },
      'item index refresh failed after manual segment edit — DSAR completeness may be stale until the next discovery',
    )
  }

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recordingId,
    action: 'AUDIO_SEGMENTS_MANUALLY_UPDATED',
    actorId: admin.id,
    payload: {
      recordingId,
      sessionId,
      segmentCount: rows.length,
      kept: rows.filter((r) => r.action === 'KEEP').length,
      muted: rows.filter((r) => r.action !== 'KEEP').length,
    },
  })

  return prisma.audioSegment.findMany({ where: { recordingId }, orderBy: { startSec: 'asc' } })
}

export async function readRedactedRecording(sessionId, recordingId, admin) {
  const recording = await loadRecording(sessionId, recordingId, admin)
  if (!recording.redactedPath || recording.status !== 'REDACTED') {
    // DEFERRED is an explicit refusal, not a 404: the recording exists and the
    // caller is entitled to it, but its mask was never confirmed and serving it
    // is the reportable failure mode.
    throw new ApiError(409, `Recording is ${recording.status} — no confirmed redacted copy exists`)
  }
  const buffer = await readFile(recording.redactedPath)
  return { buffer, mimeType: recording.mimeType }
}
