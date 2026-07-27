import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Trash2, PlayCircle, Eye, Loader2, ShieldAlert, Images } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listDsar, getDsar, runDsarDiscovery, executeDsar, requestRawMedia, getDsarMedia } from '../../lib/api'

const STATUS_TONE = {
  RECEIVED: 'neutral', TRIAGE: 'neutral', DISCOVERY: 'warning',
  EXECUTING: 'warning', REVIEW: 'brand', CLOSED: 'success', REJECTED: 'danger',
}
const MIN_JUSTIFICATION = 20
const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

// Matrix §C: raw media may only be viewed against a specific, open DSAR request
// and a written justification of at least 20 characters. This modal is the one
// place in the app that can request it, and it will not submit without both.
function BreakGlassModal({ dsarRequestId, sessionId, photoId, onClose }) {
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)

  const canSubmit = Boolean(dsarRequestId) && justification.trim().length >= MIN_JUSTIFICATION

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const url = await requestRawMedia(sessionId, photoId, {
        dsarRequestId,
        justification: justification.trim(),
      })
      setPreviewUrl(url)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-card bg-surface p-6 shadow-card">
        <div className="flex items-start gap-3">
          <ShieldAlert size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-danger" />
          <div>
            <h2 className="text-base font-bold text-ink">Break-glass: view original media</h2>
            <p className="mt-1 text-xs font-medium text-ink-faint">
              This decrypts unredacted media, is logged as an AccessEvent, and notifies the DPO.
              It is only possible against a DSAR request in Discovery or Executing.
            </p>
          </div>
        </div>

        <p className="mt-4 text-xs font-semibold text-ink-muted">
          DSAR request: <span className="font-mono text-ink">{dsarRequestId}</span>
        </p>
        <p className="text-xs font-semibold text-ink-muted">
          Object: session {sessionId} · photo {photoId}
        </p>

        {!previewUrl ? (
          <form onSubmit={submit}>
            <label className="mt-3 block text-sm font-semibold text-ink">
              Justification (min {MIN_JUSTIFICATION} characters)
              <textarea
                className={`${FIELD_CLASS} min-h-24 resize-y`}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why does resolving this DSAR require seeing the unredacted original?"
              />
            </label>
            <p className="mt-1 text-xs font-medium text-ink-faint">
              {justification.trim().length}/{MIN_JUSTIFICATION}
            </p>

            {error && (
              <p className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
                {error.message}
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit || busy}
                className="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} strokeWidth={2} />}
                Decrypt and view
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4">
            <img src={previewUrl} alt="Unredacted original" className="max-h-96 w-full rounded-lg object-contain" />
            <button
              onClick={close}
              className="mt-4 w-full rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// A named frame picker for break-glass, scoped to this request's own subject.
// Before this endpoint existed the only way to reach BreakGlassModal was to
// run discovery first and copy a sessionId/photoId out of its location rows —
// this lists the same frames directly, without depending on discovery having run.
function MediaBrowser({ requestId, onPick }) {
  const [media, setMedia] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setMedia(null)
    setError(null)
    getDsarMedia(requestId).then(setMedia).catch(setError)
  }, [requestId])

  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">
        Subject media{media ? ` — ${media.items.length} frame${media.items.length === 1 ? '' : 's'}` : ''}
      </p>

      {error && <p className="mt-2 text-xs font-semibold text-danger">{error.message}</p>}

      {!media && !error && <Loader2 size={16} className="mt-3 animate-spin text-ink-faint" />}

      {media && media.items.length === 0 && (
        <p className="mt-2 text-xs font-medium text-ink-faint">No photos are linked to this subject.</p>
      )}

      {media && media.items.length > 0 && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Session</th>
                <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Project</th>
                <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Taken</th>
                <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Subjects on frame</th>
                <th className="py-1.5 font-bold uppercase tracking-wide"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {media.items.map((item) => (
                <tr key={item.photoId}>
                  <td className="py-1.5 pr-3 font-mono text-ink-muted">{item.sessionCode}</td>
                  <td className="py-1.5 pr-3 text-ink">{item.project?.name}</td>
                  <td className="py-1.5 pr-3 text-ink-muted">
                    {item.takenAt ? new Date(item.takenAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-muted">{item.subjectsOnPhoto}</td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => onPick({ sessionId: item.sessionId, photoId: item.photoId })}
                      className="flex items-center gap-1 rounded-lg bg-canvas px-2 py-1 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <Eye size={12} strokeWidth={2} /> Break-glass
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RequestDetail({ requestId, onChanged }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [discovery, setDiscovery] = useState(null)
  const [execResult, setExecResult] = useState(null)
  const [breakGlassTarget, setBreakGlassTarget] = useState(null)
  const [showMedia, setShowMedia] = useState(false)

  const reload = useCallback(() => {
    setDetail(null)
    setError(null)
    getDsar(requestId).then(setDetail).catch(setError)
  }, [requestId])

  useEffect(() => {
    setDiscovery(null)
    setExecResult(null)
    reload()
  }, [reload])

  const runDiscovery = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await runDsarDiscovery(requestId)
      setDiscovery(result.discovery)
      await reload()
      onChanged?.()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const runExecute = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await executeDsar(requestId)
      setExecResult(result)
      await reload()
      onChanged?.()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!detail && !error) return <Loader2 size={18} className="mt-4 animate-spin text-ink-faint" />

  return (
    <div className="mt-4 rounded-card bg-surface p-6 shadow-card">
      {error && (
        <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          {error.message}
        </p>
      )}

      {detail && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-ink">
              {detail.type} — {(detail.subjectRef ?? detail.subjectId)}
            </h2>
            <StatusPill tone={STATUS_TONE[detail.status]}>{detail.status}</StatusPill>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={runDiscovery}
              disabled={busy || !['RECEIVED', 'TRIAGE', 'DISCOVERY'].includes(detail.status)}
              className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <PlayCircle size={14} strokeWidth={2} /> Run discovery
            </button>
            <button
              onClick={runExecute}
              disabled={busy || !['DISCOVERY', 'EXECUTING'].includes(detail.status)}
              className="flex items-center gap-1.5 rounded-lg bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
            >
              <Trash2 size={14} strokeWidth={2} /> Execute purge
            </button>
            <button
              onClick={() => setShowMedia((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Images size={14} strokeWidth={2} /> {showMedia ? 'Hide media' : 'Browse media'}
            </button>
          </div>

          {showMedia && <MediaBrowser requestId={requestId} onPick={setBreakGlassTarget} />}

          {discovery && (
            <div className="mt-5 border-t border-border pt-4">
              <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">
                Discovery — {discovery.counts.total} location{discovery.counts.total === 1 ? '' : 's'}
              </p>
              <div className="mt-2 max-h-64 overflow-y-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="text-ink-faint">
                    <tr>
                      <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Location</th>
                      <th className="py-1.5 pr-3 font-bold uppercase tracking-wide">Object</th>
                      <th className="py-1.5 font-bold uppercase tracking-wide"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {discovery.locations.map((loc, i) => (
                      <tr key={i}>
                        <td className="py-1.5 pr-3 font-mono text-ink-muted">{loc.locationCode}</td>
                        <td className="py-1.5 pr-3 text-ink">{loc.objectType}</td>
                        <td className="py-1.5 text-right">
                          {loc.sessionId && loc.objectId && (
                            <button
                              onClick={() =>
                                setBreakGlassTarget({ sessionId: loc.sessionId, photoId: loc.objectId })
                              }
                              className="flex items-center gap-1 rounded-lg bg-canvas px-2 py-1 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                              <Eye size={12} strokeWidth={2} /> Break-glass
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {execResult && (
            <div className="mt-5 border-t border-border pt-4 text-xs font-medium text-ink-muted">
              {execResult.purgeJob ? (
                <p>
                  Purge job {execResult.purgeJob.status}
                  {execResult.certificateId && ` — certificate ${execResult.certificateId}`}
                </p>
              ) : execResult.package ? (
                <p>Access package built.</p>
              ) : (
                <p>Request moved to {execResult.request?.status ?? 'REVIEW'}.</p>
              )}
            </div>
          )}
        </>
      )}

      {breakGlassTarget && (
        <BreakGlassModal
          dsarRequestId={requestId}
          sessionId={breakGlassTarget.sessionId}
          photoId={breakGlassTarget.photoId}
          onClose={() => setBreakGlassTarget(null)}
        />
      )}
    </div>
  )
}

export default function PurgeExport() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [requests, setRequests] = useState(null)
  const [error, setError] = useState(null)
  const selectedId = searchParams.get('requestId') ?? ''

  const reload = useCallback(() => {
    Promise.all([listDsar({ type: 'ERASE' }), listDsar({ type: 'WITHDRAWAL_ERASURE' })])
      .then(([a, b]) => setRequests([...a.items, ...b.items]))
      .catch(setError)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Purge / Export"
          subtitle="Erasure requests: run discovery, then execute the purge. Viewing an unredacted original requires break-glass justification."
        />

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Erasure requests"
            rows={requests ?? []}
            loading={!requests && !error}
            emptyTitle="No erasure requests"
            renderRow={(r) => (
              <button
                onClick={() => setSearchParams({ requestId: r.id })}
                className={`flex w-full items-center justify-between gap-4 py-4 text-left first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  r.id === selectedId ? 'text-brand' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    {(r.subjectRef ?? r.subjectId)} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    SLA due {new Date(r.sla.dueAt).toLocaleDateString()}
                  </p>
                </div>
                <StatusPill tone={r.sla.breached ? 'danger' : STATUS_TONE[r.status]}>
                  {r.sla.breached ? 'SLA breached' : r.status}
                </StatusPill>
              </button>
            )}
          />
        </div>

        {selectedId && <RequestDetail requestId={selectedId} onChanged={reload} />}
      </main>
    </div>
  )
}
