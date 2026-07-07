import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { ASSIGNMENTS } from '../../data/collectionAgent'

const STATUS_TONE = { ready: 'brand', uploading: 'warning', consent_check: 'neutral' }
const STATUS_LABEL = { ready: 'Ready', uploading: 'Uploading', consent_check: 'Consent check' }

export default function Assignments() {
  const [assignments] = useMockStore('collection-agent-assignments', ASSIGNMENTS)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Assignments"
          subtitle="Collection sessions assigned to you today."
        />

        <div className="mt-6">
          <ListPanel
            title="Today"
            rows={assignments}
            emptyTitle="No assignments today"
            renderRow={(a) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {a.code} — {a.project}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {a.dataType} · {a.location}
                  </p>
                </div>
                <StatusPill tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
