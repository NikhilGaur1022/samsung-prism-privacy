import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, Loader2, ScanFace } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import { finalizeSession, getClusters, mediaUrl, tagCluster } from '../../lib/api'

const FIELD_CLASS =
  'mt-3 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const TAG_TONE = { TAGGED: 'success', UNKNOWN: 'neutral', SKIPPED: 'neutral', NOT_A_FACE: 'neutral' }
const TAG_LABEL = { UNKNOWN: 'Unknown person', SKIPPED: 'Skipped', NOT_A_FACE: 'Not a face' }

// The select is built from the session roster and nothing else — the full subject
// DB is never offered here, which is what stops an agent tagging a face with
// someone who was never in the room (and never consented).
function ClusterCard({ sessionId, cluster, roster, onTag, busy }) {
  const value = cluster.tagStatus === 'TAGGED' ? cluster.taggedSubjectId : cluster.tagStatus
  const tagged = roster.find((r) => r.masterUserId === cluster.taggedSubjectId)

  const handleChange = (e) => {
    const next = e.target.value
    if (!next) return
    if (['UNKNOWN', 'SKIPPED', 'NOT_A_FACE'].includes(next)) {
      onTag(cluster.id, { tagStatus: next })
    } else {
      onTag(cluster.id, { tagStatus: 'TAGGED', subjectId: next })
    }
  }

  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="overflow-hidden rounded-lg bg-canvas">
        <img
          src={mediaUrl.faceCrop(sessionId, cluster.repFaceId)}
          alt="Detected face"
          className="aspect-square w-full object-cover"
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-faint">
          Seen in {cluster.faceCount} photo{cluster.faceCount === 1 ? '' : 's'}
        </p>
        {cluster.tagStatus !== 'PENDING' && (
          <StatusPill tone={TAG_TONE[cluster.tagStatus]}>
            {cluster.tagStatus === 'TAGGED' ? (tagged?.fullName ?? 'Tagged') : TAG_LABEL[cluster.tagStatus]}
          </StatusPill>
        )}
      </div>

      <select className={FIELD_CLASS} value={value ?? ''} onChange={handleChange} disabled={busy}>
        <option value="" disabled>
          Who is this?
        </option>
        {roster.map((person) => (
          <option key={person.masterUserId} value={person.masterUserId}>
            {person.fullName}
          </option>
        ))}
        <option value="UNKNOWN">Unknown person</option>
        <option value="SKIPPED">Skip</option>
        <option value="NOT_A_FACE">Not a face</option>
      </select>
    </div>
  )
}

export default function Tagging() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    () => getClusters(sessionId).then(setData).catch(setError),
    [sessionId],
  )

  useEffect(() => {
    reload()
  }, [reload])

  const handleTag = async (clusterId, payload) => {
    setBusy(true)
    setError(null)
    try {
      await tagCluster(sessionId, clusterId, payload)
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleFinalize = async () => {
    setBusy(true)
    setError(null)
    try {
      await finalizeSession(sessionId)
      navigate('/sessions')
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 px-10 py-8">
          {error ? (
            <p className="text-sm font-semibold text-danger">{error.message}</p>
          ) : (
            <Loader2 size={20} className="animate-spin text-ink-faint" />
          )}
        </main>
      </div>
    )
  }

  const pending = data.clusters.filter((c) => c.tagStatus === 'PENDING').length
  const done = data.clusters.length - pending

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Who is this?"
          subtitle={`${done} of ${data.clusters.length} face groups tagged. Names come from this session's roster only.`}
          action={
            <button
              onClick={handleFinalize}
              disabled={busy || pending > 0 || data.status !== 'TAGGING'}
              className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <CheckCircle2 size={16} strokeWidth={2} />
              {pending > 0 ? `${pending} left to tag` : 'Finalize & archive'}
            </button>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {data.clusters.length === 0 ? (
          <div className="mt-6 rounded-card bg-surface p-6 shadow-card">
            <EmptyState
              icon={ScanFace}
              title="No faces detected"
              message="Nothing to tag in this session's photos."
            />
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.clusters.map((cluster) => (
              <ClusterCard
                key={cluster.id}
                sessionId={sessionId}
                cluster={cluster}
                roster={data.roster}
                onTag={handleTag}
                busy={busy}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
