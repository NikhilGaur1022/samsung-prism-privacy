import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { Navigate, useLocation, Link } from 'react-router-dom'
import { ShieldOff } from 'lucide-react'
import { getMe, logout as apiLogout } from './lib/api'
import { ROLES } from './roles'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(null)
  const [loading, setLoading] = useState(true)

  const refreshMe = useCallback(async () => {
    try {
      const me = await getMe()
      setAdmin(me)
    } catch {
      setAdmin(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshMe()
  }, [refreshMe])

  const signIn = (me) => setAdmin(me)

  const signOut = async () => {
    try {
      await apiLogout()
    } catch {
      // best-effort — clear local state regardless of network outcome
    }
    setAdmin(null)
  }

  return (
    <AuthContext.Provider value={{ admin, roleKey: admin?.role ?? null, loading, signIn, signOut, refreshMe }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

// A refusal, stated. This used to be `<Navigate to="/dashboard" replace />`,
// which is indistinguishable from a broken link: the operator clicks, the URL
// changes back, and nothing says whether the page is gone, whether they are
// signed out, or whether they were refused. Naming the role and the page makes
// the refusal legible — and makes a genuine permission bug reportable, because
// the person who hit it can say which role was turned away from which path.
function AccessRefused({ path, roleKey, allow }) {
  const role = ROLES[roleKey]
  const permitted = allow.map((r) => ROLES[r]?.label ?? r)

  return (
    <div className="flex min-h-svh items-center justify-center bg-canvas px-6">
      <div className="max-w-lg rounded-card bg-surface p-8 shadow-card">
        <div className="flex items-center gap-2 text-danger">
          <ShieldOff size={18} strokeWidth={1.75} />
          <h1 className="text-base font-bold">This page is not part of your role</h1>
        </div>
        <p className="mt-3 text-sm font-medium text-ink-muted">
          You are signed in as <strong className="text-ink">{role?.label ?? roleKey}</strong>, and{' '}
          <code className="text-ink">{path}</code> is reserved for{' '}
          <strong className="text-ink">{permitted.join(', ') || 'no role'}</strong>.
        </p>
        <p className="mt-2 text-xs font-medium text-ink-faint">
          Nothing was read and nothing was recorded against your name. If this is work you are meant
          to be doing, it is a role change your platform administrator makes — not something this
          screen can grant.
        </p>
        <Link
          to="/dashboard"
          className="mt-5 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Back to your dashboard
        </Link>
      </div>
    </div>
  )
}

export function RequireRole({ children, allow }) {
  const { admin, loading } = useAuth()
  const location = useLocation()
  if (loading) return null
  if (!admin) return <Navigate to="/login" replace />
  if (allow && !allow.includes(admin.role)) {
    return <AccessRefused path={location.pathname} roleKey={admin.role} allow={allow} />
  }
  return children
}
