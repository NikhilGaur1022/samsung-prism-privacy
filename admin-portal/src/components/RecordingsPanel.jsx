import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Trash2, UploadCloud, X } from 'lucide-react'
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

// One recording's expandable snippet-builder + action row. Split out from
// the panel component so each recording manages its own analyze-in-progress
// state independently — expanding one row's builder doesn't disturb another.
function RecordingRow({ sessionId, recording, participants, onChanged }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [snippets, setSnippets] = useState([]) // [{ subjectId, fullName, file }]
  const [pickedSubjectId, setPickedSubjectId] = useState('')
  const snippetFileRef = useRef(null)

  const counts = segmentSummary(recording.segments)
  const hasBeenAnalyzed = recording.segments.length > 0

  const addSnippet = (file) => {
    if (!pickedSubjectId || !file) return
    const subject = participants.find((p) => p.subjectId === pickedSubjectId)
    setSnippets((prev) => [
      ...prev.filter((s) => s.subjectId !== pickedSubjectId), // one snippet per subject
      { subjectId: pickedSubjectId, fullName: subject?.fullName ?? 'Unknown', file },
    ])
    setPickedSubjectId('')
  }

  const removeSnippet = (subjectId) =>
    setSnippets((prev) => prev.filter((s) => s.subjectId !== subjectId))

  const runAnalyze = async () => {
    setBusy(true)
    setError(null)
    try {
      await analyzeRecording(sessionId, recording.id, snippets)
      setSnippets([])
      setExpanded(false)
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
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {expanded ? 'Hide' : hasBeenAnalyzed ? 'Retry analysis' : 'Analyze'}
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

      {expanded && (
        <div className="mt-4 rounded-lg bg-canvas p-3">
          <p className="text-xs font-semibold text-ink-muted">
            Voice snippets — match a roster member to a short clip of their voice. Speakers with
            no matching snippet are treated as unconsented and muted automatically.
          </p>

          {snippets.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {snippets.map((s) => (
                <li
                  key={s.subjectId}
                  className="flex items-center gap-1 rounded-pill bg-surface px-2.5 py-1 text-xs font-medium text-ink"
                >
                  {s.fullName}
                  <button
                    onClick={() => removeSnippet(s.subjectId)}
                    aria-label={`Remove snippet for ${s.fullName}`}
                    className="text-ink-faint hover:text-danger"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={pickedSubjectId}
              onChange={(e) => setPickedSubjectId(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <option value="">Select roster member…</option>
              {participants
                .filter((p) => !snippets.some((s) => s.subjectId === p.subjectId))
                .map((p) => (
                  <option key={p.subjectId} value={p.subjectId}>
                    {p.fullName}
                  </option>
                ))}
            </select>

            <button
              onClick={() => snippetFileRef.current?.click()}
              disabled={!pickedSubjectId}
              className="rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Attach voice clip…
            </button>
            <input
              ref={snippetFileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                addSnippet(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
          </div>

          <button
            onClick={runAnalyze}
            disabled={busy}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy && <Loader2 size={12} className="animate-spin" />} Run analysis
            {snippets.length === 0 && ' (no snippets — everyone will be muted)'}
          </button>
        </div>
      )}
    </div>
  )
}

// Mirrors the "Capture" section's shape (rounded-card bg-surface p-6
// shadow-card), so it reads as a natural sibling to Roster/Capture rather
// than a bolted-on feature.
export default function RecordingsPanel({ sessionId, participants, capturing }) {
  const [recordings, setRecordings] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef(null)

  const load = async () => {
    try {
      const res = await listRecordings(sessionId)
      setRecordings(res.recordings)
    } catch (err) {
      setError(err)
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
            <RecordingRow
              key={r.id}
              sessionId={sessionId}
              recording={r}
              participants={participants}
              onChanged={load}
            />
          ))
        )}
      </div>
    </section>
  )
}