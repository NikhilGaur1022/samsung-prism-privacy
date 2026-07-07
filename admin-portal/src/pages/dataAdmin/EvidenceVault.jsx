import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { EVIDENCE_ITEMS } from '../../data/dataAdmin'
import { Lock, Download } from 'lucide-react'

export default function EvidenceVault() {
  const { data, loading, error } = useMockQuery(() => fetchMock(EVIDENCE_ITEMS), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Evidence Vault"
          subtitle="Sealed proof bundles for completed DSAR actions — read-only once sealed."
        />

        <div className="mt-6">
          <ListPanel
            title="Sealed Evidence"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyIcon={Lock}
            emptyTitle="Vault is empty"
            emptyMessage="Evidence bundles are sealed automatically when a request is closed."
            renderRow={(e) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-3">
                  <Lock size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-faint" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{e.title}</p>
                    <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                      {e.kind} · sealed {e.sealed}
                    </p>
                  </div>
                </div>
                <button
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  aria-label={`Download ${e.title}`}
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
