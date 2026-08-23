import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listProjects, listProjectSessions } from '../../lib/api'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { blockedFrameCount } from '../../lib/photoState.js'
import ProjectExportPanel from '../../components/ProjectExportPanel'

// A session row has to describe what that session actually collected: counting
// photos on an audio session renders "0 photos" against a fully processed
// recording. Built from the counts rather than the session type because there
// is no VIDEO member of SessionType — a clip-only session is an IMAGE session
// holding no photos.
const SESSION_HOLDINGS = [
  ['photoCount', 'photo'],
  ['videoCount', 'clip'],
  ['recordingCount', 'recording'],
  ['documentCount', 'document'],
]

function sessionItemLabel(s) {
  const parts = SESSION_HOLDINGS.filter(([key]) => (s[key] ?? 0) > 0).map(
    ([key, noun]) => `${s[key]} ${noun}${s[key] === 1 ? '' : 's'}`,
  )
  return parts.length > 0 ? parts.join(' · ') : 'nothing collected yet'
}


const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const SESSION_STATUS_TONE = { ACTIVE: 'brand', PROCESSING: 'warning', TAGGING: 'warning', ARCHIVED: 'success', FAILED: 'danger' }
const HANDOFF_STATUS_TONE = { PENDING_INGEST: 'warning', INGESTED: 'success', REJECTED: 'danger' }

// A frame redaction never confirmed on blocks that session's handoff — invisible
// from session status alone, so it is called out on its own row rather than left
// buried in a count. See lib/photoState.js for why this is not a list of the
// states we think are bad.
const blockedCount = blockedFrameCount

// A data owner sees this session roll-up per project — counts, handoff state, and
// whether anything is blocked — and can open any row to the session's redacted
// frames (matrix §B, "dataOwner ✓ own project"). Raw originals stay out of reach:
// those need the collecting agent's pre-archive basis or a break-glass DSAR.
export default function ProcessedData() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [projectId, setProjectId] = useState('')
  const [sessions, setSessions] = useState(null)
  const [sessionsError, setSessionsError] = useState(null)

  const reload = useCallback(() => listProjects().then((r) => setProjects(r.items)).catch(setError), [])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (!projectId) {
      setSessions(null)
      return
    }
    setSessions(null)
    setSessionsError(null)
    listProjectSessions(projectId).then((r) => setSessions(r.items)).catch(setSessionsError)
  }, [projectId])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Processed Data"
          subtitle="Session-level collection and handoff status per project. Individual assets remain visible only to the collecting agent and to Data Team Admin."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
          {!projects ? (
            <Loader2 size={18} className="animate-spin text-ink-faint" />
          ) : projects.length === 0 ? (
            <p className="text-sm font-medium text-ink-faint">No projects yet.</p>
          ) : (
            <label className="block text-sm font-semibold text-ink">
              Project
              <select className={FIELD_CLASS} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
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

        {projectId && <ProjectExportPanel projectId={projectId} />}

        {projectId && (
          <div className="mt-6">
            <ListPanel
              title="Sessions"
              rows={sessions ?? []}
              loading={!sessions && !sessionsError}
              error={sessionsError}
              emptyTitle="No sessions yet"
              emptyMessage="Sessions appear here once collection begins for this project."
              renderRow={(s) => {
                const blocked = blockedCount(s.piiStatusCounts)
                return (
                  <div className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-4">
                      <button
                        onClick={() => navigate(`/sessions/${s.id}/photos`)}
                        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        title="View this session's redacted frames"
                      >
                        <p className="truncate text-sm font-semibold text-ink">
                          {s.code}
                          {s.location ? ` — ${s.location}` : ''}
                        </p>
                        <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                          {sessionItemLabel(s)} · {s.participantCount} participant
                          {s.participantCount === 1 ? '' : 's'} · created{' '}
                          {new Date(s.createdAt).toLocaleDateString()}
                        </p>
                      </button>
                      <div className="flex shrink-0 items-center gap-2">
                        {s.handoff ? (
                          <StatusPill tone={HANDOFF_STATUS_TONE[s.handoff.status]}>
                            {s.handoff.status === 'INGESTED' ? 'Handed off' : s.handoff.status}
                          </StatusPill>
                        ) : (
                          <StatusPill tone="neutral">Not handed off</StatusPill>
                        )}
                        <StatusPill tone={SESSION_STATUS_TONE[s.status]}>{s.status}</StatusPill>
                      </div>
                    </div>

                    {blocked > 0 && (
                      <div className="mt-2 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
                        <AlertTriangle size={14} strokeWidth={2} className="shrink-0" />
                        {blocked} frame{blocked === 1 ? '' : 's'} blocked from handoff — redaction did not confirm
                        {s.piiStatusCounts.PENDING ? ` (${s.piiStatusCounts.PENDING} never processed)` : ''}
                        {s.piiStatusCounts.DEFERRED ? ` (${s.piiStatusCounts.DEFERRED} deferred)` : ''}
                        {s.piiStatusCounts.FAILED ? ` (${s.piiStatusCounts.FAILED} failed)` : ''}
                      </div>
                    )}
                  </div>
                )
              }}
            />
          </div>
        )}
      </main>
    </div>
  )
}
