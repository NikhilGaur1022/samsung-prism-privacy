import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import DataTypePicker from '../../components/DataTypePicker'
import { listProjects, updateProject, submitProject, listConsentTemplates } from '../../lib/api'
import { CheckCircle2, Loader2 } from 'lucide-react'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
const EDITABLE = ['DRAFT', 'REJECTED']

export default function DataRequirements() {
  const [projects, setProjects] = useState(null)
  const [templates, setTemplates] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  const reload = useCallback(() => {
    Promise.all([listProjects(), listConsentTemplates({ status: 'PUBLISHED' })])
      .then(([p, t]) => {
        setProjects(p.items)
        setTemplates(t.items)
      })
      .catch(setError)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const project = (projects ?? []).find((p) => p.id === selectedId)

  useEffect(() => {
    if (!project) {
      setForm(null)
      return
    }
    setForm({
      purpose: project.purpose ?? '',
      retention: project.retention ?? '',
      // Kept as an array end to end. It used to be joined into a string for the
      // input and split back on save, which silently rewrote any stored value
      // containing a comma.
      dataTypes: Array.isArray(project.dataTypes) ? project.dataTypes : [],
      consentTemplateId: project.consentTemplateId ?? '',
    })
    setMessage(null)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await updateProject(project.id, {
        purpose: form.purpose.trim(),
        retention: form.retention.trim() || undefined,
        dataTypes: form.dataTypes.length > 0 ? form.dataTypes : undefined,
        consentTemplateId: form.consentTemplateId || undefined,
      })
      setMessage('Saved.')
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await submitProject(project.id)
      setMessage('Submitted for DPO approval.')
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
          title="Data Requirements"
          subtitle="Purpose, retention, data types and the bound consent notice each project must have before it can be submitted."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6 max-w-2xl rounded-card bg-surface p-6 shadow-card">
          {!projects ? (
            <Loader2 size={18} className="animate-spin text-ink-faint" />
          ) : projects.length === 0 ? (
            <p className="text-sm font-medium text-ink-faint">You have no projects yet.</p>
          ) : (
            <>
              <label className="block text-sm font-semibold text-ink">
                Project
                <select className={FIELD_CLASS} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                  <option value="">— choose a project —</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.status})
                    </option>
                  ))}
                </select>
              </label>

              {project && !EDITABLE.includes(project.status) && (
                <p className="mt-3 text-xs font-medium text-warning">
                  This project is {project.status} — only a DRAFT or REJECTED project can be edited.
                </p>
              )}

              {project && form && EDITABLE.includes(project.status) && (
                <form onSubmit={save} className="mt-5 border-t border-border pt-5">
                  {message && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-semibold text-success">
                      <CheckCircle2 size={16} strokeWidth={2} /> {message}
                    </div>
                  )}

                  <label className="block text-sm font-semibold text-ink">
                    Purpose (min 20 characters)
                    <textarea
                      className={`${FIELD_CLASS} min-h-24 resize-y`}
                      value={form.purpose}
                      onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                      minLength={20}
                      required
                    />
                  </label>

                  <label className="mt-4 block text-sm font-semibold text-ink">
                    Retention period
                    <input
                      className={FIELD_CLASS}
                      value={form.retention}
                      onChange={(e) => setForm({ ...form, retention: e.target.value })}
                    />
                  </label>

                  <fieldset className="mt-4 block">
                    <legend className="text-sm font-semibold text-ink">Data types</legend>
                    <p className="mt-1 text-xs font-medium text-ink-faint">
                      Submitting for approval fails unless every category here is also on
                      the selected consent notice.
                    </p>
                    <div className="mt-3">
                      <DataTypePicker
                        value={form.dataTypes}
                        onChange={(next) => setForm({ ...form, dataTypes: next })}
                      />
                    </div>
                  </fieldset>

                  <label className="mt-4 block text-sm font-semibold text-ink">
                    Consent notice
                    <select
                      className={FIELD_CLASS}
                      value={form.consentTemplateId}
                      onChange={(e) => setForm({ ...form, consentTemplateId: e.target.value })}
                    >
                      <option value="">— none yet —</option>
                      {(templates ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} v{t.version}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="mt-5 flex gap-2">
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={busy}
                      className="rounded-lg bg-brand-soft px-4 py-2.5 text-sm font-semibold text-brand disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      Submit for approval
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
