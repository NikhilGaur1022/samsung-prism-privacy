import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

// Confirmation for an action that cannot be undone.
//
// Two rules here are contractual rather than cosmetic (matrix §D, "bulk action
// bar"):
//   * the exact count is stated, never "all" or "these items";
//   * when `requireTyped` is set the operator has to type the word. A delete
//     that is one click away from a mis-tick is a delete that will eventually
//     happen by accident, and this system's deletions are irreversible.
//
// Note this is a confirmation, NOT an enforcement point. The shared-frame
// downgrade is decided server-side from `shared_subject_count`; the sentence
// about it here exists so the operator is not surprised by an outcome the
// server was always going to produce.
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  requireTyped = null,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) {
  const [typed, setTyped] = useState('')
  const cancelRef = useRef(null)

  useEffect(() => {
    if (open) {
      setTyped('')
      cancelRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  const unlocked = !requireTyped || typed.trim().toUpperCase() === requireTyped.toUpperCase()

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6"
    >
      <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-card">
        <div className="flex items-start gap-3">
          <AlertTriangle
            size={20}
            strokeWidth={1.75}
            className={tone === 'danger' ? 'mt-0.5 shrink-0 text-danger' : 'mt-0.5 shrink-0 text-warning'}
          />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink">{title}</h2>
            <div className="mt-2 space-y-2 text-sm font-medium text-ink-muted">{body}</div>
          </div>
        </div>

        {requireTyped && (
          <label className="mt-4 block">
            <span className="text-xs font-semibold text-ink-muted">
              Type <span className="font-mono font-bold text-ink">{requireTyped}</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
          </label>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm font-bold text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!unlocked || busy}
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
              tone === 'danger' ? 'bg-danger' : 'bg-brand'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
