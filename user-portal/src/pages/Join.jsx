import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Building2, CheckCircle2, MapPin, TriangleAlert } from 'lucide-react'
import IconChip from '../components/IconChip'
import { PoseStepper, useEnrollment } from '../components/FaceEnrollment'
import {
  acceptJoinInvite,
  getJoinInvite,
  getMe,
  renderConsentNotice,
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

  // The §5 notice for this project. GET /api/v1/join/:token now returns both the
  // rendered notice and the consentTemplateId it came from, so this no longer has
  // to guess which template applies.
  const [notice, setNotice] = useState(null)
  const [noticeError, setNoticeError] = useState(null)
  const [noticeLoading, setNoticeLoading] = useState(false)
  const [locale, setLocale] = useState('en')
  const [scrolledToBottom, setScrolledToBottom] = useState(false)

  const signedIn = useRef(false)
  const templateId = useRef(null)
  const noticeBodyRef = useRef(null)

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

  // The invite response carries the notice already rendered in the default
  // locale, plus the template id. Matching the project by NAME — which is what
  // this did before the endpoint returned an id — picks the wrong notice as soon
  // as two projects share a name, and picks nothing at all before the subject has
  // consented to anything. Only a locale change re-fetches.
  useEffect(() => {
    if (step !== 'consent' || !invite || notice || noticeLoading) return

    setNoticeLoading(true)
    setNoticeError(null)
    ;(async () => {
      templateId.current = invite.consentTemplateId ?? null
      if (!templateId.current) {
        throw new Error('No published consent notice is on file for this project.')
      }
      if (invite.notice && invite.notice.locale === locale) return invite.notice
      return renderConsentNotice(templateId.current, locale)
    })()
      .then((n) => {
        setNotice(n)
        setLocale(n.locale)
      })
      .catch((err) => setNoticeError(err))
      .finally(() => setNoticeLoading(false))
  }, [step, invite, notice, noticeLoading, locale])

  const changeLocale = (nextLocale) => {
    setLocale(nextLocale)
    setNotice(null)
    setScrolledToBottom(false)
    setNoticeError(null)
  }

  const handleNoticeScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 8) setScrolledToBottom(true)
  }

  // A notice short enough to fit inside max-h-64 never overflows, so onScroll
  // never fires and the agree button would stay disabled with no way to proceed.
  // Nothing to scroll to means the subject has already seen all of it. The
  // observer covers late layout shifts (web fonts) that shrink the box after the
  // first paint; changeLocale clears notice, which re-runs this for the new one.
  useEffect(() => {
    const el = noticeBodyRef.current
    if (!notice || !el) return

    const checkOverflow = () => {
      if (el.scrollHeight - el.clientHeight < 8) setScrolledToBottom(true)
    }
    checkOverflow()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [notice])

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
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-ink">What you are agreeing to</p>
            {notice && notice.availableLocales.length > 1 && (
              <select
                value={locale}
                onChange={(e) => changeLocale(e.target.value)}
                className="rounded-lg border border-black/10 bg-canvas px-2 py-1 text-xs font-semibold text-ink outline-none focus:border-brand"
              >
                {notice.availableLocales.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </div>

          {noticeLoading && (
            <p className="mt-3 text-xs font-medium text-ink-faint">Loading the consent notice…</p>
          )}

          {noticeError && (
            <div className="mt-3 flex items-start gap-2 rounded-card border border-border bg-danger-soft p-4">
              <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" />
              <p className="text-xs font-medium leading-relaxed text-danger">
                Could not load the consent notice for this project: {noticeError.message} You cannot
                join until it can be shown to you.
              </p>
            </div>
          )}

          {notice && (
            <>
              {notice.localeFallback && (
                <div className="mt-3 flex items-start gap-2 rounded-card border border-border bg-warning-soft p-3">
                  <TriangleAlert size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
                  <p className="text-[11px] font-semibold text-warning">
                    This notice is not yet available in "{notice.requestedLocale}" — showing English instead.
                  </p>
                </div>
              )}

              <div
                ref={noticeBodyRef}
                onScroll={handleNoticeScroll}
                className="mt-3 max-h-64 overflow-y-auto rounded-card border border-border bg-surface p-4"
              >
                <p className="text-xs font-bold uppercase tracking-wide text-brand">{notice.purpose}</p>
                <p className="mt-2 whitespace-pre-wrap text-xs font-medium leading-relaxed text-ink-muted">
                  {notice.body}
                </p>
                {notice.dataTypes?.length > 0 && (
                  <p className="mt-3 text-[11px] font-semibold text-ink-faint">
                    Data types: {notice.dataTypes.join(', ')}
                  </p>
                )}
                {notice.retention && (
                  <p className="mt-1 text-[11px] font-semibold text-ink-faint">Retention: {notice.retention}</p>
                )}
                {notice.grievanceContact && (
                  <p className="mt-1 text-[11px] font-semibold text-ink-faint">
                    Grievance contact: {notice.grievanceContact}
                  </p>
                )}
                <p className="mt-2 text-[11px] font-semibold text-ink-faint">
                  Policy version {notice.policyVersion}
                </p>
              </div>

              {!scrolledToBottom && (
                <p className="mt-2 text-[11px] font-medium text-ink-faint">
                  Scroll to the end of the notice to enable the agree button.
                </p>
              )}
            </>
          )}

          <button
            onClick={handleAccept}
            disabled={busy || !notice || !scrolledToBottom}
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
