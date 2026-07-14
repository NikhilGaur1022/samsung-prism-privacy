import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { getMe, logout as apiLogout } from './lib/api'

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

export function RequireRole({ children, allow }) {
  const { admin, loading } = useAuth()
  if (loading) return null
  if (!admin) return <Navigate to="/login" replace />
  if (allow && !allow.includes(admin.role)) return <Navigate to="/dashboard" replace />
  return children
}
