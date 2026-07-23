import { Download, FileEdit, Trash2 } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import IconChip from '../components/IconChip'

const QUICK_ACTIONS = [
  { label: 'Download All', icon: Download, tone: 'brand' },
  { label: 'Update Info', icon: FileEdit, tone: 'neutral' },
  { label: 'Delete Account', icon: Trash2, tone: 'danger' },
]

export default function DataRights() {
  return (
    <div>
      <TopBar />

      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Data Rights</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Manage your personal information and privacy requests.
        </p>

        <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
          Quick Actions
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {QUICK_ACTIONS.map(({ label, icon: Icon, tone }) => (
            <Card key={label} className="flex flex-col items-center gap-2 py-4 text-center">
              <IconChip icon={Icon} tone={tone} />
              <span className="text-xs font-semibold leading-tight text-ink">{label}</span>
            </Card>
          ))}
        </div>

        <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
          Active Requests
        </p>
        <div className="mt-3 space-y-3">
          <Card>
            <div className="flex items-center gap-3">
              <IconChip icon={RefreshCw} tone="brand" size="sm" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-ink">Data Export in Progress</p>
                <p className="text-xs font-medium text-ink-muted">Estimated completion: 15 mins</p>
              </div>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-pill bg-canvas">
              <div className="h-full rounded-pill bg-brand" style={{ width: '65%' }} />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted">65% complete</span>
              <button className="rounded text-xs font-semibold text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger">
                Cancel Request
              </button>
            </div>
          </Card>

          <Card className="flex items-center gap-3">
            <IconChip icon={CircleAlert} tone="warning" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-ink">Deletion Requested</p>
              <p className="text-xs font-medium text-ink-muted">Waiting for security verification</p>
            </div>
            <ChevronRight size={16} className="text-ink-faint" />
          </Card>
        </div>

        <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
          Audit Log
        </p>
        <div className="mt-3 rounded-card bg-surface px-4 py-6 text-center shadow-card">
          <p className="text-xs font-medium text-ink-faint">Your activity log will appear here.</p>
        </div>
      </div>
    </div>
  )
}
