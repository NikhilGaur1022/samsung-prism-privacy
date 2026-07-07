import { ChevronRight } from 'lucide-react'
import EmptyState from './EmptyState'

function DefaultRow({ title, subtitle, status, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 py-4 text-left first:pt-0 last:pb-0 ${
        onClick
          ? 'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
          : ''
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink">{title}</p>
        {subtitle && (
          <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">{subtitle}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {status}
        {onClick && <ChevronRight size={16} className="text-ink-faint" />}
      </div>
    </Tag>
  )
}

function SkeletonRows({ count = 3 }) {
  return (
    <ul className="mt-4 divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="animate-pulse py-4 first:pt-0 last:pb-0">
          <div className="h-3.5 w-2/5 rounded bg-canvas" />
          <div className="mt-2 h-3 w-3/5 rounded bg-canvas" />
        </li>
      ))}
    </ul>
  )
}

export default function ListPanel({
  title,
  action,
  rows,
  renderRow,
  loading = false,
  error = null,
  emptyIcon,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
}) {
  return (
    <div className="rounded-card bg-surface p-6 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {action}
      </div>

      {loading ? (
        <SkeletonRows />
      ) : error ? (
        <EmptyState
          title="Couldn't load this list"
          message="Something went wrong fetching this data. Try refreshing the page."
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {rows.map((row, i) => (
            <li key={row.id ?? i}>{renderRow ? renderRow(row) : <DefaultRow {...row} />}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
