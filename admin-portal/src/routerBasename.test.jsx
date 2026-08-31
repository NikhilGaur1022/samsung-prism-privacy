import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'

import { routerBasename } from './App'

// The bare URL — https://host/admin, no trailing slash — rendered a blank white
// page for two days. Vite's BASE_URL is "/admin/", React Router's stripBasename
// does a literal startsWith, "/admin" does not start with "/admin/", matchRoutes
// returns null and the router renders nothing at all. No error, no failed
// request, every server check 200. Only the bare path was affected, which is the
// one people type and bookmark, so it looked like a caching problem in one
// browser rather than a bug.

describe('routerBasename', () => {
  it('drops the trailing slash Vite always puts on BASE_URL', () => {
    expect(routerBasename('/admin/')).toBe('/admin')
  })

  it('leaves the dev root alone — React Router special-cases "/"', () => {
    expect(routerBasename('/')).toBe('/')
    expect(routerBasename('')).toBe('/')
    expect(routerBasename(undefined)).toBe('/')
  })

  it('leaves an already-bare basename alone', () => {
    expect(routerBasename('/admin')).toBe('/admin')
  })
})

function renderAt(pathname, basename) {
  window.history.pushState({}, '', pathname)
  return render(
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/" element={<p>index</p>} />
        <Route path="/sessions" element={<p>sessions</p>} />
      </Routes>
    </BrowserRouter>,
  )
}

describe('the bare /admin URL', () => {
  it('renders nothing with the raw BASE_URL — the bug', () => {
    const { container } = renderAt('/admin', '/admin/')
    expect(container.textContent).toBe('')
  })

  it('renders with the normalised basename', () => {
    renderAt('/admin', routerBasename('/admin/'))
    expect(screen.getByText('index')).toBeTruthy()
  })

  it('still renders the trailing-slash form', () => {
    renderAt('/admin/', routerBasename('/admin/'))
    expect(screen.getByText('index')).toBeTruthy()
  })

  it('still renders deep links', () => {
    renderAt('/admin/sessions', routerBasename('/admin/'))
    expect(screen.getByText('sessions')).toBeTruthy()
  })

  it('does not swallow a sibling path that merely shares the prefix', () => {
    const { container } = renderAt('/administrator', routerBasename('/admin/'))
    expect(container.textContent).toBe('')
  })
})
