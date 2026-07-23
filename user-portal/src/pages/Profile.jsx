import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { User, ShieldCheck, FileText, LogOut, ChevronRight, Users, MapPin } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { getMyParticipations, logout } from '../lib/api'
import { useMe } from '../lib/useMe'

const LINKS = [
  { label: 'Manage Consent', to: '/consent', icon: ShieldCheck },
  { label: 'Data Rights & Requests', to: '/rights', icon: FileText },
]

const GROUP_LABELS = {
  SAMSUNG_EMPLOYEE: 'Samsung Employee',
  EX_SAMSUNG_EMPLOYEE: 'Ex-Samsung Employee',
  SEED_LAB_EMPLOYEE: 'Seed Lab Employee',
  EX_SEED_LAB_EMPLOYEE: 'Ex-Seed Lab Employee',
  VOLUNTEER: 'Volunteer',
}

const SESSION_TONE = {
  ACTIVE: 'success',
  PROCESSING: 'brand',
  TAGGING: 'brand',
  ARCHIVED: 'neutral',
  FAILED: 'danger',
}

// Sessions an agent added the subject to, grouped by project so the profile reads
// as "projects that have collected you" rather than a flat session log.
function Participations() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    getMyParticipations()
      .then((res) => setItems(res.items))
      .catch(() => setError(true))
  }, [])

  if (error) return null
  if (items && items.length === 0) return null

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2">
        <Users size={16} className="text-ink-muted" strokeWidth={1.75} />
        <h2 className="text-base font-bold text-ink">Projects you&apos;ve joined</h2>
      </div>
      <p className="mt-1 text-xs font-medium text-ink-muted">
        Sessions a collection agent has added you to.
      </p>

      <div className="mt-3 space-y-2.5">
        {items === null ? (
          <p className="text-sm font-medium text-ink-faint">Loading…</p>
        ) : (
          items.map((p) => (
            <Card key={p.id} className="flex items-start gap-3 py-3.5">
              <IconChip icon={Users} tone="brand" size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-ink">
                    {p.project?.name ?? 'Project'}
                  </p>
                  <Badge tone={SESSION_TONE[p.session.status] ?? 'neutral'}>
                    {p.session.status}
                  </Badge>
                </div>
                <p className="truncate text-xs font-medium text-ink-muted">
                  {p.project?.purpose ?? '—'}
                </p>
                <div className="mt-1 flex items-center gap-3 text-[11px] font-medium text-ink-faint">
                  <span>Session {p.session.code}</span>
                  {p.session.location && (
                    <span className="flex items-center gap-1">
                      <MapPin size={11} strokeWidth={2} />
                      {p.session.location}
                    </span>
                  )}
                  <span>{new Date(p.addedAt).toLocaleDateString()}</span>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

export default function Profile() {
  const navigate = useNavigate()
  const { me } = useMe()
  const [signingOut, setSigningOut] = useState(false)

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await logout()
    } catch {
      // Even if the server call fails, leaving for /login is the right move — the
      // refresh token is single-use and will not resurrect a session on its own.
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <div>
      <TopBar title="Profile" />
      <div className="px-4 md:px-8">
        <div className="flex items-center gap-4">
          <IconChip icon={User} tone="brand" size="lg" />
          <div className="min-w-0">
            <p className="truncate text-lg font-extrabold text-ink">{me?.fullName ?? '—'}</p>
            <p className="truncate text-sm font-medium text-ink-muted">{me?.email ?? ''}</p>
            {me?.group && (
              <p className="mt-0.5 text-xs font-semibold text-brand">
                {GROUP_LABELS[me.group] ?? me.group}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 space-y-2.5">
          {LINKS.map(({ label, to, icon: Icon }) => (
            <Link
              key={label}
              to={to}
              className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Card className="flex items-center gap-3 py-3.5">
                <IconChip icon={Icon} tone="brand" size="sm" />
                <span className="flex-1 text-sm font-semibold text-ink">{label}</span>
                <ChevronRight size={16} className="text-ink-faint" />
              </Card>
            </Link>
          ))}
        </div>

        <Participations />

        <button
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-card bg-danger-soft py-3.5 text-sm font-bold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
        >
          <LogOut size={16} strokeWidth={1.75} />
          {signingOut ? 'Signing out…' : 'Sign Out'}
        </button>
      </div>
    </div>
  )
}
