import { useCallback, useEffect, useState } from 'react'
import { AudioLines, ShieldCheck, Trash2 } from 'lucide-react'
import VoiceCapture from './VoiceCapture'
import {
  addVoiceEnrollment,
  deleteVoiceEnrollment,
  getVoiceEnrollmentStatus,
  listVoiceEnrollments,
  setBiometricConsent,
  voiceEnrollmentAudioUrl,
} from '../lib/api'

// One implementation of the voice flow, in the shape useEnrollment already
// established for faces. The order is forced by the backend the same way:
// verified → biometric consent → capture, and createVoiceEnrollment 409s
// otherwise.
//
// `unavailable` is the AUDIO_CAPTURE_ENABLED kill switch (503) and is not an
// error: with audio off there is nothing wrong, there is simply nothing on
// offer, and the card removes itself rather than showing a red banner.
export function useVoiceEnrollment() {
  const [status, setStatus] = useState(null)
  const [items, setItems] = useState([])
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    try {
      const next = await getVoiceEnrollmentStatus()
      setStatus(next)
      setItems(next.biometricConsent ? (await listVoiceEnrollments()).items : [])
      return next
    } catch (err) {
      if (err.status === 503) {
        setUnavailable(true)
        return null
      }
      throw err
    }
  }, [])

  useEffect(() => {
    reload().catch(setError)
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
    unavailable,
    busy,
    error,
    reload,
    // Shared with face matching on purpose — see VoiceConsentGate.
    consent: (accepted) => run(() => setBiometricConsent(accepted)),
    capture: (blob) => run(() => addVoiceEnrollment(blob)),
    remove: (id) => run(() => deleteVoiceEnrollment(id)),
    // Sequential inside a single run(): mapping remove() over the list would
    // start N overlapping busy/reload cycles, and the last one to finish would
    // publish a list it read before the others had deleted anything — leaving
    // clips on screen that no longer exist.
    removeAll: () =>
      run(async () => {
        for (const clip of items) await deleteVoiceEnrollment(clip.id)
      }),
  }
}

export function VoiceExplainer() {
  return (
    <div className="rounded-card bg-canvas p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
        <div className="space-y-2 text-xs font-medium leading-relaxed text-ink-muted">
          <p>
            We record a few seconds of you speaking and use it to tell your voice apart from other
            people&apos;s in recordings made during a project you have consented to.
          </p>
          <p>
            This is what keeps your own words in the recording. Anyone we cannot recognise is
            silenced, so without a voice sample of you on file, your speech is silenced too.
          </p>
          <p>
            The clip and the voice measurements taken from it are stored encrypted, are never
            shared, and are used for nothing else. Only you can play the clip back — no member of
            staff can listen to it.
          </p>
          <p>
            You can delete it at any time. Withdrawing consent, or turning this off here, erases it
            immediately.
          </p>
        </div>
      </div>
    </div>
  )
}

// Voice and face rest on the same stored signal (Subject.biometricMatch) — there
// is exactly one biometric consent flag, and withdrawing it erases both. Saying
// so here is not a detail: someone who agrees on this card and does not realise
// they have also switched face matching on has not given informed consent to it.
export function VoiceConsentGate({ enrollment, onAccepted }) {
  const [checked, setChecked] = useState(false)

  return (
    <div className="space-y-4">
      <VoiceExplainer />

      <label className="flex cursor-pointer items-start gap-3 rounded-card border border-border bg-surface p-4">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span className="text-sm font-semibold text-ink">
          I agree to my face and voice being used to match me to my own photos and recordings.
        </span>
      </label>

      <p className="text-xs font-medium text-ink-muted">
        This is the same permission as face matching — turning it on here turns on both, and turning
        it off anywhere erases both.
      </p>

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
        {enrollment.busy ? 'Saving…' : 'Agree & record'}
      </button>
    </div>
  )
}

export function VoiceClipList({ enrollment }) {
  const { items, status, busy, error } = enrollment

  return (
    <div className="space-y-4">
      {items.length > 0 && (
        <ul className="space-y-2">
          {items.map((clip) => (
            <li key={clip.id} className="rounded-card bg-canvas p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-bold text-ink">
                  {clip.durationSec == null ? '—' : `${clip.durationSec.toFixed(1)} seconds`}
                  <span className="ml-2 font-medium text-ink-faint">
                    {new Date(clip.createdAt).toLocaleDateString()}
                  </span>
                </p>
                <button
                  onClick={() => enrollment.remove(clip.id)}
                  disabled={busy}
                  className="rounded-md p-1 text-ink-faint disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                  aria-label="Delete voice clip"
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </div>
              {/* preload="none" — the bytes are fetched only if the person
                  actually presses play, so opening this list does not pull every
                  clip they have ever recorded down onto the device. */}
              <audio
                controls
                preload="none"
                src={voiceEnrollmentAudioUrl(clip.id)}
                className="mt-2 w-full"
              />
            </li>
          ))}
        </ul>
      )}

      <VoiceCapture
        onCapture={enrollment.capture}
        busy={busy}
        error={error?.message}
        count={items.length}
        max={status?.max ?? 3}
      />
    </div>
  )
}

// The whole flow in one block, for embedding in a page that already has a header.
export default function VoiceEnrollment({ enrollment }) {
  const { status, unavailable } = enrollment

  if (unavailable) return null

  if (!status) {
    return <p className="text-sm font-medium text-ink-faint">Loading…</p>
  }

  if (!status.verified) {
    return (
      <p className="rounded-card bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
        Verify your email first — voice matching can only be set up on a verified account.
      </p>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm font-bold text-ink">
        <AudioLines size={16} strokeWidth={2} className="text-brand" />
        Voice matching
      </div>
      {status.biometricConsent ? (
        <VoiceClipList enrollment={enrollment} />
      ) : (
        <VoiceConsentGate enrollment={enrollment} />
      )}
    </div>
  )
}
