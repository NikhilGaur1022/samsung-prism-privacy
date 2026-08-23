import { useState } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { ShieldCheck, Mail } from 'lucide-react'
import IconChip from '../components/IconChip'
import { requestLoginOtp } from '../lib/api'
import { useMe } from '../lib/useMe'

export default function Login() {
  const navigate = useNavigate()
  const { me, loading } = useMe()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const canSubmit = email.trim().length > 3 && !submitting

  // Already signed in? Then this page is a dead end, not a door.
  //
  // The admin portal had the same hole: a live session and a form asking you to
  // start a new one. Worse here, because signing in again means waiting for an
  // OTP email to prove something the cookie in the browser already proves.
  if (loading) return null
  if (me) return <Navigate to="/dashboard" replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await requestLoginOtp(email.trim())
      navigate('/verify', { state: { email: email.trim(), devOtp: res?.devOtp } })
    } catch (err) {
      setError(err.message ?? 'Could not send a code. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface px-5 pt-10 md:max-w-sm md:min-h-0 md:my-10 md:rounded-card md:shadow-float md:pb-8">
      <div className="flex flex-col items-center">
        <IconChip icon={ShieldCheck} tone="solid" size="lg" className="shadow-card" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">Welcome to Prism</h1>
        <p className="mt-1 text-center text-sm font-medium text-ink-muted">
          Sign in to manage your data, consent and privacy.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
            Email
          </label>
          <div className="flex items-center gap-2.5 rounded-2xl border border-black/10 bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
            <Mail size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john.doe@example.com"
              className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
            />
          </div>
          <p className="mt-1.5 text-xs font-medium text-ink-faint">
            We'll send a 6-digit verification code to this address.
          </p>
        </div>

        {error && <p className="text-sm font-semibold text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card transition-opacity disabled:opacity-40"
        >
          {submitting ? 'Sending code…' : 'Send verification code'}
        </button>
      </form>

      <p className="mt-auto pt-8 pb-4 text-center text-xs font-medium text-ink-faint">
        New to Prism?{' '}
        <Link to="/register" className="font-semibold text-brand">
          Create an account
        </Link>
      </p>
    </div>
  )
}
