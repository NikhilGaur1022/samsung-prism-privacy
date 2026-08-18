import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, PackageCheck, Lock, Search, Play } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import ItemGrid from '../../components/ItemGrid'
import BulkActionBar from '../../components/BulkActionBar'
import TimelineList from '../../components/TimelineList'
import ConfirmDialog from '../../components/ConfirmDialog'
import {
  approveDsar,
  attachDsarEvidence,
  buildDsarPackage,
  closeDsar,
  executeDsar,
  getDsar,
  getDsarCertificate,
  getDsarTimeline,
  listDsarEvidence,
  listDsarItemActions,
  listDsarItems,
  requestDsarItemActions,
  runDsarDiscovery,
} from '../../lib/api'
import { COARSE_LABELS, COARSE_TONES, STATUS_TONE } from '../../lib/lifecycle'
import { useAuth } from '../../auth'

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
//
//   4. **The whole page is role-gated, not just status-gated.** Four roles reach
//      this route and no two of them may call the same set of endpoints, so the
//      tab strip itself is derived from the role rather than fixed. The rule is
//      that a tab exists only if every request it fires on selection is one the
//      server will answer for this role — a tab that mounts straight into a 403
//      is worse than no tab. Specifically: the item grid, the timeline and the
//      action log are dpo/dataAdmin/super_admin, so **dataOwner never fires
//      them**; the item actions and the package build are dataAdmin/super_admin,
//      so a dpo gets the grid read-only with the reason stated in place of the
//      button. What a dataOwner does get is the evidence file and the sign-off,
//      which are exactly the two things matrix §B routes to them.

const ACTIONABLE_STATUSES = ['DISCOVERY', 'EXECUTING', 'REVIEW']

// The two lifecycle steps that get a request from RECEIVED into a state where
// the item actions and the package build are legal. They mirror the server:
// runDiscoveryForRequest() accepts RECEIVED/TRIAGE/DISCOVERY, execute() accepts
// DISCOVERY/EXECUTING. Without them on this page a RECEIVED request was a dead
// end here — every button was disabled and the only way forward lived on a
// different screen.
const DISCOVERY_STATUSES = ['RECEIVED', 'TRIAGE', 'DISCOVERY']
const EXECUTE_STATUSES = ['DISCOVERY', 'EXECUTING']

// What the current status permits, said in the operator's terms. The status pill
// names the state; this names the next move.
const STATUS_GUIDANCE = {
  RECEIVED:
    'Nothing has been searched yet. Run discovery to walk the lineage and populate the item grid — that also moves the request into DISCOVERY, which is when redact, delete, mark-for-export and packaging become legal.',
  TRIAGE:
    'Assigned but not yet searched. Run discovery to walk the lineage and open the item actions.',
  DISCOVERY:
    'Discovery has run. Act on individual items, then Execute to fulfil the request — an access request builds the package, an erasure runs the purge and issues a deletion certificate.',
  EXECUTING:
    'Fulfilment is under way. Re-run Execute to resume a partially completed purge; it is idempotent and will not double-delete.',
  REVIEW: 'Fulfilled and awaiting sign-off. Close the request on the Close tab.',
  CLOSED: 'This request is finished. Everything here is read-only history.',
  REJECTED: 'This request was rejected. Everything here is read-only history.',
}

// One constant per requireRole() call on the routes this page touches, copied
// from backend/src/modules/dsar/dsar.routes.js. The server is still the
// enforcement — these only stop the UI from firing a request it knows will be
// refused, or from offering a button that would 403 on click.
const ITEM_READ_ROLES = ['dpo', 'dataAdmin', 'super_admin'] // items, timeline, action log
const ITEM_WRITE_ROLES = ['dataAdmin', 'super_admin'] // items/actions, package
const DISCOVERY_ROLES = ['dataOwner', 'dataAdmin', 'super_admin']
const EXECUTE_ROLES = ['dataAdmin', 'super_admin']
const EVIDENCE_WRITE_ROLES = ['dataOwner', 'dataAdmin', 'super_admin']
const CLOSE_ROLES = ['dpo', 'dataAdmin', 'super_admin'] // POST /close
const APPROVE_ROLES = ['dpo', 'dataOwner', 'super_admin'] // POST /approve

// The transition table only admits CLOSED from REVIEW. That is not a UI rule —
// the server 409s either way — but a Close button that is live from DISCOVERY
// teaches the operator that the button is unreliable rather than that the
// request is not ready.
const CLOSEABLE_STATUSES = ['REVIEW']

