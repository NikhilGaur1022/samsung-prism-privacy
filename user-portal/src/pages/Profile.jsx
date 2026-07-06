import { Link } from 'react-router-dom'
import { User, ShieldCheck, FileText, LogOut, ChevronRight } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import IconChip from '../components/IconChip'

const LINKS = [
  { label: 'Manage Consent', to: '/consent', icon: ShieldCheck },
  { label: 'Data Rights & Requests', to: '/rights', icon: FileText },
]

export default function Profile() {
  return (
    <div>
      <TopBar title="Profile" />
      <div className="px-4 md:px-8">
        <div className="flex items-center gap-4">
          <IconChip icon={User} tone="brand" size="lg" />
          <div>
            <p className="text-lg font-extrabold text-ink">John Doe</p>
            <p className="text-sm font-medium text-ink-muted">john.doe@example.com</p>
          </div>
        </div>

        <div className="mt-6 space-y-2.5">
          {LINKS.map(({ label, to, icon: Icon }) => (
            <Link key={label} to={to} className="block">
              <Card className="flex items-center gap-3 py-3.5">
                <IconChip icon={Icon} tone="brand" size="sm" />
                <span className="flex-1 text-sm font-semibold text-ink">{label}</span>
                <ChevronRight size={16} className="text-ink-faint" />
              </Card>
            </Link>
          ))}
        </div>

        <button className="mt-6 flex w-full items-center justify-center gap-2 rounded-card bg-danger-soft py-3.5 text-sm font-bold text-danger">
          <LogOut size={16} strokeWidth={1.75} />
          Sign Out
        </button>
      </div>
    </div>
  )
}
