import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { AUDIT_LOG } from '../../data/dataAdmin'

export default function AuditLogs() {
  const { data, loading, error } = useMockQuery(() => fetchMock(AUDIT_LOG), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Audit Logs"
          subtitle="Hash-chained, append-only record of every privacy-relevant action."
        />

        <div className="mt-6">
          <ListPanel
            title="Recent Activity"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="No activity recorded yet"
            renderRow={(l) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{l.action}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {l.actor} · {l.time}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-faint">{l.hash}</span>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
