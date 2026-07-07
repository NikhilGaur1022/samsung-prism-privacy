import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { PURGE_JOBS } from '../../data/dataAdmin'
import { Trash2, Download } from 'lucide-react'

const STAGE_TONE = {
  soft_delete: 'warning',
  awaiting_confirmation: 'danger',
  export_ready: 'brand',
  hard_deleted: 'success',
}
const STAGE_LABEL = {
  soft_delete: 'Soft-deleted — grace period',
  awaiting_confirmation: 'Awaiting confirmation',
  export_ready: 'Export ready',
  hard_deleted: 'Hard-deleted',
}

export default function PurgeExport() {
  const [jobs, setJobs] = useMockStore('data-admin-purge-jobs', PURGE_JOBS)

  const confirmHardDelete = (id) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === id ? { ...j, stage: 'hard_deleted', scheduledHardDelete: null } : j)),
    )
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Purge / Export"
          subtitle="Erasure jobs move through a soft-delete grace period before hard deletion; access requests generate an export bundle."
        />

        <div className="mt-6">
          <ListPanel
            title="Active Jobs"
            rows={jobs}
            emptyTitle="No jobs in flight"
            renderRow={(j) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{j.subject}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {j.scope}
                    {j.scheduledHardDelete && ` · hard delete scheduled ${j.scheduledHardDelete}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusPill tone={STAGE_TONE[j.stage]}>{STAGE_LABEL[j.stage]}</StatusPill>
                  {j.stage === 'awaiting_confirmation' && (
                    <button
                      onClick={() => confirmHardDelete(j.id)}
                      className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                    >
                      <Trash2 size={14} strokeWidth={2} /> Confirm hard delete
                    </button>
                  )}
                  {j.stage === 'export_ready' && (
                    <button className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                      <Download size={14} strokeWidth={2} /> Download
                    </button>
                  )}
                </div>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
