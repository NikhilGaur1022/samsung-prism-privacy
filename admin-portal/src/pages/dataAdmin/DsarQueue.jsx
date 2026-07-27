import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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

const STATUS_OPTIONS = ['RECEIVED', 'TRIAGE', 'DISCOVERY', 'EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED']
const TYPE_OPTIONS = ['ACCESS', 'CORRECT', 'ERASE', 'WITHDRAWAL_ERASURE', 'GRIEVANCE', 'NOMINATION']

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function DsarQueue() {
  const [status, setStatus] = useState('')
  const [type, setType] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setData(null)
    setError(null)
    const params = {}
    if (status) params.status = status
    if (type) params.type = type
    listDsar(params).then((r) => setData(r.items)).catch(setError)
  }, [status, type])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="DSAR Queue"
          subtitle="All open data subject access requests awaiting action."
          action={
            <div className="flex gap-2">
              <select className={FIELD_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <select className={FIELD_CLASS} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All types</option>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
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
            emptyTitle="Queue is empty"
            renderRow={(r) => (
              <Link
                to={`/purge-export?requestId=${r.id}`}
                className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {r.subjectId ?? r.subjectRef} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    SLA due {new Date(r.sla.dueAt).toLocaleDateString()}
                    {r.sla.breached && ' · breached'}
                  </p>
                </div>
                <StatusPill tone={r.sla.breached ? 'danger' : STATUS_TONE[r.status]}>
                  {r.sla.breached ? 'SLA breached' : r.status}
                </StatusPill>
              </Link>
            )}
          />
        </div>
      </main>
    </div>
  )
}
