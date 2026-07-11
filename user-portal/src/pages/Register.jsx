import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, UserPlus, Mail, Phone, Users } from 'lucide-react'
import IconChip from '../components/IconChip'
import { registerSubject } from '../lib/api'

const GROUPS = [
  { value: 'SAMSUNG_EMPLOYEE', label: 'Samsung Employee' },
  { value: 'EX_SAMSUNG_EMPLOYEE', label: 'Ex-Samsung Employee' },
  { value: 'SEED_LAB_EMPLOYEE', label: 'Seed Lab Employee' },
  { value: 'EX_SEED_LAB_EMPLOYEE', label: 'Ex-Seed Lab Employee' },
  { value: 'VOLUNTEER', label: 'Volunteer' },
]

const FIELD_CLASS =
  'w-full bg-transparent text-sm font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-faint'

export default function Register() {
  const navigate = useNavigate()
  const [group, setGroup] = useState(GROUPS[0].value)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const canSubmit = fullName.trim().length > 1 && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)

    try {
      const subject = await registerSubject({
        group,
        fullName: fullName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        registrationChannel: 'SELF',
      })
      navigate('/verify', { state: { masterUserId: subject.masterUserId } })
    } catch (err) {
      if (err.status === 409 && err.masterUserId) {
        navigate('/verify', { state: { masterUserId: err.masterUserId } })
        return
      }
      setError(err.message ?? 'Registration failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface px-5 pt-4 md:max-w-sm md:min-h-0 md:my-10 md:rounded-card md:shadow-float md:pb-8">
      <button
        onClick={() => navigate(-1)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-black/5"
        aria-label="Go back"
      >
        <ArrowLeft size={20} strokeWidth={1.75} />
      </button>

      <div className="mt-4 flex flex-col items-center">
        <IconChip icon={UserPlus} tone="solid" size="lg" className="shadow-card" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">Create an account</h1>
        <p className="mt-1 text-center text-sm font-medium text-ink-muted">
          Register once to manage consent across every project.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
            I am a
          </label>
          <div className="flex items-center gap-2.5 rounded-2xl border border-black/10 bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
            <Users size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
            <select value={group} onChange={(e) => setGroup(e.target.value)} className={FIELD_CLASS}>
              {GROUPS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
            Full name
          </label>
          <div className="flex items-center gap-2.5 rounded-2xl border border-black/10 bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Doe"
              className={FIELD_CLASS}
            />
          </div>
        </div>

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
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-ink-faint">
            Phone (optional)
          </label>
          <div className="flex items-center gap-2.5 rounded-2xl border border-black/10 bg-canvas px-4 py-3 focus-within:border-brand focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand/20">
            <Phone size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className={FIELD_CLASS}
            />
          </div>
        </div>

        {error && <p className="text-sm font-semibold text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card transition-opacity disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
        >
          {submitting ? 'Creating account…' : 'Continue to verification'}
        </button>
      </form>

      <p className="mt-auto pt-8 pb-4 text-center text-xs font-medium text-ink-faint">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-brand">
          Sign in
        </Link>
      </p>
    </div>
  )
}
