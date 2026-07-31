import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, ImageOff, Loader2, ShieldCheck } from 'lucide-react'
import Sidebar from '../components/Sidebar'
import PageHeader from '../components/PageHeader'
import StatusPill from '../components/StatusPill'
import { listSessionPhotos, mediaUrl } from '../lib/api'

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
          subtitle="Redacted derivatives only. Faces nobody claimed and any sensitive text detected in the frame are masked server-side before the image leaves the API."
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
              <StatusPill tone="neutral">
                {items.length} frame{items.length === 1 ? '' : 's'}
              </StatusPill>
              {data.session.location && (
                <StatusPill tone="neutral">{data.session.location}</StatusPill>
              )}
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-xs font-medium leading-relaxed text-ink-muted shadow-card">
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

            {items.length === 0 ? (
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
                    <img
                      src={mediaUrl.redacted(sessionId, photo.id)}
                      alt="Redacted collection frame"
                      loading="lazy"
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
