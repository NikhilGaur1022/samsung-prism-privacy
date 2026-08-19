import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Mic, MicOff, UploadCloud, UserX } from 'lucide-react'
import StatusPill from './StatusPill'
import {
  analyzeRecording,
  listRecordings,
  mediaUrl,
  redactRecording,
  uploadRecording,
} from '../lib/api'

const STATUS_TONE = {
  PENDING_ANALYSIS: 'neutral',
  ANALYZED: 'brand',
  REDACTED: 'success',
  DEFERRED: 'danger',
}

const STATUS_LABEL = {
  PENDING_ANALYSIS: 'Awaiting analysis',
  ANALYZED: 'Analyzed — ready to redact',
  REDACTED: 'Redacted',
  DEFERRED: 'Worker unavailable — retry',
}

function segmentSummary(segments = []) {
  const counts = { KEEP: 0, REDACT_VOICE: 0, REDACT_PII: 0 }
  for (const s of segments) counts[s.action] = (counts[s.action] ?? 0) + 1
  return counts
}

// One recording's action row and its post-analysis coverage report. Split out
// from the panel component so each recording manages its own analyze-in-progress
// state independently.
//
// The snippet builder that used to live here is gone. An agent no longer picks
// which roster member gets compared against what audio — identity comes from the
// subjects' own enrolled voice prints. That removed the worst affordance in this
// panel: attaching the wrong person's clip decided who stayed unmuted in a
// recording, and nothing downstream could tell it had happened.
function RecordingRow({ sessionId, recording, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [gallery, setGallery] = useState(null)

  const counts = segmentSummary(recording.segments)
  const hasBeenAnalyzed = recording.segments.length > 0

  const runAnalyze = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await analyzeRecording(sessionId, recording.id)
      setGallery(res.gallery ?? null)
    } catch (err) {
      setError(err)
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  const runRedact = async () => {
    setBusy(true)
    setError(null)
    try {
      await redactRecording(sessionId, recording.id)
    } catch (err) {
      setError(err)
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mic size={16} strokeWidth={2} className="text-ink-faint" />
          <span className="text-sm font-semibold text-ink">
            {new Date(recording.createdAt).toLocaleString()}
          </span>
        </div>
        <StatusPill tone={STATUS_TONE[recording.status]}>
          {STATUS_LABEL[recording.status]}
        </StatusPill>
      </div>

      {hasBeenAnalyzed && (
        <p className="mt-2 text-xs font-medium text-ink-faint">
          {counts.KEEP} kept · {counts.REDACT_VOICE} unconsented voice muted ·{' '}
          {counts.REDACT_PII} PII span{counts.REDACT_PII === 1 ? '' : 's'} muted
        </p>
      )}

      {error && (
        <div className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
          {error.message}
        </div>
      )}

      {recording.status === 'REDACTED' && (
        <audio
          controls
          className="mt-3 w-full"
          src={mediaUrl.redactedRecording(sessionId, recording.id)}
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {(recording.status === 'PENDING_ANALYSIS' || recording.status === 'DEFERRED') && (
          <button
            onClick={runAnalyze}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {hasBeenAnalyzed ? 'Retry analysis' : 'Analyze'}
          </button>
        )}

        {(recording.status === 'ANALYZED' || (recording.status === 'DEFERRED' && hasBeenAnalyzed)) && (
          <button
            onClick={runRedact}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy && <Loader2 size={12} className="animate-spin" />} Redact
          </button>
        )}
      </div>

      {/*
        Who this run was actually able to recognise. Without it "everyone was
        muted" is unreadable: it could mean nobody on the roster has enrolled a
        voice, or that their enrollments could not be loaded. Those look
        identical in the segment counts and call for opposite responses, so they
        are reported as separate lines and `broken` is styled as the fault it is.
      */}
      {gallery && (
        <div className="mt-3 rounded-lg bg-canvas p-3">
          <p className="text-xs font-semibold text-ink-muted">
            Matched against {gallery.points} enrolled voice print
            {gallery.points === 1 ? '' : 's'} from {gallery.enrolled} roster member
            {gallery.enrolled === 1 ? '' : 's'}.
          </p>

          {gallery.notEnrolled > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-ink-faint">
              <UserX size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              {gallery.notEnrolled} roster member{gallery.notEnrolled === 1 ? ' has' : 's have'} no
              voice enrollment and {gallery.notEnrolled === 1 ? 'was' : 'were'} muted as
              unidentified. Enrol them to keep their consented speech.
            </p>
          )}

          {gallery.broken > 0 && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-semibold text-danger">
              <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              {gallery.broken} roster member{gallery.broken === 1 ? ' has' : 's have'} an enrolled
              voice that could not be loaded. They were muted, but this is a fault — not a gap in
              the roster. Report it before relying on this result.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// Mirrors the "Capture" section's shape (rounded-card bg-surface p-6
// shadow-card), so it reads as a natural sibling to Roster/Capture rather
// than a bolted-on feature.
export default function RecordingsPanel({ sessionId, capturing }) {
  const [recordings, setRecordings] = useState(null)
  const [error, setError] = useState(null)
  const [audioOff, setAudioOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  const load = async () => {
    try {
      const res = await listRecordings(sessionId)
      setRecordings(res.recordings)
      setAudioOff(false)
    } catch (err) {
      // 503 is the AUDIO_CAPTURE_ENABLED kill switch, not a fault. Treated as an
      // error this panel showed a red banner and span its loader forever —
      // `recordings` stayed null, so the spinner had nothing to resolve to — on
      // every session page in a deployment where audio was simply never turned
      // on. Same rule as the voice enrollment section: this one status means
      // "not offered here", and every other status still means something broke.
      if (err.status === 503) {
        setAudioOff(true)
        setRecordings([])
      } else {
        setError(err)
      }
    }
  }

  useEffect(() => {
    load()
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (file) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await uploadRecording(sessionId, file)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Deliberately not the server's own 503 text. That message says "Set
  // AUDIO_CAPTURE_ENABLED=on once the audio worker is provisioned", which is an
  // instruction for whoever runs the deployment — a collection agent reading it
  // mid-session can only conclude something is broken and they are the one
  // expected to fix it. The panel stays visible rather than disappearing so the
  // absence of audio is a stated fact about this deployment, not a gap the agent
  // has to wonder about.
  if (audioOff) {
    return (
      <section className="rounded-card bg-surface p-6 shadow-card">
        <h2 className="text-base font-bold text-ink">Audio</h2>
        <p className="mt-0.5 flex items-start gap-1.5 text-xs font-medium text-ink-faint">
          <MicOff size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          Audio capture is switched off for this deployment — sessions here are photo-only.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-card bg-surface p-6 shadow-card">
      <h2 className="text-base font-bold text-ink">Audio</h2>
      <p className="mt-0.5 text-xs font-medium text-ink-faint">
        Session recordings — analyzed for speaker consent and PII before anything is retained.
      </p>

      {error && (
        <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          {error.message}
        </div>
      )}

      {capturing && (
        <div className="mt-4">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-brand-soft px-4 py-2.5 text-sm font-semibold text-brand disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <UploadCloud size={16} strokeWidth={2} /> Upload recording
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              handleUpload(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
          />
        </div>
      )}

      <div className="mt-5 space-y-3 border-t border-border pt-5">
        {recordings === null ? (
          <Loader2 size={18} className="animate-spin text-ink-faint" />
        ) : recordings.length === 0 ? (
          <p className="text-xs font-medium text-ink-faint">No recordings in this session yet.</p>
        ) : (
          recordings.map((r) => (
            <RecordingRow key={r.id} sessionId={sessionId} recording={r} onChanged={load} />
          ))
        )}
      </div>
    </section>
  )
}