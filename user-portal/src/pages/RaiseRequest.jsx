import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import { listConsentProjects, raiseDsarRequest } from '../lib/api'

const TYPES = [
  { value: 'ACCESS', label: 'Access', blurb: 'Get a copy of the personal data Prism holds about you.' },
  { value: 'CORRECT', label: 'Correction', blurb: 'Ask for inaccurate or outdated personal data to be fixed.' },
  { value: 'ERASE', label: 'Erasure', blurb: 'Ask for your personal data to be deleted where it is no longer lawfully needed.' },
  { value: 'GRIEVANCE', label: 'Grievance', blurb: 'Raise a complaint about how your personal data has been handled.' },
  { value: 'NOMINATION', label: 'Nomination', blurb: 'Nominate someone to exercise your rights on your behalf if you become unable to.' },
]

export default function RaiseRequest() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState(null)
  const [type, setType] = useState('')
  const [projectId, setProjectId] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  useEffect(() => {
    listConsentProjects().then((res) => setProjects(res.items)).catch(setError)
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = { type, ...(description.trim() && { description: description.trim() }), ...(projectId && { projectId }) }
      const request = await raiseDsarRequest(payload)
      setCreated(request)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <div>
        <TopBar back />
        <div className="px-4 md:px-8">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Request submitted</h1>
          <Card className="mt-5">
            <p className="text-sm font-semibold text-ink">
              Your {TYPES.find((t) => t.value === created.type)?.label ?? created.type} request has been received.
            </p>
            <p className="mt-1.5 text-xs font-medium text-ink-muted">
              Status: {created.status} · Due by {new Date(created.sla.dueAt).toLocaleDateString()}
            </p>
          </Card>
          <button
            onClick={() => navigate(`/requests/${created.id}`)}
            className="mt-5 w-full rounded-card bg-brand py-3.5 text-sm font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Track this request
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <TopBar back />
      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Raise a Request</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Exercise your rights under DPDP §11-§13. Pick the type of request below.
        </p>

        {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div className="space-y-2">
            {TYPES.map((t) => (
              <label
                key={t.value}
                className={`flex cursor-pointer items-start gap-3 rounded-card border p-4 ${
                  type === t.value ? 'border-brand bg-brand-soft' : 'border-border bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="type"
                  value={t.value}
                  checked={type === t.value}
                  onChange={(e) => setType(e.target.value)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-bold text-ink">{t.label}</p>
                  <p className="mt-0.5 text-xs font-medium text-ink-muted">{t.blurb}</p>
                </div>
              </label>
            ))}
          </div>

          {projects && projects.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
                Related project (optional)
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full rounded-2xl border border-black/10 bg-canvas px-4 py-3 text-sm font-semibold text-ink outline-none focus:border-brand focus:bg-surface"
              >
                <option value="">Not specific to a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Add any detail that will help us handle this request."
              className="w-full rounded-2xl border border-black/10 bg-canvas px-4 py-3 text-sm font-medium text-ink outline-none focus:border-brand focus:bg-surface"
            />
          </div>

          <button
            type="submit"
            disabled={busy || !type}
            className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      </div>
    </div>
  )
}
