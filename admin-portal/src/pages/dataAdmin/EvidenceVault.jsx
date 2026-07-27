import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listDsar, getDsar, attachDsarEvidence, listDsarEvidence } from '../../lib/api'
import { Lock, FileCheck2, Plus } from 'lucide-react'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
const FILTER_FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
const EVIDENCE_KINDS = ['DISCOVERY_RESULT', 'IDENTITY_PROOF', 'EXPORT_PACKAGE', 'PURGE_REPORT', 'CORRESPONDENCE', 'APPROVAL']
const STATUS_TONE = {
  RECEIVED: 'neutral', TRIAGE: 'neutral', DISCOVERY: 'warning',
  EXECUTING: 'warning', REVIEW: 'brand', CLOSED: 'success', REJECTED: 'danger',
}

// The default view: every evidence record this admin can see, across DSAR
// requests, filterable by kind and (optionally) a specific request. Picking a
// request is no longer a precondition for seeing anything in the vault.
function VaultListing({ onSelectRequest }) {
  const [kind, setKind] = useState('')
  const [requestId, setRequestId] = useState('')
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setItems(null)
    setError(null)
    const params = { limit: '100' }
    if (kind) params.kind = kind
    if (requestId.trim()) params.dsarRequestId = requestId.trim()
    listDsarEvidence(params).then((r) => setItems(r.items)).catch(setError)
  }, [kind, requestId])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <ListPanel
      title="Evidence vault"
      action={
        <form
          onSubmit={(e) => {
            e.preventDefault()
            reload()
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <select className={FILTER_FIELD_CLASS} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            className={FILTER_FIELD_CLASS}
            placeholder="Request ID"
            value={requestId}
            onChange={(e) => setRequestId(e.target.value)}
          />
          <button
            type="submit"
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Filter
          </button>
        </form>
      }
      rows={items ?? []}
      loading={!items && !error}
      error={error}
      emptyIcon={Lock}
      emptyTitle="No evidence in the vault"
      emptyMessage="Nothing matches these filters yet."
      renderRow={(e) => (
        <button
          onClick={() => onSelectRequest(e.dsarRequestId)}
          className="flex w-full items-center gap-3 py-4 text-left first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {e.hasFile ? (
            <FileCheck2 size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-success" />
          ) : (
            <Lock size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-faint" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{e.label}</p>
            <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
              {e.kind} · {e.subjectRef} · {e.requestType} · attached {new Date(e.createdAt).toLocaleString()}
            </p>
          </div>
          <StatusPill tone={STATUS_TONE[e.requestStatus]} className="shrink-0">
            {e.requestStatus}
          </StatusPill>
        </button>
      )}
    />
  )
}

// The per-request drill-down: sealed evidence for one DSAR request, plus the
// form to attach a new record to it. Selecting a request here is inherent to
// attaching evidence — it is no longer required just to browse the vault.
function RequestDrilldown({ requests, selectedId, setSelectedId }) {
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState(null)
  const [kind, setKind] = useState(EVIDENCE_KINDS[0])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const reloadDetail = useCallback(() => {
    if (!selectedId) return
    setDetailError(null)
    getDsar(selectedId).then(setDetail).catch(setDetailError)
  }, [selectedId])

  useEffect(() => {
    setDetail(null)
    reloadDetail()
  }, [selectedId, reloadDetail])

  const attach = async (e) => {
    e.preventDefault()
    setBusy(true)
    setDetailError(null)
    try {
      await attachDsarEvidence(selectedId, { kind, label: label.trim() })
      setLabel('')
      await reloadDetail()
    } catch (err) {
      setDetailError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
      <label className="block text-sm font-semibold text-ink">
        DSAR request
        <select className={FIELD_CLASS} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          <option value="">— choose a request —</option>
          {(requests ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {(r.subjectRef ?? r.subjectId)} — {r.type} — {r.status}
            </option>
          ))}
        </select>
      </label>

      {detailError && <p className="mt-3 text-sm font-semibold text-danger">{detailError.message}</p>}

      {selectedId && (
        <form onSubmit={attach} className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-5">
          <label className="text-sm font-semibold text-ink">
            Kind
            <select className={FIELD_CLASS} value={kind} onChange={(e) => setKind(e.target.value)}>
              {EVIDENCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-ink">
            Label
            <input
              className={FIELD_CLASS}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              minLength={3}
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            <Plus size={14} strokeWidth={2} /> Attach
          </button>
        </form>
      )}

      {selectedId && (
        <div className="mt-6">
          <ListPanel
            title="Sealed evidence for this request"
            rows={detail?.evidence ?? []}
            loading={selectedId && !detail && !detailError}
            emptyIcon={Lock}
            emptyTitle="No evidence attached yet"
            renderRow={(e) => (
              <div className="flex items-center gap-3 py-4 first:pt-0 last:pb-0">
                <Lock size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-faint" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{e.label}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {e.kind} · attached {new Date(e.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            )}
          />
        </div>
      )}
    </div>
  )
}

export default function EvidenceVault() {
  const [requests, setRequests] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState('')

  const reloadRequests = useCallback(() => listDsar().then((r) => setRequests(r.items)).catch(setError), [])

  useEffect(() => {
    reloadRequests()
  }, [reloadRequests])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Evidence Vault"
          subtitle="Proof bundles across every DSAR request — discovery results, identity proofs, export and purge reports. Pick a row to attach more or view a request's full seal."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <VaultListing onSelectRequest={setSelectedId} />
        </div>

        <RequestDrilldown requests={requests} selectedId={selectedId} setSelectedId={setSelectedId} />
      </main>
    </div>
  )
}
