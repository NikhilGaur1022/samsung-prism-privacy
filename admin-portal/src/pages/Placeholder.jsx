import { useAuth } from '../auth'
import { ROLES } from '../roles'
import Sidebar from '../components/Sidebar'
import { Hammer } from 'lucide-react'

export default function Placeholder({ label }) {
  const { roleKey } = useAuth()
  const role = ROLES[roleKey]

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{label}</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">{role?.subtitle}</p>

        <div className="mt-6 flex items-center gap-3 rounded-card bg-surface p-6 shadow-card">
          <Hammer size={18} strokeWidth={1.75} className="shrink-0 text-brand" />
          <p className="text-sm font-medium text-ink-muted">
            This page is scheduled for a later build phase. Data and interactions will
            appear here once implemented.
          </p>
        </div>
      </main>
    </div>
  )
}
