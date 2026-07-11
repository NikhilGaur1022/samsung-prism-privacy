const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    const error = new Error(body?.error ?? `Request failed with status ${res.status}`)
    error.status = res.status
    error.details = body?.details
    error.masterUserId = body?.details?.masterUserId
    throw error
  }

  return body
}

export function registerSubject(payload) {
  return request('/subjects', { method: 'POST', body: JSON.stringify(payload) })
}

export function verifyOtp(masterUserId, otp) {
  return request(`/subjects/${masterUserId}/verify-otp`, {
    method: 'POST',
    body: JSON.stringify({ otp }),
  })
}
