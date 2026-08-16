import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, Mic } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listSessions } from '../../lib/api'

const TONE = {
  ACTIVE: 'brand',
  PROCESSING: 'warning',
  TAGGING: 'warning',
  ARCHIVED: 'success',
  FAILED: 'danger',
}

const LABEL = {
  ACTIVE: 'Capturing',
  PROCESSING: 'Processing',
  TAGGING: 'Needs tagging',
  ARCHIVED: 'Archived',
  FAILED: 'Failed',
}

export default function Sessions() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listSessions()
      .then((res) => setSessions(res.items))
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])

  const open = (session) => {
    if (session.type === 'AUDIO') {
      navigate(`/sessions/${session.id}/audio`)
    } else if (session.status === 'TAGGING') {
      navigate(`/sessions/${session.id}/tagging`)
    } else {
      navigate(`/sessions/${session.id}`)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader title="Sessions" subtitle="Every collection session you have run." />

        <div className="mt-6">
          <ListPanel
            title="My sessions"
            rows={sessions}
            loading={loading}
            error={error}
            emptyIcon={Camera}
            emptyTitle="No sessions yet"
            emptyMessage="Start one from New Session."
            renderRow={(s) => {
              const isAudio = s.type === 'AUDIO'
              return (
                <button
                  key={s.id}
                  onClick={() => open(s)}
                  className="flex w-full items-center justify-between gap-4 py-4 text-left first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand hover:bg-canvas/50 px-2 rounded-lg transition"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className={`p-2.5 rounded-xl border ${
                      isAudio ? 'bg-amber-500/10 border-amber-500/20 text-amber-600' : 'bg-brand-soft/50 border-brand/20 text-brand'
                    }`}>
                      {isAudio ? <Mic size={18} /> : <Camera size={18} />}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-ink">
                          {s.code} — {s.project.name}
                        </p>
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${
                          isAudio ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                        }`}>
                          {isAudio ? 'Audio' : 'Image'}
                        </span>
                      </div>

                      <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                        {s.participantCount} on roster ·{' '}
                        {isAudio
                          ? `${s.recordingCount || 0} recording${s.recordingCount === 1 ? '' : 's'}`
                          : `${s.photoCount || 0} photo${s.photoCount === 1 ? '' : 's'}`}
                        {s.location ? ` · ${s.location}` : ''}
                      </p>
                    </div>
                  </div>

                  <StatusPill tone={TONE[s.status]}>{LABEL[s.status]}</StatusPill>
                </button>
              )
            }}
          />
        </div>
      </main>
    </div>
  )
}
