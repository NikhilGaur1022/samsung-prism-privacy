import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PlayCircle } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { createSession, listProjects } from '../../lib/api'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function NewSession() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(state?.projectId ?? '')
  const [location, setLocation] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    listProjects()
      .then((res) => {
        setProjects(res.items)
        setProjectId((current) => current || res.items[0]?.id || '')
      })
      .catch(setError)
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!projectId) return

    setSubmitting(true)
    setError(null)
    try {
      const session = await createSession({ projectId, location: location.trim() || undefined })
      navigate(`/sessions/${session.id}`)
    } catch (err) {
      setError(err)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="New Session"
          subtitle="Start a collection session for one of your assigned projects."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          {error && (
            <div className="mb-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
              {error.message}
            </div>
          )}

          {projects.length === 0 ? (
            <p className="text-sm font-medium text-ink-muted">
              You have no assigned projects yet — nothing to collect for.
            </p>
          ) : (
            <form onSubmit={handleSubmit}>
              <label className="block text-sm font-semibold text-ink">
                Project
                <select
                  className={FIELD_CLASS}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mt-4 block text-sm font-semibold text-ink">
                Location
                <input
                  className={FIELD_CLASS}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Bengaluru Studio A"
                />
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <PlayCircle size={16} strokeWidth={2} />
                {submitting ? 'Starting…' : 'Start session'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
