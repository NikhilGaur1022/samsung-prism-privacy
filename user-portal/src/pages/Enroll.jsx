import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, ScanFace } from 'lucide-react'
import IconChip from '../components/IconChip'
import { ConsentGate, PoseStepper, useEnrollment } from '../components/FaceEnrollment'

// Sits between /verify and /dashboard. Deliberately skippable: hard-blocking
// someone out of their own consent dashboard over an optional biometric step is
// the wrong trade — the Consent Hub keeps prompting instead.
export default function Enroll() {
  const navigate = useNavigate()
  const enrollment = useEnrollment()
  const [finished, setFinished] = useState(false)

  const { status, busy, loading, error } = enrollment
  const complete = status?.complete === true

  const arrived = useRef(null)
  if (status && arrived.current === null) arrived.current = complete
  const arrivedComplete = arrived.current

  // Every login routes through here. Someone who finished this months ago should
  // pass straight through rather than be asked again on each sign-in. Keyed on
  // the FIRST status only — becoming complete mid-flow must not yank the page out
  // from under someone who is still taking photos.
  useEffect(() => {
    if (arrivedComplete === true) navigate('/dashboard', { replace: true })
  }, [arrivedComplete, navigate])

  // Loading, error and empty are three different things and this page used to
  // render all three as "Loading…" forever. /enroll now sits inside RequireAuth,
  // so an unauthorised visit is redirected before this renders — but a page on
  // the onboarding path must not be able to hang on a network failure either.
  if (loading) {
    return (
      <div className="mx-auto flex min-h-svh w-full max-w-md items-center justify-center bg-surface px-5">
        <p className="text-sm font-medium text-ink-faint">Loading…</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="mx-auto flex min-h-svh w-full max-w-md flex-col items-center justify-center gap-4 bg-surface px-5 text-center">
        <IconChip icon={ScanFace} tone="soft" size="lg" />
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-ink">
            Face setup is unavailable right now
          </h1>
          <p className="mt-2 text-sm font-medium text-ink-muted">
            {error?.message ?? 'We could not load your setup status.'}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <button
            onClick={() => enrollment.reload().catch(() => {})}
            className="min-h-11 w-full rounded-card bg-brand py-3 text-base font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Try again
          </button>
          {/* This step is optional by design — hard-blocking someone out of
              their own consent dashboard over a biometric setup is the wrong
              trade, and doubly so when the reason is our outage. */}
          <button
            onClick={() => navigate('/dashboard', { replace: true })}
            className="min-h-11 w-full rounded-card border border-border py-3 text-base font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Skip for now
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface px-5 pt-10 md:max-w-sm md:min-h-0 md:my-10 md:rounded-card md:shadow-float md:pb-8">
      {finished ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <IconChip icon={CheckCircle2} tone="solid" size="lg" className="shadow-card" />
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">You&apos;re set up</h1>
          <p className="mt-2 text-sm font-medium text-ink-muted">
            Pictures of you taken on projects you have consented to will be found automatically. You
            can review or delete your photos any time from the Consent Hub.
          </p>
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-8 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Go to dashboard
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center text-center">
            <IconChip icon={ScanFace} tone="solid" size="lg" className="shadow-card" />
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">
              Set up face matching
            </h1>
            <p className="mt-1 text-sm font-medium text-ink-muted">
              {status.biometricConsent
                ? 'Five quick photos so we can find pictures of you automatically.'
                : 'One last step, and it is entirely up to you.'}
            </p>
          </div>

          <div className="mt-8">
            {status.biometricConsent ? (
              <PoseStepper enrollment={enrollment} />
            ) : (
              <ConsentGate enrollment={enrollment} />
            )}
          </div>

          {status.biometricConsent && (
            <button
              onClick={() => setFinished(true)}
              disabled={!complete || busy}
              className="mt-6 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              {complete
                ? 'Done'
                : `Take ${Math.max(3 - status.poses.length, 1)} more to finish`}
            </button>
          )}

          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 pb-4 text-center text-sm font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Skip for now
          </button>
        </>
      )}
    </div>
  )
}
