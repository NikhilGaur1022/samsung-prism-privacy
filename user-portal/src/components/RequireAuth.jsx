import { Navigate } from 'react-router-dom'
import { useMe } from '../lib/useMe'

// The gate on every signed-in route.
//
// There was none. Thirteen routes sat under a bare <Route element={<AppLayout />}>,
// so a signed-out visitor typing /my-data got the full shell — sidebar, bottom
// bar, page chrome — and then whatever each page did with its own 401. Two of
// the thirteen called useMe and handled it; the other eleven rendered an empty
// signed-in screen, which reads as "we hold nothing about you" rather than as
// "you are not signed in". One gate in front of the layout means the session is
// established before any page renders and every page can assume it.
//
// A refused visitor lands on /login rather than back where they were: signing in
// is a three-screen OTP walk (/login → /verify → /enroll) with no return-to
// carried through it, so promising a bounce-back here would be a promise the
// login flow does not keep.
export default function RequireAuth({ children }) {
  const { me, loading, unauthorized } = useMe()

  // No shell, no spinner-shaped hint about what is behind the gate.
  if (loading) return null
  if (unauthorized || !me) return <Navigate to="/login" replace />
  return children
}
