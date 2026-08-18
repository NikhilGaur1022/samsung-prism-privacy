import { NavLink } from 'react-router-dom'
import { ShieldCheck, LogOut } from 'lucide-react'
import { useAuth } from '../auth'
import { ROLES, navSectionsForRole } from '../roles'

export default function Sidebar() {
  const { roleKey, signOut } = useAuth()
  const role = ROLES[roleKey]
  const sections = navSectionsForRole(roleKey)
  // Four of the five roles land in a single section, where a heading would only
  // repeat what the sidebar already says. The groups exist for super_admin,
  // whose twenty-three entries are otherwise an undifferentiated wall of links.
  const showGroupLabels = sections.length > 1

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

      <nav className="flex-1 overflow-y-auto px-3">
        {sections.map((section) => (
          <div key={section.key} className={showGroupLabels ? 'mb-4 last:mb-0' : undefined}>
            {showGroupLabels && (
              <p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-sidebar-muted">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map(({ label, icon: Icon, path }) => (
                <li key={path}>
                  <NavLink
                    to={path}
                    className={({ isActive }) =>
                      `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
                        isActive
                          ? 'bg-white/10 text-white'
                          : 'text-sidebar-muted hover:bg-white/5 hover:text-white'
                      }`
                    }
                  >
                    <Icon size={16} strokeWidth={1.75} />
                    {label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="px-3 pb-6">
        <button
          onClick={signOut}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-sidebar-muted hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <LogOut size={16} strokeWidth={1.75} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
