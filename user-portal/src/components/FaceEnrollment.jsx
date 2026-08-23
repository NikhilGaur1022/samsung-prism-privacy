import { useCallback, useEffect, useState } from 'react'
import { ScanFace, ShieldCheck, Trash2 } from 'lucide-react'
import SelfieCapture, { POSES } from './SelfieCapture'
import {
  addEnrollment,
  deleteEnrollment,
  enrollmentImageUrl,
  getEnrollmentStatus,
  listEnrollments,
  setBiometricConsent,
} from '../lib/api'

const POSE_LABEL = Object.fromEntries(POSES.map((p) => [p.key, p.key]))

// One implementation of the enrollment flow, shared by /enroll, the Consent Hub
// card and the QR join screen. The order it enforces is forced by the backend:
// verified → biometric consent → capture. createEnrollment 409s otherwise.
export function useEnrollment() {
  const [status, setStatus] = useState(null)
  const [items, setItems] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Three states, not two.
  //
  // `status` alone cannot distinguish "still loading" from "the request failed",
  // and every caller wrote `if (!status) return <Loading/>`. So an unauthorised
  // /enroll visit 401'd, status stayed null, and the page showed "Loading…"
  // forever — verified at three viewports with a seven-second settle. That page
  // is on the path every newly-registered subject is sent down after /verify.
  const [loading, setLoading] = useState(true)
  const [unauthorized, setUnauthorized] = useState(false)

  const reload = useCallback(async () => {
    const next = await getEnrollmentStatus()
    setStatus(next)
    // Listing 401s nothing but returns an empty set before consent is given —
    // only ask for it once there is something to list.
    setItems(next.biometricConsent ? (await listEnrollments()).items : [])
    return next
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    reload()
      .then(() => {
        if (!cancelled) setUnauthorized(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err)
        if (err?.status === 401) setUnauthorized(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload])

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return {
    status,
    items,
    busy,
    error,
    loading,
    unauthorized,
    reload,
    consent: (accepted) => run(() => setBiometricConsent(accepted)),
    capture: (blob, pose) => run(() => addEnrollment(blob, pose)),
    remove: (id) => run(() => deleteEnrollment(id)),
  }
}

// Plain language on purpose. "Biometric template" is accurate and tells a person
// nothing about what they are agreeing to.
export function BiometricExplainer() {
  return (
    <div className="rounded-card bg-canvas p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
        <div className="space-y-2 text-xs font-medium leading-relaxed text-ink-muted">
          <p>
            We take five photos of your face from slightly different angles and use them to
            recognise you in pictures taken during a project you have consented to.
          </p>
          <p>
            The photos and the face measurements taken from them are stored encrypted, are never
            shared, and are used for nothing except matching you to your own pictures.
          </p>
          <p>
            This is the same permission that lets you record a voice sample, so that you can be
            recognised — and not silenced — in session recordings. Nothing of your voice is
            recorded unless you record it yourself.
          </p>
          <p>
            You can delete them at any time. Withdrawing consent to a project, or turning this off
            here, erases your photos and any voice recording immediately.
          </p>
        </div>
      </div>
    </div>
  )
}

// onAccepted is optional and fires after the flag has actually moved — the
// Consent Hub uses it to re-read the voice card, which is driven by the same
// stored consent and would otherwise still be offering to collect it.
export function ConsentGate({ enrollment, onAccepted }) {
  const [checked, setChecked] = useState(false)

  return (
    <div className="space-y-4">
      <BiometricExplainer />

      <label className="flex cursor-pointer items-start gap-3 rounded-card border border-border bg-surface p-4">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span className="text-sm font-semibold text-ink">
          I agree to my face being used to match me to my own photos.
        </span>
      </label>

      {enrollment.error && (
        <p className="text-sm font-semibold text-danger">{enrollment.error.message}</p>
      )}

      <button
        type="button"
        disabled={!checked || enrollment.busy}
        onClick={async () => {
          await enrollment.consent(true)
          onAccepted?.()
        }}
        className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
      >
        {enrollment.busy ? 'Saving…' : 'Agree & take photos'}
      </button>
    </div>
  )
}

export function PoseStepper({ enrollment }) {
  const { status, items, busy, error } = enrollment
  const captured = items.map((i) => i.pose).filter(Boolean)

  return (
    <div className="space-y-4">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {items.map((item) => (
            <div key={item.id} className="relative">
              <img
                src={enrollmentImageUrl(item.id)}
                alt=""
                className="h-20 w-20 rounded-card object-cover"
              />
              <button
                onClick={() => enrollment.remove(item.id)}
                disabled={busy}
                className="absolute right-1 top-1 rounded-md bg-surface/90 p-1 text-ink-faint disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                aria-label="Delete photo"
              >
                <Trash2 size={12} strokeWidth={1.75} />
              </button>
              <p className="mt-1 text-center text-[10px] font-bold text-ink-faint">
                {POSE_LABEL[item.pose] ?? '—'}
              </p>
            </div>
          ))}
        </div>
      )}

      <SelfieCapture
        poses={POSES.slice(0, status?.max ?? POSES.length)}
        captured={captured}
        onCapture={enrollment.capture}
        busy={busy}
        error={error?.message}
      />
    </div>
  )
}

// The whole flow in one block, for embedding in a page that already has a header.
export default function FaceEnrollment({ enrollment }) {
  const { status } = enrollment

  if (!status) {
    return <p className="text-sm font-medium text-ink-faint">Loading…</p>
  }

  if (!status.verified) {
    return (
      <p className="rounded-card bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
        Verify your email first — face matching can only be set up on a verified account.
      </p>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm font-bold text-ink">
        <ScanFace size={16} strokeWidth={2} className="text-brand" />
        Face matching
      </div>
      {status.biometricConsent ? (
        <PoseStepper enrollment={enrollment} />
      ) : (
        <ConsentGate enrollment={enrollment} />
      )}
    </div>
  )
}
