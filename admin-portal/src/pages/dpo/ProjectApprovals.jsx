import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listProjects, approveProject, rejectProject } from '../../lib/api'

const STATUS_TONE = { SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger', DRAFT: 'neutral', CLOSED: 'neutral' }
const RISK_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'success' }
const MIN_REASON = 20

function RejectModal({ project, onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState('')
  const tooShort = reason.trim().length < MIN_REASON

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-card">
        <h2 className="text-base font-bold text-ink">Reject &ldquo;{project.name}&rdquo;</h2>
        <p className="mt-1 text-xs font-medium text-ink-faint">
          The owner needs a reason they can act on. Minimum {MIN_REASON} characters.
        </p>
        <textarea
          className="mt-3 min-h-28 w-full resize-y rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What is missing or non-compliant about this project?"
        />
        <p className="mt-1 text-xs font-medium text-ink-faint">{reason.trim().length}/{MIN_REASON}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={busy || tooShort}
            className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
          >
            Reject project
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectApprovals() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(null)

  const reload = useCallback(() => listProjects().then((r) => setProjects(r.items)).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  const runAction = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
      setRejecting(null)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const pending = (projects ?? []).filter((p) => p.status === 'SUBMITTED')
  const decided = (projects ?? []).filter((p) => p.status !== 'SUBMITTED' && p.status !== 'DRAFT')

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Project Approvals"
          subtitle="Review new data collection projects before they can start."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title={`Pending Approval (${pending.length})`}
            rows={pending}
            loading={!projects && !error}
            error={null}
            emptyTitle="All caught up"
            emptyMessage="No projects are waiting on your review."
            renderRow={(p) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                    {p.riskLevel && (
                      <StatusPill tone={RISK_TONE[p.riskLevel]}>{p.riskLevel.toLowerCase()} risk</StatusPill>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    submitted {p.submittedAt ? new Date(p.submittedAt).toLocaleDateString() : '—'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => runAction(() => approveProject(p.id))}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg bg-success-soft px-3 py-1.5 text-xs font-semibold text-success disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success"
                  >
                    <Check size={14} strokeWidth={2} /> Approve
                  </button>
                  <button
                    onClick={() => setRejecting(p)}
                    disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                  >
                    <X size={14} strokeWidth={2} /> Reject
                  </button>
                </div>
              </div>
            )}
          />
        </div>

        {decided.length > 0 && (
          <div className="mt-6">
            <ListPanel
              title="Recently Decided"
              rows={decided}
              renderRow={(p) => (
                <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                  <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                </div>
              )}
            />
          </div>
        )}

        {rejecting && (
          <RejectModal
            project={rejecting}
            busy={busy}
            onCancel={() => setRejecting(null)}
            onConfirm={(reason) => runAction(() => rejectProject(rejecting.id, reason))}
          />
        )}
      </main>
    </div>
  )
}
