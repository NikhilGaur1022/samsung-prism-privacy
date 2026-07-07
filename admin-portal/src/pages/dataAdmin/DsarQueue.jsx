import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { DSAR_QUEUE } from '../../data/dataAdmin'

const STATUS_TONE = { discovery: 'warning', ready: 'brand', closed: 'success' }
const STATUS_LABEL = { discovery: 'In discovery', ready: 'Ready to action', closed: 'Closed' }

export default function DsarQueue() {
  const { data, loading, error } = useMockQuery(() => fetchMock(DSAR_QUEUE), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="DSAR Queue"
          subtitle="All open data subject access requests awaiting action."
        />

        <div className="mt-6">
          <ListPanel
            title="Open Requests"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="Queue is empty"
            renderRow={(r) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {r.subject} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {r.locations} locations affected
                  </p>
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
