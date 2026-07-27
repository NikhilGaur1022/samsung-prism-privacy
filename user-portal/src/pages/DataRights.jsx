import { Link } from 'react-router-dom'
import { ChevronRight, Database, FileEdit, Inbox, ShieldCheck, Trash2 } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import IconChip from '../components/IconChip'

const LINKS = [
  { to: '/my-data', label: 'My Data', desc: 'Profile, consents and enrollment — DPDP §11 summary.', icon: Database, tone: 'brand' },
  { to: '/consents', label: 'My Consents', desc: 'Grant or withdraw consent per project.', icon: ShieldCheck, tone: 'brand' },
  { to: '/requests/new', label: 'Raise a Request', desc: 'Access, correction, erasure, grievance or nomination.', icon: FileEdit, tone: 'neutral' },
  { to: '/requests', label: 'Request Status', desc: 'Track requests you have raised, with SLA countdown.', icon: Trash2, tone: 'neutral' },
  { to: '/inbox', label: 'Secure Inbox', desc: 'Outcomes, certificates and package downloads.', icon: Inbox, tone: 'neutral' },
]

export default function DataRights() {
  return (
    <div>
      <TopBar />

      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Data Rights</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Manage your personal information and privacy requests.
        </p>

        <div className="mt-5 space-y-3">
          {LINKS.map(({ to, label, desc, icon: Icon, tone }) => (
            <Link key={to} to={to} className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <Card className="flex items-center gap-3">
                <IconChip icon={Icon} tone={tone} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{label}</p>
                  <p className="truncate text-xs font-medium text-ink-muted">{desc}</p>
                </div>
                <ChevronRight size={16} className="text-ink-faint" />
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
