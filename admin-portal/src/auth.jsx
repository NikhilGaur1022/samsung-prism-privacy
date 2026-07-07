import { createContext, useContext, useState } from 'react'
import { Navigate } from 'react-router-dom'

const AuthContext = createContext(null)
const STORAGE_KEY = 'prism-admin-role'

export function AuthProvider({ children }) {
  const [roleKey, setRoleKeyState] = useState(() => localStorage.getItem(STORAGE_KEY))

  const setRoleKey = (key) => {
    localStorage.setItem(STORAGE_KEY, key)
    setRoleKeyState(key)
  }

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY)
    setRoleKeyState(null)
  }

  return (
    <AuthContext.Provider value={{ roleKey, setRoleKey, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

export function RequireRole({ children }) {
  const { roleKey } = useAuth()
  if (!roleKey) return <Navigate to="/login" replace />
  return children
}
