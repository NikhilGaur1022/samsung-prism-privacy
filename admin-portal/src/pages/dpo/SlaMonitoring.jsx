import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatCard from '../../components/StatCard'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { SLA_METRICS } from '../../data/dpo'

export default function SlaMonitoring() {
  const { data, loading } = useMockQuery(() => fetchMock(SLA_METRICS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="SLA Monitoring"
          subtitle="Turnaround performance against DPDP-mandated response windows."
        />

        {loading || !data ? (
          <div className="mt-6 grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-4">
              <StatCard label="Overall SLA Compliance" value={`${data.compliance}%`} />
              <StatCard label="Breached This Month" value={data.breachedThisMonth} />
              <StatCard label="Avg. Resolution (days)" value={data.avgResolutionDays} />
            </div>

            <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
              <h2 className="text-base font-bold text-ink">Compliance by Request Type</h2>
              <div className="mt-4 space-y-4">
                {data.byType.map((row) => (
                  <div key={row.label}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-ink">{row.label}</span>
                      <span className="font-semibold text-ink-muted">{row.value}%</span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-pill bg-canvas">
                      <div
                        className="h-2 rounded-pill bg-brand"
                        style={{ width: `${row.value}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
