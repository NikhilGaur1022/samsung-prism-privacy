import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, Video } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import EmptyState from '../../components/EmptyState'
import { finalizeSession, getPhotosForReview, listVideos, mediaUrl } from '../../lib/api'

const TAG_STYLES = {
  TAGGED: { border: '#22c55e', bg: 'rgba(34,197,94,0.85)', label: (n) => n },
  UNKNOWN: { border: '#f59e0b', bg: 'rgba(245,158,11,0.85)', label: () => 'Unknown' },
  SKIPPED: { border: '#94a3b8', bg: 'rgba(148,163,184,0.85)', label: () => 'Skipped' },
  NOT_A_FACE: { border: '#ef4444', bg: 'rgba(239,68,68,0.85)', label: () => 'Not a face' },
  PENDING: { border: '#a78bfa', bg: 'rgba(167,139,250,0.85)', label: () => 'Pending' },
}

// A pending face that the model had a guess about reads differently from one it
// had nothing for — amber vs. the plain pending violet.
const SUGGESTED_STYLE = {
  border: '#f59e0b',
  bg: 'rgba(245,158,11,0.85)',
  label: () => 'Suggested',
}

const FILTERS = {
  ALL: { label: 'All', match: () => true },
  AUTO: { label: 'Auto-tagged', match: (f) => f.tagStatus === 'TAGGED' && f.autoTagged },
  MANUAL: { label: 'Manually tagged', match: (f) => f.tagStatus === 'TAGGED' && !f.autoTagged },
  UNTAGGED: { label: 'Untagged faces', match: (f) => f.tagStatus !== 'TAGGED' },
}

function styleFor(face) {
  if (face.tagStatus === 'PENDING' && face.suggested) return SUGGESTED_STYLE
  return TAG_STYLES[face.tagStatus] ?? TAG_STYLES.PENDING
}

function FaceOverlay({ face, naturalWidth, naturalHeight }) {
  const [x1, y1, x2, y2] = face.bbox
  const style = styleFor(face)

  const left = (x1 / naturalWidth) * 100
  const top = (y1 / naturalHeight) * 100
  const width = ((x2 - x1) / naturalWidth) * 100
  const height = ((y2 - y1) / naturalHeight) * 100

  const borderStyle = face.tagStatus === 'NOT_A_FACE' ? 'dashed' : 'solid'

  return (
    <div
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        border: `2px ${borderStyle} ${style.border}`,
        borderRadius: '4px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '-22px',
          left: '-1px',
          background: style.bg,
          color: '#fff',
          fontSize: '11px',
          fontWeight: 600,
          padding: '1px 6px',
          borderRadius: '3px 3px 0 0',
          whiteSpace: 'nowrap',
          lineHeight: '18px',
        }}
      >
        {style.label(face.taggedSubjectName)}
        {face.matchScore != null && ` · ${face.matchScore.toFixed(2)}`}
      </span>
    </div>
  )
}

function PhotoCard({ sessionId, photo, index, faces }) {
  // We need the natural dimensions to compute percentage-based overlay positions.
  // The DB stores width/height from the original upload; fall back to onLoad if null.
  const [dims, setDims] = useState(
    photo.width && photo.height ? { w: photo.width, h: photo.height } : null,
  )

  const handleLoad = (e) => {
    if (!dims) {
      setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight })
    }
  }

  return (
    <div
      style={{ position: 'relative', display: 'inline-block', width: '100%' }}
      className="rounded-lg overflow-hidden bg-canvas"
    >
      <img
        src={mediaUrl.photoThumb(sessionId, photo.id)}
        decoding="async" 
        alt=""
        onLoad={handleLoad}
        loading={index < 2 ? 'eager' : 'lazy'}
        className="w-full block"
        style={{ display: 'block' }}
      />
      {dims &&
        faces.map((face) => (
          <FaceOverlay
            key={face.id}
            face={face}
            naturalWidth={dims.w}
            naturalHeight={dims.h}
          />
        ))}
    </div>
  )
}