const EVIDENCE_KINDS = [
  'DISCOVERY_RESULT',
  'IDENTITY_PROOF',
  'EXPORT_PACKAGE',
  'PURGE_REPORT',
  'CORRESPONDENCE',
  'APPROVAL',
]

// Ordered; filtered per role by tabsForRole. `needs` is the role list for every
// endpoint the tab fires on selection — null means the router-level gate, which
// all four roles on this route already passed.
const ALL_TABS = [
  { key: 'data', label: 'Data', needs: ITEM_READ_ROLES },
  { key: 'timeline', label: 'Timeline', needs: ITEM_READ_ROLES },
  { key: 'actions', label: 'Actions', needs: ITEM_READ_ROLES },
  { key: 'evidence', label: 'Evidence', needs: null },
  // Two different endpoints behind one tab: dpo/dataAdmin/super_admin close the
  // request outright, a dataOwner signs it off with POST /approve, which the
  // service implements as the same REVIEW → CLOSED transition.
  { key: 'close', label: 'Close', needs: [...new Set([...CLOSE_ROLES, ...APPROVE_ROLES])] },
]

function tabsForRole(roleKey) {
  return ALL_TABS.filter((t) => !t.needs || t.needs.includes(roleKey))
}

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const ORIGINS = ['COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT']

// Mirrors DataItemType in schema.prisma. Kept in sync by hand with the zod enum
// in dsar.routes.js — a value here the server rejects is a 400 on a filter the
// operator can see and click.
const ITEM_TYPES = [
  { value: 'PHOTO', label: 'Photos' },
  { value: 'AUDIO', label: 'Audio' },
]

const ACTION_COPY = {
  REDACT: { verb: 'Redact', tone: 'warning', typed: null },
  DELETE: { verb: 'Delete', tone: 'danger', typed: 'DELETE' },
  EXPORT: { verb: 'Mark for export', tone: 'brand', typed: null },
}

