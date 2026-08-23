import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, EyeOff, Loader2, Merge, ScanFace, Split, Users, Video } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import { cardImage, seenIn } from '../../lib/clusterCard'
import EmptyState from '../../components/EmptyState'
import {
  acceptSuggestions,
  getClusters,
  mediaUrl,
  mergeClusters,
  splitFaces,
  tagCluster,
} from '../../lib/api'

const FIELD_CLASS =
  'mt-3 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

const TAG_TONE = { TAGGED: 'success', UNKNOWN: 'neutral', SKIPPED: 'neutral', NOT_A_FACE: 'neutral' }
const TAG_LABEL = { UNKNOWN: 'Unknown person', SKIPPED: 'Skipped', NOT_A_FACE: 'Not a face' }

// The select is built from the session roster and nothing else — the full subject
// DB is never offered here, which is what stops an agent tagging a face with
// someone who was never in the room (and never consented).

function ClusterCard({
  sessionId,
  cluster,
  roster,
  onTag,
  onSplit,
  busy,
  selected,
  onToggleSelect,
  forceDropdown = false,
}) {
  const [splitting, setSplitting] = useState(false)
  const [pickedFaces, setPickedFaces] = useState([])
  const [showDropdown, setShowDropdown] = useState(forceDropdown)

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

  const toggleFace = (faceId) =>
    setPickedFaces((prev) =>
      prev.includes(faceId) ? prev.filter((id) => id !== faceId) : [...prev, faceId],
    )

  const confirmSplit = async () => {
    await onSplit(cluster.id, pickedFaces)
    setPickedFaces([])
    setSplitting(false)
  }

  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="relative overflow-hidden rounded-lg bg-canvas">
        <img
          src={cardImage(sessionId, cluster)}
          alt={cluster.faceCount > 0 ? 'Detected face' : 'Detected face, from video'}
          loading="lazy"
          className="aspect-square w-full object-cover"
        />
        {cluster.videoTrackCount > 0 && (
          <span
            className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-ink/80 px-1.5 py-1 text-[11px] font-semibold text-white"
            title={`This person also appears in ${cluster.videoTrackCount} video clip${cluster.videoTrackCount === 1 ? '' : 's'}`}
          >
            <Video size={12} strokeWidth={2.5} />
            {cluster.videoTrackCount}
          </span>
        )}
        {onToggleSelect && (
          <label className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-surface/90 shadow-card">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(cluster.id)}
              aria-label="Select this face group"
            />
          </label>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-ink-faint">{seenIn(cluster)}</p>
        {cluster.tagStatus !== 'PENDING' && (
          <StatusPill tone={TAG_TONE[cluster.tagStatus]}>
            {cluster.tagStatus === 'TAGGED'
              ? (tagged?.fullName ?? 'Tagged')
              : TAG_LABEL[cluster.tagStatus]}
          </StatusPill>
        )}
      </div>

      {cluster.autoTagged && cluster.matchScore != null && (
        <p className="mt-1 text-xs font-medium text-ink-faint">
          Auto-matched at {cluster.matchScore.toFixed(2)}
        </p>
      )}

      {showDropdown ? (
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
      ) : (
        <button
          onClick={() => setShowDropdown(true)}
          className="mt-3 w-full rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Change
        </button>
      )}

      {/* A face is redacted by being left untagged, which makes "I decided this
          person is a bystander" and "I ran out of time" identical in the UI and in
          the audit log. This makes the decision an explicit act. */}
      {cluster.tagStatus !== 'UNKNOWN' && (
        <button
          onClick={() => onTag(cluster.id, { tagStatus: 'UNKNOWN' })}
          disabled={busy}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
        >
          <EyeOff size={13} strokeWidth={2} /> Not a participant — redact
        </button>
      )}

      {cluster.faces.length > 1 && (
        <div className="mt-3 border-t border-border pt-3">
          {!splitting ? (
            <button
              onClick={() => setSplitting(true)}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Split size={13} strokeWidth={2} /> Wrong person mixed in?
            </button>
          ) : (
            <>
              <p className="text-xs font-semibold text-ink">
                Pick the faces that aren&apos;t this person
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {cluster.faces.map((face) => (
                  <button
                    key={face.id}
                    onClick={() => toggleFace(face.id)}
                    className={`h-12 w-12 overflow-hidden rounded-md border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                      pickedFaces.includes(face.id) ? 'border-brand' : 'border-transparent'
                    }`}
                  >
                    <img
                      src={mediaUrl.faceCrop(sessionId, face.id)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={confirmSplit}
                  disabled={busy || pickedFaces.length === 0}
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                >
                  Split off {pickedFaces.length}
                </button>
                <button
                  onClick={() => {
                    setSplitting(false)
                    setPickedFaces([])
                  }}
                  className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function Tagging() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])

  const reload = useCallback(
    () => getClusters(sessionId).then(setData).catch(setError),
    [sessionId],
  )

  useEffect(() => {
    reload()
  }, [reload])

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const handleTag = (clusterId, payload) => run(() => tagCluster(sessionId, clusterId, payload))
  const handleSplit = (clusterId, faceIds) => run(() => splitFaces(sessionId, clusterId, faceIds))

  const handleMerge = () =>
    run(async () => {
      await mergeClusters(sessionId, selectedIds)
      setSelectedIds([])
    })

  const toggleSelect = (clusterId) =>
    setSelectedIds((prev) =>
      prev.includes(clusterId) ? prev.filter((id) => id !== clusterId) : [...prev, clusterId],
    )

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

  const suggested = data.clusters.filter((c) => c.tagStatus === 'PENDING' && c.suggestedSubjectId)
  const unidentified = data.clusters.filter(
    (c) => c.tagStatus === 'PENDING' && !c.suggestedSubjectId,
  )
  const autoTagged = data.clusters.filter((c) => c.tagStatus === 'TAGGED' && c.autoTagged)
  const manuallyDone = data.clusters.filter((c) => c.tagStatus !== 'PENDING' && !c.autoTagged)

  // Only the two sections that still need a human block the next step — an
  // auto-tag is already TAGGED, and stays overridable right up to finalize.
  const pending = suggested.length + unidentified.length

  const handleAcceptAll = () =>
    run(() => acceptSuggestions(sessionId, suggested.map((c) => c.id)))

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Who is this?"
          subtitle={`${data.clusters.length - pending} of ${data.clusters.length} face groups resolved. Names come from this session's roster only.`}
          action={
            <div className="flex items-center gap-3">
              <Link
                to={`/sessions/${sessionId}/people`}
                className="flex items-center gap-2 rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Users size={16} strokeWidth={2} /> People view
              </Link>
              <button
                onClick={() => navigate(`/sessions/${sessionId}/review`)}
                disabled={busy || pending > 0 || data.status !== 'TAGGING'}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <CheckCircle2 size={16} strokeWidth={2} />
                {pending > 0 ? `${pending} left to tag` : 'Review photos →'}
              </button>
            </div>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {selectedIds.length > 1 && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-lg bg-brand-soft px-4 py-2.5">
            <p className="text-sm font-semibold text-brand">
              {selectedIds.length} face groups selected
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleMerge}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
              >
                <Merge size={14} strokeWidth={2} /> Merge — same person
              </button>
              <button
                onClick={() => setSelectedIds([])}
                className="rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Clear
              </button>
            </div>
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
          <>
            {suggested.length > 0 && (
              <section className="mt-8">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold text-ink">Confirm these</h2>
                    <p className="text-xs font-medium text-ink-faint">
                      Recognised, but not confidently enough to tag without you.
                    </p>
                  </div>
                  <button
                    onClick={handleAcceptAll}
                    disabled={busy}
                    className="rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    Accept all {suggested.length} suggestion{suggested.length === 1 ? '' : 's'}
                  </button>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {suggested.map((cluster) => (
                    <div key={cluster.id}>
                      <ClusterCard
                        sessionId={sessionId}
                        cluster={cluster}
                        roster={data.roster}
                        onTag={handleTag}
                        onSplit={handleSplit}
                        busy={busy}
                        selected={selectedIds.includes(cluster.id)}
                        onToggleSelect={toggleSelect}
                      />
                      <button
                        onClick={() =>
                          handleTag(cluster.id, {
                            tagStatus: 'TAGGED',
                            subjectId: cluster.suggestedSubjectId,
                          })
                        }
                        disabled={busy}
                        className="mt-2 w-full rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
                      >
                        Yes, {cluster.suggestedName ?? 'confirm'}
                        {cluster.matchScore != null && ` (${cluster.matchScore.toFixed(2)})`}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {unidentified.length > 0 && (
              <section className="mt-8">
                <h2 className="text-base font-bold text-ink">Unidentified</h2>
                <p className="text-xs font-medium text-ink-faint">
                  No enrolled photo matched these faces — tag them from the roster.
                </p>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {unidentified.map((cluster) => (
                    <ClusterCard
                      key={cluster.id}
                      sessionId={sessionId}
                      cluster={cluster}
                      roster={data.roster}
                      onTag={handleTag}
                      onSplit={handleSplit}
                      busy={busy}
                      selected={selectedIds.includes(cluster.id)}
                      onToggleSelect={toggleSelect}
                      forceDropdown
                    />
                  ))}
                </div>
              </section>
            )}

            {autoTagged.length > 0 && (
              <details className="mt-8 rounded-card bg-surface p-4 shadow-card" open>
                <summary className="cursor-pointer text-base font-bold text-ink">
                  Auto-tagged ({autoTagged.length}) — review and override
                </summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {autoTagged.map((cluster) => (
                    <ClusterCard
                      key={cluster.id}
                      sessionId={sessionId}
                      cluster={cluster}
                      roster={data.roster}
                      onTag={handleTag}
                      onSplit={handleSplit}
                      busy={busy}
                      selected={selectedIds.includes(cluster.id)}
                      onToggleSelect={toggleSelect}
                    />
                  ))}
                </div>
              </details>
            )}

            {manuallyDone.length > 0 && (
              <details className="mt-6 rounded-card bg-surface p-4 shadow-card">
                <summary className="cursor-pointer text-base font-bold text-ink">
                  Tagged by you ({manuallyDone.length})
                </summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {manuallyDone.map((cluster) => (
                    <ClusterCard
                      key={cluster.id}
                      sessionId={sessionId}
                      cluster={cluster}
                      roster={data.roster}
                      onTag={handleTag}
                      onSplit={handleSplit}
                      busy={busy}
                      selected={selectedIds.includes(cluster.id)}
                      onToggleSelect={toggleSelect}
                    />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </main>
    </div>
  )
}
