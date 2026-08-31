import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Camera, Mic, FileText, Video, PlayCircle } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { createSession, listProjects } from '../../lib/api'

// The four capture modalities, as data rather than four near-identical copies of
// the same twenty lines of JSX — which is what this was, and is why adding a
// fourth was worth doing here rather than by pasting a third time.
//
// `route` is where a freshly created session of this type belongs: audio and text
// have dedicated workspaces, while image and video both use the general session
// page (the video panel already lives on it).
const SESSION_TYPES = [
  {
    value: 'IMAGE',
    label: 'Image',
    Icon: Camera,
    blurb: 'Face recognition, blurring, and visual PII masking.',
  },
  {
    value: 'VIDEO',
    label: 'Video',
    Icon: Video,
    blurb: 'Face tracking and blurring across frames. Clips must be silent.',
  },
  {
    value: 'AUDIO',
    label: 'Audio',
    Icon: Mic,
    blurb: 'Diarization, voice matching, and spoken PII muting.',
  },
  {
    value: 'TEXT',
    label: 'Text',
    Icon: FileText,
    blurb: 'Subject quote tagging, unconsented & PII text redaction.',
  },
]

const ROUTE_FOR = { AUDIO: 'audio', TEXT: 'text' }

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function NewSession() {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [projects, setProjects] = useState([])
  const [projectId, setProjectId] = useState(state?.projectId ?? '')
  const [sessionType, setSessionType] = useState('IMAGE')
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
      const session = await createSession({
        projectId,
        location: location.trim() || undefined,
        type: sessionType,
      })
      const sub = ROUTE_FOR[sessionType]
      navigate(sub ? `/sessions/${session.id}/${sub}` : `/sessions/${session.id}`)
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
            <form onSubmit={handleSubmit} className="space-y-5">
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

              {/* Session Modality Selector */}
              <div>
                <label className="block text-sm font-semibold text-ink mb-1.5">
                  Session Type
                </label>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {SESSION_TYPES.map(({ value, label, Icon, blurb }) => {
                    const selected = sessionType === value
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSessionType(value)}
                        className={`flex flex-col items-start p-3.5 rounded-xl border text-left transition ${
                          selected
                            ? 'border-brand bg-brand-soft/40 ring-2 ring-brand'
                            : 'border-border bg-canvas hover:bg-surface'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-ink font-bold text-xs">
                          <Icon size={16} className={selected ? 'text-brand' : 'text-ink-faint'} />
                          <span>{label}</span>
                        </div>
                        <p className="mt-1 text-[11px] leading-tight text-ink-faint">{blurb}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              <label className="block text-sm font-semibold text-ink">
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
                className="mt-6 flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark shadow-sm transition hover:bg-brand-dark"
              >
                <PlayCircle size={16} strokeWidth={2} />
                {submitting
                  ? 'Starting…'
                  : `Start ${SESSION_TYPES.find((t) => t.value === sessionType)?.label ?? 'Image'} Session`}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}

