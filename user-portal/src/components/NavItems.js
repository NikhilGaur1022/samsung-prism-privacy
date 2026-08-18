import {
  LayoutGrid,
  FolderKanban,
  ShieldCheck,
  CircleUserRound,
  Scale,
  Database,
  FileClock,
  Inbox,
  FilePlus2,
} from 'lucide-react'

// The whole signed-in surface, grouped.
//
// This list used to hold four entries — dashboard, projects, consent, profile —
// against thirteen protected routes. Everything DPDP §11–§13 actually gives a
// principal (see what data is held, see and withdraw consent, raise an access,
// correction, portability or erasure request, follow it, collect the answer)
// was reachable only by typing the URL. A right nobody can find is not a right
// they have, so the nav is now built around the rights rather than around the
// projects.
export const NAV_SECTIONS = [
  {
    key: 'overview',
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Home', icon: LayoutGrid },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
    ],
  },
  {
    key: 'consent',
    label: 'Consent',
    items: [
      { to: '/consent', label: 'Give consent', icon: ShieldCheck },
      { to: '/consents', label: 'My consents', icon: FileClock },
    ],
  },
  {
    key: 'rights',
    label: 'Your rights',
    items: [
      { to: '/rights', label: 'Data rights', icon: Scale },
      { to: '/my-data', label: 'My data', icon: Database },
      { to: '/requests/new', label: 'Raise a request', icon: FilePlus2 },
      { to: '/requests', label: 'My requests', icon: FileClock },
      { to: '/inbox', label: 'Secure inbox', icon: Inbox },
    ],
  },
  {
    key: 'account',
    label: 'Account',
    items: [{ to: '/profile', label: 'Profile', icon: CircleUserRound }],
  },
]

export const NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items)

// The phone bar. Five is the most that stays tappable across one row, so it is
// a chosen subset rather than the full list — the rest live behind the sidebar
// on a wide screen and behind /rights on a narrow one, which is why Data rights
// keeps its slot here even though it is a hub rather than a destination.
const PRIMARY_PATHS = ['/dashboard', '/consent', '/rights', '/requests', '/profile']

export const PRIMARY_NAV = PRIMARY_PATHS.map((p) => NAV_ITEMS.find((i) => i.to === p)).filter(
  Boolean,
)
