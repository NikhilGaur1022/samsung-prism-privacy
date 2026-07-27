import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockQuery } from '../../lib/useMockQuery'
import { getDashboardSummary } from '../../lib/api'

export default function CollectionProgress() {
  const { data, loading, error } = useMockQuery(() => getDashboardSummary(), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Collection Progress"
          subtitle="Sessions and consented links recorded so far for each of your projects."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
          {loading || !data ? (
            <div className="space-y-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-3.5 w-2/5 rounded bg-canvas" />
                  <div className="mt-2 h-2 w-full rounded-pill bg-canvas" />
                </div>
              ))}
            </div>
          ) : (data.projects ?? []).length === 0 ? (
            <p className="text-sm font-medium text-ink-faint">No projects yet.</p>
          ) : (
            <div className="space-y-5">
              {data.projects.map((p) => (
                <div key={p.id}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">{p.name}</span>
                    <span className="font-semibold text-ink-muted">
                      {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} · {p.consentCount} consent
                      {p.consentCount === 1 ? '' : 's'} · {p.agentCount} agent{p.agentCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium text-ink-faint">{p.status}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
