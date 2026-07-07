import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { COMPLIANCE_REPORTS } from '../../data/dpo'
import { Download } from 'lucide-react'

export default function ComplianceReports() {
  const { data, loading, error } = useMockQuery(() => fetchMock(COMPLIANCE_REPORTS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Compliance Reports"
          subtitle="Generated summaries for regulators, audits, and internal review."
        />

        <div className="mt-6">
          <ListPanel
            title="Reports"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="No reports generated yet"
            renderRow={(r) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {r.type} · generated {r.generated}
                  </p>
                </div>
                <button
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  aria-label={`Download ${r.title}`}
                >
                  <Download size={14} strokeWidth={2} /> Download
                </button>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
