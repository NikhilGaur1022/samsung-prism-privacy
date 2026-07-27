import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import { listAudit } from '../../lib/api'

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function AuditLogs() {
  const [entityType, setEntityType] = useState('')
  const [action, setAction] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setData(null)
    setError(null)
    const params = { limit: '100' }
    if (entityType.trim()) params.entityType = entityType.trim()
    if (action.trim()) params.action = action.trim()
    listAudit(params).then((r) => setData(r.items)).catch(setError)
  }, [entityType, action])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Audit Logs"
          subtitle="Hash-chained, append-only record of every privacy-relevant action."
          action={
            <form
              onSubmit={(e) => {
                e.preventDefault()
                reload()
              }}
              className="flex gap-2"
            >
              <input
                className={FIELD_CLASS}
                placeholder="Entity type"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              />
              <input
                className={FIELD_CLASS}
                placeholder="Action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
              <button
                type="submit"
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                Filter
              </button>
            </form>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Recent activity"
            rows={data ?? []}
            loading={!data && !error}
            emptyTitle="No activity recorded yet"
            renderRow={(l) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{l.action}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {l.entityType} · {new Date(l.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-faint">{l.payloadHash.slice(0, 12)}</span>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
