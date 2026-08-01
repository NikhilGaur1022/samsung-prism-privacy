import { EyeOff, Trash2, PackageCheck, X } from 'lucide-react'

// The action bar for the Data tab.
//
// Two properties it must keep:
//
//   1. **Select-all-matching sends the FILTER, not a harvested id list.** The
//      operator can only tick what a page rendered, so a client-built "all"
//      would be "all of page one" — and the server resolves the filter against
//      the request's own subject anyway, capped at its own ceiling. The parent
//      passes `scope` so this bar can say which of the two claims is being made.
//
//   2. **The count is always exact and always visible.** Never "all items",
//      never a number computed from `items.length` when the scope is a filter —
//      that is `totals.matching`, and conflating the two is how a bulk delete
//      turns out bigger than the screen implied.

const KINDS = [
  { kind: 'REDACT', label: 'Redact', Icon: EyeOff, tone: 'brand' },
  { kind: 'DELETE', label: 'Delete', Icon: Trash2, tone: 'danger' },
  { kind: 'EXPORT', label: 'Mark for export', Icon: PackageCheck, tone: 'brand' },
]

export default function BulkActionBar({
  count,
  sharedCount,
  scope,
  disabled = false,
  disabledReason = null,
  onAction,
  onClear,
}) {
  if (count === 0) return null

  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-card bg-ink px-4 py-3 shadow-card">
      <div className="min-w-0 text-sm font-semibold text-white">
        <span>
          {count} item{count === 1 ? '' : 's'} selected
        </span>
        <span className="ml-2 text-xs font-medium text-white/60">
          {scope === 'filter' ? 'everything matching the current filters' : 'ticked on screen'}
        </span>
        {sharedCount > 0 && (
          <p className="mt-0.5 text-xs font-medium text-warning">
            {sharedCount} of these are shared frames — a delete on those becomes a redaction.
          </p>
        )}
        {disabled && disabledReason && (
          <p className="mt-0.5 text-xs font-medium text-white/60">{disabledReason}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {KINDS.map(({ kind, label, Icon, tone }) => (
          <button
            key={kind}
            type="button"
            disabled={disabled}
            onClick={() => onAction(kind)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
              tone === 'danger' ? 'bg-danger' : 'bg-brand'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className="rounded-lg p-1.5 text-white/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
