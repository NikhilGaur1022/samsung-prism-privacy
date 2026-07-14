import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listProjects, searchProjectSubjects } from '../../lib/api'

const FIELD_CLASS =
  'w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const VERDICT = {
  ELIGIBLE: { tone: 'success', label: 'Consent given', icon: ShieldCheck },
  NO_CONSENT: { tone: 'danger', label: 'Consent not given', icon: ShieldOff },
  REVOKED: { tone: 'danger', label: 'Consent revoked', icon: ShieldOff },
  SUBJECT_INACTIVE: { tone: 'neutral', label: 'Subject not active', icon: ShieldOff },
}

// Read-only. Consent is granted by the subject in their own portal — an agent can
// never grant it on someone's behalf, only look up where a person stands.
export default function ConsentCheck() {
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState('')
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listProjects()
      .then((res) => {
        setProjects(res.items)
        setProjectId(res.items[0]?.id ?? '')
        if (res.items.length === 0) setLoading(false)
      })
      .catch((err) => {
        setError(err)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    const handle = setTimeout(() => {
      searchProjectSubjects(projectId, query.trim())
        .then((res) => setPeople(res.items))
        .catch(setError)
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(handle)
  }, [projectId, query])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Consent Check"
          subtitle="Look up whether a person has consented to a project before you plan a session."
        />

        <div className="mt-6 grid max-w-2xl gap-3 sm:grid-cols-2">
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
          <input
            className={FIELD_CLASS}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email or employee ID"
          />
        </div>

        <div className="mt-6">
          <ListPanel
            title="People"
            rows={people}
            loading={loading}
            error={error}
            emptyIcon={ShieldOff}
            emptyTitle="No people found"
            emptyMessage="Search for someone registered as a data subject."
            renderRow={(person) => {
              const verdict = VERDICT[person.verdict]
              const Icon = verdict.icon
              return (
                <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{person.fullName}</p>
                    <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                      {person.email} · {person.group}
                    </p>
                  </div>
                  <StatusPill tone={verdict.tone} className="gap-1.5">
                    <Icon size={13} strokeWidth={2} /> {verdict.label}
                  </StatusPill>
                </div>
              )
            }}
          />
        </div>
      </main>
    </div>
  )
}
