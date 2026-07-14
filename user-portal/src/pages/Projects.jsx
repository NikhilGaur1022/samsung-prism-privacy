import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ScanFace } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { listConsentProjects } from '../lib/api'

const CONSENT_BADGE = {
  ACTIVE: { tone: 'success', label: 'CONSENT GIVEN' },
  REVOKED: { tone: 'danger', label: 'REVOKED' },
  PURGED: { tone: 'neutral', label: 'PURGED' },
}

const NOT_GIVEN = { tone: 'neutral', label: 'NOT GIVEN' }

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listConsentProjects()
      .then((res) => setProjects(res.items))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <TopBar title="Projects" />
      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Projects</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Projects asking for your data. You decide which ones may use it.
        </p>

        {error && (
          <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>
        )}

        {loading ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">No projects are asking for your data yet.</p>
        ) : (
          <div className="mt-5 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {projects.map((project) => {
              const badge = project.consent
                ? CONSENT_BADGE[project.consent.status]
                : NOT_GIVEN
              return (
                <Link
                  key={project.id}
                  to={`/consent/${project.id}`}
                  className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <Card className="flex items-center gap-3">
                    <IconChip icon={ScanFace} tone="brand" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{project.name}</p>
                      <p className="truncate text-xs font-medium text-ink-muted">{project.purpose}</p>
                    </div>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </Card>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
