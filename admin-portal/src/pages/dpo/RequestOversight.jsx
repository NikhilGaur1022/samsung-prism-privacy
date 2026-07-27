import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listDsar } from '../../lib/api'

const STATUS_TONE = {
  RECEIVED: 'neutral',
  TRIAGE: 'neutral',
  DISCOVERY: 'warning',
  EXECUTING: 'warning',
  REVIEW: 'brand',
  CLOSED: 'success',
  REJECTED: 'danger',
}

export default function RequestOversight() {
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setData(null)
    setError(null)
    listDsar(overdueOnly ? { overdue: 'true' } : {})
      .then((r) => setData(r.items))
      .catch(setError)
  }, [overdueOnly])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Request Oversight"
          subtitle="DSAR requests visible for legal review. Subjects are shown only as a pseudonymous reference."
          action={
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
              <input
                type="checkbox"
                checked={overdueOnly}
                onChange={(e) => setOverdueOnly(e.target.checked)}
              />
              Overdue only
            </label>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Requests"
            rows={data ?? []}
            loading={!data && !error}
            emptyTitle="Nothing here"
            emptyMessage="No DSAR requests match this filter."
            renderRow={(r) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {r.subjectRef} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    SLA due {new Date(r.sla.dueAt).toLocaleDateString()}
                    {r.sla.breached ? ' · breached' : ` · ${r.sla.daysRemaining}d remaining`}
                  </p>
                </div>
                <StatusPill tone={r.sla.breached ? 'danger' : STATUS_TONE[r.status]}>
                  {r.sla.breached ? 'SLA breached' : r.status}
                </StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
