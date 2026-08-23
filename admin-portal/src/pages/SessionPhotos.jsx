import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, FileText, ImageOff, Loader2, Mic, ShieldCheck, Video } from 'lucide-react'
import Sidebar from '../components/Sidebar'
import PageHeader from '../components/PageHeader'
import StatusPill from '../components/StatusPill'
import { listSessionPhotos, mediaUrl } from '../lib/api'

// What this session holds besides frames. Keyed off the counts rather than off
// the session type on purpose: there is no VIDEO member of SessionType, so a
// clip-only session is an IMAGE session with no photos in it, and keying off
// the type would report that one as empty.
const OTHER_HOLDINGS = [
  {
    key: 'videos',
    icon: Video,
    noun: 'clip',
    detail:
      'Per-track face recognition and the redacted derivative live on the capture workspace for this session.',
  },
  {
    key: 'recordings',
    icon: Mic,
    noun: 'recording',
    detail:
      'Diarisation, transcription, speaker identification and the muted PII segments live on the capture workspace for this session.',
  },
  {
    key: 'documents',
    icon: FileText,
    noun: 'document',
    detail:
      'Detected entities, the tagged spans and the redacted output live on the capture workspace for this session.',
  },
]

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`

const SESSION_STATUS_TONE = {
  ACTIVE: 'brand',
  PROCESSING: 'warning',
  TAGGING: 'warning',
  ARCHIVED: 'success',
  FAILED: 'danger',
}

// The redacted set for one session, for the roles that are accountable for the
// output but do not do the collecting (dataOwner on its own projects, dataAdmin).
//
// Only redacted derivatives are ever requested here. There is no toggle to the
// original: matrix §B gives that to the collecting agent pre-archive and to a
// break-glass DSAR operator, and neither basis is "an admin opened a page".
export default function SessionPhotos() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setError(null)
    listSessionPhotos(sessionId).then(setData).catch(setError)
  }, [sessionId])

  useEffect(() => {
    load()
  }, [load])

  const items = data?.items ?? []
  const pending = items.filter((p) => p.redactionPending)
  const viewable = items.filter((p) => !p.redactionPending)
  // Only IMAGE sessions have a frame grid. For the others this page used to say
  // "no frames in this session", which reads as "we collected nothing" about a
  // session that was captured and processed end to end.
  // Everything this session holds that is not a frame. When there are no frames
  // but this is non-empty, saying "no frames in this session" would describe a
  // fully captured and processed session as if nothing had been collected.
  const counts = data?.session?.counts ?? {}
  const otherHoldings = OTHER_HOLDINGS.filter((h) => (counts[h.key] ?? 0) > 0)
  const framelessButHeld = items.length === 0 && otherHoldings.length > 0

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <button
          onClick={() => navigate(-1)}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <ArrowLeft size={14} strokeWidth={2} /> Back
        </button>

        <PageHeader
          title={data ? `Session ${data.session.code}` : 'Session photos'}
          subtitle={
            framelessButHeld
              ? 'This session collected media this view does not render. Redacted derivatives only — nothing here reaches an unmasked original.'
              : 'Redacted derivatives only. Faces nobody claimed and any sensitive text detected in the frame are masked server-side before the image leaves the API.'
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.status === 403
              ? 'You are not authorized to view this session — it belongs to a project you do not own.'
              : error.message}
          </div>
        )}

        {!data && !error && (
          <div className="mt-6 flex items-center gap-2 text-sm font-medium text-ink-faint">
            <Loader2 size={16} className="animate-spin" /> Loading frames…
          </div>
        )}

        {data && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <StatusPill tone={SESSION_STATUS_TONE[data.session.status]}>
                {data.session.status}
              </StatusPill>
              {items.length > 0 && (
                <StatusPill tone="neutral">{plural(items.length, 'frame')}</StatusPill>
              )}
              {otherHoldings.map((h) => (
                <StatusPill key={h.key} tone="neutral">
                  {plural(counts[h.key], h.noun)}
                </StatusPill>
              ))}
              {data.session.location && (
                <StatusPill tone="neutral">{data.session.location}</StatusPill>
              )}
            </div>

            <div
              className={`mt-4 flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-xs font-medium leading-relaxed text-ink-muted shadow-card ${items.length === 0 ? 'hidden' : ''}`}
            >
              <ShieldCheck size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
              <p>
                Every frame below was fetched as a redacted copy and each fetch is written to the
                access log against your account. The unmasked original is not reachable from this
                screen.
              </p>
            </div>

            {/* Called out rather than rendered as broken tiles. A DEFERRED frame is
                one the PII worker never confirmed, and it also blocks the handoff —
                so "why is this missing" needs an answer on the page itself. */}
            {pending.length > 0 && (
              <div className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-xs font-semibold text-danger">
                <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" />
                <p>
                  {pending.length} frame{pending.length === 1 ? '' : 's'} cannot be shown: redaction
                  has not confirmed on {pending.length === 1 ? 'it' : 'them'} yet, so no masked copy
                  exists. These also block this session&apos;s handoff until the retry queue clears
                  them.
                </p>
              </div>
            )}

            {framelessButHeld ? (
              <div className="mt-6 flex flex-col items-center gap-3 rounded-card bg-surface px-6 py-12 text-center shadow-card">
                <div className="flex items-center gap-3">
                  {otherHoldings.map((h) => (
                    <h.icon key={h.key} size={22} strokeWidth={1.75} className="text-brand" />
                  ))}
                </div>
                <p className="text-sm font-semibold text-ink">
                  {otherHoldings.map((h) => plural(counts[h.key], h.noun)).join(' · ')} in this
                  session
                </p>
                <p className="max-w-md text-xs font-medium leading-relaxed text-ink-faint">
                  {otherHoldings.map((h) => h.detail).join(' ')} This oversight view renders image
                  frames only, so there is nothing to show here — the session is not empty.
                </p>
              </div>
            ) : items.length === 0 ? (
              <div className="mt-6 flex flex-col items-center gap-2 rounded-card bg-surface px-6 py-12 text-center shadow-card">
                <ImageOff size={22} strokeWidth={1.75} className="text-ink-faint" />
                <p className="text-sm font-semibold text-ink">No frames in this session</p>
                <p className="text-xs font-medium text-ink-faint">
                  Photos appear here once the collecting agent uploads them.
                </p>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {viewable.map((photo) => (
                  <figure
                    key={photo.id}
                    className="overflow-hidden rounded-card bg-surface shadow-card"
                  >
                    {/* The tile gets the grid-sized derivative, not the full
                        frame. Twelve 2816x1584 JPEGs to fill twelve 250px tiles
                        was several megabytes to paint a few hundred kilobytes
                        of pixels, and on anything slower than localhost it read
                        as a broken gallery rather than a loading one. */}
                    <img
                      src={mediaUrl.redactedThumb(sessionId, photo.id)}
                      alt="Redacted collection frame"
                      loading="lazy"
                      decoding="async"
                      width="480"
                      height="480"
                      className="aspect-square w-full bg-canvas object-cover"
                    />
                    <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="truncate text-[11px] font-semibold text-ink-faint">
                        {new Date(photo.createdAt).toLocaleString()}
                      </span>
                      <StatusPill tone={photo.piiStatus === 'MASKED' ? 'warning' : 'success'}>
                        {photo.piiStatus === 'MASKED' ? 'PII masked' : 'No PII text'}
                      </StatusPill>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
