import { Link, useLocation } from 'react-router-dom'
import { Compass } from 'lucide-react'
import IconChip from '../components/IconChip'
import { useMe } from '../lib/useMe'

// A real 404, for the same reason the admin portal has one.
//
// `<Route path="*" element={<Navigate to="/dashboard" />} />` sent every unknown
// URL to the dashboard, where RequireAuth then bounced a signed-out visitor to
// /login — so a mistyped address ended at a sign-in form with no explanation.
// For a data principal, who visits this portal rarely and usually from an email
// link, that reads as "your account is gone".
export default function NotFound() {
  const location = useLocation()
  const { me, loading } = useMe()

  if (loading) return null

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col items-center justify-center gap-5 bg-surface px-5 text-center">
      <IconChip icon={Compass} tone="soft" size="lg" />
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">
          We could not find that page
        </h1>
        <p className="mt-2 text-sm font-medium leading-relaxed text-ink-muted">
          Nothing is at <span className="font-mono text-xs">{location.pathname}</span>. The link may
          be from an old email, or it may have been mistyped.
        </p>
        {me && (
          <p className="mt-2 text-sm font-medium text-ink-muted">
            You are still signed in — nothing has expired.
          </p>
        )}
      </div>
      <Link
        to={me ? '/dashboard' : '/login'}
        className="flex min-h-11 w-full items-center justify-center rounded-card bg-brand py-3 text-base font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
      >
        {me ? 'Back to my dashboard' : 'Go to sign in'}
      </Link>
    </div>
  )
}
