import { Fingerprint, Clock, Database, ScanFace, User, MapPin, ChevronRight, ShieldOff } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'

const COLLECTED = [
  { label: 'Biometric Data', icon: Fingerprint },
  { label: 'Full Name', icon: User },
  { label: 'Location', icon: MapPin },
]

export default function ProjectDetails() {
  return (
    <div>
      <TopBar back />

      <div className="px-4 md:px-8 md:grid md:grid-cols-5 md:gap-8">
        <div className="md:col-span-3">
          <Badge tone="danger">Consent Active</Badge>
          <h1 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight text-ink">
            Face Recognition Training v4.2
          </h1>

          <div className="mt-4 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-card bg-gradient-to-br from-brand-soft to-canvas md:aspect-video">
            <ScanFace size={72} strokeWidth={1} className="text-brand" />
          </div>

          <div className="mt-5">
            <p className="text-xs font-bold uppercase tracking-wide text-brand">Purpose</p>
            <p className="mt-1.5 text-sm font-medium leading-relaxed text-ink-muted">
              This dataset is utilized for training adaptive facial geometry algorithms.
              It ensures higher accuracy across diverse lighting conditions and enhances
              security for biometric authentication modules.
            </p>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <Card className="flex items-center gap-3">
              <IconChip icon={Clock} tone="neutral" size="sm" />
              <div>
                <p className="text-xs font-medium text-ink-muted">Retention</p>
                <p className="text-sm font-bold text-ink">2 Years</p>
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <IconChip icon={Database} tone="neutral" size="sm" />
              <div>
                <p className="text-xs font-medium text-ink-muted">Data Size</p>
                <p className="text-sm font-bold text-ink">14.2 GB</p>
              </div>
            </Card>
          </div>
        </div>

        <div className="mt-6 md:col-span-2 md:mt-0">
          <h2 className="text-base font-bold text-ink">Collected Data</h2>
          <div className="mt-3 space-y-2.5">
            {COLLECTED.map(({ label, icon: Icon }) => (
              <Card key={label} className="flex items-center gap-3 py-3">
                <IconChip icon={Icon} tone="brand" size="sm" />
                <span className="flex-1 text-sm font-semibold text-ink">{label}</span>
                <ChevronRight size={16} className="text-ink-faint" />
              </Card>
            ))}
          </div>

          <div className="mt-6 space-y-3 pb-6">
            <button className="w-full rounded-card bg-brand py-3.5 text-sm font-bold text-white shadow-card">
              Manage Consent
            </button>
            <button className="flex w-full items-center justify-center gap-2 rounded-card bg-danger-soft py-3.5 text-sm font-bold text-danger">
              <ShieldOff size={16} strokeWidth={1.75} />
              Revoke Access
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
