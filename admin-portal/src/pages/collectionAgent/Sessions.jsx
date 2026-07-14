import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listSessions } from '../../lib/api'

const TONE = {
  ACTIVE: 'brand',
  PROCESSING: 'warning',
  TAGGING: 'warning',
  ARCHIVED: 'success',
  FAILED: 'danger',
}

const LABEL = {
  ACTIVE: 'Capturing',
  PROCESSING: 'Detecting faces',
  TAGGING: 'Needs tagging',
  ARCHIVED: 'Archived',
  FAILED: 'Failed',
}

export default function Sessions() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listSessions()
      .then((res) => setSessions(res.items))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  const open = (session) =>
    navigate(session.status === 'TAGGING' ? `/sessions/${session.id}/tagging` : `/sessions/${session.id}`)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader title="Sessions" subtitle="Every collection session you have run." />

        <div className="mt-6">
          <ListPanel
            title="My sessions"
            rows={sessions}
            loading={loading}
            error={error}
            emptyIcon={Camera}
            emptyTitle="No sessions yet"
            emptyMessage="Start one from New Session."
            renderRow={(s) => (
              <button
                onClick={() => open(s)}
                className="flex w-full items-center justify-between gap-4 py-4 text-left first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {s.code} — {s.project.name}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {s.participantCount} on roster · {s.photoCount} photo
                    {s.photoCount === 1 ? '' : 's'}
                    {s.location ? ` · ${s.location}` : ''}
                  </p>
                </div>
                <StatusPill tone={TONE[s.status]}>{LABEL[s.status]}</StatusPill>
              </button>
            )}
          />
        </div>
      </main>
    </div>
  )
}
