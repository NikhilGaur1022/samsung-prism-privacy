import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { grantConsent, listConsentProjects, revokeConsent } from '../lib/api'

const STATUS_BADGE = {
  ACTIVE: { tone: 'success', label: 'Consent given' },
  REVOKED: { tone: 'danger', label: 'Withdrawn' },
  PURGED: { tone: 'neutral', label: 'Purged' },
}

export default function MyConsents() {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [confirmId, setConfirmId] = useState(null)

  const load = () => listConsentProjects().then((res) => setProjects(res.items)).catch(setError)

  useEffect(() => {
    load()
  }, [])

  const act = async (projectId, fn) => {
    setBusyId(projectId)
    setError(null)
    try {
      await fn(projectId)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setBusyId(null)
      setConfirmId(null)
    }
  }

  return (
    <div>
      <TopBar title="My Consents" />
      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">My Consents</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Grant or withdraw consent per project. This is the only place your consent decisions are made.
        </p>

        {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

        {!projects ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">No projects are asking for your data yet.</p>
        ) : (
          <div className="mt-5 space-y-3">
            {projects.map((project) => {
              const status = project.consent?.status
              const badge = status ? STATUS_BADGE[status] : { tone: 'neutral', label: 'Not given' }
              const active = status === 'ACTIVE'
              const purged = status === 'PURGED'
              const busy = busyId === project.id
              const confirming = confirmId === project.id

              return (
                <Card key={project.id}>
                  <div className="flex items-start gap-3">
                    <IconChip icon={active ? ShieldCheck : ShieldOff} tone={active ? 'brand' : 'neutral'} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{project.name}</p>
                      <p className="mt-0.5 text-xs font-medium text-ink-muted">{project.purpose}</p>
                      {project.consent?.consentedAt && (
                        <p className="mt-1 text-[11px] font-medium text-ink-faint">
                          Consented {new Date(project.consent.consentedAt).toLocaleString()}
                          {project.consent.policyVersion && ` · Policy ${project.consent.policyVersion}`}
                        </p>
                      )}
                      {project.consent?.revokedAt && (
                        <p className="mt-1 text-[11px] font-medium text-ink-faint">
                          Withdrawn {new Date(project.consent.revokedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>

                  {!confirming ? (
                    <div className="mt-3">
                      {purged ? (
                        <p className="text-xs font-medium text-ink-faint">
                          This project's data was purged. Consent cannot be re-granted.
                        </p>
                      ) : active ? (
                        <button
                          onClick={() => setConfirmId(project.id)}
                          disabled={busy}
                          className="text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                        >
                          Withdraw consent
                        </button>
                      ) : (
                        <button
                          onClick={() => act(project.id, grantConsent)}
                          disabled={busy}
                          className="rounded-pill bg-brand px-4 py-2 text-xs font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                        >
                          {busy ? 'Saving…' : 'Give consent'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-card border border-border bg-danger-soft p-3">
                      <div className="flex items-start gap-2">
                        <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" />
                        <p className="text-xs font-medium leading-relaxed text-danger">
                          Withdrawing stops all future processing under {project.name} immediately, and
                          triggers erasure of any of your data this project no longer has a lawful basis to
                          hold — including photos and face data linked to you. This cannot be undone from
                          here; you would need to give consent again to rejoin.
                        </p>
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={() => act(project.id, revokeConsent)}
                          disabled={busy}
                          className="rounded-pill bg-danger px-4 py-2 text-xs font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                        >
                          {busy ? 'Withdrawing…' : 'Yes, withdraw'}
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          disabled={busy}
                          className="rounded-pill bg-canvas px-4 py-2 text-xs font-bold text-ink-muted disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
