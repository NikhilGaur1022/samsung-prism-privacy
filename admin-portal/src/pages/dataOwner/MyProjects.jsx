import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { MY_PROJECTS } from '../../data/dataOwner'

const STATUS_TONE = { active: 'brand', processing: 'warning', pending_approval: 'neutral' }
const STATUS_LABEL = {
  active: 'Active',
  processing: 'Processing',
  pending_approval: 'Awaiting DPO approval',
}

export default function MyProjects() {
  const [projects] = useMockStore('data-owner-projects', MY_PROJECTS)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="My Projects"
          subtitle="Data collection projects you own, from approval through processing."
        />

        <div className="mt-6">
          <ListPanel
            title="Projects"
            rows={projects}
            emptyTitle="No projects yet"
            emptyMessage="Create a project to start collecting data."
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {p.dataType}
                    {p.status !== 'pending_approval' && ` · ${p.progress}% collected`}
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
