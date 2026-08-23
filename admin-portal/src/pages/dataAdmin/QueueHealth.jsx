import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Activity, Loader2, RefreshCw, CheckCircle2 } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import { getQueueHealth, requeueStalled } from '../../lib/api'
import { blockedFrameCount } from '../../lib/photoState.js'
import { useAuth } from '../../auth'

// The screen that did not exist.
//
// Session COL-7224 sat PROCESSING for two days and the oldest unredacted photo
// for sixteen, and there was no reaper, no surfaced stalled-job timeout, and
// nothing anywhere that would have shown either. Worse, the counters that DID
// exist reported zero throughout, because they enumerated DEFERRED and FAILED
// while the real stuck state is PENDING.
//
// So this page reads its numbers from the same predicate the pipeline now uses
// (lib/photoState.js), which is what makes the screen and the gate agree.

const POLL_MS = 15_000

function humanDuration(ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function Tile({ label, value, tone = 'neutral', detail }) {
  const toneClass =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'ok'
          ? 'text-success'
          : 'text-ink'
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <p className={`text-2xl font-extrabold tabular-nums tracking-tight ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      {detail && <p className="mt-1 text-xs font-medium text-ink-muted">{detail}</p>}
    </div>
  )
}

export default function QueueHealth() {
  // The DPO reads this page for accountability but does not operate the
  // platform, so the sweep trigger is hidden for that role rather than shown and
  // then 403d by the server.
  const { admin } = useAuth() ?? {}
  const canSweep = ['dataAdmin', 'super_admin'].includes(admin?.role)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [requeueing, setRequeueing] = useState(false)
  const timer = useRef(null)

  const load = useCallback(async () => {
    try {
      setData(await getQueueHealth())
      setError(null)
    } catch (err) {
      setError(err)
    }
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, POLL_MS)
    return () => clearInterval(timer.current)
  }, [load])

  async function onRequeue() {
    setRequeueing(true)
    try {
      await requeueStalled()
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setRequeueing(false)
    }
  }

  const pipeline = data?.pipeline
  const oldestUnresolvedMs = pipeline?.oldestUnresolved?.ageMs ?? null
  const staleThresholdMs = 24 * 60 * 60 * 1000

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Queue health"
          subtitle="What the pipeline is doing right now, and what has stopped doing it."
          action={
            <button
              type="button"
              onClick={onRequeue}
              disabled={requeueing || !canSweep}
              hidden={!canSweep}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
              title="Runs a reaper sweep now instead of waiting for the interval"
            >
              {requeueing ? (
                <Loader2 size={15} className="animate-spin" strokeWidth={2} />
              ) : (
                <RefreshCw size={15} strokeWidth={2} />
              )}
              Sweep now
            </button>
          }
        />

        {error && (
          <div className="mt-5 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            <AlertTriangle size={15} strokeWidth={2} className="mt-px shrink-0" />
            {error.message}
          </div>
        )}

        {!data && !error ? (
          <div className="mt-8">
            <Loader2 size={18} className="animate-spin text-ink-faint" />
          </div>
        ) : !data ? null : (
          <>
            {/* The four numbers that would have caught the two-day stall. */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                label="Frames awaiting redaction"
                value={pipeline.unresolvedPhotos}
                tone={pipeline.unresolvedPhotos > 0 ? 'warning' : 'ok'}
                detail={
                  pipeline.oldestUnresolved
                    ? `oldest ${humanDuration(oldestUnresolvedMs)}`
                    : 'nothing outstanding'
                }
              />
              <Tile
                label="Sessions redacting"
                value={pipeline.redactingSessions}
                tone={pipeline.redactingSessions > 0 ? 'warning' : 'ok'}
                detail="committed, not yet handed off"
              />
              <Tile
                label="Recognition running"
                value={pipeline.runningRecognition}
                tone={
                  (pipeline.oldestRunningRecognition?.ageMs ?? 0) > 60 * 60_000 ? 'danger' : 'neutral'
                }
                detail={
                  pipeline.oldestRunningRecognition
                    ? `oldest ${humanDuration(pipeline.oldestRunningRecognition.ageMs)}`
                    : 'idle'
                }
              />
              <Tile
                label="Stalled jobs"
                value={data.stalledJobs.length}
                tone={data.stalledJobs.length > 0 ? 'danger' : 'ok'}
                detail="unresolved"
              />
            </div>

            {oldestUnresolvedMs !== null && oldestUnresolvedMs > staleThresholdMs && (
              <div className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
                <AlertTriangle size={15} strokeWidth={2} className="mt-px shrink-0" />
                <span>
                  A frame has been waiting {humanDuration(oldestUnresolvedMs)} for redaction. Until
                  it clears, its session cannot be handed off and it cannot appear in an export.
                </span>
              </div>
            )}

            {/* Queues */}
            <h2 className="mt-8 text-sm font-semibold text-ink">Queues</h2>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {data.queues.map((q) => (
                <div key={q.name} className="rounded-card bg-surface p-5 shadow-card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm font-semibold text-ink">{q.name}</p>
                    <StatusPill tone={q.reachable ? 'success' : 'danger'}>
                      {q.reachable ? 'reachable' : 'UNREACHABLE'}
                    </StatusPill>
                  </div>
                  {!q.reachable ? (
                    <p className="mt-3 text-sm font-medium text-danger">
                      Redis is not answering. The API keeps serving while every deferred job
                      silently stops being retried — this is the failure that looks like nothing is
                      wrong.
                    </p>
                  ) : (
                    <>
                      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm sm:grid-cols-6">
                        {['waiting', 'active', 'delayed', 'failed', 'completed', 'paused'].map((k) => (
                          <div key={k}>
                            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                              {k}
                            </dt>
                            <dd
                              className={`mt-0.5 text-base font-bold tabular-nums ${
                                k === 'failed' && q.counts[k] > 0 ? 'text-danger' : 'text-ink'
                              }`}
                            >
                              {q.counts[k] ?? 0}
                            </dd>
                          </div>
                        ))}
                      </dl>
                      {/* Depth alone does not separate "busy" from "wedged". A
                          queue of 3 that has not moved in an hour is the
                          emergency; a queue of 300 draining steadily is not. */}
                      <p className="mt-3 text-xs font-medium text-ink-muted">
                        oldest waiting {humanDuration(q.oldestWaitingMs)} · oldest active{' '}
                        {humanDuration(q.oldestActiveMs)}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>

            {/* Workers */}
            <h2 className="mt-8 text-sm font-semibold text-ink">
              Worker reachability{' '}
              <span className="font-medium text-ink-faint">(this API instance&apos;s view)</span>
            </h2>
            <div className="mt-3 rounded-card bg-surface p-5 shadow-card">
              {Object.keys(data.workerBreakers).length === 0 ? (
                <p className="text-sm font-medium text-ink-faint">
                  No worker calls have been made from this instance yet.
                </p>
              ) : (
                <ul className="flex flex-wrap gap-3">
                  {Object.entries(data.workerBreakers).map(([name, b]) => (
                    <li key={name} className="flex items-center gap-2">
                      <StatusPill tone={b.open ? 'danger' : b.failures > 0 ? 'warning' : 'success'}>
                        {name}
                      </StatusPill>
                      <span className="text-xs font-medium text-ink-muted">
                        {b.open ? 'circuit open' : `${b.failures} recent failure(s)`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Stalled */}
            <h2 className="mt-8 text-sm font-semibold text-ink">Stalled jobs</h2>
            <div className="mt-3 rounded-card bg-surface p-5 shadow-card">
              {data.stalledJobs.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Nothing stalled"
                  message="Every job the queues have handed out is either running or finished."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {data.stalledJobs.map((job) => (
                    <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-semibold text-ink">
                          {job.queueName} · {job.jobId}
                        </p>
                        <p className="mt-0.5 text-xs font-medium text-ink-muted">
                          detected {new Date(job.detectedAt).toLocaleString()}
                          {job.stalledForMs ? ` · stalled ${humanDuration(job.stalledForMs)}` : ''}
                          {job.attempts ? ` · ${job.attempts} requeue(s)` : ''}
                        </p>
                        {job.lastError && (
                          <p className="mt-1 text-xs font-medium text-danger">{job.lastError}</p>
                        )}
                      </div>
                      <StatusPill tone={job.state === 'REQUEUED' ? 'warning' : 'danger'}>
                        {job.state}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Storage */}
            <h2 className="mt-8 text-sm font-semibold text-ink">Storage</h2>
            <div className="mt-3 rounded-card bg-surface p-5 shadow-card">
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {Object.entries(data.orphanBlobs).length === 0 ? (
                  <p className="text-sm font-medium text-ink-faint">
                    No unreferenced blobs recorded.
                  </p>
                ) : (
                  Object.entries(data.orphanBlobs).map(([state, count]) => (
                    <div key={state}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                        {state.replace(/_/g, ' ').toLowerCase()}
                      </p>
                      <p
                        className={`mt-0.5 text-lg font-bold tabular-nums ${
                          state === 'PENDING_DELETE' && count > 0 ? 'text-danger' : 'text-ink'
                        }`}
                      >
                        {count}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <p className="mt-3 max-w-prose text-xs font-medium leading-relaxed text-ink-muted">
                A file on disk that no row references is invisible to DSAR discovery and unreachable
                by purge — so a deletion certificate could be signed while it remains. The reaper
                quarantines these rather than deleting them outright; run{' '}
                <code className="font-mono">npm run storage:reap</code> to act on the backlog.
              </p>
            </div>

            {/* piiStatus breakdown, because "0 DEFERRED, 0 FAILED, 27 PENDING"
                is exactly the shape of the reporting bug this page exists to
                make impossible to repeat. */}
            <h2 className="mt-8 text-sm font-semibold text-ink">Photos by redaction state</h2>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3 rounded-card bg-surface p-5 shadow-card">
              {Object.entries(pipeline.photosByPiiStatus).map(([state, count]) => (
                <div key={state}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    {state.toLowerCase()}
                  </p>
                  <p
                    className={`mt-0.5 text-lg font-bold tabular-nums ${
                      ['CLEAN', 'MASKED'].includes(state) ? 'text-ink' : 'text-warning'
                    }`}
                  >
                    {count}
                  </p>
                </div>
              ))}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  not finished
                </p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-danger">
                  {blockedFrameCount(pipeline.photosByPiiStatus)}
                </p>
              </div>
            </div>

            <p className="mt-6 flex items-center gap-1.5 text-xs font-medium text-ink-faint">
              <Activity size={13} strokeWidth={2} />
              Refreshed {new Date(data.generatedAt).toLocaleTimeString()} · updates every{' '}
              {POLL_MS / 1000}s
            </p>
          </>
        )}
      </main>
    </div>
  )
}
