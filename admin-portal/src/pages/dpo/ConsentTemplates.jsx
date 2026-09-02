import { useCallback, useEffect, useState } from 'react'
import { Plus, Send } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import DataTypePicker from '../../components/DataTypePicker'
import { formatDataTypes } from '../../lib/dataTypeLabel'
import { listConsentTemplates, createConsentTemplate, publishConsentTemplate } from '../../lib/api'

const STATUS_TONE = { DRAFT: 'neutral', PUBLISHED: 'success', SUPERSEDED: 'warning' }

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

function NewTemplateForm({ onCreated }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [body, setBody] = useState('')
  const [retention, setRetention] = useState('')
  // An array of vocabulary codes now, not a comma-separated string.
  const [dataTypes, setDataTypes] = useState([])
  const [grievanceContact, setGrievanceContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createConsentTemplate({
        name: name.trim(),
        purpose: purpose.trim(),
        bodyByLocale: { en: body.trim() },
        retention: retention.trim() || undefined,
        dataTypes: dataTypes.length > 0 ? dataTypes : undefined,
        grievanceContact: grievanceContact.trim() || undefined,
      })
      setName('')
      setPurpose('')
      setBody('')
      setRetention('')
      setDataTypes([])
      setGrievanceContact('')
      setOpen(false)
      onCreated()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
      >
        <Plus size={14} strokeWidth={2} /> New template
      </button>
    )
  }

  return (
    <div className="mt-4 rounded-card bg-surface p-6 shadow-card">
      {error && (
        <div className="mb-4 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          {error.message}
        </div>
      )}
      <form onSubmit={submit}>
        <label className="block text-sm font-semibold text-ink">
          Name
          <input className={FIELD_CLASS} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="mt-4 block text-sm font-semibold text-ink">
          Purpose (min 20 characters)
          <textarea
            className={`${FIELD_CLASS} min-h-20 resize-y`}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            required
          />
        </label>
        <label className="mt-4 block text-sm font-semibold text-ink">
          Notice body — English (min 50 characters)
          <textarea
            className={`${FIELD_CLASS} min-h-32 resize-y`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
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
        {/* A fieldset, not a label: a label pointing at a group of chip buttons
            has no single control to point at, and clicking its text would
            activate whichever one happened to be first. */}
        <fieldset className="mt-4 block">
          <legend className="text-sm font-semibold text-ink">Data types disclosed</legend>
          <p className="mt-1 text-xs font-medium text-ink-faint">
            These are the categories the principal reads on the notice before consenting.
            Pick from the list so a project declaring the same category matches this one
            exactly — approval compares the two literally.
          </p>
          <div className="mt-3">
            <DataTypePicker value={dataTypes} onChange={setDataTypes} />
          </div>
        </fieldset>
        <label className="mt-4 block text-sm font-semibold text-ink">
          Grievance contact
          <input
            className={FIELD_CLASS}
            value={grievanceContact}
            onChange={(e) => setGrievanceContact(e.target.value)}
            placeholder="required before this template can be published"
          />
        </label>
        <div className="mt-5 flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Create draft
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

export default function ConsentTemplates() {
  const [templates, setTemplates] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    () => listConsentTemplates().then((r) => setTemplates(r.items)).catch(setError),
    [],
  )

  useEffect(() => {
    reload()
  }, [reload])

  const publish = async (id) => {
    setBusy(true)
    setError(null)
    try {
      await publishConsentTemplate(id)
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
          title="Consent Templates"
          subtitle="Master consent language reused across data collection projects."
          action={<NewTemplateForm onCreated={reload} />}
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Templates"
            rows={templates ?? []}
            loading={!templates && !error}
            emptyTitle="No templates yet"
            emptyMessage="Create a template above to define the notice a project's collection is bound to."
            renderRow={(t) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{t.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    v{t.version} · {t.retention ?? 'no retention set'}
                    {t.publishedAt && ` · published ${new Date(t.publishedAt).toLocaleDateString()}`}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-faint">
                    {formatDataTypes(t.dataTypes)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone={STATUS_TONE[t.status]}>{t.status}</StatusPill>
                  {t.status === 'DRAFT' && (
                    <button
                      onClick={() => publish(t.id)}
                      disabled={busy}
                      className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <Send size={13} strokeWidth={2} /> Publish
                    </button>
                  )}
                </div>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
