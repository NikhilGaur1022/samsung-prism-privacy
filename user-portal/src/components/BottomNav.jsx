import { NavLink } from 'react-router-dom'
import { PRIMARY_NAV } from './NavItems'

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 border-t border-black/5 bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="flex items-stretch justify-between px-2">
        {PRIMARY_NAV.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end={to === '/requests'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-1 py-2.5 text-center text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  isActive ? 'text-brand' : 'text-ink-faint'
                }`
              }
            >
              <Icon size={22} strokeWidth={1.75} />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
