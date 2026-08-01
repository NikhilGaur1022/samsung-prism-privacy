import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, PackageCheck, Lock } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import ItemGrid from '../../components/ItemGrid'
import BulkActionBar from '../../components/BulkActionBar'
import TimelineList from '../../components/TimelineList'
import ConfirmDialog from '../../components/ConfirmDialog'
import {
  buildDsarPackage,
  closeDsar,
  getDsar,
  getDsarTimeline,
  listDsarItemActions,
  listDsarItems,
  requestDsarItemActions,
} from '../../lib/api'
import { COARSE_LABELS, COARSE_TONES, STATUS_TONE } from '../../lib/lifecycle'

// The request workspace — the screen PLAN §G5 calls the biggest gap: "what
// requests exist, what state, what happened".
//
// Three things here are contractual rather than presentational:
//
//   1. **Actions may only be requested while the request is DISCOVERY,
//      EXECUTING or REVIEW.** The server enforces it with a 409; disabling the
//      bar means an operator learns that from the UI instead of from an error.
//
//   2. **"Select all matching" sends the filter, not a harvested id list.** The
//      grid only ever holds one page, so a client-built "all" would be "all of
//      page one". The server resolves the filter against this request's own
//      subject and caps the batch.
//
//   3. **The confirm dialog states the exact count and the shared-frame
//      downgrade.** The server performs the downgrade either way — the point is
//      that the operator is not surprised by it.

const ACTIONABLE_STATUSES = ['DISCOVERY', 'EXECUTING', 'REVIEW']

// The transition table only admits CLOSED from REVIEW. That is not a UI rule —
// the server 409s either way — but a Close button that is live from DISCOVERY
// teaches the operator that the button is unreliable rather than that the
// request is not ready.
const CLOSEABLE_STATUSES = ['REVIEW']

const TABS = [
  { key: 'data', label: 'Data' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'actions', label: 'Actions' },
  { key: 'close', label: 'Close' },
]

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const ORIGINS = ['COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT']

const ACTION_COPY = {
  REDACT: { verb: 'Redact', tone: 'warning', typed: null },
  DELETE: { verb: 'Delete', tone: 'danger', typed: 'DELETE' },
  EXPORT: { verb: 'Mark for export', tone: 'brand', typed: null },
}

