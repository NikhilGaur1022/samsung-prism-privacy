import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, EyeOff, Loader2, ScanFace, Users, X } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import {
  acceptSuggestions,
  getPeople,
  getPersonPhotos,
  mediaUrl,
  tagCluster,
} from '../../lib/api'

const SOURCE_TONE = { AUTO: 'brand', MANUAL: 'neutral', MIXED: 'neutral' }
const SOURCE_LABEL = { AUTO: 'Auto-matched', MANUAL: 'Tagged by you', MIXED: 'Auto + manual' }

function PersonCard({ sessionId, person, onOpen }) {
  return (
    <button
      onClick={() => onOpen(person.subjectId)}
      className="flex flex-col items-center gap-2 rounded-card bg-surface p-4 text-center shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <div className="h-24 w-24 overflow-hidden rounded-full bg-canvas">
        {person.coverFaceId && (
          <img
            src={mediaUrl.faceCrop(sessionId, person.coverFaceId)}
            alt={person.fullName}
            loading="lazy"
            className="aspect-square h-full w-full object-cover"
          />
        )}
      </div>
      <p className="w-full truncate text-sm font-semibold text-ink">{person.fullName}</p>
      <p className="text-xs font-medium text-ink-faint">
        {person.photoCount} photo{person.photoCount === 1 ? '' : 's'}
      </p>
      <StatusPill tone={SOURCE_TONE[person.source]}>{SOURCE_LABEL[person.source]}</StatusPill>
    </button>
  )
}

function SuggestionCard({ sessionId, item, roster, onConfirm, onReject, onRedact, busy }) {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <div className="overflow-hidden rounded-lg bg-canvas">
        <img
          src={mediaUrl.faceCrop(sessionId, item.repFaceId)}
          alt="Detected face"
          loading="lazy"
          className="aspect-square w-full object-cover"
        />
      </div>

      <p className="mt-3 text-sm font-semibold text-ink">
        {item.suggestedName ? `Is this ${item.suggestedName}?` : 'Who is this?'}
      </p>
      <p className="mt-0.5 text-xs font-medium text-ink-faint">
        Seen in {item.faceCount} photo{item.faceCount === 1 ? '' : 's'}
        {item.matchScore != null && ` · match ${item.matchScore.toFixed(2)}`}
      </p>

      {item.suggestedSubjectId ? (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => onConfirm(item.clusterId)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            <Check size={14} strokeWidth={2} /> Yes
          </button>
          <button
            onClick={() => onReject(item.clusterId)}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X size={14} strokeWidth={2} /> Someone else
          </button>
        </div>
      ) : (
        <select
          className="mt-3 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && onReject(item.clusterId, e.target.value)}
        >
          <option value="" disabled>
            Who is this?
          </option>
          {roster.map((person) => (
            <option key={person.masterUserId} value={person.masterUserId}>
              {person.fullName}
            </option>
          ))}
          <option value="UNKNOWN">Unknown person</option>
        </select>
      )}

      {/* Explicit, and destructive-styled, because the consequence is real: this
          face gets blurred out of every photo at finalize. Leaving it untagged
          does the same thing silently, which is the problem. */}
      <button
        onClick={() => onRedact(item.clusterId)}
        disabled={busy}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
      >
        <EyeOff size={13} strokeWidth={2} /> Not a participant — redact
      </button>
    </div>
  )
}

function PersonPhotos({ sessionId, subjectId, name, onBack }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setData(null)
    getPersonPhotos(sessionId, subjectId).then(setData).catch(setError)
  }, [sessionId, subjectId])

  return (
    <div className="mt-6">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm font-semibold text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <ArrowLeft size={16} strokeWidth={2} /> All people
      </button>

      {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

      {!data ? (
        <Loader2 size={20} className="mt-6 animate-spin text-ink-faint" />
      ) : (
        <>
          <h2 className="mt-4 text-lg font-bold text-ink">
            {name} — {data.photos.length} photo{data.photos.length === 1 ? '' : 's'}
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.photos.map((photo) => (
              <div key={photo.id} className="rounded-card bg-surface p-3 shadow-card">
                <img
                  src={mediaUrl.personRedacted(sessionId, subjectId, photo.id)}
                  alt=""
                  loading="lazy"
                  className="w-full rounded-lg object-cover"
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function People() {
  const { sessionId } = useParams()
  const [params, setParams] = useSearchParams()
  const selected = params.get('person')

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    () => getPeople(sessionId).then(setData).catch(setError),
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

  const handleConfirm = (clusterId) => run(() => acceptSuggestions(sessionId, [clusterId]))

  const handleReject = (clusterId, subjectId) =>
    run(() =>
      tagCluster(
        sessionId,
        clusterId,
        subjectId && subjectId !== 'UNKNOWN'
          ? { tagStatus: 'TAGGED', subjectId }
          : { tagStatus: 'UNKNOWN' },
      ),
    )

  const handleRedact = (clusterId) =>
    run(() => tagCluster(sessionId, clusterId, { tagStatus: 'UNKNOWN' }))

  const handleAcceptAll = () => {
    const ids = data.pending.filter((p) => p.suggestedSubjectId).map((p) => p.clusterId)
    if (ids.length) run(() => acceptSuggestions(sessionId, ids))
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

  const suggestable = data.pending.filter((p) => p.suggestedSubjectId)
  const selectedPerson = data.people.find((p) => p.subjectId === selected)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="People in this session"
          subtitle={`${data.counts.autoTagged} auto-matched · ${data.counts.suggested} to confirm · ${data.counts.unidentified} unidentified`}
          action={
            <Link
              to={`/sessions/${sessionId}/tagging`}
              className="flex items-center gap-2 rounded-lg bg-canvas px-4 py-2.5 text-sm font-semibold text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <ScanFace size={16} strokeWidth={2} /> Tagging view
            </Link>
          }
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {selectedPerson ? (
          <PersonPhotos
            sessionId={sessionId}
            subjectId={selectedPerson.subjectId}
            name={selectedPerson.fullName}
            onBack={() => setParams({})}
          />
        ) : (
          <>
            {data.pending.length > 0 && (
              <section className="mt-8">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-bold text-ink">Confirm these</h2>
                  {suggestable.length > 0 && (
                    <button
                      onClick={handleAcceptAll}
                      disabled={busy}
                      className="rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      Accept all {suggestable.length} suggestion
                      {suggestable.length === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {data.pending.map((item) => (
                    <SuggestionCard
                      key={item.clusterId}
                      sessionId={sessionId}
                      item={item}
                      roster={data.roster}
                      onConfirm={handleConfirm}
                      onReject={handleReject}
                      onRedact={handleRedact}
                      busy={busy}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="mt-8">
              <h2 className="text-base font-bold text-ink">Identified people</h2>
              {data.people.length === 0 ? (
                <div className="mt-4 rounded-card bg-surface p-6 shadow-card">
                  <EmptyState
                    icon={Users}
                    title="Nobody identified yet"
                    message="Confirm the suggestions above, or tag faces manually."
                  />
                </div>
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
                  {data.people.map((person) => (
                    <PersonCard
                      key={person.subjectId}
                      sessionId={sessionId}
                      person={person}
                      onOpen={(id) => setParams({ person: id })}
                    />
                  ))}
                </div>
              )}
            </section>

            {data.roster.some((r) => !r.enrolled) && (
              <p className="mt-6 text-xs font-medium text-ink-faint">
                {data.roster.filter((r) => !r.enrolled).length} person(s) on this roster have no
                enrolled photo and can only be tagged manually.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
