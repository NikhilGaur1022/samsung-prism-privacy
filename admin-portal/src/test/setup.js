import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// A component test that leaks its DOM into the next one produces failures that
// depend on file order, which is worse than no test.
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// jsdom implements neither, and both are used by the layout code under test.
globalThis.matchMedia ??= (query) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
