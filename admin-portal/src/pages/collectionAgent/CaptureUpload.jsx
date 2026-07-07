import { useRef, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockStore } from '../../lib/mockStore'
import { ASSIGNMENTS, UPLOAD_QUEUE } from '../../data/collectionAgent'
import { UploadCloud } from 'lucide-react'

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function CaptureUpload() {
  const [assignments] = useMockStore('collection-agent-assignments', ASSIGNMENTS)
  const [, setQueue] = useMockStore('collection-agent-upload-queue', UPLOAD_QUEUE)
  const [sessionCode, setSessionCode] = useState(assignments[0]?.code ?? '')
  const [justAdded, setJustAdded] = useState(0)
  const inputRef = useRef(null)

  const handleFiles = (fileList) => {
    const files = Array.from(fileList)
    if (files.length === 0) return

    setQueue((prev) => [
      ...files.map((f, i) => ({
        id: `up-${sessionCode}-${Date.now()}-${i}`,
        session: sessionCode,
        file: f.name,
        sizeMb: Math.round(f.size / 1024 / 1024) || 1,
        progress: 0,
      })),
      ...prev,
    ])
    setJustAdded(files.length)
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Capture & Upload"
          subtitle="Attach captured media to a session and send it to the upload queue."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          {justAdded > 0 && (
            <div className="mb-5 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-semibold text-success">
              {justAdded} file{justAdded === 1 ? '' : 's'} added to the Upload Queue.
            </div>
          )}

          <label className="block text-sm font-semibold text-ink">
            Session
            <select
              className={FIELD_CLASS}
              value={sessionCode}
              onChange={(e) => setSessionCode(e.target.value)}
            >
              {assignments.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.project}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-4 flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-canvas py-10 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <UploadCloud size={22} strokeWidth={1.5} className="text-ink-faint" />
            <p className="text-sm font-semibold text-ink">Click to select files</p>
            <p className="text-xs font-medium text-ink-faint">or drag and drop captured media here</p>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      </main>
    </div>
  )
}
