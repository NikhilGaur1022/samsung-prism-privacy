import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { PROCESSED_DATA } from '../../data/dataOwner'

const STATUS_TONE = { ready: 'success', processing: 'warning' }
const STATUS_LABEL = { ready: 'Ready', processing: 'Processing' }

export default function ProcessedData() {
  const { data, loading, error } = useMockQuery(() => fetchMock(PROCESSED_DATA), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Processed Data"
          subtitle="Collected assets after ingestion, labeling, and QA processing."
        />

        <div className="mt-6">
          <ListPanel
            title="Processed Assets"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="Nothing processed yet"
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.project}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {p.assets} assets · last processed {p.lastProcessed}
                  </p>
                </div>
                <StatusPill tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
