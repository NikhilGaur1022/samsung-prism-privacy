import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import {
  Camera,
  CircleSlash,
  Copy,
  Loader2,
  RefreshCw,
  Search,
  ShieldOff,
  StopCircle,
  Trash2,
  UploadCloud,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import SessionVideoPanel from '../../components/SessionVideoPanel'
import StatusPill from '../../components/StatusPill'
import {
  addParticipant,
  createInvite,
  deletePhoto,
  endSession,
  getInvite,
  getSessionFresh,
  mediaUrl,
  removeParticipant,
  revokeInvite,
  searchProjectSubjects,
  uploadPhotos,
} from '../../lib/api'

const VERDICT_LABEL = {
  ELIGIBLE: 'Consent given',
  NO_CONSENT: 'Consent not given',
  REVOKED: 'Consent revoked',
  SUBJECT_INACTIVE: 'Subject not active',
}

const FIELD_CLASS =
  'w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

// The camera only ever runs while the agent is actively capturing — the stream is
// torn down on stop and on unmount so the device light doesn't stay on.
function useCamera() {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [on, setOn] = useState(false)
  const [error, setError] = useState(null)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setOn(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setOn(true)
    } catch (err) {
      setError(err.message ?? 'Could not open the camera')
    }
  }, [])

  useEffect(() => stop, [stop])

  const capture = useCallback(async () => {
    const video = videoRef.current
    if (!video) return null

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    return new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })
  }, [])

  return { videoRef, on, error, start, stop, capture }
}

