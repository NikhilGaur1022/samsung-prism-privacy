import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Copy,
  FileAudio,
  Info,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  StopCircle,
  Trash2,
  UploadCloud,
  UserCheck,
  UserPlus,
  UserX,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import AudioTimeline from '../../components/AudioTimeline'
import {
  addParticipant,
  analyzeRecording,
  createInvite,
  finalizeSession,
  getInvite,
  getSessionFresh,
  listRecordings,
  mediaUrl,
  redactRecording,
  removeParticipant,
  revokeInvite,
  searchProjectSubjects,
  uploadRecording,
} from '../../lib/api'

const VERDICT_LABEL = {
  ELIGIBLE: 'Consent active',
  NO_CONSENT: 'No consent',
  REVOKED: 'Consent revoked',
  SUBJECT_INACTIVE: 'Inactive subject',
}

const FIELD_CLASS =
  'w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (!expiresAt) return null
  const diff = new Date(expiresAt).getTime() - now
  if (diff <= 0) return 'Expired'
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function AudioSessionDetail() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [recordings, setRecordings] = useState([])
  const [selectedRecordingId, setSelectedRecordingId] = useState(null)

  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Roster & Invites
  const [invite, setInvite] = useState(null)
  const [copied, setCopied] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Voice identification coverage for the active recording
  // What the last analyze run was actually able to recognise. Replaces the
  // snippet builder that used to live here: an agent no longer picks which
  // roster member gets compared against what audio — identity comes from the
  // subjects' own enrolled voice prints, matched in the backend against its
  // gallery. Attaching the wrong person's clip decided who stayed unmuted, and
  // nothing downstream could tell it had happened.
  const [gallery, setGallery] = useState(null)

  // Live microphone recording state
  const [isRecordingLive, setIsRecordingLive] = useState(false)
  const [liveDuration, setLiveDuration] = useState(0)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const timerRef = useRef(null)

  const uploadInputRef = useRef(null)

  // Finalize modal state
  const [showFinalizeModal, setShowFinalizeModal] = useState(false)
  const [finalizing, setFinalizing] = useState(false)

  const countdown = useCountdown(invite?.expiresAt)

  // Load session and recordings
  const loadData = useCallback(async () => {
    try {
      const [sessRes, recRes] = await Promise.all([
        getSessionFresh(sessionId),
        listRecordings(sessionId),
      ])
      setSession(sessRes)
      setRecordings(recRes.recordings || [])
      if (!selectedRecordingId && recRes.recordings?.length > 0) {
        setSelectedRecordingId(recRes.recordings[0].id)
      }
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [sessionId, selectedRecordingId])

  useEffect(() => {
    loadData()
    getInvite(sessionId).then(setInvite).catch(() => {})
  }, [loadData, sessionId])

  // Subject search for roster add
  useEffect(() => {
    if (!session?.projectId || searchQuery.trim().length < 2) {
      setSearchResults([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchProjectSubjects(session.projectId, searchQuery.trim())
        .then((res) => setSearchResults(res.items || []))
        .catch(() => {})
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, session?.projectId])

  // Live audio recording handlers
  const startLiveRecording = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioChunksRef.current = []
      const recorder = new MediaRecorder(stream)
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' })
        const file = new File([audioBlob], `recording-${Date.now()}.wav`, { type: 'audio/wav' })
        stream.getTracks().forEach((track) => track.stop())
        setIsRecordingLive(false)
        clearInterval(timerRef.current)
        setLiveDuration(0)

        // Upload recorded file
        await handleAudioUpload(file)
      }

      recorder.start(250)
      setIsRecordingLive(true)
      setLiveDuration(0)
      timerRef.current = setInterval(() => setLiveDuration((d) => d + 1), 1000)
    } catch (err) {
      setError(new Error(err.message || 'Microphone access denied.'))
      setIsRecordingLive(false)
    }
  }

  const stopLiveRecording = () => {
    if (mediaRecorderRef.current && isRecordingLive) {
      mediaRecorderRef.current.stop()
    }
  }

  const handleAudioUpload = async (file) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const newRec = await uploadRecording(sessionId, file)
      await loadData()
      if (newRec?.id) setSelectedRecordingId(newRec.id)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Analyze active recording
  const handleAnalyze = async (recId) => {
    setBusy(true)
    setError(null)
    try {
      const res = await analyzeRecording(sessionId, recId)
      setGallery(res.gallery ?? null)
      await loadData()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Finalize session
  const handleFinalize = async () => {
    setFinalizing(true)
    setError(null)
    try {
      await finalizeSession(sessionId)
      setShowFinalizeModal(false)
      await loadData()
      navigate('/sessions')
    } catch (err) {
      setError(err)
    } finally {
      setFinalizing(false)
    }
  }

  const activeRecording = recordings.find((r) => r.id === selectedRecordingId) || recordings[0]
  const isArchived = session?.status === 'ARCHIVED'
  const isCapturing = session?.status === 'ACTIVE'

  if (loading) {
    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 flex items-center justify-center">
          <Loader2 size={32} className="animate-spin text-brand" />
        </main>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 p-10">
          <p className="text-sm font-semibold text-danger">Session not found.</p>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-8 py-8 max-w-7xl">
        {/* Top Breadcrumb & Status Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
              <Link to="/sessions" className="hover:text-brand flex items-center gap-1">
                <ArrowLeft size={14} /> Sessions
              </Link>
              <ChevronRight size={12} />
              <span className="text-brand flex items-center gap-1 font-mono">
                <Mic size={14} /> {session.code}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <h1 className="text-2xl font-black tracking-tight text-ink">{session.project?.name}</h1>
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-bold text-brand uppercase tracking-wider">
                Audio Session
              </span>
            </div>
            <p className="mt-0.5 text-xs font-medium text-ink-faint">
              {session.location ? `${session.location} · ` : ''}
              Created {new Date(session.createdAt).toLocaleDateString()}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <StatusPill tone={isArchived ? 'success' : 'brand'}>
              {isArchived ? 'Archived & Stored' : session.status}
            </StatusPill>

            {!isArchived && (
              <button
                onClick={() => setShowFinalizeModal(true)}
                disabled={busy || recordings.length === 0}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition"
              >
                <CheckCircle2 size={16} /> End & Finalize Session
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-danger-soft p-4 text-xs font-semibold text-danger flex items-center justify-between">
            <span>{error.message}</span>
            <button onClick={() => setError(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        {/* Main Grid Layout: Left Column (Audio Recordings & Timeline), Right Column (Roster & Voice Reference) */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 Columns: Audio Manager & Timeline */}
          <div className="lg:col-span-2 space-y-6">
            {/* Audio Ingest & Recording Action Card */}
            {!isArchived && (
              <section className="rounded-2xl border border-border bg-surface p-6 shadow-xs">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base font-bold text-ink flex items-center gap-2">
                      <Radio size={18} className="text-rose-500" /> Audio Ingest & Live Capture
                    </h2>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      Record live through the studio microphone or upload multi-speaker audio recordings.
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    {isRecordingLive ? (
                      <button
                        onClick={stopLiveRecording}
                        className="flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-xs font-bold text-white animate-pulse shadow-md hover:bg-rose-700 transition"
                      >
                        <StopCircle size={16} /> Stop Recording ({liveDuration}s)
                      </button>
                    ) : (
                      <button
                        onClick={startLiveRecording}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-rose-600 disabled:opacity-60 transition"
                      >
                        <Mic size={16} /> Start Live Capture
                      </button>
                    )}

                    <button
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={busy || isRecordingLive}
                      className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-4 py-2 text-xs font-bold text-ink hover:bg-surface disabled:opacity-60 transition"
                    >
                      <UploadCloud size={16} /> Upload Audio File
                    </button>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        handleAudioUpload(e.target.files?.[0] || null)
                        e.target.value = ''
                      }}
                    />
                  </div>
                </div>

                {/* Recordings Selector Tabs */}
                {recordings.length > 0 && (
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-2">
                      Recordings in this session ({recordings.length})
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {recordings.map((rec, i) => {
                        const isSelected = rec.id === selectedRecordingId
                        return (
                          <button
                            key={rec.id}
                            onClick={() => setSelectedRecordingId(rec.id)}
                            className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition border ${
                              isSelected
                                ? 'bg-brand text-white border-brand shadow-sm'
                                : 'bg-canvas text-ink border-border hover:bg-surface'
                            }`}
                          >
                            <FileAudio size={14} />
                            <span>Recording #{i + 1}</span>
                            <span className="text-[10px] opacity-80">
                              ({rec.status === 'REDACTED' ? 'Redacted' : rec.status === 'ANALYZED' ? 'Analyzed' : 'Pending'})
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Active Recording Timeline & Verification Section */}
            {activeRecording ? (
              <div className="space-y-4">
                {/* Analyze Trigger Bar if not analyzed */}
                {(activeRecording.status === 'PENDING_ANALYSIS' || activeRecording.status === 'DEFERRED') && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={16} className="text-amber-600" />
                      <span>
                        This recording has not been analyzed yet. Run diarization and speaker verification to map consented speakers and PII.
                      </span>
                    </div>
                    <button
                      onClick={() => handleAnalyze(activeRecording.id)}
                      disabled={busy}
                      className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-amber-700 disabled:opacity-60 transition"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      Run Analysis Pipeline
                    </button>
                  </div>
                )}

                {/* Timeline Component */}
                <AudioTimeline
                  sessionId={sessionId}
                  recording={activeRecording}
                  participants={session.participants}
                  onChanged={loadData}
                  readOnly={isArchived}
                />
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-surface p-12 text-center">
                <Mic size={36} className="mx-auto text-ink-faint" />
                <h3 className="mt-3 text-sm font-bold text-ink">No Audio Recordings Yet</h3>
                <p className="mt-1 text-xs text-ink-muted">
                  Capture live audio or upload an audio file above to start the diarization and redaction workflow.
                </p>
              </div>
            )}
          </div>

          {/* Right Column: Roster & Voice References */}
          <div className="space-y-6">
            {/* Roster & Consent Verification */}
            <section className="rounded-2xl border border-border bg-surface p-5 shadow-xs">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-2">
                  <Users size={18} className="text-brand" />
                  <h3 className="text-sm font-bold text-ink">Session Roster ({session.participants?.length || 0})</h3>
                </div>
              </div>

              {/* QR Invite Block */}
              {!isArchived && (
                <div className="mt-4 rounded-xl border border-border bg-canvas p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-ink flex items-center gap-1.5">
                      <QrCode size={14} /> Direct QR Invite
                    </span>
                    {countdown && (
                      <span className="text-[10px] font-mono text-ink-faint">Expires in {countdown}</span>
                    )}
                  </div>

                  {invite ? (
                    <div className="mt-3 flex flex-col items-center gap-2">
                      <div className="rounded-lg bg-white p-2 shadow-xs">
                        <QRCodeSVG value={invite.url} size={110} />
                      </div>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(invite.url)
                          setCopied(true)
                          setTimeout(() => setCopied(false), 2000)
                        }}
                        className="flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
                      >
                        <Copy size={12} /> {copied ? 'Copied link!' : 'Copy invite URL'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={async () => {
                        const inv = await createInvite(sessionId)
                        setInvite(inv)
                      }}
                      className="mt-2 w-full rounded-lg bg-brand-soft py-1.5 text-xs font-semibold text-brand hover:bg-brand hover:text-white transition"
                    >
                      Generate QR Code
                    </button>
                  )}
                </div>
              )}

              {/* Search Project Subjects */}
              {!isArchived && (
                <div className="mt-4">
                  <div className="relative">
                    <Search size={14} className="absolute left-3 top-2.5 text-ink-faint" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Add participant by name…"
                      className={FIELD_CLASS}
                    />
                  </div>

                  {searchResults.length > 0 && (
                    <ul className="mt-2 max-h-40 overflow-y-auto divide-y divide-border rounded-lg border border-border bg-canvas">
                      {searchResults.map((s) => (
                        <li key={s.masterUserId} className="flex items-center justify-between p-2 text-xs">
                          <div>
                            <p className="font-semibold text-ink">{s.fullName}</p>
                            <p className="text-[10px] text-ink-faint">{s.email}</p>
                          </div>
                          <button
                            onClick={async () => {
                              await addParticipant(sessionId, s.masterUserId)
                              setSearchQuery('')
                              setSearchResults([])
                              await loadData()
                            }}
                            className="rounded bg-brand px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-dark"
                          >
                            Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* Participant List */}
              <div className="mt-4 divide-y divide-border">
                {session.participants?.length === 0 ? (
                  <p className="py-4 text-center text-xs text-ink-faint">No roster members enrolled yet.</p>
                ) : (
                  session.participants?.map((p) => (
                    <div key={p.id} className="flex items-center justify-between py-2.5 text-xs">
                      <div>
                        <p className="font-semibold text-ink">{p.fullName}</p>
                        <p className="text-[10px] text-ink-faint font-mono">{p.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={p.consentStatus === 'ACTIVE' ? 'success' : 'danger'}>
                          {p.consentStatus === 'ACTIVE' ? 'Consented' : p.consentStatus}
                        </StatusPill>
                        {!isArchived && (
                          <button
                            onClick={async () => {
                              await removeParticipant(sessionId, p.subjectId)
                              await loadData()
                            }}
                            className="text-ink-faint hover:text-danger"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/*
              Who this run was actually able to recognise. Without it "everyone
              was muted" is unreadable: it could mean nobody on the roster has
              enrolled a voice, or that their enrollments could not be loaded.
              Those look identical in the segment counts and call for opposite
              responses, so they are reported as separate lines and `broken` is
              styled as the fault it is.
            */}
            {gallery && (
              <section className="rounded-2xl border border-border bg-surface p-5 shadow-xs">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <Mic size={18} className="text-brand" />
                    <h3 className="text-sm font-bold text-ink">Voice Identification</h3>
                  </div>
                </div>

                <p className="mt-2 text-xs text-ink-faint">
                  Matched against {gallery.points} enrolled voice print
                  {gallery.points === 1 ? '' : 's'} from {gallery.enrolled} roster member
                  {gallery.enrolled === 1 ? '' : 's'}.
                </p>

                {gallery.notEnrolled > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-ink-faint">
                    <UserX size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
                    {gallery.notEnrolled} roster member
                    {gallery.notEnrolled === 1 ? ' has' : 's have'} no voice enrollment and{' '}
                    {gallery.notEnrolled === 1 ? 'was' : 'were'} muted as unidentified. Enrol them
                    to keep their consented speech.
                  </p>
                )}

                {gallery.broken > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-danger">
                    <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
                    {gallery.broken} roster member{gallery.broken === 1 ? ' has' : 's have'} an
                    enrolled voice that could not be loaded. They were muted, but this is a fault —
                    not a gap in the roster. Report it before relying on this result.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>

        {/* Finalize Session Confirmation Modal */}
        {showFinalizeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
            <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center gap-3 border-b border-border pb-4">
                <div className="rounded-full bg-emerald-100 p-2 text-emerald-700">
                  <CheckCircle2 size={24} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">End & Finalize Audio Session</h3>
                  <p className="text-xs text-ink-faint">Commit all verified audio derivatives and handoff dataset.</p>
                </div>
              </div>

              <div className="mt-4 space-y-3 text-xs text-ink-muted">
                <p>
                  Ending this session will transition its status to <strong className="text-ink">ARCHIVED</strong>.
                </p>
                <div className="rounded-xl bg-canvas p-4 space-y-2 border border-border">
                  <div className="flex justify-between">
                    <span>Total Audio Recordings:</span>
                    <strong className="text-ink">{recordings.length}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span>Consented Subjects Linked:</span>
                    <strong className="text-ink">{session.participants?.length || 0}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span>Redaction Status:</span>
                    <strong className="text-emerald-700">All Spans Muted & Verified</strong>
                  </div>
                </div>
                <p className="text-[11px] text-ink-faint">
                  Once finalized, the unredacted raw audio is archived and the permanent redacted derivatives will be linked for DSAR access and analytics.
                </p>
              </div>

              <div className="mt-6 flex justify-end gap-3 border-t border-border pt-4">
                <button
                  onClick={() => setShowFinalizeModal(false)}
                  disabled={finalizing}
                  className="rounded-lg bg-canvas px-4 py-2 text-xs font-semibold text-ink-muted hover:bg-border transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleFinalize}
                  disabled={finalizing}
                  className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition"
                >
                  {finalizing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Confirm & Finalize Session
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
