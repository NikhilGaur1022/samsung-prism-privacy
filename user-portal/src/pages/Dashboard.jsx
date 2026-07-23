import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { QrCode, ScanFace, ChevronRight } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { getEnrollmentStatus, listConsentProjects } from '../lib/api'
import { useMe } from '../lib/useMe'

// The QR itself is scanned with the phone's own camera app, which opens /join/:token
// directly. This is the fallback for a code read off a printed sheet or a laptop —
// previously the card was a dead label with nothing behind it.
function JoinCard() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  const go = () => {
    const input = value.trim()
    if (!input) return
    // Accept either the whole join URL or the bare token pasted out of it.
    const token = input.includes('/join/') ? input.split('/join/').pop().split(/[?#]/)[0] : input
    navigate(`/join/${token}`)
  }

  return (
    <Card className="md:col-span-2 flex flex-col items-center justify-center gap-3 bg-brand py-8 text-center text-white">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15">
        <QrCode size={24} strokeWidth={1.75} />
      </div>
      <p className="text-base font-bold">Scan QR to Join Project</p>
      <p className="max-w-xs text-xs font-medium text-white/80">
        Point your phone camera at the agent&apos;s QR code — it opens the join screen.
      </p>

      {open ? (
        <div className="mt-1 flex w-full max-w-xs gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="Paste the join link"
            className="w-full rounded-lg bg-white/15 px-3 py-2 text-sm font-semibold text-white outline-none placeholder:text-white/60"
          />
          <button
            onClick={go}
            className="shrink-0 rounded-lg bg-white px-3 py-2 text-sm font-bold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Go
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="text-xs font-bold text-white/90 underline focus-visible:outline-none"
        >
          Can&apos;t scan? Enter the link instead
        </button>
      )}
    </Card>
  )
}

// Persistent, because /enroll is skippable. Someone who skipped has no way back
// to it otherwise, and an unenrolled subject is a manual tagging job for an agent.
function EnrollmentBanner() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    getEnrollmentStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  if (!status || status.complete || !status.verified) return null

  return (
    <Link
      to="/enroll"
      className="mt-4 block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <Card className="flex items-center gap-3 bg-brand-soft">
        <IconChip icon={ScanFace} tone="brand" size="sm" />
        <div className="flex-1">
          <p className="text-sm font-bold text-brand">Finish setting up face matching</p>
          <p className="text-xs font-medium text-brand/80">
            {status.biometricConsent
              ? `${status.poses.length} of 5 angles captured — takes about a minute.`
              : 'Not set up yet. Pictures of you have to be tagged by hand until it is.'}
          </p>
        </div>
        <ChevronRight size={18} className="text-brand" />
      </Card>
    </Link>
  )
}

function useActiveConsents() {
  const [projects, setProjects] = useState(null)

  useEffect(() => {
    listConsentProjects()
      .then((data) => setProjects(data?.items ?? []))
      .catch(() => setProjects([]))
  }, [])

  return projects
}

export default function Dashboard() {
  const { me } = useMe()
  const projects = useActiveConsents()
  const activeConsents = (projects ?? []).filter((p) => p.consent?.status === 'ACTIVE')

  const firstName = me?.fullName?.split(' ')[0] ?? 'there'

  return (
    <div>
      <TopBar title="Dashboard" />

      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Hello, {firstName}</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Your digital footprint is well-guarded.</p>

        <EnrollmentBanner />

        <div className="mt-5">
          <JoinCard />
        </div>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">Active Consents</h2>
          <Link to="/projects" className="text-sm font-semibold text-brand">
            View all
          </Link>
        </div>

        {projects === null ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">Loading…</p>
        ) : activeConsents.length === 0 ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">No active consents yet.</p>
        ) : (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {activeConsents.map(({ id, name, purpose }) => (
              <Link
                key={id}
                to={`/consent/${id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Card className="flex items-center gap-3">
                  <IconChip icon={ScanFace} tone="brand" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{name}</p>
                    <p className="truncate text-xs font-medium text-ink-muted">{purpose}</p>
                  </div>
                  <Badge tone="success">ACTIVE</Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
