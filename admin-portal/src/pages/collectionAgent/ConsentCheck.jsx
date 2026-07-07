import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { CONSENT_CHECKS } from '../../data/collectionAgent'
import { ShieldCheck } from 'lucide-react'

export default function ConsentCheck() {
  const [checks, setChecks] = useMockStore('collection-agent-consent-checks', CONSENT_CHECKS)

  const markSigned = (id) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, signed: true } : c)))
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Consent Check"
          subtitle="Confirm consent is signed under the correct template before capture begins."
        />

        <div className="mt-6">
          <ListPanel
            title="Sessions"
            rows={checks}
            emptyTitle="No sessions awaiting consent check"
            renderRow={(c) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{c.session}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {c.subject} · {c.templateVersion}
                  </p>
                </div>
                {c.signed ? (
                  <StatusPill tone="success">Signed</StatusPill>
                ) : (
                  <button
                    onClick={() => markSigned(c.id)}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <ShieldCheck size={14} strokeWidth={2} /> Confirm signed
                  </button>
                )}
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
