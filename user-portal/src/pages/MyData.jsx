import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioLines, Image as ImageIcon, Lock, ScanFace, ShieldCheck, User } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import {
  getEnrollmentStatus,
  getMe,
  getMyParticipations,
  getMyPhotoSummary,
  enrollmentImageUrl,
  listConsentProjects,
  listEnrollments,
  listVoiceEnrollments,
  voiceEnrollmentAudioUrl,
} from '../lib/api'

const POSE_LABEL = { FRONT: 'Front', LEFT: 'Left', RIGHT: 'Right' }

// Dates are rendered day-precision on purpose. A capture timestamp is itself a
// fact about where the principal was and when; the day is enough to make the
// summary meaningful without rebuilding a movement log out of it.
const day = (d) => (d ? new Date(d).toLocaleDateString() : null)

function collectedRange(first, last) {
  const a = day(first)
  const b = day(last)
  if (!a) return null
  return a === b ? `Collected ${a}` : `Collected ${a} – ${b}`
}

const CONSENT_LABEL = {
  ACTIVE: { tone: 'success', label: 'Active' },
  REVOKED: { tone: 'danger', label: 'Withdrawn' },
  PURGED: { tone: 'neutral', label: 'Purged' },
}

// DPDP §11: the summary a data principal is entitled to of what is held about
// them and on what basis. Every figure here comes straight off an API response.
//
// A summary is all this page shows. It used to render the photographs as well,
// as a grid the portal fetched frame by frame — which turned a session cookie
// into a standing read over the collected material, with no review, no record of
// what a principal was actually shown, and nothing to revoke if the account were
// taken over. Copies are obtained by raising an ACCESS request instead: reviewed,
// approved by the DPO, and delivered once to the secure inbox.
export default function MyData() {
  const [me, setMe] = useState(null)
  const [projects, setProjects] = useState(null)
  const [enrollment, setEnrollment] = useState(null)
  const [participations, setParticipations] = useState(null)
  const [photos, setPhotos] = useState(null)
  const [poses, setPoses] = useState([])
  const [clips, setClips] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getMe(),
      listConsentProjects(),
      getEnrollmentStatus(),
      getMyParticipations(),
      getMyPhotoSummary(),
      listEnrollments(),
      // 503 when AUDIO_CAPTURE_ENABLED is off. That is "not offered here", not a
      // failure, so it resolves to an empty list rather than blanking the page.
      listVoiceEnrollments().catch(() => ({ items: [] })),
    ])
      .then(([meRes, projectsRes, enrollmentRes, participationsRes, photosRes, posesRes, clipsRes]) => {
        setMe(meRes)
        setProjects(projectsRes.items)
        setEnrollment(enrollmentRes)
        setParticipations(participationsRes.items)
        setPhotos(photosRes)
        setPoses(posesRes.items)
        setClips(clipsRes.items)
      })
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  const consented = projects?.filter((p) => p.consent?.status === 'ACTIVE') ?? []

  return (
    <div>
      <TopBar title="My Data" />
      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">My Data</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          What Prism holds about you, and on what basis, as required under DPDP §11.
        </p>

        {loading && <p className="mt-5 text-sm font-medium text-ink-muted">Loading…</p>}
        {error && <p className="mt-5 text-sm font-semibold text-danger">{error.message}</p>}

        {me && (
          <>
            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">Profile</p>
            <Card className="mt-3 flex items-center gap-3">
              <IconChip icon={User} tone="brand" size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{me.fullName}</p>
                <p className="truncate text-xs font-medium text-ink-muted">{me.email}</p>
                {me.phone && <p className="truncate text-xs font-medium text-ink-muted">{me.phone}</p>}
              </div>
              <Badge tone={me.status === 'ACTIVE' ? 'success' : 'neutral'}>{me.status}</Badge>
            </Card>

            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
              Consents ({consented.length} active of {projects.length})
            </p>
            <div className="mt-3 space-y-2.5">
              {projects.length === 0 && (
                <p className="text-sm font-medium text-ink-muted">No projects are asking for your data.</p>
              )}
              {projects.map((p) => {
                const c = p.consent ? CONSENT_LABEL[p.consent.status] : { tone: 'neutral', label: 'Not given' }
                return (
                  <Card key={p.id} className="flex items-center gap-3 py-3">
                    <IconChip icon={ShieldCheck} tone="brand" size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{p.name}</p>
                      <p className="truncate text-xs font-medium text-ink-muted">
                        {p.consent?.consentedAt
                          ? `Consented ${new Date(p.consent.consentedAt).toLocaleString()}`
                          : 'No consent record'}
                      </p>
                    </div>
                    <Badge tone={c.tone}>{c.label}</Badge>
                  </Card>
                )
              })}
            </div>

            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
              Biometric enrollment
            </p>
            <Card className="mt-3 flex items-center gap-3">
              <IconChip icon={ScanFace} tone="brand" size="sm" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-ink">
                  {enrollment.count} photo{enrollment.count === 1 ? '' : 's'} on file
                </p>
                <p className="text-xs font-medium text-ink-muted">
                  {enrollment.biometricConsent
                    ? `Covering ${enrollment.poses.length} of ${enrollment.allPoses.length} angles`
                    : 'Face matching is not enabled'}
                </p>
              </div>
              <Badge tone={enrollment.complete ? 'success' : 'neutral'}>
                {enrollment.complete ? 'Complete' : 'Incomplete'}
              </Badge>
            </Card>

            {/* The enrollment media itself is shown, unlike anything collected in
                a session. The distinction is who produced it and why: these are
                the reference shots and the voice sample the principal recorded
                themselves, held one per subject as the key that face and speaker
                matching run against. Showing them back is how someone checks what
                their own reference set actually contains before deciding whether
                to delete a frame or withdraw biometric consent, and none of it
                discloses anybody else. Session material is a different thing —
                other people are in it, it was captured by an agent under a
                project purpose, and it goes through an approved access request. */}
            {poses.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {poses.map((item) => (
                  <div key={item.id}>
                    <img
                      src={enrollmentImageUrl(item.id)}
                      alt={`Your ${POSE_LABEL[item.pose] ?? 'enrollment'} reference photo`}
                      className="h-20 w-20 rounded-card object-cover"
                    />
                    <p className="mt-1 text-center text-[10px] font-bold text-ink-faint">
                      {POSE_LABEL[item.pose] ?? '—'}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {clips.length > 0 && (
              <>
                <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
                  Voice enrollment
                </p>
                <Card className="mt-3 space-y-3 py-3">
                  <div className="flex items-center gap-3">
                    <IconChip icon={AudioLines} tone="brand" size="sm" />
                    <p className="text-sm font-semibold text-ink">
                      {clips.length} voice clip{clips.length === 1 ? '' : 's'} on file
                    </p>
                  </div>
                  {clips.map((clip) => (
                    <div key={clip.id}>
                      <p className="text-xs font-bold text-ink">
                        {clip.durationSec == null ? '—' : `${clip.durationSec.toFixed(1)} seconds`}
                        <span className="ml-2 font-medium text-ink-faint">{day(clip.createdAt)}</span>
                      </p>
                      {/* preload="none" so opening this page does not pull every
                          clip the person has ever recorded onto the device. */}
                      <audio controls preload="none" src={voiceEnrollmentAudioUrl(clip.id)} className="mt-1 w-full" />
                    </div>
                  ))}
                </Card>
              </>
            )}

            {(poses.length > 0 || clips.length > 0) && (
            <p className="mt-2 text-xs font-medium text-ink-faint">
              Add, replace or delete these under{' '}
              <Link to="/consent" className="font-bold text-brand underline-offset-2 hover:underline">
                Give consent
              </Link>
              .
            </p>
            )}

            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
              Sessions you have joined ({participations.length})
            </p>
            <div className="mt-3 space-y-2.5">
              {participations.length === 0 && (
                <p className="text-sm font-medium text-ink-muted">
                  You have not been added to a collection session yet.
                </p>
              )}
              {participations.map((p) => (
                <Card key={p.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{p.project.name}</p>
                    <p className="truncate text-xs font-medium text-ink-muted">
                      Session {p.session.code} · {new Date(p.addedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge tone="neutral">{p.session.status}</Badge>
                </Card>
              ))}
            </div>

            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
              Photos of you
            </p>
            {photos.totalPhotos === 0 ? (
              <Card className="mt-3 flex items-center gap-3">
                <IconChip icon={ImageIcon} tone="neutral" size="sm" />
                <p className="text-sm font-medium text-ink-muted">
                  You do not appear in any photos yet.
                </p>
              </Card>
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold text-ink">
                  You appear in {photos.totalPhotos} photo{photos.totalPhotos === 1 ? '' : 's'} across{' '}
                  {photos.projectCount} project{photos.projectCount === 1 ? '' : 's'} and{' '}
                  {photos.sessionCount} session{photos.sessionCount === 1 ? '' : 's'}.
                </p>
                <div className="mt-3 space-y-2.5">
                  {photos.projects.map((pp) => (
                    <Card key={pp.project.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-ink">{pp.project.name}</p>
                          <p className="mt-0.5 text-xs font-medium text-ink-muted">{pp.project.purpose}</p>
                          <p className="mt-0.5 text-xs font-medium text-ink-faint">
                            Retention: {pp.project.retention}
                          </p>
                        </div>
                        <Badge tone={pp.consent ? CONSENT_LABEL[pp.consent.status]?.tone ?? 'neutral' : 'neutral'}>
                          {pp.consent ? CONSENT_LABEL[pp.consent.status]?.label ?? pp.consent.status : 'No consent record'}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs font-medium text-ink-muted">
                        {pp.photoCount} photo{pp.photoCount === 1 ? '' : 's'} · {pp.sessionCount} session
                        {pp.sessionCount === 1 ? '' : 's'}
                        {collectedRange(pp.firstCollectedAt, pp.lastCollectedAt)
                          ? ` · ${collectedRange(pp.firstCollectedAt, pp.lastCollectedAt)}`
                          : ''}
                      </p>
                    </Card>
                  ))}
                </div>
              </>
            )}

            {/* Says plainly why there are no thumbnails here, and where the
                copies actually come from. An absent feature with no explanation
                reads as a broken page, and a principal who cannot find the
                access route does not have the access right. Only shown when
                there is in fact material to ask for. */}
            {photos.totalPhotos > 0 && (
            <Card className="mt-3 flex items-start gap-3 py-3">
              <IconChip icon={Lock} tone="neutral" size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">The photos themselves aren&apos;t shown here</p>
                <p className="mt-1 text-xs font-medium text-ink-muted">
                  This page is your summary: what is held, for what purpose, and under which consent.
                  To get copies of the material, raise an access request. It is checked by a data
                  administrator, approved by the Data Protection Officer, and delivered once to your
                  secure inbox — with everyone else in the frame masked.
                </p>
                <Link
                  to="/requests/new"
                  className="mt-2 inline-flex text-xs font-bold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Request a copy of your data
                </Link>
              </div>
            </Card>
            )}

            <div className="mt-6 grid grid-cols-2 gap-3">
              <Link
                to="/consents"
                className="flex items-center justify-center rounded-card bg-brand-soft py-3 text-sm font-bold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Manage consents
              </Link>
              <Link
                to="/requests/new"
                className="flex items-center justify-center rounded-card bg-brand py-3 text-sm font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                Raise a request
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
