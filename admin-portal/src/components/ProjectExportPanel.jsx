import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, Package, AlertTriangle, ShieldCheck } from 'lucide-react'
import StatusPill from './StatusPill'
import {
  requestProjectExport,
  listProjectExports,
  projectExportDownloadUrl,
} from '../lib/api'

// The download control the product did not have.
//
// ProcessedData.jsx — the Data Owner's "finished data" screen — was a project
// selector and a read-only session roll-up with no download anywhere on it, and
// admin-portal/src/lib/api.js had no export call outside the DSAR ones. This is
// the whole client half of that requirement.

const STATUS_TONE = {
  QUEUED: 'neutral',
  RUNNING: 'warning',
  READY: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
}

const POLL_MS = 3000

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

export default function ProjectExportPanel({ projectId }) {
  const [exports, setExports] = useState(null)
  const [error, setError] = useState(null)
  const [requesting, setRequesting] = useState(false)
  const timer = useRef(null)

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await listProjectExports(projectId)
      setExports(res.items)
      setError(null)
    } catch (err) {
      setError(err)
      setExports([])
    }
  }, [projectId])

  useEffect(() => {
    setExports(null)
    setError(null)
    load()
  }, [projectId, load])

  // Poll only while something is actually in flight. A screen that polls
  // forever is a screen that keeps a tab and a server busy for no reason.
  const inFlight = exports?.some((e) => e.status === 'QUEUED' || e.status === 'RUNNING')

  useEffect(() => {
    clearInterval(timer.current)
    if (!inFlight) return undefined
    timer.current = setInterval(load, POLL_MS)
    return () => clearInterval(timer.current)
  }, [inFlight, load])

  async function onRequest() {
    setRequesting(true)
    setError(null)
    try {
      await requestProjectExport(projectId)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setRequesting(false)
    }
  }

  if (!projectId) return null

  return (
    <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Package size={16} strokeWidth={2} className="shrink-0 text-ink-faint" />
            Project export
          </h2>
          <p className="mt-1 max-w-prose text-xs font-medium leading-relaxed text-ink-faint">
            Downloads everything finished in this project as one archive — stills, clips,
            recordings and documents. Redacted derivatives only: bystanders and printed PII are
            masked, unidentified speech is muted, and no original capture is included. Every file
            has a manifest row naming its capture session and the pseudonymous people in it, and
            each image additionally carries that as a signed stamp in its own metadata. The
            pseudonym-to-name mapping is one file inside the archive.
          </p>
        </div>
        <button
          type="button"
          onClick={onRequest}
          disabled={requesting || inFlight}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
        >
          {requesting || inFlight ? (
            <Loader2 size={15} className="animate-spin" strokeWidth={2} />
          ) : (
            <Package size={15} strokeWidth={2} />
          )}
          {inFlight ? 'Building…' : 'Build export'}
        </button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-ink-faint">
        <ShieldCheck size={13} strokeWidth={2} className="mt-px shrink-0" />
        Every download is recorded in the access ledger against your account. There is no approval
        step; that record is what stands in its place.
      </p>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
          <AlertTriangle size={15} strokeWidth={2} className="mt-px shrink-0" />
          <span className="min-w-0">
            {error.message}
            {/* The refusal that matters most: unfinished redaction. Naming the
                count turns "it failed" into something the operator can act on. */}
            {error.details?.unresolvedCount ? (
              <span className="mt-1 block font-medium">
                {error.details.unresolvedCount} frame
                {error.details.unresolvedCount === 1 ? '' : 's'} still processing. Exporting now
                would blur the very people the dataset is about.
              </span>
            ) : null}
          </span>
        </div>
      )}

      <div className="mt-5">
        {exports === null ? (
          <Loader2 size={16} className="animate-spin text-ink-faint" />
        ) : exports.length === 0 ? (
          <p className="text-sm font-medium text-ink-faint">
            No exports yet for this project.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {exports.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {new Date(job.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-0.5 text-xs font-medium text-ink-faint">
                    {job.status === 'RUNNING' && job.photosTotal > 0
                      ? `${job.photosWritten} of ${job.photosTotal} files · ${job.progress}%`
                      : `${job.photosWritten} file${job.photosWritten === 1 ? '' : 's'} · ${job.subjectCount} subject${job.subjectCount === 1 ? '' : 's'} · ${formatBytes(job.sizeBytes)}`}
                    {job.photosExcluded > 0 && (
                      <> · {job.photosExcluded} excluded by consent</>
                    )}
                    {job.expiresAt && job.status === 'READY' && (
                      <> · expires {new Date(job.expiresAt).toLocaleDateString()}</>
                    )}
                  </p>
                  {job.status === 'FAILED' && job.error && (
                    <p className="mt-1 text-xs font-semibold text-danger">{job.error}</p>
                  )}
                </div>

                <StatusPill tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status}</StatusPill>

                {job.status === 'READY' && (
                  <a
                    href={projectExportDownloadUrl(projectId, job.id)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Download size={13} strokeWidth={2} />
                    Download
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
