import { useAuth } from '../auth'
import { ROLES } from '../roles'
import Sidebar from '../components/Sidebar'
import StatCard from '../components/StatCard'
import { ChevronRight, ShieldCheck } from 'lucide-react'

export default function Dashboard() {
  const { roleKey } = useAuth()
  const role = ROLES[roleKey]

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar activeLabel={role.nav[0].label} />

      <main className="flex-1 px-10 py-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{role.dashboardTitle}</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">{role.subtitle}</p>

        <div className="mt-6 grid grid-cols-3 gap-4">
          {role.stats.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>

        <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
          <h2 className="text-base font-bold text-ink">Current Work Queue</h2>
          <ul className="mt-4 divide-y divide-border">
            {role.queue.map(({ title }) => (
              <li key={title} className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
                <div>
                  <p className="text-sm font-semibold text-ink">{title}</p>
                  <p className="mt-0.5 text-xs font-medium text-ink-faint">
                    Open details and continue the next permitted action
                  </p>
                </div>
                <ChevronRight size={16} className="shrink-0 text-ink-faint" />
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex gap-3 rounded-card bg-surface p-5 shadow-card">
          <ShieldCheck size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
          <div>
            <p className="text-sm font-bold text-ink">Access is role-scoped</p>
            <p className="mt-1 text-xs font-medium leading-relaxed text-ink-muted">{role.accessNote}</p>
          </div>
        </div>
      </main>
    </div>
  )
}
