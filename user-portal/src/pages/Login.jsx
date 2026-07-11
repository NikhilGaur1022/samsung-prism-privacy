import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ShieldCheck, Mail, Lock, Eye, EyeOff, Smartphone } from 'lucide-react'
import IconChip from '../components/IconChip'

export default function Login() {
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const canSubmit = email.trim().length > 3 && password.length >= 4

  const handleSubmit = (e) => {
    e.preventDefault()
    if (canSubmit) navigate('/verify')
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
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-xs font-bold uppercase tracking-wide text-ink-faint">
              Password
            </label>
            <button type="button" className="text-xs font-semibold text-brand">
              Forgot?
            </button>
          </div>
          <div className="flex items-center gap-2.5 rounded-2xl border border-black/10 bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
            <Lock size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="shrink-0 text-ink-faint"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card transition-opacity disabled:opacity-40"
        >
          Sign In
        </button>
      </form>

      <div className="mt-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-black/10" />
        <span className="text-xs font-semibold text-ink-faint">OR</span>
        <div className="h-px flex-1 bg-black/10" />
      </div>

      <button
        onClick={() => navigate('/verify')}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-card border border-black/10 bg-surface py-3.5 text-sm font-bold text-ink"
      >
        <Smartphone size={18} strokeWidth={1.75} />
        Continue with OTP
      </button>

      <p className="mt-auto pt-8 pb-4 text-center text-xs font-medium text-ink-faint">
        New to Prism?{' '}
        <Link to="/register" className="font-semibold text-brand">
          Create an account
        </Link>
      </p>
    </div>
  )
}
