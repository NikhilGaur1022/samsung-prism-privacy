import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // "/" unless the build says otherwise. The deployed stack serves this console
  // under /admin on the same origin as the user portal and the API, so that the
  // session cookies (sameSite: 'strict') the API sets are actually sent — see
  // deploy/staging/Caddyfile. App.jsx reads the same value back as BASE_URL for
  // react-router's basename.
  base: process.env.VITE_BASE_PATH ?? '/',
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
