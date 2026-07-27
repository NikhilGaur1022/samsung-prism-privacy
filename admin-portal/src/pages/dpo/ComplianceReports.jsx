import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatCard from '../../components/StatCard'
import { verifyAuditChain, getComplianceReport, listAudit } from '../../lib/api'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'
const DATE_FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

function ChainVerifier() {
  const [entityType, setEntityType] = useState('Project')
  const [entityId, setEntityId] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await verifyAuditChain({ entityType, entityId: entityId.trim() }))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-card bg-surface p-6 shadow-card">
      <h2 className="text-base font-bold text-ink">Verify audit hash chain</h2>
      <p className="mt-1 text-xs font-medium text-ink-faint">
        Recomputes the chain for one entity and reports whether it holds.
      </p>
      <form onSubmit={run} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm font-semibold text-ink">
          Entity type
          <select className={FIELD_CLASS} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="Project">Project</option>
            <option value="DsarRequest">DsarRequest</option>
            <option value="ConsentTemplate">ConsentTemplate</option>
            <option value="Session">Session</option>
            <option value="Subject">Subject</option>
          </select>
        </label>
        <label className="text-sm font-semibold text-ink">
          Entity ID
          <input
            className={FIELD_CLASS}
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="UUID"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
        >
          Verify
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          {error.message}
        </div>
      )}

      {result && (
        <div
          className={`mt-4 flex items-start gap-3 rounded-lg px-4 py-3 ${
            result.valid ? 'bg-success-soft' : 'bg-danger-soft'
          }`}
        >
          {result.valid ? (
            <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-success" />
          ) : (
            <ShieldAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" />
          )}
          <div className="text-sm">
            <p className={`font-bold ${result.valid ? 'text-success' : 'text-danger'}`}>
              {result.valid ? 'Chain intact' : `${result.breaks.length} integrity break(s) found`}
            </p>
            <p className="mt-1 text-xs font-medium text-ink-muted">
              {result.entries} entries · {result.verified} fully verified · {result.linkageOnly} linkage-only
            </p>
            {result.caveat && <p className="mt-1 text-xs font-medium text-ink-faint">{result.caveat}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// Every counts object in the report is {STATUS/TYPE: n}. Render only what
// occurred in the period — no fabricated zero rows.
function CountsList({ counts }) {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0)
  if (!entries.length) return <p className="text-xs font-medium text-ink-faint">none in this period</p>
  return (
    <p className="text-xs font-medium text-ink-muted">
      {entries.map(([k, n]) => `${k} ${n}`).join(' · ')}
    </p>
  )
}

function Section({ title, children }) {
  return (
    <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
      <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  )
}

// The accountability report: every figure below is counted server-side by
// GET /dashboard/compliance-report over the chosen window (default trailing
// 90 days). This replaces what used to be a raw /audit entry list standing in
// for a report — the chain verifier above is a different primitive (integrity
// of one entity's trail) and stays, since the report doesn't replace it.
function ComplianceReportPanel() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setReport(null)
    setError(null)
    const params = {}
    if (from) params.from = from
    if (to) params.to = to
    getComplianceReport(params).then(setReport).catch(setError)
  }, [from, to])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="rounded-card bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Compliance report</h2>
          <p className="mt-1 text-xs font-medium text-ink-faint">Defaults to the trailing 90 days.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            reload()
          }}
          className="flex items-end gap-2"
        >
          <label className="text-xs font-semibold text-ink-muted">
            From
            <input
              type="date"
              className={`mt-1 block ${DATE_FIELD_CLASS}`}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            To
            <input
              type="date"
              className={`mt-1 block ${DATE_FIELD_CLASS}`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Apply
          </button>
        </form>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          {error.message}
        </div>
      )}

      {!report && !error && (
        <div className="mt-6 grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-card bg-canvas" />
          ))}
        </div>
      )}

      {report && (
        <>
          <p className="mt-4 text-xs font-medium text-ink-faint">
            Period {new Date(report.period.from).toLocaleDateString()} –{' '}
            {new Date(report.period.to).toLocaleDateString()} · scope{' '}
            {report.scope.projectIds === 'ALL' ? 'all projects' : `${report.scope.projectIds.length} project(s)`}
          </p>

          <Section title="Governance">
            <CountsList counts={report.governance.projects} />
            <p className="mt-2 text-xs font-medium text-ink-muted">
              {report.governance.publishedNotices} published consent notice{report.governance.publishedNotices === 1 ? '' : 's'}
            </p>
          </Section>

          <Section title="Consent">
            <div className="grid grid-cols-2 gap-4">
              <StatCard label="Granted" value={report.consent.granted} />
              <StatCard label="Withdrawn" value={report.consent.withdrawn} />
            </div>
          </Section>

          <Section title="DSAR">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Closed" value={report.dsar.closed} />
              <StatCard
                label="On-time rate"
                value={report.dsar.onTimeRate === null ? 'No requests closed in this period' : `${report.dsar.onTimeRate}%`}
              />
              <StatCard
                label="Median days to close"
                value={report.dsar.medianDaysToClose === null ? '—' : report.dsar.medianDaysToClose}
              />
              <StatCard label="Open" value={report.dsar.open} />
              <StatCard label={`Open, SLA breached (${report.dsar.slaDays}d)`} value={report.dsar.openBreached} />
              <StatCard
                label={`Past internal target (${report.dsar.internalSlaDays}d)`}
                value={report.dsar.openPastInternalTarget}
              />
            </div>
            <div className="mt-3">
              <CountsList counts={report.dsar.raisedByType} />
            </div>
            <p className="mt-2 text-xs font-medium text-ink-muted">
              {report.dsar.certificatesIssued} deletion certificate{report.dsar.certificatesIssued === 1 ? '' : 's'} issued
            </p>
          </Section>

          <Section title="Access">
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Access events" value={report.access.events} />
              <StatCard label="Break-glass reads" value={report.access.breakGlass} />
              <StatCard label="Break-glass share" value={`${report.access.breakGlassShare}%`} />
            </div>
          </Section>

          <Section title="Data minimisation">
            <CountsList counts={report.minimisation.photosByPiiStatus} />
            <p className="mt-2 text-xs font-medium text-ink-muted">
              {report.minimisation.framesBlockedByFailedRedaction} frame
              {report.minimisation.framesBlockedByFailedRedaction === 1 ? '' : 's'} blocked by failed redaction
            </p>
            <div className="mt-2">
              <CountsList counts={report.minimisation.handoffs} />
            </div>
          </Section>

          <Section title="Breaches">
            <p className="text-sm font-semibold text-ink">
              {report.breaches.detectedInPeriod} detected in this period
            </p>
          </Section>

          <p className="mt-4 text-xs font-medium text-ink-faint">
            Generated {new Date(report.generatedAt).toLocaleString()} for role {report.generatedForRole}
          </p>
        </>
      )}
    </div>
  )
}

export default function ComplianceReports() {
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(
    () => listAudit({ limit: '50' }).then((r) => setEntries(r.items)).catch(setError),
    [],
  )

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Compliance Reports"
          subtitle="The accountability report for regulators and internal review, plus the audit trail and its hash-chain integrity."
        />

        <div className="mt-6">
          <ComplianceReportPanel />
        </div>

        <div className="mt-6">
          <ChainVerifier />
        </div>

        {/* Secondary to the report above: the report is aggregate counts, this
            is the individual ledger rows — dataAdmin has its own Audit Logs
            page, but this is the DPO's only view onto the raw trail. */}
        <div className="mt-6">
          <ListPanel
            title="Recent audit entries"
            rows={entries ?? []}
            loading={!entries && !error}
            error={error}
            emptyTitle="No audit entries yet"
            renderRow={(l) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{l.action}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {l.entityType} · {new Date(l.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-faint">{l.payloadHash.slice(0, 12)}</span>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
