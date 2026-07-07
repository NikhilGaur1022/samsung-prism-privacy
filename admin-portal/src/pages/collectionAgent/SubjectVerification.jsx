import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockStore } from '../../lib/mockStore'
import { SUBJECTS } from '../../data/collectionAgent'
import { UserCheck } from 'lucide-react'

export default function SubjectVerification() {
  const [subjects, setSubjects] = useMockStore('collection-agent-subjects', SUBJECTS)

  const verify = (id) => {
    setSubjects((prev) => prev.map((s) => (s.id === id ? { ...s, verified: true } : s)))
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Subject Verification"
          subtitle="Confirm the data subject's identity before starting collection."
        />

        <div className="mt-6">
          <ListPanel
            title="Subjects"
            rows={subjects}
            emptyTitle="No subjects to verify"
            renderRow={(s) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{s.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">{s.code}</p>
                </div>
                {s.verified ? (
                  <StatusPill tone="success">Verified</StatusPill>
                ) : (
                  <button
                    onClick={() => verify(s.id)}
                    className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <UserCheck size={14} strokeWidth={2} /> Verify
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
