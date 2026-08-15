import { prisma } from '../../config/prisma.js'
import { readFile, writeFile } from '../../lib/storage.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { consentVerdict, isEligible } from '../../lib/consent.js'

const AUDIO_SERVICE_URL = process.env.AUDIO_SERVICE_URL ?? 'http://localhost:8003'

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

async function callAnalyze(buffer, filename, snippets) {
  const form = new FormData()
  form.append('main_audio', new Blob([buffer]), filename)
  form.append('snippet_muids', JSON.stringify(snippets.map((s) => s.muid)))
  for (const s of snippets) {
    form.append('voice_snippets', new Blob([s.buffer]), s.filename)
  }

  let res
  try {
    res = await fetch(`${AUDIO_SERVICE_URL}/api/v1/analyze`, { method: 'POST', body: form })
  } catch (err) {
    throw new AudioUnavailableError(`Audio worker unreachable while analyzing ${filename}`, err)
  }
  if (!res.ok) {
    throw new AudioUnavailableError(`Audio worker returned ${res.status} while analyzing ${filename}`)
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
    throw new AudioUnavailableError(`Audio worker returned ${res.status} while redacting ${filename}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

// Step 1: agent (or, for now, the test client) uploads the raw session
// recording. Stored under sessions/<sid>/audio/ so storage.js's existing
// scopeForPath rule ("sessions/<sid>/... -> session-scoped DEK") applies with
// zero changes to lib/storage.js — the same key family that already protects
// photos (L2) now covers audio without a new case in that switch statement.
export async function uploadRecording(sessionId, file, admin) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } })
  if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 })

  const recording = await prisma.recording.create({
    data: { sessionId, status: 'PENDING_ANALYSIS', storagePath: '' },
  })

  const relativePath = `sessions/${sessionId}/audio/${recording.id}.wav`
  await writeFile(relativePath, file.buffer)

  const updated = await prisma.recording.update({
    where: { id: recording.id },
    data: { storagePath: relativePath },
  })

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recording.id,
    action: 'RECORDING_UPLOADED',
    actorId: admin.id,
    payload: { sessionId },
  })

  return updated
}

// Step 2: detection only. Calls /analyze, stores the raw findings as
// AudioSegment rows, and separately computes+stores the KEEP/REDACT decision
// via project_consent_matrix — the audio-worker never sees consent data, so
// this function is the one and only place that joins the two.
//
// `voiceSnippets` is supplied by the caller per-request for now (there is no
// voice-enrollment flow yet — see note in the route file). Each entry is
// { muid, filename, buffer }.
export async function analyzeRecording(sessionId, recordingId, voiceSnippets, admin) {
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw Object.assign(new Error('Recording not found'), { statusCode: 404 })

  const original = await readFile(recording.storagePath)

  let result
  try {
    result = await callAnalyze(original, `${recordingId}.wav`, voiceSnippets)
  } catch (err) {
    // Fail closed, same rule as image PII (invariant 8): a recording that
    // could not be analyzed is DEFERRED, not silently treated as clean.
    await prisma.recording.update({ where: { id: recordingId }, data: { status: 'DEFERRED' } })
    await writeAuditLog({
      entityType: 'Recording',
      entityId: recordingId,
      action: 'RECORDING_ANALYSIS_FAILED',
      actorId: admin.id,
      payload: { error: err.message },
    })
    throw err
  }

  // Resolve each speaker_match's matched_muid against real consent. This is
  // the block that replaces the hardcoded bob/alice profile from the
  // prototype: ProjectConsent is all-or-nothing per project (no separate
  // "biometric" / "pii" flags in the schema), so the decision collapses to
  // one check — isEligible(consentVerdict(subject, consent)) — same helper
  // session.service.js already uses for photos.
  const project = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { projectId: true },
  })

  const segmentRows = []
  for (const match of result.speaker_matches) {
    let action = 'REDACT_VOICE'
    let reason = 'UNIDENTIFIED_SPEAKER'
    let subjectId = null
    let consentId = null

    if (match.matched_muid) {
      const [subject, consent] = await Promise.all([
        prisma.subject.findUnique({ where: { masterUserId: match.matched_muid } }),
        prisma.projectConsent.findUnique({
          where: {
            subjectId_projectId: { subjectId: match.matched_muid, projectId: project.projectId },
          },
        }),
      ])
      if (subject && isEligible(consentVerdict(subject, consent))) {
        action = 'KEEP'
        reason = 'CONSENTED_SPEAKER'
        subjectId = match.matched_muid
        consentId = consent?.consentId ?? null
      } else if (subject) {
        reason = 'CONSENT_INELIGIBLE'
        subjectId = match.matched_muid
        consentId = consent?.consentId ?? null
      }
    }

    segmentRows.push({
      recordingId,
      speakerId: match.speaker_id,
      subjectId,
      consentId,
      startSec: 0, // filled in per-turn below; speaker_matches has no timing itself
      endSec: 0,
      action,
      reason,
      matchScore: match.score,
    })
  }

  // segments[] carries the actual per-utterance timing; speaker_matches only
  // carries one action per speaker. Expand to one AudioSegment row per
  // transcript segment so the redact step has exact intervals, same
  // granularity as FaceDetection rows per photo.
  const actionBySpeaker = new Map(segmentRows.map((r) => [r.speakerId, r]))
  const expandedRows = result.segments.map((seg) => {
    const base = actionBySpeaker.get(seg.speaker_id)
    return {
      recordingId,
      speakerId: seg.speaker_id,
      subjectId: base?.subjectId ?? null,
      consentId: base?.consentId ?? null,
      startSec: seg.start,
      endSec: seg.end,
      action: base?.action ?? 'REDACT_VOICE',
      reason: base?.reason ?? 'UNIDENTIFIED_SPEAKER',
      piiType: null,
      matchScore: base?.matchScore ?? 0,
    }
  })

  // PII spans are muted unconditionally, regardless of whose voice it is —
  // matches the image pipeline, where PII text masking is not gated by
  // biometric consent either (docs/01_PRIVACY_DATAFLOW.md Phase D).
  const piiRows = result.pii_spans.map((span) => {
    const base = actionBySpeaker.get(span.speaker_id)
    return {
      recordingId,
      speakerId: span.speaker_id,
      subjectId: base?.subjectId ?? null,
      consentId: base?.consentId ?? null,
      startSec: span.start,
      endSec: span.end,
      action: 'REDACT_PII',
      reason: `PII_${span.type || 'DETECTED'}_FOUND`,
      piiType: span.type || null,
      matchScore: null,
    }
  })

  await prisma.$transaction([
    prisma.audioSegment.deleteMany({ where: { recordingId } }),
    prisma.audioSegment.createMany({ data: [...expandedRows, ...piiRows] }),
    prisma.recording.update({ where: { id: recordingId }, data: { status: 'ANALYZED' } }),
  ])

  await writeAuditLog({
    entityType: 'Recording',
    entityId: recordingId,
    action: 'RECORDING_ANALYZED',
    actorId: admin.id,
    payload: {
      segments: expandedRows.length,
      piiSpans: piiRows.length,
      speakerManifest: segmentRows.map((s) => ({
        speakerId: s.speakerId,
        subjectId: s.subjectId,
        consentId: s.consentId,
        action: s.action,
        reason: s.reason,
        matchScore: s.matchScore,
      })),
    },
  })

  return prisma.audioSegment.findMany({ where: { recordingId } })
}

// Step 3: execution. Reads the stored AudioSegment decisions (not fresh
// detection — analyze and redact are deliberately two calls, see
// ai-core/audio-worker/README.md), builds the mute-interval list, and asks
// the worker to produce the redacted file. The worker never sees a subject
// id or a consent status, only start/end seconds — same separation as
// /redact on the image side, which takes bboxes it did not compute.
export async function redactRecording(sessionId, recordingId, admin) {
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw Object.assign(new Error('Recording not found'), { statusCode: 404 })
  if (recording.status !== 'ANALYZED') {
    throw Object.assign(new Error('Recording has not been analyzed yet'), { statusCode: 409 })
  }

  const segments = await prisma.audioSegment.findMany({
    where: { recordingId, action: { in: ['REDACT_VOICE', 'REDACT_PII'] } },
  })
  const intervals = segments.map((s) => ({ start: s.startSec, end: s.endSec }))

  const original = await readFile(recording.storagePath)

  let redactedBuffer
  try {
    redactedBuffer = await callRedact(original, `${recordingId}.wav`, intervals)
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

  const redactedPath = `sessions/${sessionId}/audio/${recordingId}.redacted.wav`
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

// Powers the session detail page's "Audio" section — list, not single-record
// detail, so it stays cheap even with many recordings on a long session.
export async function listRecordings(sessionId) {
  return prisma.recording.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    include: { segments: true },
  })
}

export async function getRecording(sessionId, recordingId) {
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw Object.assign(new Error('Recording not found'), { statusCode: 404 })
  const segments = await prisma.audioSegment.findMany({ where: { recordingId } })
  return { recording, segments }
}

export async function readRedactedRecording(sessionId, recordingId) {
  const recording = await prisma.recording.findFirst({ where: { id: recordingId, sessionId } })
  if (!recording) throw Object.assign(new Error('Recording not found'), { statusCode: 404 })
  if (!recording.redactedPath) {
    throw Object.assign(new Error('Recording has not been redacted'), { statusCode: 409 })
  }
  const buffer = await readFile(recording.redactedPath)
  return { buffer, mimeType: 'audio/wav' }
}