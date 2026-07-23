import { useEffect, useState } from 'react'
import { getMe } from './api'

// The signed-in subject, straight from the session cookie. A 401 means the
// session is gone — callers get { me: null, unauthorized: true } and should
// send the user back to /login rather than render a signed-in shell.
export function useMe() {
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)
  const [unauthorized, setUnauthorized] = useState(false)

  useEffect(() => {
    let alive = true
    getMe()
      .then((data) => alive && setMe(data))
      .catch((err) => alive && err?.status === 401 && setUnauthorized(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  return { me, loading, unauthorized }
}
