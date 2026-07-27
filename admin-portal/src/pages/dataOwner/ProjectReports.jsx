import { useCallback, useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import StatCard from '../../components/StatCard'
import { listProjects, getProjectReport } from '../../lib/api'
import { AlertTriangle, Loader2 } from 'lucide-react'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
const STATUS_TONE = { APPROVED: 'success', SUBMITTED: 'warning', DRAFT: 'neutral', REJECTED: 'danger', CLOSED: 'neutral', ACTIVE: 'brand' }

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 text-sm last:border-0">
      <span className="font-semibold text-ink-muted">{label}</span>
      <span className="max-w-[60%] text-right font-medium text-ink">{value ?? '—'}</span>
    </div>
  )
}

// Every counts object in the report is {STATUS: n}. Render it as the statuses
// that actually occurred, in the shape the API returned them — no fabricated
// zero rows for statuses this project never touched.
function CountsRow({ label, counts }) {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0)
  return (
    <Row
      label={label}
      value={
        entries.length
          ? entries.map(([status, n]) => `${status} ${n}`).join(' · ')
          : 'none'
      }
    />
  )
}

function Section({ title, children }) {
  return (
    <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">{title}</h2>
      <div className="mt-2">{children}</div>
    </div>
  )
}

// This is the live GET /projects/:id/report — a point-in-time report counted
// server-side, not assembled here. It supersedes what used to be a single
// GET /projects/:id read of lifecycle fields only.
export default function ProjectReports() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState('')
  const [report, setReport] = useState(null)
  const [reportError, setReportError] = useState(null)

  const reload = useCallback(() => listProjects().then((r) => setProjects(r.items)).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!selectedId) {
      setReport(null)
      return
    }
    setReport(null)
    setReportError(null)
    getProjectReport(selectedId).then(setReport).catch(setReportError)
  }, [selectedId])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Project Reports"
          subtitle="Consent, collection, handoff and DSAR status for each project you own, counted server-side."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6 max-w-3xl rounded-card bg-surface p-6 shadow-card">
          {!projects ? (
            <Loader2 size={18} className="animate-spin text-ink-faint" />
          ) : projects.length === 0 ? (
            <p className="text-sm font-medium text-ink-faint">No projects yet.</p>
          ) : (
            <label className="block text-sm font-semibold text-ink">
              Project
              <select className={FIELD_CLASS} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value="">— choose a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {reportError && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {reportError.message}
          </div>
        )}

        {selectedId && !report && !reportError && (
          <Loader2 size={18} className="mt-6 animate-spin text-ink-faint" />
        )}

        {report && (
          <div className="max-w-3xl">
            <Section title="Project">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <span className="font-semibold text-ink-muted">Status</span>
                <StatusPill tone={STATUS_TONE[report.project.status]}>{report.project.status}</StatusPill>
              </div>
              <Row label="Purpose" value={report.project.purpose} />
              <Row label="Retention" value={report.project.retention} />
              <Row label="Data types" value={Array.isArray(report.project.dataTypes) ? report.project.dataTypes.join(', ') : null} />
              <Row label="Risk level" value={report.project.riskLevel} />
              <Row
                label="Approved"
                value={report.project.approvedAt && new Date(report.project.approvedAt).toLocaleString()}
              />
            </Section>

            <Section title="Consent">
              <div className="grid grid-cols-2 gap-4">
                <StatCard label="Active" value={report.consent.active} />
                <StatCard label="Withdrawn" value={report.consent.withdrawn} />
              </div>
            </Section>

            <Section title="Collection">
              <div className="grid grid-cols-2 gap-4">
                <StatCard label="Photos" value={report.collection.photos} />
                <StatCard label="Consent-linked photo/subject links" value={report.collection.photoSubjectLinks} />
              </div>
              <div className="mt-2">
                <CountsRow label="Sessions by status" counts={report.collection.sessions} />
                <CountsRow label="Photos by PII status" counts={report.collection.piiStatus} />
              </div>
              {report.collection.blockedFrames > 0 && (
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
                  <AlertTriangle size={16} strokeWidth={2} className="shrink-0" />
                  {report.collection.blockedFrames} frame{report.collection.blockedFrames === 1 ? '' : 's'} blocked
                  from handoff — redaction did not confirm.
                </div>
              )}
            </Section>

            <Section title="Handoffs">
              <CountsRow label="Handoffs by status" counts={report.handoffs} />
            </Section>

            <Section title="DSAR">
              <CountsRow label="Requests by status" counts={report.dsar.byStatus} />
              <Row label="Certificates issued" value={report.dsar.certificatesIssued} />
            </Section>

            <p className="mt-4 text-xs font-medium text-ink-faint">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
