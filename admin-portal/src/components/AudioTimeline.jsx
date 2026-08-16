import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Edit2,
  Info,
  Loader2,
  Mic,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Shield,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import StatusPill from './StatusPill'
import { mediaUrl, redactRecording, updateRecordingSegments } from '../lib/api'

const STANDARD_REASONS = [
  { value: 'UNIDENTIFIED_SPEAKER', label: 'Unidentified / Bystander Voice', tone: 'danger', type: 'VOICE' },
  { value: 'PII_PERSON_FOUND', label: 'Person Name PII', tone: 'warning', type: 'PII', piiType: 'PERSON' },
  { value: 'PII_PHONE_NUMBER_FOUND', label: 'Phone Number PII', tone: 'warning', type: 'PII', piiType: 'PHONE_NUMBER' },
  { value: 'PII_EMAIL_ADDRESS_FOUND', label: 'Email Address PII', tone: 'warning', type: 'PII', piiType: 'EMAIL_ADDRESS' },
  { value: 'PII_CREDIT_CARD_FOUND', label: 'Credit Card / Financial PII', tone: 'warning', type: 'PII', piiType: 'CREDIT_CARD' },
  { value: 'PII_LOCATION_FOUND', label: 'Location / Address PII', tone: 'warning', type: 'PII', piiType: 'LOCATION' },
  { value: 'PII_DATE_TIME_FOUND', label: 'Date / Time PII', tone: 'warning', type: 'PII', piiType: 'DATE_TIME' },
  { value: 'PII_OTHER_FOUND', label: 'Other Sensitive PII', tone: 'warning', type: 'PII', piiType: 'OTHER' },
  { value: 'AGENT_MANUAL_REDACTION', label: 'Agent Manual Redaction / Discretion', tone: 'brand', type: 'MANUAL' },
]

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`
}

function formatShortTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function AudioTimeline({
  sessionId,
  recording,
  participants = [],
  onChanged,
  readOnly = false,
}) {
  const [audioSource, setAudioSource] = useState(recording.status === 'REDACTED' ? 'redacted' : 'raw')
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(recording.durationSec || 0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isScrubbing, setIsScrubbing] = useState(false)

  // Local copy of segments for manual editing
  const [segments, setSegments] = useState(recording.segments || [])
  const [isSaving, setIsSaving] = useState(false)
  const [isRedacting, setIsRedacting] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  // Manual Redaction Modal / Form state
  const [showAddModal, setShowAddModal] = useState(false)
  const [manualStart, setManualStart] = useState('')
  const [manualEnd, setManualEnd] = useState('')
  const [manualReason, setManualReason] = useState('PII_PHONE_NUMBER_FOUND')

  // Active selected segment for highlighting
  const [selectedSegmentId, setSelectedSegmentId] = useState(null)

  const audioRef = useRef(null)
  const timelineRef = useRef(null)

  // Segments duration fallback if metadata has not loaded yet
  const fallbackMaxSegmentEnd = segments.length > 0 ? Math.max(...segments.map((s) => s.endSec)) : 0
  const effectiveDuration = duration > 0 ? duration : (recording.durationSec || fallbackMaxSegmentEnd || 10)

  useEffect(() => {
    setSegments(recording.segments || [])
  }, [recording.segments])

  useEffect(() => {
    if (recording.status === 'REDACTED') {
      setAudioSource('redacted')
    } else {
      setAudioSource('raw')
    }
  }, [recording.status])

  // Get active audio URL based on toggle
  const audioUrl =
    audioSource === 'redacted' && recording.status === 'REDACTED'
      ? mediaUrl.redactedRecording(sessionId, recording.id)
      : mediaUrl.rawRecording(sessionId, recording.id)

  // Audio event listeners
  const onLoadedMetadata = () => {
    if (audioRef.current) {
      const d = audioRef.current.duration
      if (d && !isNaN(d) && isFinite(d) && d > 0) {
        setDuration(d)
      }
    }
  }

  const onTimeUpdate = () => {
    if (audioRef.current && !isScrubbing) {
      setCurrentTime(audioRef.current.currentTime)
    }
  }

  const onEnded = () => {
    setIsPlaying(false)
  }

  const togglePlay = () => {
    if (!audioRef.current) return
    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      audioRef.current.play().catch(() => setIsPlaying(false))
      setIsPlaying(true)
    }
  }

  const seekTo = useCallback(
    (seconds) => {
      const clamped = Math.max(0, Math.min(seconds, effectiveDuration))
      setCurrentTime(clamped)
      if (audioRef.current) {
        try {
          audioRef.current.currentTime = clamped
        } catch (e) {
          // ignore seek range errors
        }
      }
    },
    [effectiveDuration],
  )

  const skip = (delta) => {
    seekTo(currentTime + delta)
  }

  const getTimeFromEvent = (e) => {
    if (!timelineRef.current || !effectiveDuration) return 0
    const rect = timelineRef.current.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const percentage = Math.max(0, Math.min(1, clickX / rect.width))
    return percentage * effectiveDuration
  }

  const handleTimelineMouseDown = (e) => {
    setIsScrubbing(true)
    const targetTime = getTimeFromEvent(e)
    seekTo(targetTime)

    const handleMouseMove = (moveEvent) => {
      const moveTime = getTimeFromEvent(moveEvent)
      seekTo(moveTime)
    }

    const handleMouseUp = () => {
      setIsScrubbing(false)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  const handlePlaybackRateChange = (rate) => {
    setPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }

  const handleSourceSwitch = (source) => {
    if (source === audioSource) return
    const prevTime = currentTime
    const wasPlaying = isPlaying
    setAudioSource(source)
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = prevTime
        if (wasPlaying) {
          audioRef.current.play().catch(() => {})
        }
      }
    }, 50)
  }

  // Segment management
  const handleAddManualSegment = async (e) => {
    e.preventDefault()
    const start = parseFloat(manualStart)
    const end = parseFloat(manualEnd)

    if (isNaN(start) || isNaN(end) || start < 0 || end <= start) {
      setError({ message: 'Please enter valid start and end seconds (End must be greater than Start).' })
      return
    }

    const selectedDef = STANDARD_REASONS.find((r) => r.value === manualReason)
    const action = selectedDef?.type === 'VOICE' ? 'REDACT_VOICE' : 'REDACT_PII'

    const newSeg = {
      speakerId: 'MANUAL',
      subjectId: null,
      consentId: null,
      startSec: start,
      endSec: end,
      action,
      reason: manualReason,
      piiType: selectedDef?.piiType || null,
      matchScore: null,
    }

    const updated = [...segments, newSeg].sort((a, b) => a.startSec - b.startSec)
    setSegments(updated)
    setShowAddModal(false)
    setManualStart('')
    setManualEnd('')
    setError(null)

    await saveAndUpdate(updated)
  }

  const handleDeleteSegment = async (indexToDelete) => {
    const updated = segments.filter((_, i) => i !== indexToDelete)
    setSegments(updated)
    await saveAndUpdate(updated)
  }

  const saveAndUpdate = async (newSegments) => {
    setIsSaving(true)
    setError(null)
    try {
      await updateRecordingSegments(sessionId, recording.id, newSegments)
      setSuccessMsg('Timeline updated. Click "Re-apply Redaction" to render the new audio file.')
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setIsSaving(false)
    }
  }

  const handleReapplyRedaction = async () => {
    setIsRedacting(true)
    setError(null)
    setSuccessMsg(null)
    try {
      await redactRecording(sessionId, recording.id)
      setSuccessMsg('Audio redaction complete! Redacted derivative saved and updated in the database.')
      setAudioSource('redacted')
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err)
    } finally {
      setIsRedacting(false)
    }
  }

  // Calculate subject map for quick lookup
  const participantMap = new Map(participants.map((p) => [p.subjectId, p]))

  // Counts summary
  const keptCount = segments.filter((s) => s.action === 'KEEP').length
  const voiceMutedCount = segments.filter((s) => s.action === 'REDACT_VOICE').length
  const piiMutedCount = segments.filter((s) => s.action === 'REDACT_PII').length

  return (
    <div className="space-y-6">
      {/* Audio Player & Controls Bar */}
      <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          className="hidden"
        />

        {/* Top Header: Source Selector & Stats */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="flex rounded-lg bg-canvas p-1 border border-border">
              <button
                onClick={() => handleSourceSwitch('raw')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  audioSource === 'raw'
                    ? 'bg-surface text-ink shadow-sm'
                    : 'text-ink-faint hover:text-ink'
                }`}
              >
                Original Audio (Raw)
              </button>
              <button
                onClick={() => handleSourceSwitch('redacted')}
                disabled={recording.status !== 'REDACTED'}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  audioSource === 'redacted'
                    ? 'bg-brand text-white shadow-sm'
                    : 'text-ink-faint hover:text-ink disabled:opacity-40'
                }`}
              >
                <Shield size={12} strokeWidth={2.5} />
                Redacted Derivative
              </button>
            </div>

            <span className="text-xs font-medium text-ink-faint">
              Playback: <strong className="text-ink">{audioSource === 'redacted' ? 'Redacted (Muted Spans)' : 'Unredacted Original'}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              <CheckCircle2 size={12} /> {keptCount} Kept
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">
              <VolumeX size={12} /> {voiceMutedCount} Unconsented Muted
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
              <Scissors size={12} /> {piiMutedCount} PII Spans Muted
            </span>
          </div>
        </div>

        {/* Player Transport Controls */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => skip(-5)}
              title="Rewind 5s"
              className="rounded-lg border border-border bg-canvas p-2 text-ink hover:bg-surface hover:text-brand transition"
            >
              <RotateCcw size={16} />
            </button>
            <button
              onClick={togglePlay}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white shadow-md hover:bg-brand-dark transition"
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
            </button>
            <button
              onClick={() => skip(5)}
              title="Forward 5s"
              className="rounded-lg border border-border bg-canvas p-2 text-ink hover:bg-surface hover:text-brand transition"
            >
              <RotateCw size={16} />
            </button>

            <div className="ml-2 flex items-center gap-1 font-mono text-sm font-semibold text-ink">
              <span>{formatTime(currentTime)}</span>
              <span className="text-ink-faint">/</span>
              <span className="text-ink-muted">{formatTime(effectiveDuration)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Playback speed */}
            <div className="flex items-center gap-1 rounded-lg border border-border bg-canvas px-2 py-1">
              {[1, 1.25, 1.5, 2].map((rate) => (
                <button
                  key={rate}
                  onClick={() => handlePlaybackRateChange(rate)}
                  className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                    playbackRate === rate ? 'bg-brand text-white' : 'text-ink-faint hover:text-ink'
                  }`}
                >
                  {rate}x
                </button>
              ))}
            </div>

            {/* Quick manual redact button */}
            {!readOnly && (
              <button
                onClick={() => {
                  setManualStart(currentTime.toFixed(2))
                  setManualEnd(Math.min(currentTime + 5, effectiveDuration).toFixed(2))
                  setShowAddModal(true)
                }}
                className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-2 text-xs font-semibold text-brand hover:bg-brand hover:text-white transition"
              >
                <Plus size={14} /> Add Manual Redaction
              </button>
            )}
          </div>
        </div>

        {/* Visual Timeline & Waveform Bar */}
        <div className="mt-6">
          <div className="flex items-center justify-between text-xs font-mono text-ink-faint mb-1.5">
            <span>00:00</span>
            <span>{formatShortTime(effectiveDuration * 0.25)}</span>
            <span>{formatShortTime(effectiveDuration * 0.5)}</span>
            <span>{formatShortTime(effectiveDuration * 0.75)}</span>
            <span>{formatShortTime(effectiveDuration)}</span>
          </div>

          {/* Timeline Track Container */}
          <div
            ref={timelineRef}
            onMouseDown={handleTimelineMouseDown}
            className="group relative h-20 w-full cursor-pointer overflow-hidden rounded-xl border border-border bg-slate-950 select-none shadow-inner"
          >
            {/* Waveform Background Simulation Grid */}
            <div className="absolute inset-0 flex items-center justify-between px-1 opacity-20 pointer-events-none">
              {Array.from({ length: 120 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-slate-400"
                  style={{
                    height: `${20 + Math.sin(i * 0.3) * 30 + (i % 7) * 8}%`,
                  }}
                />
              ))}
            </div>

            {/* Render Segments on Timeline */}
            {segments.map((seg, idx) => {
              const leftPercent = Math.max(0, Math.min(100, (seg.startSec / effectiveDuration) * 100))
              const widthPercent = Math.max(0.6, Math.min(100 - leftPercent, ((seg.endSec - seg.startSec) / effectiveDuration) * 100))
              const isSelected = selectedSegmentId === (seg.id || idx)

              let bgStyle = 'bg-emerald-500/80 border-emerald-400 text-emerald-100'
              let label = 'KEPT'
              if (seg.action === 'REDACT_VOICE') {
                bgStyle = 'bg-rose-500/80 border-rose-400 text-rose-100'
                label = 'MUTED VOICE'
              } else if (seg.action === 'REDACT_PII') {
                bgStyle = 'bg-amber-500/85 border-amber-300 text-amber-100'
                label = seg.piiType || 'PII'
              }

              return (
                <div
                  key={seg.id || idx}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedSegmentId(seg.id || idx)
                    seekTo(seg.startSec)
                  }}
                  title={`[${formatTime(seg.startSec)} - ${formatTime(seg.endSec)}] ${seg.speakerId} (${label}): ${seg.reason || 'No reason'}`}
                  style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  className={`absolute top-1.5 bottom-1.5 rounded-md border flex flex-col justify-center px-1 overflow-hidden transition cursor-pointer hover:brightness-110 hover:z-20 ${bgStyle} ${
                    isSelected ? 'ring-2 ring-white z-30 shadow-lg' : 'opacity-90'
                  }`}
                >
                  <span className="truncate text-[10px] font-bold uppercase tracking-wider leading-tight">
                    {seg.speakerId === 'MANUAL' ? 'MANUAL' : seg.speakerId}
                  </span>
                  <span className="truncate text-[9px] opacity-90 font-medium">
                    {label}
                  </span>
                </div>
              )
            })}

            {/* Playhead indicator */}
            {effectiveDuration > 0 && (
              <div
                style={{ left: `${Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100))}%` }}
                className="absolute top-0 bottom-0 w-0.5 bg-white z-40 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.9)]"
              >
                <div className="absolute -top-1 -left-1.5 h-3 w-3 rounded-full bg-white shadow-md" />
              </div>
            )}
          </div>

          {/* Timeline Legend */}
          <div className="mt-3 flex flex-wrap items-center justify-between text-xs text-ink-muted">
            <div className="flex flex-wrap items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Consented Voice (Kept)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Unconsented / Unknown Voice (Muted)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Spoken PII Span (Muted)
              </span>
            </div>
            <span className="text-[11px] text-ink-faint">
              Click & drag anywhere on track to scrub · Click segment to inspect
            </span>
          </div>
        </div>

        {/* Action Messages */}
        {error && (
          <div className="mt-4 rounded-lg bg-danger-soft px-3.5 py-2.5 text-xs font-semibold text-danger flex items-center justify-between">
            <span>{error.message}</span>
            <button onClick={() => setError(null)} className="text-danger hover:opacity-70">
              <X size={14} />
            </button>
          </div>
        )}

        {successMsg && (
          <div className="mt-4 rounded-lg bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-800 flex items-center justify-between">
            <span>{successMsg}</span>
            <button onClick={() => setSuccessMsg(null)} className="text-emerald-800 hover:opacity-70">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Re-apply Redaction Bar */}
        {!readOnly && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <Info size={14} className="text-brand" />
              <span>
                Manual changes are saved in real-time. Click <strong>Re-apply Redaction</strong> to re-generate the redacted audio waveform.
              </span>
            </div>

            <button
              onClick={handleReapplyRedaction}
              disabled={isRedacting || isSaving}
              className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-brand-dark disabled:opacity-60 transition"
            >
              {isRedacting ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Rendering Redacted Audio…
                </>
              ) : (
                <>
                  <RefreshCw size={14} /> Re-apply Redaction
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Segments Inspector & Granular Manifest Table */}
      <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink">Audio Segments & Redaction Manifest</h3>
            <p className="text-xs text-ink-faint">
              Detailed turn-by-turn speaker verification, consent mapping, and PII redactions.
            </p>
          </div>

          {!readOnly && (
            <button
              onClick={() => {
                setManualStart(currentTime.toFixed(2))
                setManualEnd(Math.min(currentTime + 5, effectiveDuration).toFixed(2))
                setShowAddModal(true)
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface hover:text-brand transition"
            >
              <Plus size={13} /> Add Manual Interval
            </button>
          )}
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-ink-faint uppercase tracking-wider font-semibold text-[10px]">
                <th className="py-2.5 px-3">Interval</th>
                <th className="py-2.5 px-3">Speaker / ID</th>
                <th className="py-2.5 px-3">Subject / Consent</th>
                <th className="py-2.5 px-3">Action</th>
                <th className="py-2.5 px-3">Reason / Details</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {segments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ink-faint">
                    No segments detected or added yet. Run analysis to detect speakers and PII.
                  </td>
                </tr>
              ) : (
                segments.map((seg, idx) => {
                  const isSelected = selectedSegmentId === (seg.id || idx)
                  const matchedParticipant = seg.subjectId ? participantMap.get(seg.subjectId) : null
                  const durationSec = (seg.endSec - seg.startSec).toFixed(1)

                  return (
                    <tr
                      key={seg.id || idx}
                      onClick={() => {
                        setSelectedSegmentId(seg.id || idx)
                        seekTo(seg.startSec)
                      }}
                      className={`cursor-pointer transition hover:bg-canvas ${
                        isSelected ? 'bg-brand-soft/30 font-medium' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3 font-mono text-ink">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            seekTo(seg.startSec)
                          }}
                          className="hover:text-brand flex items-center gap-1"
                        >
                          <Play size={10} />
                          {formatTime(seg.startSec)} – {formatTime(seg.endSec)}
                          <span className="text-[10px] text-ink-faint">({durationSec}s)</span>
                        </button>
                      </td>

                      <td className="py-2.5 px-3">
                        <span className="font-semibold text-ink">{seg.speakerId}</span>
                        {seg.matchScore !== null && seg.matchScore !== undefined && (
                          <span className="ml-1.5 text-[10px] text-ink-faint font-mono">
                            ({(seg.matchScore * 100).toFixed(0)}% match)
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 px-3">
                        {matchedParticipant ? (
                          <div className="flex flex-col">
                            <span className="font-semibold text-ink">{matchedParticipant.fullName}</span>
                            <span className="text-[10px] text-ink-faint font-mono truncate max-w-[120px]">
                              Consent: {seg.consentId || 'Active'}
                            </span>
                          </div>
                        ) : seg.action === 'KEEP' ? (
                          <span className="text-ink-faint">Consented Speaker</span>
                        ) : (
                          <span className="text-ink-faint italic">No consent / Unidentified</span>
                        )}
                      </td>

                      <td className="py-2.5 px-3">
                        {seg.action === 'KEEP' ? (
                          <StatusPill tone="success">KEPT</StatusPill>
                        ) : seg.action === 'REDACT_VOICE' ? (
                          <StatusPill tone="danger">MUTED VOICE</StatusPill>
                        ) : (
                          <StatusPill tone="warning">MUTED PII</StatusPill>
                        )}
                      </td>

                      <td className="py-2.5 px-3">
                        <span className="font-mono text-[11px] text-ink">
                          {seg.reason || (seg.action === 'REDACT_VOICE' ? 'UNIDENTIFIED_SPEAKER' : 'PII_DETECTED')}
                        </span>
                        {seg.piiType && (
                          <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                            {seg.piiType}
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-right">
                        {!readOnly && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteSegment(idx)
                            }}
                            title="Delete / Override this segment"
                            className="rounded p-1 text-ink-faint hover:bg-danger-soft hover:text-danger transition"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Manual Redaction Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Scissors size={18} className="text-brand" />
                <h3 className="text-base font-bold text-ink">Add Manual Redaction</h3>
              </div>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-ink-faint hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleAddManualSegment} className="mt-4 space-y-4">
              <p className="text-xs text-ink-muted">
                Specify the start and end timestamp to mute unwanted speech or sensitive PII.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-semibold text-ink">
                  Start Seconds
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={manualStart}
                    onChange={(e) => setManualStart(e.target.value)}
                    placeholder="0.00"
                    className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-mono text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                  <span className="text-[10px] text-ink-faint">{formatTime(parseFloat(manualStart) || 0)}</span>
                </label>

                <label className="block text-xs font-semibold text-ink">
                  End Seconds
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={manualEnd}
                    onChange={(e) => setManualEnd(e.target.value)}
                    placeholder="5.00"
                    className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-mono text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                  <span className="text-[10px] text-ink-faint">{formatTime(parseFloat(manualEnd) || 0)}</span>
                </label>
              </div>

              <label className="block text-xs font-semibold text-ink">
                Redaction Reason
                <select
                  value={manualReason}
                  onChange={(e) => setManualReason(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {STANDARD_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label} ({r.value})
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-5 flex justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg bg-canvas px-4 py-2 text-xs font-semibold text-ink-muted hover:bg-border transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-brand-dark transition"
                >
                  {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Scissors size={12} />}
                  Add Redaction Interval
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
