import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listProjects, submitProject } from '../../lib/api'

const STATUS_TONE = { DRAFT: 'neutral', SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger', CLOSED: 'neutral' }

export default function MyProjects() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => listProjects().then((r) => setProjects(r.items)).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  const submit = async (id) => {
    setBusy(true)
    setError(null)
    try {
      await submitProject(id)
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="My Projects"
          subtitle="Data collection projects you own, from draft through approval and collection."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Projects"
            rows={projects ?? []}
            loading={!projects && !error}
            emptyTitle="No projects yet"
            emptyMessage="Create a project to start collecting data."
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} · {p.consentCount} consent
                    {p.consentCount === 1 ? '' : 's'}
                    {p.rejectionReason && ` · rejected: ${p.rejectionReason}`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                  {(p.status === 'DRAFT' || p.status === 'REJECTED') && (
                    <button
                      onClick={() => submit(p.id)}
                      disabled={busy}
                      className="rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      Submit for approval
                    </button>
                  )}
                  <Link
                    to="/data-requirements"
                    className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    Edit
                  </Link>
                </div>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
