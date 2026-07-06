import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react'
import IconChip from '../components/IconChip'

const LENGTH = 6

export default function Verify() {
  const navigate = useNavigate()
  const [digits, setDigits] = useState(Array(LENGTH).fill(''))
  const inputs = useRef([])

  const setDigit = (i, value) => {
    const clean = value.replace(/\D/g, '').slice(-1)
    const next = [...digits]
    next[i] = clean
    setDigits(next)
    if (clean && i < LENGTH - 1) inputs.current[i + 1]?.focus()
  }

  const onKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus()
    }
  }

  const complete = digits.every(Boolean)

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface px-5 pt-4 md:max-w-sm md:min-h-0 md:my-10 md:rounded-card md:shadow-float md:pb-8">
      <button
        onClick={() => navigate(-1)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-black/5"
        aria-label="Go back"
      >
        <ArrowLeft size={20} strokeWidth={1.75} />
      </button>

      <div className="mt-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Verify</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Enter the 6-digit code sent to your registered device.
        </p>
      </div>

      <div className="mt-8 flex justify-between gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => (inputs.current[i] = el)}
            value={d}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            inputMode="numeric"
            maxLength={1}
            className="h-14 w-full max-w-12 rounded-2xl border border-black/10 bg-canvas text-center text-xl font-bold text-ink outline-none focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand/20"
          />
        ))}
      </div>

      <button
        disabled={!complete}
        onClick={() => navigate('/dashboard')}
        className="mt-8 w-full rounded-card bg-brand py-3.5 text-base font-bold text-white shadow-card transition-opacity disabled:opacity-40"
      >
        Verify &amp; Continue
      </button>

      <button className="mt-4 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand">
        <RefreshCw size={14} strokeWidth={2} />
        Resend Code
      </button>

      <div className="mt-8 flex gap-3 rounded-card bg-canvas p-4">
        <IconChip icon={ShieldCheck} tone="neutral" size="sm" />
        <div>
          <p className="text-sm font-semibold text-ink">Two-Factor Authentication</p>
          <p className="mt-1 text-xs font-medium leading-relaxed text-ink-muted">
            This extra step ensures only you can access your consent management
            dashboard and project settings.
          </p>
        </div>
      </div>

      <p className="mt-auto pt-8 pb-4 text-center text-xs font-medium text-ink-faint">
        Having trouble? <span className="font-semibold text-brand">Contact Support</span>
      </p>
    </div>
  )
}
