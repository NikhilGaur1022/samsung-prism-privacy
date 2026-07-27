import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Image as ImageIcon, ScanFace, ShieldCheck, User } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import {
  getEnrollmentStatus,
  getMe,
  getMyParticipations,
  getMyPhotos,
  getMyRedactedPhoto,
  listConsentProjects,
} from '../lib/api'

const CONSENT_LABEL = {
  ACTIVE: { tone: 'success', label: 'Active' },
  REVOKED: { tone: 'danger', label: 'Withdrawn' },
  PURGED: { tone: 'neutral', label: 'Purged' },
}

// A single photo tile. Only ever fetches bytes for entries the server marked
// viewable — anything else means redaction has not been confirmed, and the
// image cannot be shown to anyone, including the principal it belongs to.
function PhotoThumb({ photo }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!photo.viewable) return undefined
    let cancelled = false
    let objectUrl = null

    getMyRedactedPhoto(photo.photoId)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photo.photoId, photo.viewable])

  if (!photo.viewable) {
    return (
      <div className="flex aspect-square flex-col items-center justify-center rounded-card bg-canvas p-2 text-center">
        <p className="text-[10px] font-semibold leading-snug text-ink-faint">
          Privacy masking has not finished — this photo can&apos;t be shown to anyone yet, including you.
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex aspect-square flex-col items-center justify-center rounded-card bg-canvas p-2 text-center">
        <p className="text-[10px] font-semibold text-danger">Could not load this photo.</p>
      </div>
    )
  }

  if (!url) {
    return <div className="aspect-square animate-pulse rounded-card bg-canvas" />
  }

  return (
    <img
      src={url}
      alt={`Your copy of a photo from session ${photo.sessionCode}`}
      className="aspect-square w-full rounded-card object-cover"
    />
  )
}

// DPDP §11: the summary a data principal is entitled to of what is held about
// them and on what basis. Every figure here comes straight off an API response.
export default function MyData() {
  const [me, setMe] = useState(null)
  const [projects, setProjects] = useState(null)
  const [enrollment, setEnrollment] = useState(null)
  const [participations, setParticipations] = useState(null)
  const [photos, setPhotos] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      getMe(),
      listConsentProjects(),
      getEnrollmentStatus(),
      getMyParticipations(),
      getMyPhotos(),
    ])
      .then(([meRes, projectsRes, enrollmentRes, participationsRes, photosRes]) => {
        setMe(meRes)
        setProjects(projectsRes.items)
        setEnrollment(enrollmentRes)
        setParticipations(participationsRes.items)
        setPhotos(photosRes)
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

            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">Photos</p>
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
                  {photos.projectCount} project{photos.projectCount === 1 ? '' : 's'}.
                </p>
                <div className="mt-3 space-y-4">
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
                      </p>
                      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {pp.photos.map((photo) => (
                          <PhotoThumb key={photo.photoId} photo={photo} />
                        ))}
                      </div>
                    </Card>
                  ))}
                </div>
              </>
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
