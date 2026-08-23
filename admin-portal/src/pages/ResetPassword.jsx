import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { ShieldCheck, Lock } from 'lucide-react'
import { resetPassword } from '../lib/api'

export default function ResetPassword() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const canSubmit =
    token && newPassword.length >= 8 && newPassword === confirmPassword && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)

    try {
      await resetPassword(token, newPassword)
      navigate('/login')
    } catch (err) {
      setError(err.message ?? 'Could not reset password. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-card bg-surface p-10 shadow-float">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
            <ShieldCheck size={20} strokeWidth={1.75} />
          </div>
          <span className="text-xl font-extrabold tracking-tight text-ink">PRISM</span>
        </div>

        <h1 className="mt-8 text-2xl font-extrabold tracking-tight text-ink">Choose a new password</h1>

        {!token && (
          <p className="mt-4 text-sm font-semibold text-danger">
            This reset link is missing its token — please use the link from your reset email.
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
              New password
            </label>
            <div className="flex items-center gap-2.5 rounded-lg border border-border bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
              <Lock size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
              Confirm password
            </label>
            <div className="flex items-center gap-2.5 rounded-lg border border-border bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
              <Lock size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
              />
            </div>
          </div>

          {error && <p className="text-sm font-semibold text-danger">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-brand py-3 text-sm font-bold text-white shadow-card transition-opacity disabled:opacity-40"
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs font-medium text-ink-faint">
          <Link
            to="/login"
            className="-my-2 inline-flex min-h-11 items-center px-1 font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
