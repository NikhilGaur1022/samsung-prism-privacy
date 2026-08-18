import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AudioLines, ShieldCheck, ShieldOff, ScanFace } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { ConsentGate, PoseStepper, useEnrollment } from '../components/FaceEnrollment'
import {
  VoiceClipList,
  VoiceConsentGate,
  useVoiceEnrollment,
} from '../components/VoiceEnrollment'

// Collapsed-behind-"Add photo" was the actual reason nobody ever enrolled: the
// card looked finished when it was empty. It now opens itself until the set is
// complete, and only collapses once there is genuinely nothing left to do.
//
// onBiometricChange fires after the consent flag moves. Both cards read the same
// flag, so without it, withdrawing here would leave the voice card below still
// listing clips the server had already erased — a stale screen that says the
// erasure did not happen.
function FaceEnrollmentCard({ onBiometricChange }) {
  const enrollment = useEnrollment()
  const { status } = enrollment
  const [expanded, setExpanded] = useState(null)

  const complete = status?.complete === true
  const open = expanded ?? !complete

  const summary = !status
    ? 'Loading…'
    : !status.verified
      ? 'Verify your email to set this up.'
      : !status.biometricConsent
        ? 'Not set up. Photos of you have to be tagged by hand until it is.'
        : complete
          ? `${status.count} photo${status.count === 1 ? '' : 's'} on file, covering ${status.poses.length} angles.`
          : `${status.poses.length} of 5 angles captured — a few more makes matching far more reliable.`

  return (
    <Card className="mt-5">
      <div className="flex items-start gap-3">
        <IconChip icon={ScanFace} tone="brand" size="sm" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-ink">Face matching</p>
          <p className="mt-0.5 text-xs font-medium text-ink-muted">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {complete && <Badge tone="success">SET UP</Badge>}
          <button
            onClick={() => setExpanded(!open)}
            className="rounded-pill bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {open ? 'Hide' : 'Manage'}
          </button>
        </div>
      </div>

      {open && status?.verified && (
        <div className="mt-4">
          {status.biometricConsent ? (
            <>
              <PoseStepper enrollment={enrollment} />
              <button
                onClick={async () => {
                  await enrollment.consent(false)
                  onBiometricChange()
                }}
                disabled={enrollment.busy}
                className="mt-4 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                Turn off biometric matching and delete my photos and voice recordings
              </button>
            </>
          ) : (
            <ConsentGate enrollment={enrollment} onAccepted={onBiometricChange} />
          )}
        </div>
      )}
    </Card>
  )
}

// Same shape as the face card above, with two differences that matter.
//
// It renders nothing at all when audio is switched off for the deployment — a
// card advertising a feature that 503s on every button is worse than no card.
//
// And it stays open until there is at least one clip, because the consequence of
// skipping this one is not "you get tagged by hand later": every word the person
// says in a session recording is silenced until they have enrolled a voice.
function VoiceEnrollmentCard({ onBiometricChange }) {
  const enrollment = useVoiceEnrollment()
  const { status, unavailable, items } = enrollment
  const [expanded, setExpanded] = useState(null)

  const complete = status?.complete === true
  const open = expanded ?? !complete

  if (unavailable) return null

  const summary = !status
    ? 'Loading…'
    : !status.verified
      ? 'Verify your email to set this up.'
      : !status.biometricConsent
        ? 'Not set up. Your voice is silenced in session recordings until it is.'
        : complete
          ? `${status.count} clip${status.count === 1 ? '' : 's'} on file — you are recognised in session recordings.`
          : 'No voice recorded yet. Your speech is silenced in session recordings until there is one.'

  return (
    <Card className="mt-5">
      <div className="flex items-start gap-3">
        <IconChip icon={AudioLines} tone="brand" size="sm" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-ink">Voice matching</p>
          <p className="mt-0.5 text-xs font-medium text-ink-muted">{summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {complete && <Badge tone="success">SET UP</Badge>}
          <button
            onClick={() => setExpanded(!open)}
            className="rounded-pill bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {open ? 'Hide' : 'Manage'}
          </button>
        </div>
      </div>

      {open && status?.verified && (
        <div className="mt-4">
          {status.biometricConsent ? (
            <>
              <VoiceClipList enrollment={enrollment} />
              {items.length > 0 && (
                // Deletes the clips, not the consent flag: turning biometric
                // matching off entirely belongs on the face card, which is the
                // one place that says what else it switches off.
                <button
                  onClick={enrollment.removeAll}
                  disabled={enrollment.busy}
                  className="mt-4 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                >
                  Delete my voice recordings
                </button>
              )}
            </>
          ) : (
            <VoiceConsentGate enrollment={enrollment} onAccepted={onBiometricChange} />
          )}
        </div>
      )}
    </Card>
  )
}

export default function ConsentHub() {
  const [revoked, setRevoked] = useState(false)
  // Bumped whenever either card moves the biometric consent flag. Both cards are
  // keyed on it so the other one re-reads instead of continuing to display a
  // state the server has already left.
  const [bioKey, setBioKey] = useState(0)
  const bumpBio = () => setBioKey((k) => k + 1)

  return (
    <div>
      <TopBar />

      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Consent</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Manage your data and privacy preferences.</p>

        <FaceEnrollmentCard key={`face-${bioKey}`} onBiometricChange={bumpBio} />
        <VoiceEnrollmentCard key={`voice-${bioKey}`} onBiometricChange={bumpBio} />

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Card className="flex items-center gap-3">
            <IconChip icon={ShieldCheck} tone="solid" size="sm" />
            <div>
              <p className="text-sm font-semibold text-ink">Secure &amp; Active</p>
            </div>
          </Card>

          <Card className="flex items-center gap-3">
            <IconChip icon={ShieldOff} tone="danger" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-ink">Global Revocation</p>
              <p className="text-xs font-medium text-ink-muted">Pause all data processing</p>
            </div>
            <button
              role="switch"
              aria-checked={revoked}
              onClick={() => setRevoked((v) => !v)}
              className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger ${
                revoked ? 'bg-danger' : 'bg-black/15'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  revoked ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </Card>
        </div>

        <div className="mt-6 grid grid-cols-1">
          <Link
            to="/rights"
            className="flex items-center justify-center rounded-card bg-brand py-3 text-sm font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Data Request
          </Link>
        </div>

        <div className="mt-6 flex justify-center gap-4 text-xs font-semibold text-ink-muted">
          <span>Privacy Policy</span>
          <span>Terms of Service</span>
          <span>GDPR Support</span>
        </div>
        <p className="mt-3 pb-4 text-center text-[11px] font-medium text-ink-faint">
          Consent Manager v6.21 &middot; Samsung Electronics Co., Ltd.
        </p>
      </div>
    </div>
  )
}
