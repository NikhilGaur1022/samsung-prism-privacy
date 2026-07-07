import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { REQUEST_OVERSIGHT } from '../../data/dpo'

const STATUS_TONE = { review: 'brand', in_progress: 'warning', overdue: 'danger' }
const STATUS_LABEL = { review: 'Needs review', in_progress: 'In progress', overdue: 'Overdue' }

export default function RequestOversight() {
  const { data, loading, error } = useMockQuery(() => fetchMock(REQUEST_OVERSIGHT), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Request Oversight"
          subtitle="DSAR requests flagged for legal review or running against SLA."
        />

        <div className="mt-6">
          <ListPanel
            title="Flagged Requests"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="Nothing flagged"
            emptyMessage="Requests needing legal oversight will appear here."
            renderRow={(r) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {r.subject} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {r.locations} locations · SLA due {r.slaDue}
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
