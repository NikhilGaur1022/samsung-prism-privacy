import { useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockStore } from '../../lib/mockStore'
import { ASSIGNMENTS } from '../../data/collectionAgent'
import { PlayCircle } from 'lucide-react'

const PROJECTS = ['XR Research 2026', 'Camera Quality Study', 'Mobile Capture Program']
const DATA_TYPES = ['XR Session', 'DSLR Photos', 'iPhone Media']

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function NewSession() {
  const [, setAssignments] = useMockStore('collection-agent-assignments', ASSIGNMENTS)
  const [project, setProject] = useState(PROJECTS[0])
  const [dataType, setDataType] = useState(DATA_TYPES[0])
  const [location, setLocation] = useState('')
  const [started, setStarted] = useState(null)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!location.trim()) return

    const code = `COL-${Math.floor(2000 + Math.random() * 999)}`
    setAssignments((prev) => [
      { id: code.toLowerCase(), code, project, dataType, location: location.trim(), status: 'consent_check' },
      ...prev,
    ])
    setStarted(code)
    setLocation('')
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="New Session"
          subtitle="Start a new collection session for one of your assigned projects."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          {started && (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-semibold text-success">
              <PlayCircle size={16} strokeWidth={2} />
              Session {started} started — continue to Consent Check next.
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <label className="block text-sm font-semibold text-ink">
              Project
              <select
                className={FIELD_CLASS}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                {PROJECTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Data type
              <select
                className={FIELD_CLASS}
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
              >
                {DATA_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
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
                required
              />
            </label>

            <button
              type="submit"
              className="mt-6 flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <PlayCircle size={16} strokeWidth={2} /> Start session
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
