import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Building2, CheckCircle2, MapPin, ShieldCheck } from 'lucide-react'
import IconChip from '../components/IconChip'
import { PoseStepper, useEnrollment } from '../components/FaceEnrollment'
import {
  acceptJoinInvite,
  getJoinInvite,
  getMe,
  requestLoginOtp,
  verifyLoginOtp,
} from '../lib/api'

const OTP_LENGTH = 6

// Walk-up flow on someone's own phone: no sidebar, no assumption of a session.
// The scan is NOT consent — it only gets you to this screen. The agree button is.
export default function Join() {
  const { token } = useParams()
  const navigate = useNavigate()

  // card → auth → consent → done
  const [step, setStep] = useState('card')
  const [invite, setInvite] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [showEnroll, setShowEnroll] = useState(false)

  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [devOtp, setDevOtp] = useState(null)

  const signedIn = useRef(false)

  useEffect(() => {
    getJoinInvite(token).then(setInvite).catch(setError)
    getMe()
      .then(() => (signedIn.current = true))
      .catch(() => (signedIn.current = false))
  }, [token])

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleContinue = () => setStep(signedIn.current ? 'consent' : 'auth')

  const handleSendOtp = () =>
    run(async () => {
      const res = await requestLoginOtp(email.trim())
      setDevOtp(res?.devOtp ?? null)
      setOtpSent(true)
    })

  const handleVerify = () =>
    run(async () => {
      await verifyLoginOtp(email.trim(), otp)
      signedIn.current = true
      setStep('consent')
    })

  const handleAccept = () =>
    run(async () => {
      const res = await acceptJoinInvite(token)
      setResult(res)
      setStep('done')
    })

  if (error && !invite) {
    return (
      <Shell>
        <p className="text-center text-sm font-semibold text-danger">{error.message}</p>
      </Shell>
    )
  }

  if (!invite) {
    return (
      <Shell>
        <p className="text-center text-sm font-medium text-ink-faint">Loading…</p>
      </Shell>
    )
  }

  return (
    <Shell>
      {step !== 'done' && (
        <div className="rounded-card bg-canvas p-4">
          <div className="flex items-start gap-3">
            <IconChip icon={Building2} tone="brand" size="sm" />
            <div className="min-w-0">
              <p className="text-base font-bold text-ink">{invite.projectName}</p>
              <p className="mt-0.5 text-xs font-medium text-ink-muted">{invite.purpose}</p>
              {invite.sessionLocation && (
                <p className="mt-1 flex items-center gap-1 text-xs font-medium text-ink-faint">
                  <MapPin size={12} strokeWidth={2} /> {invite.sessionLocation}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

      {step === 'card' && (
        <>
          <p className="mt-5 text-sm font-medium text-ink-muted">
            Photos are being taken here. Nothing is collected about you until you agree on the next
            screen.
          </p>
          <button
            onClick={handleContinue}
            className="mt-6 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            Continue
          </button>
        </>
      )}

      {step === 'auth' && (
        <div className="mt-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
              Your email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john.doe@example.com"
              disabled={otpSent}
              className="w-full rounded-2xl border border-black/10 bg-canvas px-4 py-3 text-sm font-semibold text-ink outline-none focus:border-brand focus:bg-surface disabled:opacity-60"
            />
          </div>

          {devOtp && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wide text-amber-700">
                Dev mode — email delivery bypassed
              </p>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <span className="font-mono text-2xl font-extrabold tracking-[0.3em] text-amber-900">
                  {devOtp}
                </span>
                <button
                  type="button"
                  onClick={() => setOtp(String(devOtp).slice(0, OTP_LENGTH))}
                  className="shrink-0 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-bold text-white"
                >
                  Autofill
                </button>
              </div>
            </div>
          )}

          {otpSent && (
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
                6-digit code
              </label>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
                inputMode="numeric"
                placeholder="000000"
                className="w-full rounded-2xl border border-black/10 bg-canvas px-4 py-3 text-center font-mono text-xl font-bold tracking-[0.3em] text-ink outline-none focus:border-brand focus:bg-surface"
              />
            </div>
          )}

          <button
            onClick={otpSent ? handleVerify : handleSendOtp}
            disabled={busy || (otpSent ? otp.length < OTP_LENGTH : email.trim().length < 4)}
            className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy ? 'Please wait…' : otpSent ? 'Verify & continue' : 'Send me a code'}
          </button>

          <p className="text-center text-xs font-medium text-ink-faint">
            No account yet?{' '}
            <button
              onClick={() => navigate('/register')}
              className="font-semibold text-brand focus-visible:outline-none"
            >
              Create one
            </button>
          </p>
        </div>
      )}

      {step === 'consent' && (
        <div className="mt-6">
          <div className="flex items-start gap-3 rounded-card border border-border bg-surface p-4">
            <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <p className="text-sm font-bold text-ink">What you are agreeing to</p>
              <p className="mt-1.5 text-xs font-medium leading-relaxed text-ink-muted">
                {invite.consentText}
              </p>
              <p className="mt-2 text-[11px] font-semibold text-ink-faint">
                Policy version {invite.policyVersion}
              </p>
            </div>
          </div>

          <button
            onClick={handleAccept}
            disabled={busy}
            className="mt-6 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            {busy ? 'Joining…' : 'I agree — add me to this session'}
          </button>

          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 w-full text-center text-sm font-semibold text-ink-muted"
          >
            No thanks
          </button>
        </div>
      )}

      {step === 'done' && <Done result={result} showEnroll={showEnroll} setShowEnroll={setShowEnroll} navigate={navigate} />}
    </Shell>
  )
}

function Done({ result, showEnroll, setShowEnroll, navigate }) {
  // The hook fetches on mount, so it lives in the branch that actually needs it.
  const enrollment = useEnrollment()

  return (
    <div className="flex flex-col items-center text-center">
      <IconChip icon={CheckCircle2} tone="solid" size="lg" className="shadow-card" />
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">
        {result.alreadyJoined ? "You're already in" : "You're in"}
      </h1>
      <p className="mt-2 text-sm font-medium text-ink-muted">
        You have joined <span className="font-bold text-ink">{result.projectName}</span> (session{' '}
        {result.sessionCode}). This now appears in your Consent Hub, where you can withdraw at any
        time.
      </p>

      {!result.enrollmentComplete && !showEnroll && (
        <div className="mt-6 w-full rounded-card bg-warning-soft p-4 text-left">
          <p className="text-sm font-bold text-warning">Add your photos?</p>
          <p className="mt-1 text-xs font-medium text-warning/80">
            Without them an agent has to pick you out of the photos by hand. Takes about a minute.
          </p>
          <button
            onClick={() => setShowEnroll(true)}
            className="mt-3 rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning"
          >
            Take photos now
          </button>
        </div>
      )}

      {showEnroll && (
        <div className="mt-6 w-full text-left">
          {enrollment.status?.biometricConsent ? (
            <PoseStepper enrollment={enrollment} />
          ) : (
            <p className="rounded-card bg-canvas p-4 text-xs font-medium text-ink-muted">
              Face matching needs a separate consent first — set it up from the Consent Hub.
            </p>
          )}
        </div>
      )}

      <button
        onClick={() => navigate('/consent')}
        className="mt-8 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
      >
        Go to my Consent Hub
      </button>
    </div>
  )
}

function Shell({ children }) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface px-5 pt-10 md:max-w-sm md:min-h-0 md:my-10 md:rounded-card md:shadow-float md:pb-8">
      {children}
    </div>
  )
}
