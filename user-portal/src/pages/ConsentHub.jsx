import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldCheck, ShieldOff, ShieldAlert, Building2, Globe2 } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'

const REQUESTS = [
  {
    id: 'AZ-99120',
    name: 'Amazon Inc.',
    purpose: 'Personalization Data',
    status: 'DONE',
    tone: 'neutral',
    icon: Building2,
  },
  {
    id: 'MT-12884',
    name: 'Meta Platforms',
    purpose: 'Social Graph Portability',
    status: 'APPLIED',
    tone: 'brand',
    icon: Globe2,
  },
]

export default function ConsentHub() {
  const [revoked, setRevoked] = useState(false)

  return (
    <div>
      <TopBar />

      <div className="px-4 md:px-8">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Consent</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Manage your data and privacy preferences.</p>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <Card className="flex items-center gap-3">
            <IconChip icon={ShieldCheck} tone="solid" size="sm" />
            <div>
              <p className="text-sm font-semibold text-ink">Secure &amp; Active</p>
              <p className="text-xs font-medium text-ink-muted">Last checked: 2 mins ago</p>
            </div>
          </Card>

          <Card className="flex items-center gap-3">
            <IconChip icon={ShieldOff} tone="danger" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-ink">Global Revocation</p>
              <p className="text-xs font-medium text-ink-muted">Pause all data processing</p>
            </div>
            <button
              role="switch"
              aria-checked={revoked}
              onClick={() => setRevoked((v) => !v)}
              className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors ${
                revoked ? 'bg-danger' : 'bg-black/15'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  revoked ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </Card>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink">Recent Requests</h2>
          <button className="text-sm font-semibold text-brand">View All</button>
        </div>

        <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
          {REQUESTS.map(({ id, name, purpose, status, tone, icon: Icon }) => (
            <Card key={id}>
              <div className="flex items-start gap-3">
                <IconChip icon={Icon} tone="neutral" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{name}</p>
                    <Badge tone={tone}>{status}</Badge>
                  </div>
                  <p className="text-xs font-medium text-ink-muted">{purpose}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <p className="text-[11px] font-medium text-ink-faint">Request ID: #{id}</p>
                    <button className="text-xs font-semibold text-brand">View Report</button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <Card className="flex flex-col justify-center">
            <div className="flex items-center gap-1.5 text-ink-muted">
              <ShieldAlert size={16} strokeWidth={1.75} />
              <span className="text-xs font-semibold">Privacy Score</span>
            </div>
            <p className="mt-1 text-2xl font-extrabold text-brand">88</p>
          </Card>
          <Link
            to="/rights"
            className="flex items-center justify-center rounded-card bg-brand text-sm font-bold text-white shadow-card"
          >
            Data Request
          </Link>
        </div>

        <div className="mt-6 flex justify-center gap-4 text-xs font-semibold text-ink-muted">
          <span>Privacy Policy</span>
          <span>Terms of Service</span>
          <span>GDPR Support</span>
        </div>
        <p className="mt-3 pb-4 text-center text-[11px] font-medium text-ink-faint">
          Consent Manager v6.21 &middot; Samsung Electronics Co., Ltd.
        </p>
      </div>
    </div>
  )
}
