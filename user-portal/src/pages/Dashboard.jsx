import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ChevronRight,
  Database,
  FileClock,
  FilePlus2,
  Inbox,
  Loader2,
  QrCode,
  Scale,
  ScanFace,
  ShieldCheck,
} from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import {
  getEnrollmentStatus,
  listConsentProjects,
  getMyPhotoSummary,
  listMyDsarRequests,
} from '../lib/api'
import { useMe } from '../lib/useMe'

// One page for the whole signed-in surface.
//
// The portal had thirteen routes and a sidebar, and everything a principal can
// actually DO — see what is held, give or withdraw consent, raise a request,
// follow it, collect the answer — lived one click away behind a menu label. On a
// phone, where most of these people are, the sidebar collapses to five icons and
// the rest are effectively invisible.
//
// So this page carries the state at the top and the actions inline as you scroll,
// and every section links to the full page for anything deeper. The routes are
// all still mounted: a bookmark, a link in an email, and the deep links this page
// emits all keep working. This is a front door, not a replacement.

const STATUS_TONE = {
  RECEIVED: 'neutral',
  TRIAGE: 'neutral',
  DISCOVERY: 'warning',
  EXECUTING: 'warning',
  REVIEW: 'warning',
  CLOSED: 'success',
  REJECTED: 'danger',
}

