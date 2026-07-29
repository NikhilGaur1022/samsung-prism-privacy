import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import {
  listProjects,
  submitProject,
  listProjectAssignments,
  addProjectAssignment,
  removeProjectAssignment,
  listAdmins,
} from '../../lib/api'

const STATUS_TONE = { DRAFT: 'neutral', SUBMITTED: 'warning', APPROVED: 'success', REJECTED: 'danger', CLOSED: 'neutral' }

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

// Only an APPROVED project can take agents (assignAgent enforces this
// server-side too — this just avoids opening a panel that can only ever error).
function AgentAssignments({ projectId }) {
  const [open, setOpen] = useState(false)
  const [assignments, setAssignments] = useState(null)
  const [agents, setAgents] = useState(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [assignmentsRes, agentsRes] = await Promise.all([
        listProjectAssignments(projectId),
        listAdmins('collectionAgent'),
      ])
      setAssignments(assignmentsRes.items)
      setAgents(agentsRes.items)
    } catch (err) {
      setError(err)
    }
  }, [projectId])

  useEffect(() => {
    if (open) reload()
  }, [open, reload])

  const assign = async () => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      await addProjectAssignment(projectId, selected)
      setSelected('')
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const unassign = async (adminId) => {
    setBusy(true)
    setError(null)
    try {
      await removeProjectAssignment(projectId, adminId)
      await reload()
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
        className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <Users size={13} strokeWidth={2} /> Agents
      </button>
    )
  }

  const assignedIds = new Set((assignments ?? []).map((a) => a.admin.id))
  const available = (agents ?? []).filter((a) => !assignedIds.has(a.id))

  return (
    <div className="mt-4 rounded-lg border border-border bg-canvas p-4">
      {error && (
        <div className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
          {error.message}
        </div>
      )}

      {!assignments ? (
        <p className="text-xs font-medium text-ink-faint">Loading…</p>
      ) : assignments.length === 0 ? (
        <p className="text-xs font-medium text-ink-faint">No agents assigned yet.</p>
      ) : (
        <ul className="space-y-2">
          {assignments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 text-sm text-ink">
              <span className="truncate">{a.admin.email}</span>
              <button
                onClick={() => unassign(a.admin.id)}
                disabled={busy}
                className="shrink-0 rounded-lg bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <select
          className={`${FIELD_CLASS} mt-0`}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">— select a collection agent —</option>
          {available.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
        <button
          onClick={assign}
          disabled={busy || !selected}
          className="shrink-0 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
        >
          Assign
        </button>
      </div>
      {agents && agents.length === 0 && (
        <p className="mt-2 text-xs font-medium text-ink-faint">
          No active collection agents exist yet — invite one from the super admin's Admins page.
        </p>
      )}

      <button
        onClick={() => setOpen(false)}
        className="mt-3 text-xs font-semibold text-ink-muted underline-offset-2 hover:underline"
      >
        Close
      </button>
    </div>
  )
}

export default function MyProjects() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => listProjects().then((r) => setProjects(r.items)).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  const submit = async (id) => {
    setBusy(true)
    setError(null)
    try {
      await submitProject(id)
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
          title="My Projects"
          subtitle="Data collection projects you own, from draft through approval and collection."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Projects"
            rows={projects ?? []}
            loading={!projects && !error}
            emptyTitle="No projects yet"
            emptyMessage="Create a project to start collecting data."
            renderRow={(p) => (
              <div className="py-4 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                    <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                      {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'} · {p.consentCount} consent
                      {p.consentCount === 1 ? '' : 's'}
                      {p.rejectionReason && ` · rejected: ${p.rejectionReason}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>
                    {(p.status === 'DRAFT' || p.status === 'REJECTED') && (
                      <button
                        onClick={() => submit(p.id)}
                        disabled={busy}
                        className="rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        Submit for approval
                      </button>
                    )}
                    {p.status === 'APPROVED' && <AgentAssignments projectId={p.id} />}
                    <Link
                      to="/data-requirements"
                      className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      Edit
                    </Link>
                  </div>
                </div>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
