import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, RotateCcw, Upload, Zap } from 'lucide-react'

// Five angles, not a 180° sweep: buffalo_l degrades past roughly ±45° yaw, so a
// profile shot costs storage and buys nothing.
export const POSES = [
  { key: 'FRONT', label: 'Look straight ahead', hint: 'Face the camera, eyes level.' },
  { key: 'LEFT', label: 'Turn slightly to your left', hint: 'About a quarter turn — not a full profile.' },
  { key: 'RIGHT', label: 'Turn slightly to your right', hint: 'About a quarter turn — not a full profile.' },
  { key: 'UP', label: 'Tilt your chin up a little', hint: 'Just enough to change the angle.' },
  { key: 'DOWN', label: 'Tilt your chin down a little', hint: 'Keep your eyes on the camera.' },
]

// Client-side quality gate — tune here. The backend still validates det_score
// and single-face on every shot; these just save a round trip on obviously
// bad frames and give auto-capture something to pause on.
const BRIGHTNESS_MIN = 50
const BRIGHTNESS_MAX = 230
const QUALITY_SAMPLE_SIZE = 64 // px, downscaled square-ish sample for the luma pass
const QUALITY_POLL_MS = 500
const AUTO_COUNTDOWN_SECONDS = 3

// getUserMedia needs HTTPS or localhost — over a LAN IP it silently yields nothing,
// so the file input is always rendered rather than offered only as a fallback.
// Without it, a phone that walked up to a session cannot enroll at all.
export default function SelfieCapture({ poses = POSES, captured = [], onCapture, busy, error }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [on, setOn] = useState(false)
  const [camError, setCamError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [active, setActive] = useState(null)

  // Auto-capture: walks the remaining poses unattended, pausing on the first
  // rejection (backend or client quality gate) instead of blasting through five.
  const [auto, setAuto] = useState(false)
  const [autoPaused, setAutoPaused] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [blockMsg, setBlockMsg] = useState(null)
  const [quality, setQuality] = useState(null)

  const countdownTimerRef = useRef(null)
  const qualityIntervalRef = useRef(null)
  const autoPendingRef = useRef(null) // pose key currently awaiting an onCapture result in auto mode
  const faceDetectorRef = useRef(null)
  const detectingRef = useRef(false)

  const done = new Set(captured)
  const next = poses.find((p) => !done.has(p.key)) ?? null
  const current = poses.find((p) => p.key === active) ?? next
  const complete = !next

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setOn(false)
    setAuto(false)
    setAutoPaused(false)
    setCountdown(null)
    setBlockMsg(null)
    setQuality(null)
    autoPendingRef.current = null
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
    if (qualityIntervalRef.current) {
      clearInterval(qualityIntervalRef.current)
      qualityIntervalRef.current = null
    }
  }, [])

  // Without this the camera light stays on after the user navigates away, and
  // the countdown/quality-poll timers would keep firing into an unmounted tree.
  useEffect(() => stop, [stop])

  // The <video> is mounted only once `on` is true, so srcObject cannot be set
  // inside start() — the element does not exist yet, and the assignment is
  // silently dropped, leaving a live-but-black preview. Attach here instead,
  // after the element mounts. Re-runs when the capture-preview overlay clears
  // so the stream stays wired across shots.
  useEffect(() => {
    const video = videoRef.current
    if (on && video && streamRef.current && video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current
      video.play?.().catch(() => {})
    }
  }, [on, preview])

  const start = async () => {
    setCamError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 1280, height: 720 },
        audio: false,
      })
      streamRef.current = stream
      setOn(true) // mounts the <video>; the effect above wires the stream to it
    } catch (err) {
      setCamError(err.message ?? 'Could not open the camera')
    }
  }

  // Downscaled luma read for brightness, plus a best-effort FaceDetector pass.
  // FaceDetector is Chrome/Android-only and unsupported everywhere else — when
  // it's missing we skip face checks silently and let the backend catch it.
  const analyzeFrame = useCallback(async (video) => {
    if (!video || !video.videoWidth) return null
    const canvas = document.createElement('canvas')
    const w = QUALITY_SAMPLE_SIZE
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w))
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    const brightness = sum / (data.length / 4)

    if (brightness < BRIGHTNESS_MIN) return { ok: false, message: 'Too dark — move to better light' }
    if (brightness > BRIGHTNESS_MAX) return { ok: false, message: 'Too bright — reduce glare' }

    if (typeof window !== 'undefined' && window.FaceDetector && !detectingRef.current) {
      detectingRef.current = true
      try {
        faceDetectorRef.current ??= new window.FaceDetector({ fastMode: true })
        const faces = await faceDetectorRef.current.detect(video)
        if (faces.length === 0) return { ok: false, message: 'No face detected — center your face' }
        if (faces.length > 1) return { ok: false, message: 'Only one person in frame' }
      } catch {
        // Best-effort only — the backend still validates det_score and face count.
      } finally {
        detectingRef.current = false
      }
    }

    return { ok: true, message: 'Ready' }
  }, [])

  // Live readiness pill: polls while the camera is on and idle so the user
  // gets feedback before pressing capture, not just after a rejection.
  useEffect(() => {
    if (!on || busy || countdown !== null) {
      setQuality(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      const result = await analyzeFrame(videoRef.current)
      if (!cancelled) setQuality(result)
    }
    tick()
    qualityIntervalRef.current = setInterval(tick, QUALITY_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(qualityIntervalRef.current)
      qualityIntervalRef.current = null
    }
  }, [on, busy, countdown, analyzeFrame])

  const send = async (blob) => {
    if (!current) return
    await onCapture(blob, current.key)
    setActive(null)
  }

  const captureAndSend = async (video) => {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) return

    setPreview(URL.createObjectURL(blob))
    // The stream stays up between poses — stopping and restarting it five times
    // is a permission-prompt-shaped way to lose people halfway through.
    await send(blob)
    setPreview(null)
  }

  // triggerAutoShot is memoized for the countdown-timer effect below; capturing
  // captureAndSend through a ref (instead of a useCallback dep) keeps it stable
  // across renders that don't actually change the pose being captured.
  const captureAndSendRef = useRef(captureAndSend)
  captureAndSendRef.current = captureAndSend

  const shoot = async () => {
    const video = videoRef.current
    if (!video) return
    const result = await analyzeFrame(video)
    if (result && !result.ok) {
      setBlockMsg(result.message)
      return
    }
    setBlockMsg(null)
    await captureAndSend(video)
  }

  // One state-machine effect for auto mode: it either resolves a capture that
  // just finished, or — once idle — arms the countdown for the next pose.
  // Splitting those into the same effect (rather than two effects racing on
  // `busy`) keeps a rejection from being immediately overwritten by a fresh
  // countdown before `autoPaused` has actually committed.
  useEffect(() => {
    if (!auto || !on) return

    if (autoPendingRef.current) {
      if (busy) return
      const pending = autoPendingRef.current
      autoPendingRef.current = null
      if (error || !captured.includes(pending)) {
        setAutoPaused(true)
      }
      return
    }

    if (autoPaused || busy || complete || preview || countdown !== null) return
    setCountdown(AUTO_COUNTDOWN_SECONDS)
  }, [auto, on, autoPaused, busy, complete, preview, countdown, captured, error])

  // Stop the camera once auto mode finishes the last pose.
  useEffect(() => {
    if (auto && complete && on) stop()
  }, [auto, complete, on, stop])

  const triggerAutoShot = useCallback(async () => {
    const video = videoRef.current
    const pose = next
    if (!video || !pose) return
    const result = await analyzeFrame(video)
    if (result && !result.ok) {
      setBlockMsg(result.message)
      setAutoPaused(true)
      return
    }
    setBlockMsg(null)
    setActive(pose.key)
    autoPendingRef.current = pose.key
    await captureAndSendRef.current(video)
  }, [next, analyzeFrame])

  useEffect(() => {
    if (countdown === null) return
    if (countdown === 0) {
      setCountdown(null)
      triggerAutoShot()
      return
    }
    countdownTimerRef.current = setTimeout(() => {
      setCountdown((c) => (c === null ? null : c - 1))
    }, 1000)
    return () => {
      clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [countdown, triggerAutoShot])

  const toggleAuto = () => {
    if (auto) {
      setAuto(false)
      setAutoPaused(false)
      setCountdown(null)
      setBlockMsg(null)
      autoPendingRef.current = null
    } else {
      setAuto(true)
      setAutoPaused(false)
      setBlockMsg(null)
    }
  }

  const resumeAuto = () => {
    setAutoPaused(false)
    setBlockMsg(null)
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await send(file)
  }

  const showResume = auto && autoPaused

  return (
    <div className="rounded-card border border-border bg-canvas p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink">
          {complete ? 'All angles captured' : current.label}
        </p>
        <p className="shrink-0 text-xs font-semibold text-ink-faint">
          {done.size} of {poses.length}
        </p>
      </div>
      {!complete && <p className="mt-0.5 text-xs font-medium text-ink-muted">{current.hint}</p>}

      {/* The strip doubles as the retake control — tapping a finished pose re-arms
          it, which is the only way to replace a bad shot without deleting it first. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {poses.map((pose) => {
          const isDone = done.has(pose.key)
          const isCurrent = current?.key === pose.key
          return (
            <button
              key={pose.key}
              type="button"
              onClick={() => setActive(pose.key)}
              disabled={busy || auto}
              className={`flex h-12 w-12 items-center justify-center rounded-lg border-2 text-[10px] font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                isCurrent
                  ? 'border-brand bg-brand-soft text-brand'
                  : isDone
                    ? 'border-transparent bg-brand text-white'
                    : 'border-transparent bg-surface text-ink-faint'
              }`}
              aria-label={isDone ? `Retake: ${pose.label}` : pose.label}
            >
              {isDone && !isCurrent ? <Check size={16} strokeWidth={2.5} /> : pose.key}
            </button>
          )
        })}
      </div>

      {(on || preview) && (
        <div className="relative mt-3 overflow-hidden rounded-lg bg-black">
          {/* Kept mounted the whole time the camera is on — swapping it out for the
              preview would tear down the element and drop the stream, so the
              preview is layered on top instead. */}
          {on && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="aspect-video w-full scale-x-[-1] object-cover"
            />
          )}
          {preview && (
            <img
              src={preview}
              alt="Captured selfie"
              className={`${on ? 'absolute inset-0 h-full w-full' : 'aspect-video w-full'} bg-black object-contain`}
            />
          )}
          {auto && countdown !== null && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/60 text-center text-white">
              <p className="text-sm font-bold">{current?.label}</p>
              <p className="text-xs font-medium text-white/80">{current?.hint}</p>
              <p className="mt-1 text-4xl font-black tabular-nums">{countdown}</p>
            </div>
          )}
        </div>
      )}

      {on && !complete && (
        <p
          className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
            quality
              ? quality.ok
                ? 'bg-success-soft text-success'
                : 'bg-warning-soft text-warning'
              : 'bg-surface text-ink-faint'
          }`}
        >
          {quality ? (quality.ok ? 'Ready' : quality.message) : 'Checking…'}
        </p>
      )}

      {(camError || error || blockMsg) && (
        <p className="mt-3 text-xs font-semibold text-danger">{camError ?? blockMsg ?? error}</p>
      )}

      {showResume && (
        <button
          type="button"
          onClick={resumeAuto}
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
        >
          <Zap size={14} strokeWidth={2} /> Resume
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!on ? (
          <button
            type="button"
            onClick={start}
            disabled={busy || complete}
            className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Camera size={14} strokeWidth={2} /> Use camera
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={shoot}
              disabled={busy || complete || auto}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <Camera size={14} strokeWidth={2} /> {busy ? 'Adding…' : 'Take photo'}
            </button>
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <RotateCcw size={14} strokeWidth={2} /> Stop camera
            </button>
          </>
        )}

        <button
          type="button"
          onClick={toggleAuto}
          disabled={busy || complete}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            auto ? 'bg-brand-soft text-brand' : 'bg-surface text-ink-muted'
          }`}
        >
          <Zap size={14} strokeWidth={2} /> {auto ? 'Auto: on' : 'Auto-capture'}
        </button>

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted ${
            busy || complete || auto ? 'pointer-events-none opacity-40' : ''
          }`}
        >
          <Upload size={14} strokeWidth={2} /> Upload instead
          <input
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={handleFile}
            disabled={busy || complete || auto}
          />
        </label>
      </div>
    </div>
  )
}
