import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatCard from '../../components/StatCard'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { getDsarSla } from '../../lib/api'

export default function SlaMonitoring() {
  const { data, loading, error } = useMockQuery(() => getDsarSla(), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="SLA Monitoring"
          subtitle="Turnaround performance against the statutory and internal response windows."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {loading || !data ? (
          <div className="mt-6 grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-4">
              <StatCard label={`Open requests (${data.statutoryDays}-day statutory clock)`} value={data.open} />
              <StatCard label="SLA breached" value={data.breached} />
              <StatCard label={`Past internal target (${data.internalTargetDays}d)`} value={data.internalBreached} />
            </div>

            <div className="mt-6">
              <ListPanel
                title="Open requests"
                rows={data.requests}
                emptyTitle="Nothing open"
                emptyMessage="No open DSAR requests."
                renderRow={(r) => (
                  <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">
                        {r.subjectRef} — {r.type}
                      </p>
                      <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                        {r.status} · SLA due {new Date(r.slaDueAt).toLocaleDateString()}
                      </p>
                    </div>
                    <StatusPill tone={r.breached ? 'danger' : r.internalBreached ? 'warning' : 'success'}>
                      {r.breached
                        ? 'Breached'
                        : r.internalBreached
                          ? 'Past internal target'
                          : `${r.daysRemaining}d left`}
                    </StatusPill>
                  </div>
                )}
              />
            </div>
          </>
        )}
      </main>
    </div>
  )
}
