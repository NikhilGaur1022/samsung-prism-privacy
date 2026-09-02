import { useCallback, useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

// Full-frame viewer for a redacted collection frame.
//
// The galleries that feed this render `object-cover` thumbnails, which is the
// right call for a grid — a contained thumbnail leaves ragged whitespace and
// makes a wall of frames hard to scan. It is the wrong call for the only copy of
// the image on screen: a 16:9 frame in a square tile loses a quarter of its width
// to the crop, and what falls outside is frequently the part an operator is
// checking. Until this existed the only place any frame could be seen whole was
// the tagging screen, which is a different page with a different purpose.
//
// It shows the REDACTED derivative, never the original. That is not a detail of
// this component — the URL is handed in by the caller, and every caller in the
// admin portal passes a `redacted` URL. There is no code path here that could
// reach for an unmasked frame.

export default function PhotoLightbox({ items, index, onClose, onIndex, srcFor, captionFor }) {
  const closeRef = useRef(null)
  const open = index != null && index >= 0 && index < items.length

  const go = useCallback(
    (delta) => {
      if (!open) return
      // Wraps rather than clamping. An operator paging through a session hits the
      // end constantly, and a dead arrow key reads as a broken control.
      onIndex((index + delta + items.length) % items.length)
    },
    [open, index, items.length, onIndex],
  )

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === 'ArrowLeft') go(-1)
    }
    document.addEventListener('keydown', onKey)
    // The gallery behind this scrolls independently otherwise, so closing the
    // viewer returns the operator to a different place in the grid than the one
    // they opened it from.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose, go])

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  if (!open) return null
  const item = items[index]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Full frame"
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      // Backdrop only. Without the target check, a click that lands on the image
      // or on an arrow closes the viewer, which makes paging by mouse impossible.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 text-white">
        <p className="min-w-0 truncate text-sm font-semibold">
          {captionFor ? captionFor(item) : null}
        </p>
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-white/70">
            {index + 1} / {items.length}
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg bg-white/10 p-2 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2 pb-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous frame"
            className="shrink-0 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ChevronLeft size={22} strokeWidth={2.5} />
          </button>
        )}

        {/* object-contain and a viewport-bounded box: the whole frame, letterboxed
            rather than cropped. This is the entire point of the component. */}
        <img
          src={srcFor(item)}
          alt="Redacted collection frame, full size"
          className="max-h-full min-h-0 max-w-full flex-1 object-contain"
        />

        {items.length > 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next frame"
            className="shrink-0 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ChevronRight size={22} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}
