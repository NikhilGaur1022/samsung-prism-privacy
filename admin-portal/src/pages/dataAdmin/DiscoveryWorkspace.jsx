import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { DISCOVERY_ITEMS } from '../../data/dataAdmin'

export default function DiscoveryWorkspace() {
  const { data, loading, error } = useMockQuery(() => fetchMock(DISCOVERY_ITEMS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Discovery Workspace"
          subtitle="Systems matched to a data subject across the estate for open requests."
        />

        <div className="mt-6">
          <ListPanel
            title="Matched Locations"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="No matches found"
            emptyMessage="Run discovery on a request to see matched systems here."
            renderRow={(d) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{d.system}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {d.request} · {d.matchType}
                  </p>
                </div>
                <StatusPill tone="brand">{d.records} records</StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
