import { Link } from 'react-router-dom'
import { Building2, Landmark } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'

const PROJECTS = [
  { id: 'proj-1', name: 'Project 1', detail: 'Face Recognition Training v4.2', icon: Building2, tone: 'success', status: 'ACTIVE' },
  { id: 'proj-2', name: 'Project 2', detail: 'Retail Analytics Programme', icon: Landmark, tone: 'success', status: 'ACTIVE' },
]

export default function Projects() {
  return (
    <div>
      <TopBar title="Projects" />
      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Projects</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Every project you've shared data with.</p>

        <div className="mt-5 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
          {PROJECTS.map(({ id, name, detail, icon: Icon, tone, status }) => (
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
                <Badge tone={tone}>{status}</Badge>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