// Preload images in the background so scrolling down is instant.
function useImagePreloader(sessionId, photos) {
  useEffect(() => {
    if (!photos?.length) return
    // Start after a short delay to not compete with the initial render
    const timer = setTimeout(() => {
      for (const photo of photos) {
        const img = new Image()
        img.src = mediaUrl.photo(sessionId, photo.id)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [sessionId, photos])
}

export default function ReviewPhotos() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState('ALL')
  // null until the clip list has been read. Distinguished from [] so "no clips"
  // and "not yet known" do not render the same, which is how a notice about
  // unfinished work ends up silently absent.
  const [videos, setVideos] = useState(null)

  const reload = useCallback(
    () => getPhotosForReview(sessionId).then(setData).catch(setError),
    [sessionId],
  )

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    // A 503 means video capture is off in this environment. That is not an
    // error the agent can act on, so it resolves to "no clips" rather than
    // failing the whole review screen over a feature that is switched off.
    listVideos(sessionId)
      .then((d) => setVideos(d.videos ?? []))
      .catch(() => setVideos([]))
  }, [sessionId])

  // Preload all photo images in the background after initial data arrives
  useImagePreloader(sessionId, data?.photos)

  const handleFinalize = async () => {
    setBusy(true)
    setError(null)
    try {
      await finalizeSession(sessionId)
      // Where finalising lands you depends on what the session actually holds.
      //
      // Photos are redacted synchronously and their blurred copies live on the
      // People screen, so the sessions list is a fine place to end up. Clips are
      // not: redaction is queued and finishes minutes later, and the only player
      // for a blurred clip is on the session page. Dropping a video session at
      // /sessions therefore ends the flow one screen short of the actual output
      // — the operator finalises, gets bounced to a list, and never sees that a
      // blurred video was produced at all.
      navigate(videos.length > 0 ? `/sessions/${sessionId}` : '/sessions')
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  if (!data) {
    // An ARCHIVED session is not an error, it is a finished one. This screen is
    // the pre-finalize review, so the server correctly refuses it — but the page
    // rendered that refusal as one line of red text on an otherwise empty page,
    // with no way onward. And the Tagging screen links here unconditionally, so
    // that dead end is exactly where an agent lands after finalising: the last
    // step of the happy path ends at what looks like a crash.
    const archived = /ARCHIVED/i.test(error?.message ?? '')

    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 px-10 py-8">
          {!error ? (
            <Loader2 size={20} className="animate-spin text-ink-faint" />
          ) : archived ? (
            <div className="max-w-lg rounded-card bg-surface p-6 shadow-card">
              <h1 className="flex items-center gap-2 text-lg font-extrabold text-ink">
                <CheckCircle2 size={18} className="text-success" />
                This session is finished
              </h1>
              <p className="mt-2 text-sm font-medium leading-relaxed text-ink-muted">
                It has been finalised and archived, so there is nothing left to review here —
                redaction has already run and the redacted set has been handed on for oversight.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  to="/sessions"
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white hover:bg-brand-dark"
                >
                  Back to sessions
                </Link>
                <Link
                  to={`/sessions/${sessionId}/people`}
                  className="rounded-lg border border-border bg-canvas px-4 py-2 text-sm font-semibold text-ink hover:bg-surface"
                >
                  Who was in it
                </Link>
              </div>
            </div>
          ) : (
            <div className="max-w-lg rounded-card bg-surface p-6 shadow-card">
              <p className="text-sm font-semibold text-danger">{error.message}</p>
              <Link
                to="/sessions"
                className="mt-4 inline-block rounded-lg border border-border bg-canvas px-4 py-2 text-sm font-semibold text-ink hover:bg-surface"
              >
                Back to sessions
              </Link>
            </div>
          )}
        </main>
      </div>
    )
  }

  const totalFaces = data.photos.reduce((sum, p) => sum + p.faces.length, 0)
  const taggedFaces = data.photos.reduce(
    (sum, p) => sum + p.faces.filter((f) => f.tagStatus === 'TAGGED').length,
    0,
  )
  const uniquePeople = new Set(
    data.photos.flatMap((p) =>
      p.faces.filter((f) => f.taggedSubjectName).map((f) => f.taggedSubjectName),
    ),
  ).size

  // Mirrors redactBystanders() on the server: UNKNOWN and PENDING faces get
  // blurred. Finalize is irreversible, so the count is stated before the button,
  // not discovered afterwards in the output folder.
  const blurredFaces = data.photos.reduce(
    (sum, p) => sum + p.faces.filter((f) => f.tagStatus === 'UNKNOWN' || f.tagStatus === 'PENDING').length,
    0,
  )
  const blurredPhotos = data.photos.filter((p) =>
    p.faces.some((f) => f.tagStatus === 'UNKNOWN' || f.tagStatus === 'PENDING'),
  ).length

  // Clips are part of what finalize commits, and they are the thing most likely
  // to hold the session open afterwards: blurring a clip is slower than
  // blurring a still, and a clip whose analysis failed will not be blurred at
  // all. Saying so here means the agent knows before they press the button,
  // rather than discovering it as a session that never leaves REDACTING.
  // The header counted stills only, so a clip-only session opened on "0 photos ·
  // 0 faces detected · 0 tagged across 0 people" directly above a clip with a
  // detected, named track in it. The numbers were true and the sentence was a
  // lie: it reads as "nothing was found", which is the one thing the agent must
  // not believe right before pressing an irreversible Finalize.
  const clipCount = videos?.length ?? 0
  const trackCount = (videos ?? []).reduce((sum, v) => sum + (v._count?.tracks ?? 0), 0)
  const hasStills = data.photos.length > 0
  const reviewTitle =
    clipCount > 0 && !hasStills
      ? 'Review tagged clips'
      : clipCount > 0
        ? 'Review tagged capture'
        : 'Review tagged photos'
  const stillsSummary = `${data.photos.length} photo${data.photos.length === 1 ? '' : 's'} · ${totalFaces} face${totalFaces === 1 ? '' : 's'} detected · ${taggedFaces} tagged across ${uniquePeople} ${uniquePeople === 1 ? 'person' : 'people'}`
  const clipsSummary = `${clipCount} clip${clipCount === 1 ? '' : 's'} · ${trackCount} face track${trackCount === 1 ? '' : 's'}`
  const reviewSummary =
    clipCount > 0 && !hasStills
      ? clipsSummary
      : clipCount > 0
        ? `${stillsSummary} · ${clipsSummary}`
        : stillsSummary

  const videoNotice = (() => {
    if (videos === null) return null
    if (videos.length === 0) return null
    const failed = videos.filter((v) => v.status === 'DEFERRED').length
    if (failed > 0) {
      return `${failed} clip${failed === 1 ? '' : 's'} could not be analysed. ${failed === 1 ? 'It' : 'They'} will not be blurred and the session will stay open until the video worker succeeds.`
    }
    return `${videos.length} clip${videos.length === 1 ? '' : 's'} will be blurred after finalizing — everyone not tagged to a person on the roster. The session archives once that finishes.`
  })()

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title={reviewTitle}
          subtitle={reviewSummary}
          action={
            <div className="flex items-center gap-3">
              <Link
                to={`/sessions/${sessionId}/tagging`}
                className="flex items-center gap-2 rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <ArrowLeft size={16} strokeWidth={2} />
                Back to tagging
              </Link>
              <button
                onClick={handleFinalize}
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <CheckCircle2 size={16} strokeWidth={2} />
                {busy ? 'Finalizing…' : 'Confirm & finalize'}
              </button>
            </div>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {blurredFaces > 0 && (
          <div className="mt-5 flex items-start gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning">
            <EyeOff size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
            <span>
              Finalizing will blur {blurredFaces} face{blurredFaces === 1 ? '' : 's'} across{' '}
              {blurredPhotos} photo{blurredPhotos === 1 ? '' : 's'} — everyone not tagged to a
              person on the roster. This cannot be undone.
            </span>
          </div>
        )}

        {videoNotice && (
          <div className="mt-5 flex items-start gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-sm font-semibold text-warning">
            <Video size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
            <span>{videoNotice}</span>
          </div>
        )}

        {/* Legend */}
        <div className="mt-5 flex flex-wrap items-center gap-4 rounded-lg bg-surface px-4 py-3 shadow-card">
          <span className="text-xs font-bold uppercase tracking-wide text-ink-faint">Legend:</span>
          {Object.entries(TAG_STYLES).filter(([k]) => k !== 'PENDING').map(([key, s]) => (
            <span key={key} className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
              <span
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  border: `2px ${key === 'NOT_A_FACE' ? 'dashed' : 'solid'} ${s.border}`,
                }}
              />
              {s.label(key === 'TAGGED' ? 'Person name' : null)}
            </span>
          ))}
        </div>

        {/* Filters narrow which boxes are drawn, not which photos are shown — the
            agent is checking overlays, so hiding photos would hide the context. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {Object.entries(FILTERS).map(([key, f]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-pill px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                filter === key ? 'bg-brand text-white' : 'bg-surface text-ink-muted shadow-card'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Clips, shown BEFORE the stills.
            This screen is the last look before finalize blurs everything, and it
            used to describe the clips in a sentence and show none of them: a
            video-only session landed on "No photos — this session has no photos
            to review", which reads as the upload having been lost.

            What is offered is the DETECTION OVERLAY, not the original — the same
            derivative the capture panel shows, with every detected face boxed and
            labelled. That is the thing worth checking here: whether a track
            follows one person, because a merged track tagged to a consenting
            subject leaves both of them unblurred in the release. Once a blurred
            copy exists it is shown alongside, so the agent can see the result of
            the decision they just made. */}
        {videos && videos.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-bold text-ink">
              {videos.length} clip{videos.length === 1 ? '' : 's'} in this session
            </h2>
            <div className="mt-3 grid gap-6 lg:grid-cols-2">
              {videos.map((video) => (
                <div key={video.id} className="rounded-card bg-surface p-3 shadow-card">
                  {video.hasDetected ? (
                    <>
                      <video
                        controls
                        preload="metadata"
                        className="w-full rounded-lg bg-canvas"
                        src={mediaUrl.detectedVideo(sessionId, video.id)}
                      />
                      <p className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-warning">
                        <Eye size={13} strokeWidth={2.5} className="mt-0.5 shrink-0" />
                        <span>
                          Detected faces, <strong>not blurred</strong>. Check each box follows one
                          person before finalizing.
                        </span>
                      </p>
                    </>
                  ) : video.status === 'DEFERRED' ? (
                    <p className="p-4 text-xs font-semibold text-danger">
                      This clip could not be analysed, so nothing in it will be blurred and the
                      session stays open until the video worker succeeds.
                    </p>
                  ) : (
                    <p className="p-4 text-xs font-medium text-ink-faint">
                      Still being analysed — the preview appears here when it finishes.
                    </p>
                  )}

                  {video.hasRedacted && (
                    <>
                      <video
                        controls
                        preload="metadata"
                        className="mt-3 w-full rounded-lg bg-canvas"
                        src={mediaUrl.redactedVideo(sessionId, video.id)}
                      />
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-success">
                        <EyeOff size={13} strokeWidth={2.5} />
                        Blurred copy — this is what leaves the session.
                      </p>
                    </>
                  )}

                  <p className="mt-2 text-center text-xs font-semibold text-ink-faint">
                    {video.durationSec ? `${video.durationSec.toFixed(1)}s` : 'Clip'}
                    {video.width && video.height ? ` · ${video.width}×${video.height}` : ''}
                    {typeof video._count?.tracks === 'number'
                      ? ` · ${video._count.tracks} track${video._count.tracks === 1 ? '' : 's'}`
                      : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.photos.length === 0 ? (
          // Only an empty state when the session really is empty. A video session
          // has its clips rendered above and does not need to be told it has no
          // photos.
          videos && videos.length > 0 ? null : (
            <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
              <EmptyState
                icon={Eye}
                title="Nothing to review"
                message="This session has no photos or clips."
              />
            </div>
          )
        ) : (
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            {data.photos.map((photo, index) => {
              const visible = photo.faces.filter(FILTERS[filter].match)
              return (
                <div key={photo.id} className="rounded-card bg-surface p-3 shadow-card">
                  <PhotoCard
                    sessionId={sessionId}
                    photo={photo}
                    index={index}
                    faces={visible}
                  />
                  <p className="mt-2 text-center text-xs font-semibold text-ink-faint">
                    {filter === 'ALL'
                      ? `${photo.faces.length} face${photo.faces.length === 1 ? '' : 's'} detected`
                      : `${visible.length} of ${photo.faces.length} face${photo.faces.length === 1 ? '' : 's'} shown`}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
