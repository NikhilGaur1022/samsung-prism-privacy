import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Camera,
  CircleSlash,
  Loader2,
  Search,
  ShieldOff,
  StopCircle,
  Trash2,
  UploadCloud,
  UserPlus,
  X,
} from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import {
  addParticipant,
  deletePhoto,
  endSession,
  getSession,
  mediaUrl,
  removeParticipant,
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

  const reload = useCallback(
    () => getSession(sessionId).then(setSession).catch(setError),
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
    if (session?.status === 'TAGGING') navigate(`/sessions/${sessionId}/tagging`)
  }, [session?.status, sessionId, navigate])

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
      await endSession(sessionId)
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
                disabled={busy || session.photos.length === 0}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <StopCircle size={16} strokeWidth={2} /> End session & detect faces
              </button>
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

        {session.status === 'PROCESSING' && (
          <div className="mt-5 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning">
            <Loader2 size={16} className="animate-spin" />
            Running face detection on {session.job?.photosTotal ?? session.photos.length} photos (
            {session.job?.photosDone ?? 0} done). You'll be taken to tagging automatically.
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">Roster</h2>
            <p className="mt-0.5 text-xs font-medium text-ink-faint">
              Only people who consented to this project in their own portal can be added.
            </p>

            <ul className="mt-4 divide-y divide-border">
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

            {capturing && (
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
                    <img
                      src={mediaUrl.photo(sessionId, photo.id)}
                      alt=""
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
        </div>
      </main>
    </div>
  )
}
