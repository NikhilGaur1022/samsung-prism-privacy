import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { ROLES } from '../roles'
import Sidebar from '../components/Sidebar'
import PageHeader from '../components/PageHeader'
import ListPanel from '../components/ListPanel'
import { getDashboardSummary } from '../lib/api'
import { ShieldCheck } from 'lucide-react'

const TONE_MAP = { danger: 'danger', warn: 'warning', ok: 'success' }

// tile.href is role-prefixed by the API (e.g. "/dpo/project-approvals") but this router is flat — strip the prefix so the link resolves instead of 404ing.
const HREF_PREFIXES = ['/dpo', '/data-owner', '/agent', '/data-admin']
function resolveHref(href) {
  if (!href) return null
  // Match on a full path segment, not a raw prefix — "/dpo" must not eat "/dpoSomethingElse".
  const prefix = HREF_PREFIXES.find((p) => href === p || href.startsWith(`${p}/`))
  return prefix ? href.slice(prefix.length) || '/' : href
}

// Every screen underneath this one queues work by pulling from a specific
// endpoint (projects, dsar, handoffs...). The dashboard's job is only to
// summarise — it renders whatever shape the role-aware /dashboard/summary
// response hands back, so it never hardcodes what a role's queue looks like.
function queueRows(summary) {
  if (Array.isArray(summary.queue)) {
    return summary.queue.map((item) => ({
      id: item.id,
      title: item.subjectRef ? `${item.subjectRef} — ${item.type}` : (item.title ?? item.type ?? item.id),
      subtitle: item.status
        ? `${item.status}${item.slaDueAt ? ` · SLA due ${new Date(item.slaDueAt).toLocaleDateString()}` : ''}`
        : undefined,
    }))
  }
  if (Array.isArray(summary.projects)) {
    return summary.projects.map((p) => ({
      id: p.id,
      title: p.name,
      subtitle: `${p.status}${p.sessionCount != null ? ` · ${p.sessionCount} sessions` : ''}`,
    }))
  }
  if (Array.isArray(summary.assignments)) {
    return summary.assignments.map((a) => ({
      id: a.id,
      title: a.name,
      subtitle: `${a.status} · assigned ${new Date(a.assignedAt).toLocaleDateString()}`,
    }))
  }
  if (Array.isArray(summary.sessions)) {
    return summary.sessions.map((s) => ({
      id: s.id,
      title: `${s.code} — ${s.project?.name ?? ''}`,
      subtitle: `${s.status} · ${s.photoCount} photos`,
    }))
  }
  return []
}

export default function Dashboard() {
  const { roleKey } = useAuth()
  const role = ROLES[roleKey]
  const navigate = useNavigate()

  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  const reload = useCallback(() => {
    setError(null)
    getDashboardSummary().then(setSummary).catch(setError)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader title={role?.dashboardTitle} subtitle={role?.subtitle} />

        {error ? (
          <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
            <p className="text-sm font-semibold text-danger">{error.message}</p>
          </div>
        ) : !summary ? (
          <div className="mt-6 grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-3 gap-4">
              {summary.tiles.map((tile) => {
                const bg =
                  TONE_MAP[tile.tone] === 'danger'
                    ? 'bg-danger-soft'
                    : TONE_MAP[tile.tone] === 'warning'
                      ? 'bg-warning-soft'
                      : 'bg-surface'
                const href = resolveHref(tile.href)
                const Tag = href ? 'button' : 'div'
                return (
                  <Tag
                    key={tile.label}
                    type={href ? 'button' : undefined}
                    onClick={href ? () => navigate(href) : undefined}
                    className={`rounded-card p-5 text-left shadow-card ${bg} ${
                      href ? 'cursor-pointer hover:shadow-md' : ''
                    } ${tile.emphasis ? 'ring-2 ring-brand' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
                  >
                    <p className="text-2xl font-extrabold text-ink">{tile.value}</p>
                    <p className="mt-1 text-sm font-medium text-ink-muted">{tile.label}</p>
                  </Tag>
                )
              })}
            </div>

            <div className="mt-6">
              <ListPanel title="Current Work Queue" rows={queueRows(summary)} emptyTitle="Nothing queued" />
            </div>
          </>
        )}

        <div className="mt-6 flex gap-3 rounded-card bg-surface p-5 shadow-card">
          <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
          <div>
            <p className="text-sm font-bold text-ink">Access is role-scoped</p>
            <p className="mt-1 text-xs font-medium leading-relaxed text-ink-muted">{role?.accessNote}</p>
          </div>
        </div>
      </main>
    </div>
  )
}
