import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { DATA_REQUIREMENTS } from '../../data/dataOwner'

const STATUS_TONE = { met: 'success', at_risk: 'warning' }
const STATUS_LABEL = { met: 'Met', at_risk: 'At risk' }

export default function DataRequirements() {
  const { data, loading, error } = useMockQuery(() => fetchMock(DATA_REQUIREMENTS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Data Requirements"
          subtitle="Collection criteria each project must satisfy before it's considered complete."
        />

        <div className="mt-6">
          <ListPanel
            title="Requirements"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="No requirements defined"
            renderRow={(r) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{r.requirement}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">{r.project}</p>
                </div>
                <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
