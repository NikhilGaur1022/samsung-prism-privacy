import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Fingerprint, Clock, Database, ScanFace, User, ShieldCheck, ShieldOff } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { grantConsent, listConsentProjects, revokeConsent } from '../lib/api'

const COLLECTED = [
  { label: 'Photographs of you', icon: ScanFace },
  { label: 'Biometric face data', icon: Fingerprint },
  { label: 'Full Name', icon: User },
]

export default function ProjectDetails() {
  const { projectId } = useParams()
  const [project, setProject] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () =>
    listConsentProjects()
      .then((res) => setProject(res.items.find((p) => p.id === projectId) ?? null))
      .catch(setError)

  useEffect(() => {
    load()
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn(projectId)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!project) {
    return (
      <div>
        <TopBar back />
        <div className="px-4 md:px-8">
          <p className="text-sm font-medium text-ink-muted">
            {error ? error.message : 'Loading…'}
          </p>
        </div>
      </div>
    )
  }

  const active = project.consent?.status === 'ACTIVE'

  return (
    <div>
      <TopBar back />

      <div className="px-4 md:px-8 md:grid md:grid-cols-5 md:gap-8">
        <div className="md:col-span-3">
          <Badge tone={active ? 'success' : 'neutral'}>
            {active ? 'Consent Active' : 'Consent Not Given'}
          </Badge>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight text-ink">
            {project.name}
          </h1>

          <div className="mt-4 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-card bg-gradient-to-br from-brand-soft to-canvas md:aspect-video">
            <ScanFace size={72} strokeWidth={1} className="text-brand" />
          </div>

          <div className="mt-5">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">Purpose</p>
            <p className="mt-1.5 text-sm font-medium leading-relaxed text-ink-muted">
              {project.purpose}
            </p>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <Card className="flex items-center gap-3">
              <IconChip icon={Clock} tone="neutral" size="sm" />
              <div>
                <p className="text-xs font-medium text-ink-muted">Retention</p>
                <p className="text-sm font-bold text-ink">{project.retention ?? 'Not stated'}</p>
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <IconChip icon={Database} tone="neutral" size="sm" />
              <div>
                <p className="text-xs font-medium text-ink-muted">Policy</p>
                <p className="text-sm font-bold text-ink">{project.policyVersion}</p>
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-6 md:col-span-2 md:mt-0">
          <h2 className="text-base font-bold text-ink">Collected Data</h2>
          <div className="mt-3 space-y-2.5">
            {COLLECTED.map(({ label, icon: Icon }) => (
              <Card key={label} className="flex items-center gap-3 py-3">
                <IconChip icon={Icon} tone="brand" size="sm" />
                <span className="flex-1 text-sm font-semibold text-ink">{label}</span>
              </Card>
            ))}
          </div>

          {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

          {/* One decision, project-wide. Granting covers everything above — including
              being photographed and having your face detected in those photos. */}
          <div className="mt-6 space-y-3 pb-6">
            {active ? (
              <button
                onClick={() => act(revokeConsent)}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-card bg-danger-soft py-3.5 text-sm font-bold text-danger disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                <ShieldOff size={16} strokeWidth={1.75} />
                {busy ? 'Revoking…' : 'Revoke Consent'}
              </button>
            ) : (
              <button
                onClick={() => act(grantConsent)}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-sm font-bold text-white shadow-card disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <ShieldCheck size={16} strokeWidth={1.75} />
                {busy ? 'Saving…' : 'Give Consent'}
              </button>
            )}
            <p className="text-center text-xs font-medium text-ink-faint">
              {active
                ? 'You can revoke at any time. Your photos are then deleted and you are removed from any active collection session.'
                : 'Until you consent, collection agents cannot add you to a photo session for this project.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
