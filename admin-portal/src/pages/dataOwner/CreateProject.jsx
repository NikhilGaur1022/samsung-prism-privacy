import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { createProject, listConsentTemplates } from '../../lib/api'
import { CheckCircle2 } from 'lucide-react'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function CreateProject() {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState(null)
  const [templatesError, setTemplatesError] = useState(null)

  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [retention, setRetention] = useState('')
  const [dataTypes, setDataTypes] = useState('')
  const [riskLevel, setRiskLevel] = useState('')
  const [consentTemplateId, setConsentTemplateId] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  const reloadTemplates = useCallback(
    () => listConsentTemplates({ status: 'PUBLISHED' }).then((r) => setTemplates(r.items)).catch(setTemplatesError),
    [],
  )

  useEffect(() => {
    reloadTemplates()
  }, [reloadTemplates])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setCreated(null)
    try {
      const project = await createProject({
        name: name.trim(),
        purpose: purpose.trim(),
        retention: retention.trim() || undefined,
        dataTypes: dataTypes.trim()
          ? dataTypes.split(',').map((t) => t.trim()).filter(Boolean)
          : undefined,
        riskLevel: riskLevel || undefined,
        consentTemplateId: consentTemplateId || undefined,
      })
      setCreated(project)
      setName('')
      setPurpose('')
      setRetention('')
      setDataTypes('')
      setRiskLevel('')
      setConsentTemplateId('')
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
          title="Create Project"
          subtitle="New projects are submitted to the DPO for approval before collection can start."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          {created && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-semibold text-success">
              <span className="flex items-center gap-2">
                <CheckCircle2 size={16} strokeWidth={2} />
                &ldquo;{created.name}&rdquo; created as a draft.
              </span>
              <button
                onClick={() => navigate('/data-requirements')}
                className="rounded-lg bg-success px-3 py-1 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success"
              >
                Complete requirements →
              </button>
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
              {error.message}
            </div>
          )}

          {templatesError && (
            <div className="mb-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
              Could not load consent templates: {templatesError.message}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <label className="block text-sm font-semibold text-ink">
              Project name
              <input
                className={FIELD_CLASS}
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={3}
                required
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Purpose (min 20 characters — what is collected and why)
              <textarea
                className={`${FIELD_CLASS} min-h-24 resize-y`}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                minLength={20}
                required
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Retention period
              <input
                className={FIELD_CLASS}
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                placeholder="e.g. 90 days after project close"
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Data types (comma-separated)
              <input
                className={FIELD_CLASS}
                value={dataTypes}
                onChange={(e) => setDataTypes(e.target.value)}
                placeholder="e.g. photo, face_embedding"
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Risk level
              <select className={FIELD_CLASS} value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
                <option value="">— not set —</option>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Consent notice
              <select
                className={FIELD_CLASS}
                value={consentTemplateId}
                onChange={(e) => setConsentTemplateId(e.target.value)}
              >
                <option value="">— none yet —</option>
                {(templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} v{t.version}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs font-medium text-ink-faint">
                A published notice is required before this project can be submitted for DPO approval.
              </span>
            </label>

            <button
              type="submit"
              disabled={busy}
              className="mt-6 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              Create draft
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
