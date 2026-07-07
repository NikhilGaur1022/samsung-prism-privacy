import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { COLLECTION_PROGRESS } from '../../data/dataOwner'

export default function CollectionProgress() {
  const { data, loading } = useMockQuery(() => fetchMock(COLLECTION_PROGRESS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Collection Progress"
          subtitle="Live progress toward each project's collection target."
        />

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
          ) : (
            <div className="space-y-5">
              {data.map((p) => {
                const pct = Math.round((p.collected / p.target) * 100)
                return (
                  <div key={p.id}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-ink">{p.project}</span>
                      <span className="font-semibold text-ink-muted">
                        {p.collected.toLocaleString()} / {p.target.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-pill bg-canvas">
                      <div
                        className={`h-2 rounded-pill ${pct >= 100 ? 'bg-success' : 'bg-brand'}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
