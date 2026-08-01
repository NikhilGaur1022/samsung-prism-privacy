import { Users, Trash2, FileWarning } from 'lucide-react'
import StatusPill from './StatusPill'

// The Data tab's grid.
//
// Everything it renders comes from the item index and is pseudonymous by
// construction — the endpoint returns no name, no email and no `storagePath`
// (matrix §D). There is nothing here to hide client-side, which is the point:
// a screen that has to remember to omit a field is a screen that will one day
// forget.
//
// `shared` is precomputed server-side from `shared_subject_count`. It is shown
// on the row BEFORE the operator ticks anything, because a delete on a shared
// frame will come back as a redaction and finding that out afterwards is how an
// operator loses trust in the tool.

const ORIGIN_LABELS = {
  COLLECTION_SESSION: 'Collected',
  IMPORT: 'Imported',
  ENROLLMENT: 'Enrollment selfie',
}

function shortId(id) {
  return id ? `${id.slice(0, 8)}…` : '—'
}

export default function ItemGrid({ items, selected, onToggle, onToggleAll, allOnPageSelected }) {
  return (
    <div className="overflow-x-auto rounded-card bg-surface shadow-card">
      <table className="w-full min-w-[880px] text-left">
        <thead>
          <tr className="border-b border-border text-xs font-semibold text-ink-muted">
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                aria-label="Select every item on this page"
                checked={allOnPageSelected}
                onChange={onToggleAll}
                className="size-4 accent-brand"
              />
            </th>
            <th className="px-3 py-3">Item</th>
            <th className="px-3 py-3">Origin</th>
            <th className="px-3 py-3">Captured</th>
            <th className="px-3 py-3">Project / session</th>
            <th className="px-3 py-3">Lawful basis</th>
            <th className="px-3 py-3">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => {
            const isSelected = selected.has(item.itemId)
            return (
              <tr
                key={item.itemId}
                className={`text-sm font-medium ${
                  item.deletedAt ? 'text-ink-faint' : 'text-ink'
                } ${isSelected ? 'bg-brand-soft/40' : ''}`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select item ${item.itemId}`}
                    checked={isSelected}
                    // A tombstoned item has nothing left to act on. Leaving it
                    // selectable would let an operator submit a batch that comes
                    // back entirely SKIPPED and read as a failure.
                    disabled={Boolean(item.deletedAt)}
                    onChange={() => onToggle(item.itemId)}
                    className="size-4 accent-brand disabled:opacity-30"
                  />
                </td>
                <td className="px-3 py-3 font-mono text-xs">{shortId(item.itemId)}</td>
                <td className="px-3 py-3">{ORIGIN_LABELS[item.origin] ?? item.origin}</td>
                <td className="px-3 py-3">
                  {item.capturedAt ? new Date(item.capturedAt).toLocaleDateString() : 'Unknown'}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-ink-faint">
                  {shortId(item.projectId)} / {shortId(item.sessionId)}
                </td>
                <td className="px-3 py-3">
                  {item.lawfulBasis === 'IMPORT_UNVERIFIED' ? (
                    <StatusPill tone="warning">Unverified</StatusPill>
                  ) : item.lawfulBasis ? (
                    <StatusPill tone="success">Consent</StatusPill>
                  ) : (
                    <span className="text-xs text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.shared && (
                      <span
                        title={`${item.sharedSubjectCount} people appear on this frame — a delete becomes a redaction`}
                        className="inline-flex items-center gap-1 rounded-pill bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning"
                      >
                        <Users size={12} /> Shared ×{item.sharedSubjectCount}
                      </span>
                    )}
                    {item.deletedAt && (
                      <span className="inline-flex items-center gap-1 rounded-pill bg-canvas px-2 py-0.5 text-xs font-semibold text-ink-faint">
                        <Trash2 size={12} /> Deleted
                      </span>
                    )}
                    {!item.redactedAvailable && !item.deletedAt && (
                      <span
                        title="No confirmed redacted derivative — it cannot be served or packaged"
                        className="inline-flex items-center gap-1 rounded-pill bg-canvas px-2 py-0.5 text-xs font-semibold text-ink-faint"
                      >
                        <FileWarning size={12} /> No redacted copy
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
