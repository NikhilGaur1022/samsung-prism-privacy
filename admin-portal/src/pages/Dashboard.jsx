import { useAuth } from '../auth'
import { ROLES } from '../roles'
import Sidebar from '../components/Sidebar'
import StatCard from '../components/StatCard'
import PageHeader from '../components/PageHeader'
import ListPanel from '../components/ListPanel'
import { ShieldCheck } from 'lucide-react'

export default function Dashboard() {
  const { roleKey } = useAuth()
  const role = ROLES[roleKey]

  const rows = role.queue.map(({ title }) => ({
    title,
    subtitle: 'Open details and continue the next permitted action',
  }))

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader title={role.dashboardTitle} subtitle={role.subtitle} />

        <div className="mt-6 grid grid-cols-3 gap-4">
          {role.stats.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>

        <div className="mt-6">
          <ListPanel title="Current Work Queue" rows={rows} />
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
