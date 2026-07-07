import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockStore } from '../../lib/mockStore'
import { UPLOAD_QUEUE } from '../../data/collectionAgent'
import EmptyState from '../../components/EmptyState'
import { UploadCloud } from 'lucide-react'

export default function UploadQueue() {
  const [queue] = useMockStore('collection-agent-upload-queue', UPLOAD_QUEUE)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Upload Queue"
          subtitle="Files transferring from device to secure storage."
        />

        <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
          <h2 className="text-base font-bold text-ink">In Progress</h2>

          {queue.length === 0 ? (
            <EmptyState
              icon={UploadCloud}
              title="Queue is empty"
              message="Files added from Capture & Upload will appear here."
            />
          ) : (
            <div className="mt-4 space-y-4">
              {queue.map((u) => (
                <div key={u.id}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate font-medium text-ink">
                      {u.session} · {u.file}
                    </span>
                    <span className="shrink-0 font-semibold text-ink-muted">
                      {u.progress >= 100 ? 'Done' : `${u.progress}% of ${u.sizeMb}MB`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-pill bg-canvas">
                    <div
                      className={`h-2 rounded-pill ${u.progress >= 100 ? 'bg-success' : 'bg-brand'}`}
                      style={{ width: `${Math.max(u.progress, 4)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