function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (!expiresAt) return null
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return { seconds, text: h > 0 ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s` }
}

// The subject scans this, reads the consent text, and taps agree — the scan alone
// is not consent, which is why the QR points at a screen and not at an accept
// endpoint. Accepting creates the roster row, so the agent adds nobody by hand.
function JoinPanel({ sessionId, active }) {
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getInvite(sessionId)
      .then((res) => setInvite(res.invite))
      .catch(setError)
  }, [sessionId])

  const countdown = useCountdown(invite?.expiresAt)
  const expired = countdown?.seconds === 0

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      setInvite(await fn())
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    await navigator.clipboard.writeText(invite.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (!active) {
    return (
      <p className="mt-4 text-xs font-medium text-ink-faint">
        People can only join while the session is active.
      </p>
    )
  }

  return (
    <div className="mt-4">
      {error && <p className="mb-3 text-sm font-semibold text-danger">{error.message}</p>}

      {!invite || expired ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-semibold text-ink">
            {expired ? 'This code has expired.' : 'No join code yet.'}
          </p>
          <p className="mt-1 text-xs font-medium text-ink-faint">
            Generate one and show it to people as they arrive.
          </p>
          <button
            onClick={() => run(() => createInvite(sessionId))}
            disabled={busy}
            className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy ? 'Generating…' : 'Generate join code'}
          </button>
        </div>
      ) : (
        <>
          <div className="flex justify-center rounded-lg bg-white p-5">
            <QRCodeSVG value={invite.url} size={220} level="M" />
          </div>

          {/* Printed under the QR because a cracked camera or a locked-down phone
              is common enough that "just scan it" is not a complete answer. */}
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-canvas px-3 py-2 text-xs font-semibold text-ink-muted">
              {invite.url}
            </code>
            <button
              onClick={copy}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-canvas px-3 py-2 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Copy size={13} strokeWidth={2} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-ink-faint">Expires in {countdown?.text}</p>
            <div className="flex gap-2">
              <button
                onClick={() => run(() => createInvite(sessionId))}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <RefreshCw size={13} strokeWidth={2} /> Rotate
              </button>
              <button
                onClick={() => run(async () => (await revokeInvite(sessionId), null))}
                disabled={busy}
                className="rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                Revoke
              </button>
            </div>
          </div>

          <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-[11px] font-medium leading-relaxed text-ink-faint">
            A phone cannot reach <code>localhost</code> — the link must use this machine&apos;s LAN
            IP or a tunnel. On-device selfie capture additionally needs HTTPS, so a tunnel
            (ngrok/cloudflared) is the realistic setup.
          </p>
        </>
      )}
    </div>
  )
}

export default function SessionDetail() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const camera = useCamera()

  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notEnrolled, setNotEnrolled] = useState([])
  const [rosterTab, setRosterTab] = useState('qr')

  // Fresh, not cached: reload runs right after a mutation (add/remove participant,
  // upload, end) and the 60s GET cache would otherwise echo the pre-mutation
  // roster — a removed person would reappear until the cache aged out.
  const reload = useCallback(
    () => getSessionFresh(sessionId).then(setSession).catch(setError),
    [sessionId],
  )

  useEffect(() => {
    reload()
  }, [reload])

  // A PROCESSING session is waiting on the face worker — poll until it flips to
  // TAGGING (or FAILED) rather than making the agent refresh the page.
  useEffect(() => {
    if (session?.status !== 'PROCESSING') return
    const timer = setInterval(reload, 3000)
    return () => clearInterval(timer)
  }, [session?.status, reload])

  useEffect(() => {
    if (session?.type === 'AUDIO') {
      navigate(`/sessions/${sessionId}/audio`, { replace: true })
    } else if (session?.type === 'TEXT') {
      navigate(`/sessions/${sessionId}/text`, { replace: true })
    } else if (session?.status === 'TAGGING') {
      navigate(`/sessions/${sessionId}/tagging`)
    }
  }, [session?.type, session?.status, sessionId, navigate])

  // People join by scanning, with nothing to tell the agent it happened. Poll the
  // roster while the QR is on screen — through getSessionFresh, because the 60s
  // GET cache would otherwise hide every joiner for a minute at a time.
  useEffect(() => {
    if (session?.status !== 'ACTIVE' || rosterTab !== 'qr') return
    const timer = setInterval(() => {
      getSessionFresh(sessionId).then(setSession).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [session?.status, rosterTab, sessionId])

  useEffect(() => {
    if (!session) return
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await searchProjectSubjects(session.project.id, query.trim())
        setResults(res.items)
      } catch (err) {
        setError(err)
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [query, session?.project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleFiles = (files) => {
    if (!files?.length) return
    run(() => uploadPhotos(sessionId, Array.from(files), 'IPHONE_UPLOAD'))
  }

  const handleCapture = async () => {
    const file = await camera.capture()
    if (file) await run(() => uploadPhotos(sessionId, [file], 'IPHONE_LIVE'))
  }

  const handleEnd = () =>
    run(async () => {
      camera.stop()
      // The gallery build reports who has no enrolled photo — surface it now, while
      // the agent is still in the room and could take one.
      const result = await endSession(sessionId)
      setNotEnrolled(result.notEnrolled ?? [])
    })

  if (!session) {
    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 px-10 py-8">
          {error ? (
            <p className="text-sm font-semibold text-danger">{error.message}</p>
          ) : (
            <Loader2 size={20} className="animate-spin text-ink-faint" />
          )}
        </main>
      </div>
    )
  }

  const rosterIds = new Set(session.participants.map((p) => p.subjectId))
  const capturing = session.status === 'ACTIVE'
  // A VIDEO session collects clips and nothing else, so the stills panel is not
  // just empty on it — it is an invitation to capture something the session is
  // not for. IMAGE sessions keep both panels: they may legitimately hold clips
  // alongside photos, and every session created before the VIDEO type existed
  // holds its clips under IMAGE.
  const videoOnly = session.type === 'VIDEO'
  // What "there is something to process" means. Gating this on photos alone made
  // a video-only session impossible to end from the UI: the button stayed
  // disabled forever, so the recognition pass was never enqueued and every clip
  // sat at PENDING_ANALYSIS looking like a dead pipeline. The backend has always
  // accepted either (endSession counts photos AND videos); only this button
  // disagreed.
  const hasCaptures = session.photos.length > 0 || (session.videoCount ?? 0) > 0

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title={`${session.code} — ${session.project.name}`}
          subtitle={session.location ? `Location: ${session.location}` : 'No location recorded'}
          action={
            capturing ? (
              <button
                onClick={handleEnd}
                disabled={busy || !hasCaptures}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <StopCircle size={16} strokeWidth={2} />{' '}
                {videoOnly ? 'End session & analyse clips' : 'End session & detect faces'}
              </button>
            ) : session.status === 'ARCHIVED' ? (
              <Link
                to={`/sessions/${sessionId}/people`}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <Users size={16} strokeWidth={2} /> View people
              </Link>
            ) : (
              <StatusPill tone="warning">Detecting faces…</StatusPill>
            )
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {notEnrolled.length > 0 && (
          <div className="mt-5 rounded-lg bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning">
            {notEnrolled.length} {notEnrolled.length === 1 ? 'person has' : 'people have'} no
            enrolled photo and will need manual tagging:{' '}
            {notEnrolled.map((n) => n.fullName).join(', ')}
          </div>
        )}

        {session.status === 'PROCESSING' && (
          <div className="mt-5 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning">
            <Loader2 size={16} className="animate-spin" />
            {videoOnly ? (
              <>
                Analysing {session.videoCount ?? 0} clip
                {(session.videoCount ?? 0) === 1 ? '' : 's'} — face tracking runs frame by
                frame, so this takes a few minutes per clip on this machine.
              </>
            ) : (
              <>
                Running face detection on {session.job?.photosTotal ?? session.photos.length}{' '}
                photos ({session.job?.photosDone ?? 0} done). You'll be taken to tagging
                automatically.
              </>
            )}
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">Roster</h2>
            <p className="mt-0.5 text-xs font-medium text-ink-faint">
              Only people who have consented to this project can be added — by scanning, or by hand.
            </p>

            {capturing && (
              <div className="mt-4 flex gap-2">
                {[
                  ['qr', 'Scan to join'],
                  ['manual', 'Add manually'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setRosterTab(key)}
                    className={`rounded-pill px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                      rosterTab === key ? 'bg-brand text-white' : 'bg-canvas text-ink-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {capturing && rosterTab === 'qr' && (
              <JoinPanel sessionId={sessionId} active={session.status === 'ACTIVE'} />
            )}

            <p className="mt-5 text-xs font-bold uppercase tracking-wide text-ink-faint">
              {session.participants.length} on the roster
            </p>

            <ul className="mt-2 divide-y divide-border">
              {session.participants.map((p) => (
                <li key={p.subjectId} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.fullName}</p>
                    <p className="truncate text-xs font-medium text-ink-faint">{p.email}</p>
                  </div>
                  {capturing && (
                    <button
                      onClick={() => run(() => removeParticipant(sessionId, p.subjectId))}
                      disabled={busy}
                      className="rounded-md p-1.5 text-ink-faint hover:bg-canvas hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                      aria-label={`Remove ${p.fullName}`}
                    >
                      <X size={15} strokeWidth={2} />
                    </button>
                  )}
                </li>
              ))}
              {session.participants.length === 0 && (
                <li className="py-3 text-xs font-medium text-ink-faint">Nobody added yet.</li>
              )}
            </ul>

            {capturing && rosterTab === 'manual' && (
              <div className="mt-5 border-t border-border pt-5">
                <div className="relative">
                  <Search
                    size={15}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                  />
                  <input
                    className={FIELD_CLASS}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search people by name, email or employee ID"
                  />
                </div>

                <ul className="mt-3 max-h-72 divide-y divide-border overflow-y-auto">
                  {searching && <li className="py-3 text-xs font-medium text-ink-faint">Searching…</li>}
                  {!searching &&
                    results
                      .filter((r) => !rosterIds.has(r.masterUserId))
                      .map((r) => {
                        const eligible = r.verdict === 'ELIGIBLE'
                        return (
                          <li
                            key={r.masterUserId}
                            className={`flex items-center justify-between gap-3 py-3 ${
                              eligible ? '' : 'opacity-60'
                            }`}
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-ink">{r.fullName}</p>
                              <p className="truncate text-xs font-medium text-ink-faint">{r.email}</p>
                            </div>
                            {eligible ? (
                              <button
                                onClick={() => run(() => addParticipant(sessionId, r.masterUserId))}
                                disabled={busy}
                                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                              >
                                <UserPlus size={14} strokeWidth={2} /> Add
                              </button>
                            ) : (
                              <span className="flex shrink-0 items-center gap-1.5 rounded-pill bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger">
                                <ShieldOff size={13} strokeWidth={2} />
                                {VERDICT_LABEL[r.verdict]}
                              </span>
                            )}
                          </li>
                        )
                      })}
                </ul>
              </div>
            )}
          </section>

          {!videoOnly && (
          <section className="rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">Capture</h2>
            <p className="mt-0.5 text-xs font-medium text-ink-faint">
              Shoot from the device camera, or upload photos you took earlier.
            </p>

            {capturing && (
              <>
                <div className="mt-4 overflow-hidden rounded-lg bg-sidebar">
                  <video
                    ref={camera.videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`aspect-video w-full object-cover ${camera.on ? '' : 'hidden'}`}
                  />
                  {!camera.on && (
                    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 text-sidebar-muted">
                      <CircleSlash size={22} strokeWidth={1.5} />
                      <p className="text-xs font-semibold">Camera is off</p>
                    </div>
                  )}
                </div>

                {camera.error && (
                  <p className="mt-2 text-xs font-semibold text-danger">{camera.error}</p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  {camera.on ? (
                    <>
                      <button
                        onClick={handleCapture}
                        disabled={busy}
                        className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                      >
                        <Camera size={16} strokeWidth={2} /> Take photo
                      </button>
                      <button
                        onClick={camera.stop}
                        className="rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        Stop camera
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={camera.start}
                      className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                    >
                      <Camera size={16} strokeWidth={2} /> Start camera
                    </button>
                  )}

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-lg bg-brand-soft px-4 py-2.5 text-sm font-semibold text-brand disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <UploadCloud size={16} strokeWidth={2} /> Upload photos
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      handleFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </div>
              </>
            )}

            <div className="mt-5 border-t border-border pt-5">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">
                {session.photos.length} photo{session.photos.length === 1 ? '' : 's'} in this session
              </p>

              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {session.photos.map((photo) => (
                  <div key={photo.id} className="group relative overflow-hidden rounded-lg bg-canvas">
                    {/* The agent's basis for the raw original expires at ARCHIVE, so
                        /file 403s from then on and this grid rendered as a wall of
                        broken thumbnails — which read as "my photos are gone". The
                        redacted derivative is what the role is still entitled to. */}
                    <img
                      src={
                        session.status === 'ARCHIVED'
                          ? mediaUrl.redactedThumb(sessionId, photo.id)
                          : mediaUrl.photoThumb(sessionId, photo.id)
                      }
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width="480"
                      height="480"
                      className="aspect-square w-full object-cover"
                    />
                    {capturing && (
                      <button
                        onClick={() => run(() => deletePhoto(sessionId, photo.id))}
                        disabled={busy}
                        className="absolute right-1 top-1 hidden rounded-md bg-surface/90 p-1 text-danger group-hover:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                        aria-label="Delete photo"
                      >
                        <Trash2 size={14} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
          )}

          <SessionVideoPanel
            sessionId={sessionId}
            canCapture={capturing}
            sessionStatus={session.status}
          />
        </div>
      </main>
    </div>
  )
}