// The QR itself is scanned with the phone's own camera app, which opens /join/:token
// directly. This is the fallback for a code read off a printed sheet or a laptop.
function JoinCard() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')

  const go = () => {
    const input = value.trim()
    if (!input) return
    const token = input.includes('/join/') ? input.split('/join/').pop().split(/[?#]/)[0] : input
    navigate(`/join/${token}`)
  }

  return (
    <Card className="flex flex-col items-center justify-center gap-3 bg-brand py-8 text-center text-white">
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
function EnrollmentBanner({ status }) {
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

function Stat({ label, value, hint, to, loading }) {
  const body = (
    <Card className="h-full">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tracking-tight text-ink">
        {loading ? <Loader2 size={20} className="animate-spin text-ink-faint" /> : value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] font-medium text-ink-faint">{hint}</p>}
    </Card>
  )
  return to ? (
    <Link to={to} className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
      {body}
    </Link>
  ) : (
    body
  )
}

// A section heading with its own "see everything" escape hatch. Every block on
// this page has one, because the page is a summary and a principal who wants the
// detail must never hit a dead end here.
function SectionHeader({ title, to, linkLabel = 'View all' }) {
  return (
    <div className="mt-7 flex items-center justify-between">
      <h2 className="text-base font-bold text-ink">{title}</h2>
      {to && (
        <Link to={to} className="text-sm font-semibold text-brand">
          {linkLabel}
        </Link>
      )}
    </div>
  )
}

function ActionTile({ to, icon: Icon, label, description }) {
  return (
    <Link to={to} className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
      <Card className="flex h-full items-center gap-3">
        <IconChip icon={Icon} tone="brand" size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">{label}</p>
          <p className="text-xs font-medium text-ink-muted">{description}</p>
        </div>
        <ChevronRight size={16} className="shrink-0 text-ink-faint" />
      </Card>
    </Link>
  )
}

export default function Dashboard() {
  const { me } = useMe()
  const [projects, setProjects] = useState(null)
  const [photos, setPhotos] = useState(null)
  const [requests, setRequests] = useState(null)
  const [enrollment, setEnrollment] = useState(null)

  // Every panel fails on its own. A dashboard that blanks because one endpoint
  // is down is worse than one that shows four things and an empty fifth — and
  // the §11 summary in particular is the panel most likely to be slow.
  const load = useCallback(() => {
    listConsentProjects().then((d) => setProjects(d?.items ?? [])).catch(() => setProjects([]))
    getMyPhotoSummary().then(setPhotos).catch(() => setPhotos(null))
    listMyDsarRequests().then((d) => setRequests(d?.items ?? [])).catch(() => setRequests([]))
    getEnrollmentStatus().then(setEnrollment).catch(() => setEnrollment(null))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const firstName = me?.fullName?.split(' ')[0] ?? 'there'
  const activeConsents = (projects ?? []).filter((p) => p.consent?.status === 'ACTIVE')
  const pendingConsents = (projects ?? []).filter((p) => !p.consent || p.consent.status !== 'ACTIVE')
  const openRequests = (requests ?? []).filter(
    (r) => r.status !== 'CLOSED' && r.status !== 'REJECTED',
  )
  // The one that needs them to act. An erasure sits in DISCOVERY until the
  // principal reviews the package and presses Erase, and nothing else on the
  // page would tell them the ball is in their court.
  const awaitingConfirmation = (requests ?? []).filter(
    (r) => r.type === 'ERASE' && r.status === 'DISCOVERY' && !r.subjectConfirmedAt,
  )

  return (
    <div>
      <TopBar title="Dashboard" />

      <div className="px-4 pb-10 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Hello, {firstName}</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Everything we hold about you, and everything you can do about it.
        </p>

        <EnrollmentBanner status={enrollment} />

        {awaitingConfirmation.length > 0 && (
          <div className="mt-4 space-y-2">
            {awaitingConfirmation.map((r) => (
              <Link
                key={r.id}
                to={`/requests/${r.id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                <Card className="flex items-center gap-3 bg-danger-soft">
                  <IconChip icon={Scale} tone="danger" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-danger">Your erasure is waiting on you</p>
                    <p className="text-xs font-medium text-danger/80">
                      Review the photos it covers, then press Erase. Nothing is deleted until you do.
                    </p>
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-danger" />
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* ---- At a glance ---- */}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Photos of you"
            value={photos?.totalPhotos ?? 0}
            hint={photos ? `across ${photos.projectCount} project${photos.projectCount === 1 ? '' : 's'}` : null}
            to="/my-data"
            loading={photos === null && requests === null}
          />
          <Stat
            label="Active consents"
            value={activeConsents.length}
            hint={pendingConsents.length > 0 ? `${pendingConsents.length} awaiting you` : 'all up to date'}
            to="/consents"
            loading={projects === null}
          />
          <Stat
            label="Open requests"
            value={openRequests.length}
            hint={requests ? `${requests.length} in total` : null}
            to="/requests"
            loading={requests === null}
          />
          <Stat
            label="Secure inbox"
            value={(requests ?? []).filter((r) => r.status === 'CLOSED').length}
            hint="completed requests"
            to="/inbox"
            loading={requests === null}
          />
        </div>

        <div className="mt-5">
          <JoinCard />
        </div>

        {/* ---- Consent ---- */}
        <SectionHeader title="Your consents" to="/consents" />
        {projects === null ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">Loading…</p>
        ) : activeConsents.length === 0 && pendingConsents.length === 0 ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">
            No projects have asked for your consent yet.
          </p>
        ) : (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {[...pendingConsents, ...activeConsents].slice(0, 4).map(({ id, name, purpose, consent }) => (
              <Link
                key={id}
                to={`/consent/${id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Card className="flex items-center gap-3">
                  <IconChip icon={ShieldCheck} tone={consent?.status === 'ACTIVE' ? 'brand' : 'warning'} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{name}</p>
                    <p className="truncate text-xs font-medium text-ink-muted">{purpose}</p>
                  </div>
                  <Badge tone={consent?.status === 'ACTIVE' ? 'success' : 'warning'}>
                    {consent?.status === 'ACTIVE' ? 'ACTIVE' : 'ACTION NEEDED'}
                  </Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* ---- Data held ---- */}
        <SectionHeader title="What we hold" to="/my-data" linkLabel="See details" />
        {photos === null ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">Loading…</p>
        ) : photos.totalPhotos === 0 ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">
            No photographs of you have been collected yet.
          </p>
        ) : (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {photos.projects.slice(0, 4).map((row) => (
              <Card key={row.project.id} className="flex items-center gap-3">
                <IconChip icon={Database} tone="brand" size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{row.project.name}</p>
                  <p className="truncate text-xs font-medium text-ink-muted">
                    {row.photoCount} photo{row.photoCount === 1 ? '' : 's'} · {row.sessionCount} session
                    {row.sessionCount === 1 ? '' : 's'}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* ---- Requests ---- */}
        <SectionHeader title="Your requests" to="/requests" />
        {requests === null ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="mt-3 text-xs font-medium text-ink-faint">
            You have not raised any requests.
          </p>
        ) : (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {requests.slice(0, 4).map((r) => (
              <Link
                key={r.id}
                to={`/requests/${r.id}`}
                className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Card className="flex items-center gap-3">
                  <IconChip icon={FileClock} tone="brand" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{r.type} request</p>
                    <p className="truncate text-xs font-medium text-ink-muted">
                      Raised {new Date(r.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}

        {/* ---- Everything you can do ----
            The point of the page. These were menu entries; a right nobody can
            find is not a right they have. */}
        <SectionHeader title="What you can do" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ActionTile
            to="/consent"
            icon={ShieldCheck}
            label="Give consent"
            description="Review a notice and agree to take part"
          />
          <ActionTile
            to="/requests/new"
            icon={FilePlus2}
            label="Raise a request"
            description="Access, correct, or erase your data"
          />
          <ActionTile
            to="/my-data"
            icon={Database}
            label="See my photos"
            description="What is held, by project"
          />
          <ActionTile
            to="/rights"
            icon={Scale}
            label="My rights"
            description="What the law entitles you to here"
          />
          <ActionTile
            to="/requests"
            icon={FileClock}
            label="Track my requests"
            description="Progress and deadlines"
          />
          <ActionTile
            to="/inbox"
            icon={Inbox}
            label="Secure inbox"
            description="Collect packages and certificates"
          />
        </div>
      </div>
    </div>
  )
}
