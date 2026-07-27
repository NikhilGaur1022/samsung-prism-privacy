import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import { Loader2, Share2 } from 'lucide-react'
import { getLineage } from '../../lib/api'

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

// One row per photo_subjects entry: photo → subject → consent → project. That
// chain is exactly what a DSAR erasure walks, so rendering it is the evidence.
export default function DataLineage() {
  const [projectId, setProjectId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setData(null)
    setError(null)
    const params = {}
    if (projectId.trim()) params.projectId = projectId.trim()
    if (subjectId.trim()) params.subjectId = subjectId.trim()
    getLineage(params).then(setData).catch(setError)
  }, [projectId, subjectId])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Data Lineage"
          subtitle="Where a subject's data flows from intake through to export or purge."
          action={
            <form
              onSubmit={(e) => {
                e.preventDefault()
                reload()
              }}
              className="flex gap-2"
            >
              <input
                className={FIELD_CLASS}
                placeholder="Project ID"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              />
              <input
                className={FIELD_CLASS}
                placeholder="Subject ID"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              />
              <button
                type="submit"
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                Filter
              </button>
            </form>
          }
        />

        {error && (
          <p className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </p>
        )}

        {!data && !error ? (
          <Loader2 size={20} className="mt-6 animate-spin text-ink-faint" />
        ) : data && data.items.length === 0 ? (
          <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
            <EmptyState
              icon={Share2}
              title="No photo lineage found"
              message="Links appear once a collection session is finalized. Try clearing the filters."
            />
          </div>
        ) : data ? (
          <div className="mt-6 overflow-x-auto rounded-card bg-surface p-4 shadow-card">
            <table className="min-w-full text-left text-xs">
              <thead className="text-ink-faint">
                <tr>
                  <th className="py-2 pr-4 font-bold uppercase tracking-wide">Photo</th>
                  <th className="py-2 pr-4 font-bold uppercase tracking-wide">Session</th>
                  <th className="py-2 pr-4 font-bold uppercase tracking-wide">Subject</th>
                  <th className="py-2 pr-4 font-bold uppercase tracking-wide">Consent</th>
                  <th className="py-2 pr-4 font-bold uppercase tracking-wide">Project</th>
                  <th className="py-2 font-bold uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-mono text-ink-muted">{row.sha256.slice(0, 12)}</td>
                    <td className="py-2 pr-4 text-ink-muted">{row.sessionCode}</td>
                    <td className="py-2 pr-4 font-semibold text-ink">{row.subjectName}</td>
                    <td className="py-2 pr-4 font-mono text-ink-muted">{row.consentId.slice(0, 8)}</td>
                    <td className="py-2 pr-4 text-ink-muted">{row.projectName}</td>
                    <td className="py-2">
                      <StatusPill tone={row.consentStatus === 'ACTIVE' ? 'success' : 'danger'}>
                        {row.consentStatus}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </main>
    </div>
  )
}
