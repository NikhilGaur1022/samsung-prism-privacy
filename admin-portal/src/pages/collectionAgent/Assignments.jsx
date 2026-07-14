import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderKanban, PlayCircle } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listProjects } from '../../lib/api'

export default function Assignments() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listProjects()
      .then((res) => setProjects(res.items))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Assignments"
          subtitle="The projects you are assigned to. You can only run sessions for these."
        />

        <div className="mt-6">
          <ListPanel
            title="My projects"
            rows={projects}
            loading={loading}
            error={error}
            emptyIcon={FolderKanban}
            emptyTitle="No projects assigned"
            emptyMessage="A Data Owner has to assign you to a project before you can collect for it."
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} · {p.consentCount} consented
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusPill tone={p.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    {p.status}
                  </StatusPill>
                  <button
                    onClick={() => navigate('/new-session', { state: { projectId: p.id } })}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <PlayCircle size={14} strokeWidth={2} /> Start session
                  </button>
                </div>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
