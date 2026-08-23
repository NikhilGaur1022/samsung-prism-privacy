import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5180 },
  // There were zero frontend tests. Three of the audit's findings were
  // client-side and every one of them was invisible to the backend suite: the
  // permanent loading state with no error arm, the 404 that impersonated a
  // logout, and the blocked-frame counter that reported zero because it
  // enumerated the wrong states.
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    globals: true,
  },
})
