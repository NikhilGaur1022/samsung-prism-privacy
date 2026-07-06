import { LayoutGrid, FolderKanban, ShieldCheck, CircleUserRound } from 'lucide-react'

export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutGrid },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/consent', label: 'Consent', icon: ShieldCheck },
  { to: '/profile', label: 'Profile', icon: CircleUserRound },
]
