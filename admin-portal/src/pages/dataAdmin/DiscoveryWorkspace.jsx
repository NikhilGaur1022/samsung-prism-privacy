import { useCallback, useEffect, useState } from 'react'
import { Inbox, Loader2 } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { getHandoff, ingestHandoff, listHandoffs } from '../../lib/api'

const STATUS_TONE = { PENDING_INGEST: 'warning', INGESTED: 'success', REJECTED: 'danger' }
const STATUS_LABEL = { PENDING_INGEST: 'Awaiting ingest', INGESTED: 'Ingested', REJECTED: 'Rejected' }

function BatchDetail({ handoffId, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    getHandoff(handoffId).then(setData).catch(setError)
  }, [handoffId])

  return (
    <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-bold text-ink">
          Consent-mapped batch{data ? ` — ${data.sessionCode}` : ''}
        </h2>
        <button
          onClick={onClose}
          className="text-xs font-semibold text-ink-faint hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Close
        </button>
      </div>

      {error && <p className="mt-3 text-sm font-semibold text-danger">{error.message}</p>}

      {!data ? (
        <Loader2 size={18} className="mt-4 animate-spin text-ink-faint" />
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-2 pr-4 font-bold uppercase tracking-wide">Subject</th>
                <th className="py-2 pr-4 font-bold uppercase tracking-wide">Photo</th>
                <th className="py-2 pr-4 font-bold uppercase tracking-wide">Consent</th>
                <th className="py-2 pr-4 font-bold uppercase tracking-wide">Policy</th>
                <th className="py-2 font-bold uppercase tracking-wide">Redacted copy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.links.map((link) => (
                <tr key={`${link.photoId}-${link.subjectId}`}>
                  <td className="py-2 pr-4 font-semibold text-ink">{link.subjectName}</td>
                  <td className="py-2 pr-4 font-mono text-ink-muted">{link.sha256.slice(0, 12)}</td>
                  <td className="py-2 pr-4 font-mono text-ink-muted">
                    {link.consentId.slice(0, 8)} · {link.consentStatus}
                  </td>
                  <td className="py-2 pr-4 text-ink-muted">{link.policyVersion}</td>
                  <td className="py-2 text-ink-muted">{link.hasRedacted ? 'Yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.links.length === 0 && (
            <p className="py-4 text-xs font-medium text-ink-faint">
              No consent-mapped photos in this batch.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function DiscoveryWorkspace() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState(null)

  const reload = useCallback(() => listHandoffs().then(setData).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  const handleIngest = async (id) => {
    setBusy(true)
    setError(null)
    try {
      await ingestHandoff(id)
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Discovery Workspace"
          subtitle="Finalized collection sessions handed off for consent mapping and redaction."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Handoff queue"
            rows={data?.items ?? []}
            loading={!data && !error}
            error={error}
            emptyTitle="Nothing awaiting ingest"
            emptyMessage="Finalized sessions appear here with their consent-mapped photo batch."
            renderRow={(h) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {h.sessionCode} — {h.projectName}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {h.photoCount} photos · {h.subjectCount} subjects · {h.linkCount} consent links ·{' '}
                    {new Date(h.emittedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</StatusPill>
                  <button
                    onClick={() => setOpenId(openId === h.id ? null : h.id)}
                    className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {openId === h.id ? 'Hide batch' : 'View batch'}
                  </button>
                  {h.status === 'PENDING_INGEST' && (
                    <button
                      onClick={() => handleIngest(h.id)}
                      disabled={busy}
                      className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                    >
                      <Inbox size={14} strokeWidth={2} /> Ingest
                    </button>
                  )}
                </div>
              </div>
            )}
          />
        </div>

        {openId && <BatchDetail handoffId={openId} onClose={() => setOpenId(null)} />}
      </main>
    </div>
  )
}
