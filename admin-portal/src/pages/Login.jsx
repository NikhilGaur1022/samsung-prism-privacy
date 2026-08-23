import { useState } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { ShieldCheck, Mail, Lock, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '../auth'
import { login } from '../lib/api'

export default function Login() {
  const navigate = useNavigate()
  const { signIn, admin, loading } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const canSubmit = email.trim().length > 3 && password.length > 0 && !submitting

  // An admin whose cookie is still good does not need to sign in again.
  //
  // Without this, /login rendered the form for someone already authenticated —
  // /auth/admin/me answered 200 the whole time — and they sat at a sign-in
  // screen with no indication they were already in. Any stale bookmark, the
  // bare '/' redirect, or a back-button press after signing in landed there.
  if (loading) return null
  if (admin) return <Navigate to="/dashboard" replace />

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)

    try {
      const admin = await login(email.trim(), password)
      signIn(admin)
      navigate('/dashboard')
    } catch (err) {
      setError(err.message ?? 'Sign in failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-canvas p-6">
      <div className="flex w-full max-w-4xl overflow-hidden rounded-card shadow-float">
        <div className="hidden w-2/5 flex-col justify-center bg-sidebar px-10 py-12 text-white md:flex">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand">
              <ShieldCheck size={20} strokeWidth={1.75} />
            </div>
            <span className="text-xl font-extrabold tracking-tight">PRISM</span>
          </div>
          <p className="mt-1 text-sm font-semibold text-brand-soft">Privacy Governance Platform</p>

          <h1 className="mt-10 text-3xl font-extrabold leading-tight tracking-tight">
            One secure admin login
          </h1>
          <p className="mt-3 text-sm font-medium text-sidebar-muted">
            Your authorized role determines the portal, pages, data visibility and actions
            available to you.
          </p>
        </div>

        <div className="w-full bg-surface px-10 py-12 md:w-3/5">
          <h2 className="text-2xl font-extrabold tracking-tight text-ink">Admin Sign In</h2>
          <p className="mt-1 text-sm font-medium text-ink-muted">Sign in with your admin credentials</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
                Email
              </label>
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
                <Mail size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@prism.example"
                  className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="block text-xs font-bold uppercase tracking-wide text-ink-faint">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="-my-2 inline-flex min-h-11 items-center px-1 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Forgot?
                </Link>
              </div>
              <div className="flex items-center gap-2.5 rounded-lg border border-border bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
                <Lock size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
                />
                {/* WCAG 2.2 SC 2.5.8 sets 24x24 CSS px as the floor for a
                    pointer target and 44x44 as comfortable. This rendered at
                    18x18 — it fails with a mouse, not only with a thumb, so it
                    is an accessibility defect on the supported desktop surface
                    rather than a mobile one. The icon stays 18px; the hit area
                    does not. */}
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="-mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
                </button>
              </div>
            </div>

            {error && <p className="text-sm font-semibold text-danger">{error}</p>}

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-2 w-full rounded-lg bg-brand py-3 text-sm font-bold text-white shadow-card transition-opacity disabled:opacity-40"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
