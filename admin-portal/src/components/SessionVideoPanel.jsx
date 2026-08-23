import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Film, Loader2, ShieldCheck, Upload, Video } from 'lucide-react'

import { listVideos, uploadVideo, mediaUrl } from '../lib/api'
import StatusPill from './StatusPill'

// Video capture for a session.
//
// There was no video screen in either portal until today. The backend had the
// routes, the Python worker had /analyze and /redact, and the worker's own
// README said "between them, a human tags the clusters in the admin portal" —
// but that human had nowhere to do it, so no clip was ever uploaded and the
// whole path was unreachable.
//
// Two rules this panel exists to hold to:
//
//   1. The ORIGINAL clip is never played here. Only the blurred derivative is
//      offered, and only once one exists. An unblurred clip on an operator's
//      screen shows bystanders' faces to someone with no lawful basis for them,
//      and the fact that they are an admin does not create one.
//   2. A clip with no derivative is shown as unfinished, in those words, rather
//      than as a broken player. It is also what holds the session out of
//      ARCHIVED, so the operator needs to be able to see that it is the reason.

const STATUS_TONE = {
  PENDING_ANALYSIS: 'neutral',
  ANALYZED: 'warning',
  REDACTED: 'success',
  DEFERRED: 'danger',
}

const STATUS_LABEL = {
  PENDING_ANALYSIS: 'Waiting for analysis',
  ANALYZED: 'Faces found, not yet blurred',
  REDACTED: 'Blurred',
  DEFERRED: 'Analysis failed',
}

// Mirrors backend/src/lib/photoState.js — a clip is only finished when the
// status says so AND a derivative actually exists. Two columns, because a
// status can be set by a code path that crashed before writing the bytes.
function isFinished(video) {
  return video.status === 'REDACTED' && Boolean(video.redactedPath)
}

function describe(video) {
  if (isFinished(video)) return null
  if (video.status === 'DEFERRED') {
    return 'The video worker could not analyse this clip. Nothing has been blurred, so it will not be released and the session cannot be archived until it succeeds.'
  }
  if (video.status === 'REDACTED') {
    return 'This clip is marked blurred but no blurred copy was written. It is being treated as unfinished.'
  }
  return 'Blurring has not finished. The session stays open until it does.'
}

export default function SessionVideoPanel({ sessionId, canCapture, sessionStatus }) {
  const [videos, setVideos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await listVideos(sessionId)
      setVideos(data.videos ?? [])
      setError(null)
    } catch (err) {
      // A 503 here means video capture is switched off in this environment,
      // which is a configuration fact and not a failure — say so plainly rather
      // than showing an error the operator cannot act on.
      if (err.status === 503) setError({ disabled: true, message: err.message })
      else setError({ message: err.message })
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    load()
  }, [load])

  const onPick = async (event) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await uploadVideo(sessionId, files)
      if (res?.failed > 0) {
        setError({
          message:
            `${res.failed} of ${files.length} clip(s) were rejected: ` +
            (res.rejected ?? []).map((r) => `${r.filename} — ${r.reason}`).join('; '),
        })
      }
      await load()
    } catch (err) {
      setError({ message: err.message })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  if (error?.disabled) {
    return (
      <section className="rounded-card bg-surface p-6 shadow-card">
        <h2 className="flex items-center gap-2 text-base font-bold text-ink">
          <Video size={16} strokeWidth={2.5} />
          Video
        </h2>
        <p className="mt-2 text-sm font-medium text-ink-faint">
          Video capture is switched off in this environment.
        </p>
      </section>
    )
  }

  const unfinished = videos.filter((v) => !isFinished(v)).length

  return (
    <section className="rounded-card bg-surface p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="flex items-center gap-2 text-base font-bold text-ink">
            <Video size={16} strokeWidth={2.5} />
            Video
          </h2>
          <p className="mt-0.5 text-xs font-medium text-ink-faint">
            Faces are found and tracked automatically, then blurred for everyone who is not tagged
            to a consenting participant.
          </p>
        </div>

        {canCapture && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              multiple
              onChange={onPick}
              className="hidden"
              id="session-video-input"
            />
            <label
              htmlFor="session-video-input"
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-ink px-3 py-2 text-sm font-semibold text-white ${
                busy ? 'pointer-events-none opacity-60' : ''
              }`}
            >
              {busy ? (
                <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />
              ) : (
                <Upload size={15} strokeWidth={2.5} />
              )}
              {busy ? 'Uploading…' : 'Add clip'}
            </label>
          </>
        )}
      </div>

      {error && !error.disabled && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm font-medium text-danger">
          <AlertTriangle size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" />
          {error.message}
        </p>
      )}

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm font-medium text-ink-faint">
          <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />
          Loading clips…
        </p>
      ) : videos.length === 0 ? (
        <p className="mt-4 text-sm font-medium text-ink-faint">
          No clips in this session.
        </p>
      ) : (
        <>
          {unfinished > 0 && sessionStatus !== 'ARCHIVED' && (
            <p className="mt-4 flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm font-medium text-warning">
              <AlertTriangle size={15} strokeWidth={2.5} className="mt-0.5 shrink-0" />
              {unfinished} clip{unfinished === 1 ? '' : 's'} still being processed. This session
              cannot be archived or handed off until every clip is blurred.
            </p>
          )}

          <ul className="mt-4 flex flex-col gap-3">
            {videos.map((video) => {
              const finished = isFinished(video)
              const note = describe(video)
              return (
                <li key={video.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                      <Film size={15} strokeWidth={2.5} className="shrink-0 text-ink-faint" />
                      <span className="truncate">
                        {video.durationSec ? `${video.durationSec.toFixed(1)}s` : 'Clip'}
                        {video.width && video.height ? ` · ${video.width}×${video.height}` : ''}
                      </span>
                    </p>
                    <StatusPill tone={STATUS_TONE[video.status] ?? 'neutral'}>
                      {STATUS_LABEL[video.status] ?? video.status}
                    </StatusPill>
                  </div>

                  {note && <p className="mt-2 text-xs font-medium text-ink-faint">{note}</p>}

                  {finished ? (
                    <>
                      <video
                        controls
                        preload="metadata"
                        className="mt-3 w-full rounded-lg bg-canvas"
                        src={mediaUrl.redactedVideo(sessionId, video.id)}
                      />
                      <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-success">
                        <ShieldCheck size={13} strokeWidth={2.5} />
                        Blurred copy. The original is never played here.
                      </p>
                    </>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