export default function DsarRequestDetail() {
  const { requestId } = useParams()
  const { roleKey } = useAuth()
  const canReadItems = ITEM_READ_ROLES.includes(roleKey)
  const canWriteItems = ITEM_WRITE_ROLES.includes(roleKey)
  const canRunDiscovery = DISCOVERY_ROLES.includes(roleKey)
  const canExecute = EXECUTE_ROLES.includes(roleKey)
  const canFileEvidence = EVIDENCE_WRITE_ROLES.includes(roleKey)
  const canClose = CLOSE_ROLES.includes(roleKey)

  const tabs = useMemo(() => tabsForRole(roleKey), [roleKey])
  const [tab, setTab] = useState(tabs[0]?.key ?? 'evidence')

  // roleKey arrives after the /me round-trip, so the first render can carry the
  // wrong default. Snapping to the first tab this role actually has keeps a
  // dataOwner off the item grid rather than firing a 403 and showing an error.
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab(tabs[0]?.key ?? 'evidence')
  }, [tabs, tab])

  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  const [filters, setFilters] = useState({ origin: '', type: '', includeDeleted: false })
  const [page, setPage] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  // 'page' = the ticked ids; 'filter' = everything matching, resolved server-side.
  const [scope, setScope] = useState('page')

  const [timeline, setTimeline] = useState(null)
  const [actions, setActions] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [certificate, setCertificate] = useState(null)
  const [draft, setDraft] = useState({ kind: 'CORRESPONDENCE', label: '' })

  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const [closeNote, setCloseNote] = useState('')

  useEffect(() => {
    getDsar(requestId).then(setRequest).catch(setError)
  }, [requestId])

  const loadItems = useCallback(() => {
    // A dataOwner may run discovery but may not read the grid it populates, and
    // runDiscovery/runExecute both call this on success. Guarding here rather
    // than at each call site keeps the one rule in one place.
    if (!canReadItems) return
    setPage(null)
    listDsarItems(requestId, {
      origin: filters.origin || undefined,
      type: filters.type || undefined,
      includeDeleted: filters.includeDeleted ? 'true' : undefined,
      limit: 50,
    })
      .then(setPage)
      .catch(setError)
  }, [requestId, filters, canReadItems])

  const loadEvidence = useCallback(() => {
    setEvidence(null)
    listDsarEvidence({ dsarRequestId: requestId, limit: 100 })
      .then(setEvidence)
      .catch(setError)
  }, [requestId])

  useEffect(() => {
    // Every branch is conditioned on the role, not only on the tab. The tab
    // strip already hides what this role cannot read, but the guard is repeated
    // here so a stale `tab` between renders cannot fire a request the server
    // will refuse.
    if (tab === 'data' && canReadItems) loadItems()
    if (tab === 'timeline' && canReadItems) {
      getDsarTimeline(requestId).then(setTimeline).catch(setError)
    }
    if ((tab === 'actions' || tab === 'close') && canReadItems) {
      listDsarItemActions(requestId).then(setActions).catch(setError)
    }
    if (tab === 'evidence') {
      loadEvidence()
      // 404 until a purge has issued one — not an error worth a banner.
      getDsarCertificate(requestId)
        .then(setCertificate)
        .catch(() => setCertificate(null))
    }
  }, [tab, requestId, loadItems, loadEvidence, canReadItems])

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
        // Must mirror the grid's query exactly. A `type` filter left out here
        // would resolve "select all matching" to every item of every type —
        // widening a DELETE past what the operator was looking at.
        body.filter = {
          ...(filters.origin ? { origin: filters.origin } : {}),
          ...(filters.type ? { type: filters.type } : {}),
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

  const runDiscovery = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await runDsarDiscovery(requestId)
      if (result.request) setRequest(result.request)
      const found = result.discovery?.counts?.total ?? 0
      setNotice(
        `Discovery complete — ${found} location(s) recorded as evidence. The request is now in DISCOVERY` +
          (canWriteItems
            ? ', so item actions and packaging are available.'
            : '. Acting on the located items is a data-team step.'),
      )
      loadItems()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // ACCESS builds the package and lands in REVIEW; ERASE runs the purge and
  // issues a certificate. A partial purge deliberately stays EXECUTING and
  // returns no request — say so rather than reporting a completion.
  const runExecute = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await executeDsar(requestId)
      if (result.request) setRequest(result.request)
      else setRequest(await getDsar(requestId))

      if (result.package) {
        setNotice(
          'Access package built. The subject can now mint a single-use download link from their own portal — nothing is sent to them from here.',
        )
      } else if (result.purgeJob) {
        setNotice(
          result.certificateId
            ? 'Purge complete and a deletion certificate was issued. The request is in REVIEW.'
            : `Purge is ${result.purgeJob.status ?? result.status ?? 'incomplete'} — the request stays EXECUTING because the data is not fully gone. Re-run Execute to resume.`,
        )
      } else {
        setNotice('Request executed and moved to REVIEW.')
      }
      loadItems()
      if ((tab === 'actions' || tab === 'close') && canReadItems) {
        listDsarItemActions(requestId).then(setActions).catch(setError)
      }
    } catch (err) {
      setError(err)
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

  const fileEvidence = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await attachDsarEvidence(requestId, { kind: draft.kind, label: draft.label.trim() })
      setNotice('Evidence filed. The vault stores a hash of the record, not the record itself.')
      setDraft((d) => ({ ...d, label: '' }))
      loadEvidence()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Two endpoints, one intent. `POST /close` is dpo/dataAdmin/super_admin;
  // `POST /approve` is dpo/dataOwner/super_admin and the service implements it
  // as the same REVIEW → CLOSED transition, so a dataOwner signs a request off
  // through approve. dpo has both — close is the more specific one, so it wins.
  const doClose = async () => {
    setBusy(true)
    setError(null)
    try {
      const updated = canClose
        ? await closeDsar(requestId, closeNote || undefined)
        : await approveDsar(requestId, closeNote || undefined)
      setRequest(updated)
      setNotice(canClose ? 'Request closed.' : 'Request signed off and closed.')
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

        {/* The lifecycle strip. A DSAR only becomes actionable once discovery has
            run, so a RECEIVED request rendered nothing but disabled buttons and
            an operator had no way to tell that the fix was one step, not a
            permission problem. */}
        {request && (
          <div className="mt-5 flex flex-wrap items-start justify-between gap-3 rounded-card bg-surface px-4 py-3 shadow-card">
            <p className="max-w-2xl text-xs font-medium text-ink-muted">
              {STATUS_GUIDANCE[request.status] ?? ''}
            </p>

            {(canRunDiscovery || canExecute) && (
              <div className="flex shrink-0 items-center gap-2">
                {canRunDiscovery && DISCOVERY_STATUSES.includes(request.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={runDiscovery}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-bold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Search size={13} />
                    {request.status === 'DISCOVERY' ? 'Re-run discovery' : 'Run discovery'}
                  </button>
                )}
                {canExecute && EXECUTE_STATUSES.includes(request.status) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={runExecute}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Play size={13} /> Execute request
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex gap-1 border-b border-border">
          {tabs.map((t) => (
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
                <select
                  className={FIELD_CLASS}
                  value={filters.type}
                  onChange={(e) => {
                    clearSelection()
                    setFilters((f) => ({ ...f, type: e.target.value }))
                  }}
                >
                  <option value="">All types</option>
                  {ITEM_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
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

              {canWriteItems ? (
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
              ) : (
                <p className="inline-flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted">
                  <Lock size={13} /> Read-only view. Building the response package is a data-team
                  action.
                </p>
              )}
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
                      type: filters.type || undefined,
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
              disabled={!actionable || !canWriteItems}
              disabledReason={
                !canWriteItems
                  ? 'Redact, delete and mark-for-export are data-team actions. This role has oversight of the grid and the action log, not the authority to act on a frame.'
                  : request &&
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

        {tab === 'evidence' && (
          <section className="mt-6 space-y-4">
            <div className="rounded-card bg-surface p-6 shadow-card">
              <h2 className="text-base font-bold text-ink">Evidence filed against this request</h2>
              <p className="mt-2 text-sm font-medium text-ink-muted">
                The vault holds a hash and a label for each record, never the record itself. That is
                what lets an auditor be shown the proof trail without being shown the data the
                request was about.
              </p>

              {!evidence ? (
                <div className="mt-4 h-3 w-1/3 animate-pulse rounded bg-canvas" />
              ) : evidence.items.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="No evidence yet"
                    message="Running discovery files its result here automatically. Anything else — an identity proof, a piece of correspondence — is filed by hand."
                  />
                </div>
              ) : (
                <ul className="mt-4 divide-y divide-border">
                  {evidence.items.map((e) => (
                    <li key={e.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">{e.label}</p>
                        <StatusPill tone="neutral">{e.kind}</StatusPill>
                      </div>
                      <p className="mt-1 font-mono text-xs font-medium text-ink-faint">
                        {new Date(e.createdAt).toLocaleString()} · {e.contentHash?.slice(0, 16)}…
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canFileEvidence && (
              <form onSubmit={fileEvidence} className="rounded-card bg-surface p-6 shadow-card">
                <h2 className="text-base font-bold text-ink">File a piece of evidence</h2>
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <select
                    className={FIELD_CLASS}
                    value={draft.kind}
                    onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                  >
                    {EVIDENCE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k.replace(/_/g, ' ').toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <input
                    value={draft.label}
                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                    placeholder="What this record is — at least 3 characters"
                    className="min-w-64 flex-1 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                  <button
                    type="submit"
                    disabled={busy || draft.label.trim().length < 3}
                    className="rounded-lg bg-brand px-4 py-1.5 text-xs font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    File evidence
                  </button>
                </div>
              </form>
            )}

            {certificate && (
              <div className="rounded-card bg-surface p-6 shadow-card">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-base font-bold text-ink">Deletion certificate</h2>
                  <StatusPill tone={certificate.verification?.valid ? 'success' : 'danger'}>
                    {certificate.verification?.valid ? 'Signature verified' : 'Signature invalid'}
                  </StatusPill>
                </div>
                <p className="mt-2 font-mono text-xs font-medium text-ink-faint">
                  {certificate.certificate?.id}
                </p>
                <p className="mt-2 text-sm font-medium text-ink-muted">
                  Issued {new Date(certificate.certificate?.createdAt).toLocaleString()}. The public
                  half of the signing key is served at <code>/api/v1/dsar/signing-key</code>, so the
                  principal can verify this without asking us to verify it for them.
                </p>
              </div>
            )}
          </section>
        )}

        {tab === 'close' && (
          <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">
              {canClose ? 'Close this request' : 'Sign this request off'}
            </h2>
            <p className="mt-2 text-sm font-medium text-ink-muted">
              {canClose
                ? 'Closing declares the work finished. It is refused while any item action is still queued or running — a request closed over in-flight deletions would record a completion that had not happened.'
                : 'Signing off declares the work finished and closes the request. An erasure is refused unless a deletion certificate has been issued — a closure with no proof behind it is not a closure.'}
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
              {request?.coarseStatus === 'CLOSED'
                ? 'Already closed'
                : canClose
                  ? 'Close request'
                  : 'Sign off and close'}
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
          title={canClose ? 'Close this request?' : 'Sign this request off?'}
          confirmLabel={canClose ? 'Close' : 'Sign off'}
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
