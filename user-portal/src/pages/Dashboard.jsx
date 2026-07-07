import { Link } from 'react-router-dom'
import { QrCode, ShieldCheck, Gauge, Bell, ChevronRight, Building2, Landmark } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'

const PROJECTS = [
  { id: 'proj-1', name: 'Project 1', detail: 'Face Recognition Training v4.2', icon: Building2 },
  { id: 'proj-2', name: 'Project 2', detail: 'Retail Analytics Programme', icon: Landmark },
]

export default function Dashboard() {
  return (
    <div>
      <TopBar title="Dashboard" />

      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Hello, User</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Your digital footprint is well-guarded.</p>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <Card className="md:col-span-2 flex flex-col items-center justify-center gap-3 bg-brand py-8 text-center text-white">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15">
              <QrCode size={24} strokeWidth={1.75} />
            </div>
            <div>
              <p className="text-base font-bold">Scan QR to Join Project</p>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-4 md:col-span-1 md:grid-cols-1">
            <Card>
              <div className="flex items-center justify-between">
                <IconChip icon={ShieldCheck} tone="brand" size="sm" />
                <Badge tone="success">SAFE</Badge>
              </div>
              <p className="mt-3 text-xs font-medium text-ink-muted">Data Security</p>
              <p className="text-xl font-extrabold text-ink">78%</p>
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <IconChip icon={Gauge} tone="brand" size="sm" />
                <Badge tone="success">LOW</Badge>
              </div>
              <p className="mt-3 text-xs font-medium text-ink-muted">Risk Score</p>
              <p className="text-xl font-extrabold text-ink">Low</p>
            </Card>
          </div>
        </div>

        <Link
          to="/rights"
          className="mt-4 block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <Card className="flex items-center gap-3 bg-warning-soft">
            <IconChip icon={Bell} tone="warning" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-bold text-warning">3 New Data Requests</p>
              <p className="text-xs font-medium text-warning/80">Requires your review</p>
            </div>
            <ChevronRight size={18} className="text-warning" />
          </Card>
        </Link>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">Active Consents</h2>
          <Link to="/projects" className="text-sm font-semibold text-brand">
            View all
          </Link>
        </div>

        <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
          {PROJECTS.map(({ id, name, detail, icon: Icon }) => (
            <Link
              key={id}
              to={`/consent/${id}`}
              className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Card className="flex items-center gap-3">
                <IconChip icon={Icon} tone="brand" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{name}</p>
                  <p className="truncate text-xs font-medium text-ink-muted">{detail}</p>
                </div>
                <Badge tone="success">ACTIVE</Badge>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
