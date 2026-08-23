import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import NotFound from './NotFound'

// The 404 that used to be a redirect to /login.
//
// Verified live during the audit: /this-route-does-not-exist rendered the login
// page byte-identically to /login. A signed-in admin following a stale link was
// shown a sign-in form, which reads as "you have been logged out" — and the
// natural response to that is to re-enter a password on a page you did not
// expect. That is a phishing-shaped experience produced by our own routing.

vi.mock('../auth', () => ({
  useAuth: () => mockAuth,
}))

vi.mock('../components/Sidebar', () => ({
  default: () => <nav data-testid="sidebar" />,
}))

let mockAuth = { admin: null }

function renderAt(path, auth) {
  mockAuth = auth
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotFound />
    </MemoryRouter>,
  )
}

describe('NotFound', () => {
  it('says the page does not exist rather than showing a sign-in form', () => {
    renderAt('/this-route-does-not-exist', { admin: { role: 'dpo' } })

    expect(screen.getByText(/does not exist/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^sign in$/i)).not.toBeInTheDocument()
  })

  it('names the path that was not found', () => {
    renderAt('/dsar/stale-link', { admin: { role: 'dataAdmin' } })
    expect(screen.getByText('/dsar/stale-link')).toBeInTheDocument()
  })

  it('tells a signed-in admin their session is intact', () => {
    // This is the sentence that stops a stale link reading as an expiry.
    renderAt('/nope', { admin: { role: 'dpo' } })
    expect(screen.getByText(/still signed in/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toBeInTheDocument()
  })

  it('keeps the authenticated shell for a signed-in admin', () => {
    renderAt('/nope', { admin: { role: 'dpo' } })
    expect(screen.getByTestId('sidebar')).toBeInTheDocument()
  })

  it('offers sign-in as a choice, not a silent redirect, when signed out', () => {
    renderAt('/nope', { admin: null })
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/login')
    // No shell: there is no session to frame.
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
  })
})
