import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  Loader2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'

import {
  getErasurePackage,
  erasurePhotoUrl,
  downloadErasurePackage,
  confirmErasure,
} from '../lib/api'

// The last thing you see before your data is destroyed.
//
// An erasure used to run on an operator's approval alone: you asked for it, and
// some time later it happened. You were never shown what "it" meant, and there
// was no moment at which you could say "yes, that, go ahead" — or notice that it
// covered a photo you had forgotten about.
//
// Two things this screen has to get right:
//
//   1. Every face here except yours is blurred. The other people in these frames
//      did not ask for anything and have no idea this request exists; showing
//      them to you would be a disclosure breach committed in the course of
//      honouring a privacy right.
//   2. It has to be honest about the asymmetry. A frame where you are the only
//      participant is destroyed. A frame you share is KEPT — the other person is
//      still entitled to it — and your face is blurred out of it. People expect
//      "delete my data" to mean the photo disappears, and for shared frames it
//      does not.

function Tile({ requestId, item, onOpen }) {
  const [broken, setBroken] = useState(false)

  return (
    <figure className="overflow-hidden rounded-card bg-surface shadow-card">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label="View this photo full size"
      >
        {broken ? (
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-canvas text-xs font-semibold text-ink-faint">
            Could not load
          </div>
        ) : (
          <img
            src={erasurePhotoUrl(requestId, item.photoId)}
            alt="A photo of you, with every other face blurred"
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="aspect-[4/3] w-full bg-canvas object-contain"
          />
        )}
      </button>
      <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-[11px] font-semibold text-ink-faint">
          {item.capturedAt ? new Date(item.capturedAt).toLocaleDateString() : 'Photo'}
        </span>
        {item.willBeDeleted ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[10px] font-bold text-danger">
            <Trash2 size={10} strokeWidth={3} />
            Deleted
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-bold text-warning">
            <Eye size={10} strokeWidth={3} />
            You blurred
          </span>
        )}
      </figcaption>
    </figure>
  )
}

export default function ErasureReview({ requestId, onConfirmed }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getErasurePackage(requestId))
      setError(null)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [requestId])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!lightbox) return undefined
    const onKey = (e) => e.key === 'Escape' && setLightbox(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightbox])

  const download = async () => {
    setBusy(true)
    try {
      const { blob, filename } = await downloadErasurePackage(requestId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const doConfirm = async () => {
    setBusy(true)
    try {
      await confirmErasure(requestId)
      setConfirming(false)
      await load()
      onConfirmed?.()
    } catch (err) {
      setError(err)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-ink-faint">
        <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />
        Loading your photos…
      </p>
    )
  }

  // A 409 here is normal, not a failure: it means the request has not reached the
  // review step yet. Saying so beats showing an error the person cannot act on.
  if (error && error.status === 409) {
    return (
      <div className="rounded-card bg-surface p-5 shadow-card">
        <p className="text-sm font-semibold text-ink">Not ready to review yet</p>
        <p className="mt-1 text-xs font-medium text-ink-faint">{error.message}</p>
      </div>
    )
  }

  if (error) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm font-medium text-danger">
        <AlertTriangle size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" />
        {error.message}
      </p>
    )
  }

  const { counts, items, confirmedAt, project } = data
  const done = Boolean(confirmedAt)

  return (
    <section className="rounded-card bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold text-ink">
            <ShieldCheck size={17} strokeWidth={2.5} className="text-brand" />
            Review before erasing
          </h2>
          <p className="mt-1 text-xs font-medium text-ink-faint">
            {project ? `Everything we hold of you in ${project.name}.` : 'Everything we hold of you.'}{' '}
            Every other person&apos;s face is blurred — they have not asked for anything, so we
            cannot show them to you.
          </p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={download}
            disabled={busy}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink hover:border-brand disabled:opacity-50"
          >
            <Download size={15} strokeWidth={2.5} />
            Download all
          </button>
        )}
      </div>

      {done && (
        <p className="mt-4 flex items-start gap-2 rounded-lg bg-success-soft p-3 text-sm font-medium text-success">
          <CheckCircle2 size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" />
          You confirmed this erasure on {new Date(confirmedAt).toLocaleString()}. It is now with our
          team to carry out.
        </p>
      )}

      {items.length === 0 ? (
        <p className="mt-4 text-sm font-medium text-ink-faint">
          We hold no photographs of you in this project.
        </p>
      ) : (
        <>
          {/* Stated plainly and up front. The shared-frame rule is the one thing
              people get wrong about erasure, and finding out afterwards that a
              photo still exists feels like the request was ignored. */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-danger-soft p-3">
              <p className="flex items-center gap-1.5 text-sm font-bold text-danger">
                <Trash2 size={14} strokeWidth={2.5} />
                {counts.willBeDeleted} deleted entirely
              </p>
              <p className="mt-1 text-xs font-medium text-danger/80">
                You are the only person in these. They are destroyed.
              </p>
            </div>
            <div className="rounded-lg bg-warning-soft p-3">
              <p className="flex items-center gap-1.5 text-sm font-bold text-warning">
                <Eye size={14} strokeWidth={2.5} />
                {counts.willBeRedacted} kept, your face blurred
              </p>
              <p className="mt-1 text-xs font-medium text-warning/80">
                Someone else is in these and has not withdrawn. The photo stays; you are blurred
                out of it.
              </p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => (
              <Tile key={item.photoId} requestId={requestId} item={item} onOpen={setLightbox} />
            ))}
          </div>
        </>
      )}

      {!done && items.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          {confirming ? (
            <div className="rounded-lg border border-danger bg-danger-soft p-4">
              <p className="text-sm font-bold text-danger">This cannot be undone.</p>
              <p className="mt-1 text-xs font-medium text-danger/90">
                {counts.willBeDeleted} photo{counts.willBeDeleted === 1 ? '' : 's'} will be
                destroyed, and your face will be permanently blurred out of{' '}
                {counts.willBeRedacted}. Download your copy first if you want to keep it.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={doConfirm}
                  disabled={busy}
                  className="flex min-h-11 items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />
                  ) : (
                    <Trash2 size={15} strokeWidth={2.5} />
                  )}
                  Yes, erase my data
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="min-h-11 rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex min-h-11 items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-bold text-white"
              >
                <Trash2 size={15} strokeWidth={2.5} />
                Erase my data
              </button>
              <p className="mt-2 text-xs font-medium text-ink-faint">
                Nothing has been deleted yet. Our team cannot begin until you press this.
              </p>
            </>
          )}
        </div>
      )}

      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo, full size"
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          onClick={(e) => e.target === e.currentTarget && setLightbox(null)}
        >
          <div className="flex shrink-0 items-center justify-between px-4 py-3 text-white">
            <p className="text-sm font-semibold">
              {lightbox.willBeDeleted ? 'Will be deleted entirely' : 'Will be kept, with you blurred out'}
            </p>
            <button
              type="button"
              onClick={() => setLightbox(null)}
              aria-label="Close"
              className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
            >
              <X size={18} strokeWidth={2.5} />
            </button>
          </div>
          <div
            className="flex min-h-0 flex-1 items-center justify-center p-4"
            onClick={(e) => e.target === e.currentTarget && setLightbox(null)}
          >
            <img
              src={erasurePhotoUrl(requestId, lightbox.photoId)}
              alt="A photo of you, full size, with every other face blurred"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        </div>
      )}
    </section>
  )
}