export default function DsarRequestDetail() {
  const { requestId } = useParams()

  const [tab, setTab] = useState('data')
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const [filters, setFilters] = useState({ origin: '', includeDeleted: false })
  const [page, setPage] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  // 'page' = the ticked ids; 'filter' = everything matching, resolved server-side.
  const [scope, setScope] = useState('page')

  const [timeline, setTimeline] = useState(null)
  const [actions, setActions] = useState(null)

  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [closeNote, setCloseNote] = useState('')

  useEffect(() => {
    getDsar(requestId).then(setRequest).catch(setError)
  }, [requestId])

  const loadItems = useCallback(() => {
    setPage(null)
    listDsarItems(requestId, {
      origin: filters.origin || undefined,
      includeDeleted: filters.includeDeleted ? 'true' : undefined,
      limit: 50,
    })
      .then(setPage)
      .catch(setError)
  }, [requestId, filters])

  useEffect(() => {
    if (tab === 'data') loadItems()
    if (tab === 'timeline') getDsarTimeline(requestId).then(setTimeline).catch(setError)
    if (tab === 'actions' || tab === 'close') {
      listDsarItemActions(requestId).then(setActions).catch(setError)
    }
  }, [tab, requestId, loadItems])

  const items = page?.items ?? []
  const totals = page?.totals ?? {}

  const selectedCount = scope === 'filter' ? (totals.matching ?? 0) : selected.size
  const sharedCount = useMemo(() => {
    if (scope === 'filter') {
      // Unknown without another query, and guessing would understate it. The bar
      // says "some may be shared" via the server's own summary after submission.
      return items.filter((i) => i.shared).length
    }
    return items.filter((i) => selected.has(i.itemId) && i.shared).length
  }, [items, selected, scope])

  const actionable = request && ACTIONABLE_STATUSES.includes(request.status)

  const toggle = (itemId) => {
    setScope('page')
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const toggleAll = () => {
    setScope('page')
    const live = items.filter((i) => !i.deletedAt).map((i) => i.itemId)
    setSelected((prev) => (live.every((id) => prev.has(id)) ? new Set() : new Set(live)))
  }

  const clearSelection = () => {
    setSelected(new Set())
    setScope('page')
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = { kind: pending.kind, reason: pending.reason || undefined }
      if (scope === 'filter') {
        body.filter = {
          ...(filters.origin ? { origin: filters.origin } : {}),
        }
      } else {
        body.itemIds = [...selected]
      }

      const result = await requestDsarItemActions(requestId, body)
      const s = result.summary ?? {}
      setNotice(
        `Batch ${result.batchId?.slice(0, 8)} recorded — ${s.requested ?? result.actions?.length ?? 0} action(s)` +
          (s.downgraded ? `, ${s.downgraded} delete(s) became redactions on shared frames` : ''),
      )
      clearSelection()
      setPending(null)
      loadItems()
    } catch (err) {
      setError(err)
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const buildPackage = async (selection) => {
    setBusy(true)
    setError(null)
    try {
      const result = await buildDsarPackage(requestId, selection)
      setNotice(
        `Package built — ${result.selection?.itemCount ?? '?'} item(s)` +
          (result.selection?.complete === false
            ? '. It is marked incomplete in the manifest and the README, because it is a narrowed selection.'
            : '.'),
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const doClose = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = await closeDsar(requestId, closeNote || undefined)
      setRequest(updated)
      setNotice('Request closed.')
      setPending(null)
    } catch (err) {
      setError(err)
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  const inFlight = actions?.inFlight ?? 0

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <Link
          to="/dsar-queue"
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-bold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <ArrowLeft size={14} /> Back to the dashboard
        </Link>

        <PageHeader
          title={
            request
              ? `${request.subjectRef ?? (request.subjectId ? `${request.subjectId.slice(0, 8)}…` : '—')} · ${request.type}`
              : 'Request'
          }
          subtitle={
            request
              ? `Raised ${new Date(request.createdAt).toLocaleDateString()} · SLA due ${new Date(
                  request.sla.dueAt,
                ).toLocaleDateString()}${request.sla.breached ? ' · breached' : ''}`
              : ''
          }
          action={
            request && (
              <div className="flex items-center gap-2">
                <StatusPill tone={COARSE_TONES[request.coarseStatus]}>
                  {COARSE_LABELS[request.coarseStatus]}
                </StatusPill>
                <StatusPill tone={STATUS_TONE[request.status]}>{request.status}</StatusPill>
              </div>
            )
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}
        {notice && (
          <div className="mt-5 rounded-lg bg-brand-soft px-3 py-2.5 text-sm font-semibold text-brand">
            {notice}
          </div>
        )}

        <div className="mt-6 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                tab === t.key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'data' && (
          <section className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className={FIELD_CLASS}
                  value={filters.origin}
                  onChange={(e) => {
                    clearSelection()
                    setFilters((f) => ({ ...f, origin: e.target.value }))
                  }}
                >
                  <option value="">All origins</option>
                  {ORIGINS.map((o) => (
                    <option key={o} value={o}>
                      {o.replace(/_/g, ' ').toLowerCase()}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                  <input
                    type="checkbox"
                    checked={filters.includeDeleted}
                    onChange={(e) => {
                      clearSelection()
                      setFilters((f) => ({ ...f, includeDeleted: e.target.checked }))
                    }}
                    className="size-3.5 accent-brand"
                  />
                  Show deleted
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => buildPackage('SELECTED')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <PackageCheck size={13} /> Package marked items
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => buildPackage('ALL')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <PackageCheck size={13} /> Package everything
                </button>
              </div>
            </div>

            {/* totals.all ignores every filter — it is the completeness claim.
                totals.matching is what the grid is paging through. Showing only
                the second would let a narrowed view read as "this is everything
                we hold about this person". */}
            <p className="mt-3 text-xs font-medium text-ink-muted">
              <span className="font-bold text-ink">{totals.all ?? '—'}</span> items held in total
              {totals.matching != null && totals.matching !== totals.all && (
                <> · {totals.matching} match the current filters</>
              )}
              {totals.deleted ? <> · {totals.deleted} already destroyed</> : null}
              {page?.index?.consistent === false && (
                <span className="ml-2 font-bold text-danger">
                  The index disagrees with the source tables — this count may understate what is held.
                </span>
              )}
            </p>

            {page && totals.matching > items.length && scope === 'page' && (
              <button
                type="button"
                onClick={() => setScope('filter')}
                className="mt-2 text-xs font-bold text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Select all {totals.matching} items matching these filters
              </button>
            )}

            <div className="mt-4">
              {!page ? (
                <div className="rounded-card bg-surface p-6 shadow-card">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-canvas" />
                </div>
              ) : items.length === 0 ? (
                <div className="rounded-card bg-surface p-6 shadow-card">
                  <EmptyState
                    title="No items"
                    message="Run discovery on this request, or widen the filters."
                  />
                </div>
              ) : (
                <ItemGrid
                  items={items}
                  selected={selected}
                  onToggle={toggle}
                  onToggleAll={toggleAll}
                  allOnPageSelected={
                    items.filter((i) => !i.deletedAt).length > 0 &&
                    items.filter((i) => !i.deletedAt).every((i) => selected.has(i.itemId))
                  }
                />
              )}
            </div>

            {page?.nextCursor && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() =>
                    listDsarItems(requestId, {
                      origin: filters.origin || undefined,
                      includeDeleted: filters.includeDeleted ? 'true' : undefined,
                      cursor: page.nextCursor,
                      limit: 50,
                    })
                      .then((next) =>
                        setPage((prev) => ({ ...next, items: [...prev.items, ...next.items] })),
                      )
                      .catch(setError)
                  }
                  className="rounded-lg border border-border px-4 py-2 text-sm font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Load more
                </button>
              </div>
            )}

            <BulkActionBar
              count={selectedCount}
              sharedCount={sharedCount}
              scope={scope}
              disabled={!actionable}
              disabledReason={
                request &&
                `Actions are only permitted while the request is in discovery, execution or review — this one is ${request.status}.`
              }
              onAction={(kind) => setPending({ kind, reason: '' })}
              onClear={clearSelection}
            />
          </section>
        )}

        {tab === 'timeline' && (
          <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
            {!timeline ? (
              <div className="h-3 w-1/3 animate-pulse rounded bg-canvas" />
            ) : (
              <>
                <TimelineList entries={timeline.entries} />
                <p className="mt-6 border-t border-border pt-4 text-xs font-medium text-ink-faint">
                  {timeline.integrity?.auditEntries ?? 0} audit chain entries cover this request.
                  The chain stores a hash of each payload and never the payload — the content above
                  is read from the typed tables, and the hashes prove those rows were not edited
                  afterwards. Verify at <code>{timeline.integrity?.verifyWith}</code>.
                </p>
              </>
            )}
          </section>
        )}

        {tab === 'actions' && (
          <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
            {!actions ? (
              <div className="h-3 w-1/3 animate-pulse rounded bg-canvas" />
            ) : actions.items.length === 0 ? (
              <EmptyState title="No actions yet" message="Nothing has been done to this data." />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(actions.counts ?? {}).map(([status, n]) => (
                    <StatusPill
                      key={status}
                      tone={
                        status === 'FAILED' ? 'danger' : status === 'DONE' ? 'success' : 'neutral'
                      }
                    >
                      {status} {n}
                    </StatusPill>
                  ))}
                </div>
                <ul className="mt-4 divide-y divide-border">
                  {actions.items.map((a) => (
                    <li key={a.actionId} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">
                          {a.kind} · <span className="font-mono text-xs">{a.itemId.slice(0, 8)}…</span>
                        </p>
                        <StatusPill
                          tone={
                            a.status === 'FAILED'
                              ? 'danger'
                              : a.status === 'DONE'
                                ? 'success'
                                : a.status === 'SKIPPED'
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {a.status}
                        </StatusPill>
                      </div>
                      {/* A SKIPPED delete carries the reason it was refused. It is
                          shown, never swallowed: an operator who selected 40 items
                          and got 38 actions is owed the other two. */}
                      {a.error && (
                        <p className="mt-1 text-xs font-medium text-ink-muted">{a.error}</p>
                      )}
                      {a.reason && (
                        <p className="mt-1 text-xs font-medium text-ink-faint">“{a.reason}”</p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {tab === 'close' && (
          <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">Close this request</h2>
            <p className="mt-2 text-sm font-medium text-ink-muted">
              Closing declares the work finished. It is refused while any item action is still
              queued or running — a request closed over in-flight deletions would record a
              completion that had not happened.
            </p>

            {inFlight > 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm font-semibold text-warning">
                <Lock size={15} /> {inFlight} action(s) still in flight.
              </div>
            )}

            {request && !CLOSEABLE_STATUSES.includes(request.status) && request.coarseStatus !== 'CLOSED' && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-canvas px-3 py-2 text-sm font-semibold text-ink-muted">
                <Lock size={15} /> This request is {request.status}. It has to reach REVIEW before it
                can be closed.
              </div>
            )}

            <label className="mt-4 block">
              <span className="text-xs font-semibold text-ink-muted">Resolution note</span>
              <textarea
                rows={3}
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              />
            </label>

            <button
              type="button"
              disabled={
                busy ||
                inFlight > 0 ||
                request?.coarseStatus === 'CLOSED' ||
                !CLOSEABLE_STATUSES.includes(request?.status)
              }
              onClick={() => setPending({ kind: 'CLOSE' })}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {request?.coarseStatus === 'CLOSED' ? 'Already closed' : 'Close request'}
            </button>
          </section>
        )}

        <ConfirmDialog
          open={Boolean(pending) && pending.kind !== 'CLOSE'}
          tone={pending?.kind === 'DELETE' ? 'danger' : 'warning'}
          title={`${ACTION_COPY[pending?.kind]?.verb ?? 'Act on'} ${selectedCount} item${
            selectedCount === 1 ? '' : 's'
          }?`}
          requireTyped={ACTION_COPY[pending?.kind]?.typed}
          confirmLabel={ACTION_COPY[pending?.kind]?.verb ?? 'Confirm'}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={submit}
          body={
            <>
              <p>
                This affects exactly <strong>{selectedCount}</strong> item
                {selectedCount === 1 ? '' : 's'}
                {scope === 'filter' ? ' matching the current filters' : ' selected on screen'}.
              </p>
              {pending?.kind === 'DELETE' && (
                <p>
                  {sharedCount > 0 ? (
                    <>
                      <strong>{sharedCount}</strong> of them are frames other people also appear on.
                      Those will be <strong>redacted, not deleted</strong> — a photograph cannot be
                      destroyed for one person while another still has a lawful basis for it.
                    </>
                  ) : (
                    <>
                      Any frame that turns out to be shared with another person will be redacted
                      rather than deleted. That is decided server-side at execution time.
                    </>
                  )}
                </p>
              )}
              {pending?.kind === 'DELETE' && <p>Deletion cannot be undone.</p>}
              <label className="block">
                <span className="text-xs font-semibold text-ink-muted">
                  Reason{pending?.kind === 'DELETE' ? ' (required, min 10 characters)' : ''}
                </span>
                <textarea
                  rows={2}
                  value={pending?.reason ?? ''}
                  onChange={(e) => setPending((p) => ({ ...p, reason: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
              </label>
            </>
          }
        />

        <ConfirmDialog
          open={pending?.kind === 'CLOSE'}
          tone="warning"
          title="Close this request?"
          confirmLabel="Close"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={doClose}
          body={
            <p>
              This records the request as discharged. Any failed item action stays on the record and
              does not block the close — that is a decision you are making, and it will be visible
              on the timeline.
            </p>
          }
        />
      </main>
    </div>
  )
}
