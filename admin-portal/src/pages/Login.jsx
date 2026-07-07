import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { ROLES, ROLE_ORDER } from '../roles'
import { useAuth } from '../auth'

export default function Login() {
  const navigate = useNavigate()
  const { setRoleKey } = useAuth()
  const [selected, setSelected] = useState(null)

  const handleContinue = () => {
    if (!selected) return
    setRoleKey(selected)
    navigate('/dashboard')
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
          <p className="mt-1 text-sm font-medium text-ink-muted">Select your authorized workspace</p>

          <div className="mt-6 space-y-2.5">
            {ROLE_ORDER.map((key) => {
              const role = ROLES[key]
              const isSelected = selected === key
              return (
                <button
                  key={key}
                  onClick={() => setSelected(key)}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                    isSelected
                      ? 'border-brand bg-brand-soft'
                      : 'border-border bg-surface hover:border-ink-faint'
                  }`}
                >
                  <p className="text-sm font-bold text-ink">{role.label}</p>
                  <p className="mt-0.5 text-xs font-medium text-ink-muted">{role.description}</p>
                </button>
              )
            })}
          </div>

          <button
            onClick={handleContinue}
            disabled={!selected}
            className="mt-6 w-full rounded-lg bg-brand py-3 text-sm font-bold text-white shadow-card transition-opacity disabled:opacity-40"
          >
            Continue to selected portal
          </button>
        </div>
      </div>
    </div>
  )
}
