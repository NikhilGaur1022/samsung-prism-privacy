import { ShieldCheck, LogOut } from 'lucide-react'
import { useAuth } from '../auth'
import { ROLES } from '../roles'

export default function Sidebar({ activeLabel }) {
  const { roleKey, signOut } = useAuth()
  const role = ROLES[roleKey]

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col bg-sidebar text-white">
      <div className="px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand">
            <ShieldCheck size={18} strokeWidth={1.75} />
          </div>
          <span className="text-lg font-extrabold tracking-tight">PRISM</span>
        </div>
        <p className="mt-1 text-xs font-semibold text-brand-soft">{role?.label}</p>
      </div>

      <nav className="flex-1 px-3">
        <ul className="space-y-0.5">
          {role?.nav.map(({ label, icon: Icon }) => {
            const isActive = label === activeLabel
            return (
              <li key={label}>
                <button
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-white/10 text-white'
                      : 'text-sidebar-muted hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  {label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="px-3 pb-6">
        <button
          onClick={signOut}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-muted hover:bg-white/5 hover:text-white"
        >
          <LogOut size={16} strokeWidth={1.75} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
