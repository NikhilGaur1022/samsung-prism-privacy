import {
  ArrowRightLeft,
  FileCheck2,
  Layers,
  Trash2,
  Eye,
  KeyRound,
  ShieldAlert,
} from 'lucide-react'
import EmptyState from './EmptyState'

// Renders the merged history the server built.
//
// The one rule that matters here (matrix §D, "Timeline tab"): **never invent
// content for an entry.** `audit_log` stores a hash of each payload and never
// the payload, so every "what" on this screen was read from a typed table by
// `timeline.service.js`. If an entry has no summary, it gets its kind and
// nothing else — a plausible-sounding sentence generated in the UI would be a
// fabricated audit record, which is worse than a blank.

const KINDS = {
  TRANSITION: { Icon: ArrowRightLeft, tone: 'text-ink-muted' },
  ITEM_ACTION_BATCH: { Icon: Layers, tone: 'text-brand' },
  EVIDENCE: { Icon: FileCheck2, tone: 'text-ink-muted' },
  PURGE_PLANNED: { Icon: Trash2, tone: 'text-warning' },
  PURGE_RESULT: { Icon: Trash2, tone: 'text-danger' },
  ACCESS: { Icon: Eye, tone: 'text-ink-faint' },
  BREAK_GLASS: { Icon: ShieldAlert, tone: 'text-danger' },
  CERTIFICATE: { Icon: KeyRound, tone: 'text-success' },
}

function actorLabel(actor) {
  if (!actor || actor.type === 'SYSTEM' || !actor.id) return 'System'
  if (actor.type === 'SUBJECT') return 'Data principal'
  return `Admin ${actor.id.slice(0, 8)}`
}

export default function TimelineList({ entries }) {
  if (!entries?.length) {
    return (
      <EmptyState
        title="Nothing has happened yet"
        message="Milestones appear here as the request is worked."
      />
    )
  }

  return (
    <ol className="relative ml-3 border-l border-border">
      {entries.map((e, i) => {
        const { Icon, tone } = KINDS[e.kind] ?? { Icon: ArrowRightLeft, tone: 'text-ink-faint' }
        return (
          <li key={e.refId ?? `${e.at}-${i}`} className="relative py-4 pl-6">
            <span className="absolute -left-[9px] top-5 grid size-[18px] place-items-center rounded-full bg-surface">
              <Icon size={13} strokeWidth={2} className={tone} />
            </span>

            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-ink">
                {e.summary ?? e.kind.replace(/_/g, ' ').toLowerCase()}
              </p>
              <time className="shrink-0 text-xs font-medium text-ink-faint">
                {new Date(e.at).toLocaleString()}
              </time>
            </div>

            <p className="mt-0.5 text-xs font-medium text-ink-faint">
              {actorLabel(e.actor)}
              {e.detail?.total != null && ` · ${e.detail.total} item(s)`}
              {e.detail?.downgradedToRedact && ' · some deletes became redactions'}
            </p>

            {e.detail?.reason && (
              <p className="mt-1 rounded-lg bg-canvas px-2.5 py-1.5 text-xs font-medium text-ink-muted">
                {e.detail.reason}
              </p>
            )}

            {e.hash && (
              <p
                title="Chain hash — verify at /audit/verify. It is evidence, never content."
                className="mt-1 truncate font-mono text-[11px] text-ink-faint"
              >
                {e.hash}
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}
