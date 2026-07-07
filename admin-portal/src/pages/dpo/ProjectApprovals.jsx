import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { PROJECT_APPROVALS } from '../../data/dpo'
import { Check, X } from 'lucide-react'

const RISK_TONE = { high: 'danger', medium: 'warning', low: 'success' }
const STATUS_TONE = { approved: 'success', rejected: 'danger' }

export default function ProjectApprovals() {
  const [projects, setProjects] = useMockStore('dpo-project-approvals', PROJECT_APPROVALS)

  const decide = (id, status) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status } : p)))
  }

  const pending = projects.filter((p) => p.status === 'pending')
  const decided = projects.filter((p) => p.status !== 'pending')

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Project Approvals"
          subtitle="Review new data collection projects before they can start."
        />

        <div className="mt-6">
          <ListPanel
            title={`Pending Approval (${pending.length})`}
            rows={pending}
            emptyTitle="All caught up"
            emptyMessage="No projects are waiting on your review."
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                    <StatusPill tone={RISK_TONE[p.risk]}>{p.risk} risk</StatusPill>
                  </div>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {p.owner} · submitted {p.submitted}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => decide(p.id, 'approved')}
                    className="flex items-center gap-1.5 rounded-lg bg-success-soft px-3 py-1.5 text-xs font-semibold text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success"
                  >
                    <Check size={14} strokeWidth={2} /> Approve
                  </button>
                  <button
                    onClick={() => decide(p.id, 'rejected')}
                    className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                  >
                    <X size={14} strokeWidth={2} /> Reject
                  </button>
                </div>
              </div>
            )}
          />
        </div>

        {decided.length > 0 && (
          <div className="mt-6">
            <ListPanel
              title="Recently Decided"
              rows={decided}
              renderRow={(p) => (
                <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                </div>
              )}
            />
          </div>
        )}
      </main>
    </div>
  )
}
