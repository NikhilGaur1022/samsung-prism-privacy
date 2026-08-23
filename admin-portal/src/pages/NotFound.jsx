import { Link, useLocation } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import Sidebar from '../components/Sidebar'
import PageHeader from '../components/PageHeader'
import { useAuth } from '../auth'

// A real 404.
//
// Both portals shipped `<Route path="*" element={<Navigate to="/login" />} />`.
// Verified live: /this-route-does-not-exist rendered the login page
// byte-identically to /login. So a signed-in admin who followed a stale link, or
// mistyped a URL, was shown a sign-in form — which reads as "you have been
// logged out", and the natural response to that is to re-enter a password on a
// page you did not expect to see. That is a phishing-shaped experience produced
// by our own routing.
//
// A signed-in user keeps the authenticated shell and gets a way back. A
// signed-out one is offered the sign-in page explicitly, as a choice rather than
// as a silent redirect.
export default function NotFound() {
  const location = useLocation()
  const { admin } = useAuth() ?? {}

  const body = (
    <div className="mt-8 max-w-lg">
      <FileQuestion size={32} strokeWidth={1.5} className="text-ink-faint" aria-hidden="true" />
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">
        That page does not exist
      </h1>
      <p className="mt-2 text-sm font-medium leading-relaxed text-ink-muted">
        Nothing is at{' '}
        <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-ink">
          {location.pathname}
        </code>
        . The link may be out of date, or the page may have moved.
      </p>
      <p className="mt-2 text-sm font-medium text-ink-muted">
        {admin
          ? 'You are still signed in — nothing has expired.'
          : 'You are not signed in.'}
      </p>
      <Link
        to={admin ? '/dashboard' : '/login'}
        className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {admin ? 'Back to dashboard' : 'Go to sign in'}
      </Link>
    </div>
  )

  if (!admin) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-canvas px-6">{body}</div>
    )
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />
      <main className="flex-1 px-10 py-8">
        <PageHeader title="Not found" subtitle="This URL does not match any page in the console." />
        {body}
      </main>
    </div>
  )
}
