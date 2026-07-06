import { NavLink } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { NAV_ITEMS } from './NavItems'

export default function SidebarNav() {
  return (
    <aside className="hidden md:flex md:w-64 md:flex-col md:shrink-0 md:border-r md:border-black/5 md:bg-surface md:h-screen md:sticky md:top-0">
      <div className="flex items-center gap-2 px-6 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-dark text-white shadow-card">
          <ShieldCheck size={20} strokeWidth={1.75} />
        </div>
        <span className="text-lg font-extrabold tracking-tight text-ink">Prism</span>
      </div>
      <nav className="flex-1 px-3">
        <ul className="space-y-1">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                    isActive
                      ? 'bg-brand-soft text-brand'
                      : 'text-ink-muted hover:bg-canvas'
                  }`
                }
              >
                <Icon size={20} strokeWidth={1.75} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="px-6 py-6 text-xs font-medium text-ink-faint">
        Consent Manager v6.21
        <br />
        Samsung Electronics Co., Ltd.
      </div>
    </aside>
  )
}
