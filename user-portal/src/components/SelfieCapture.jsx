import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Check, RotateCcw, Upload, Zap } from 'lucide-react'

// Three angles, not five: the backend caps a subject at MAX_PER_SUBJECT (3)
// photos, so UP/DOWN were unreachable — the request was rejected as "max photos"
// before it ever got stored. buffalo_l also degrades past roughly ±45° yaw, so a
// profile shot costs storage and buys nothing.
export const POSES = [
  { key: 'FRONT', label: 'Look straight ahead', hint: 'Face the camera, eyes level.' },
  { key: 'LEFT', label: 'Turn slightly to your left', hint: 'About a quarter turn — not a full profile.' },
  { key: 'RIGHT', label: 'Turn slightly to your right', hint: 'About a quarter turn — not a full profile.' },
]

// Client-side quality gate — tune here. The backend still validates det_score
// and single-face on every shot; these just save a round trip on obviously
// bad frames and give auto-capture something to pause on.
const BRIGHTNESS_MIN = 50
const BRIGHTNESS_MAX = 230
const QUALITY_SAMPLE_SIZE = 64 // px wide, enough for a luma average
const SHARPNESS_SAMPLE_SIZE = 200 // px wide — 64px has no high-frequency detail left to measure
const SHARPNESS_VAR_MIN = 14 // variance-of-Laplacian on 0..255 grey; below this the frame is soft/motion-blurred

const DETECT_INTERVAL_MS = 150 // landmarker poll rate; full rAF-rate inference is wasted work
const HOLD_MS = 550 // continuous all-checks-pass time required before firing
const FACE_LANDMARKER_NUM_FACES = 2 // 2, not 1 — we need to *see* a second face to reject it

// Pinned to the installed @mediapipe/tasks-vision so the WASM ABI matches the JS wrapper.
const MEDIAPIPE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm'
const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Yaw bands per pose, in degrees, expressed from the *user's* point of view
// (which is what the mirrored preview shows them).
//
// YAW_SIGN maps the transformation matrix's rotation sense onto that point of
// view. The matrix is derived from the unmirrored <video> frame, so the sign
// depends on both the decomposition axis order and the front-camera geometry —
// verify on-device and flip this to -1 if "turn left" only ever satisfies the
// RIGHT band.
const YAW_SIGN = 1
const POSE_YAW = {
  FRONT: { min: -10, max: 10 },
  LEFT: { min: 12, max: 35 },
  RIGHT: { min: -35, max: -12 },
}

function decomposeMatrix(m) {
  // m is a 16-element column-major 4x4; r(row, col) reads the rotation block.
  const r = (row, col) => m[col * 4 + row]
  const sy = Math.hypot(r(0, 0), r(1, 0))
  const deg = (rad) => (rad * 180) / Math.PI
  if (sy < 1e-6) {
    return { yaw: deg(Math.atan2(-r(2, 0), sy)), pitch: deg(Math.atan2(-r(1, 2), r(1, 1))), roll: 0 }
  }
  return {
    yaw: deg(Math.atan2(-r(2, 0), sy)),
    pitch: deg(Math.atan2(r(2, 1), r(2, 2))),
    roll: deg(Math.atan2(r(1, 0), r(0, 0))),
  }
}

function yawMessage(poseKey, yaw) {
  const band = POSE_YAW[poseKey]
  if (!band) return null
  if (yaw >= band.min && yaw <= band.max) return null
  if (poseKey === 'FRONT') return 'Look straight at the camera'
  const overTurned = Math.abs(yaw) > Math.max(Math.abs(band.min), Math.abs(band.max))
  if (overTurned) return 'Turn back towards the camera a little'
  return poseKey === 'LEFT' ? 'Turn a bit more to your left' : 'Turn a bit more to your right'
}

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
  // rejection (backend or client quality gate) instead of blasting through them.
  const [auto, setAuto] = useState(false)
  const [autoPaused, setAutoPaused] = useState(false)
  const [blockMsg, setBlockMsg] = useState(null)
  const [quality, setQuality] = useState(null)
  const [hold, setHold] = useState(0) // 0..1 readiness-hold progress

  const rafRef = useRef(null)
  const lastDetectRef = useRef(0)
  const lastVideoTimeRef = useRef(-1)
  const holdStartRef = useRef(null)
  const firingRef = useRef(false)
  const autoPendingRef = useRef(null) // pose key currently awaiting an onCapture result in auto mode
  const landmarkerRef = useRef(null)
  const landmarkerLoadRef = useRef(/** @type {Promise<void> | null} */ (null))
  const sharpnessCanvasRef = useRef(null)
  const lumaCanvasRef = useRef(null)

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
    setBlockMsg(null)
    setQuality(null)
    setHold(0)
    autoPendingRef.current = null
    holdStartRef.current = null
    firingRef.current = false
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // Without this the camera light stays on after the user navigates away, and
  // the readiness loop would keep polling into an unmounted tree.
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

  // MediaPipe is fetched from a CDN, so it can simply not arrive: offline, a
  // blocked CDN, no WebGL. A failed load degrades to brightness+blur-only
  // gating (backend still validates face count and det_score) rather than
  // taking the whole enrollment screen down.
  const loadLandmarker = useCallback(() => {
    landmarkerLoadRef.current ??= (async () => {
      try {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL)
        landmarkerRef.current = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: FACE_LANDMARKER_NUM_FACES,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: true,
        })
      } catch {
        landmarkerRef.current = null // degraded mode
      }
    })()
    return landmarkerLoadRef.current
  }, [])

  useEffect(() => {
    if (on) loadLandmarker()
  }, [on, loadLandmarker])

  useEffect(
    () => () => {
      landmarkerRef.current?.close?.()
      landmarkerRef.current = null
    },
    [],
  )

  const sampleTo = (canvasRef, video, width) => {
    const canvas = (canvasRef.current ??= document.createElement('canvas'))
    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width))
    canvas.width = width
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(video, 0, 0, width, h)
    return { data: ctx.getImageData(0, 0, width, h).data, w: width, h }
  }

  const measureBrightness = (video) => {
    const { data } = sampleTo(lumaCanvasRef, video, QUALITY_SAMPLE_SIZE)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    return sum / (data.length / 4)
  }

  // Variance of the Laplacian: a sharp frame has lots of high-frequency edge
  // energy, a blurred one has almost none. Needs a big enough sample to have
  // any high frequencies left to measure at all.
  const measureSharpness = (video) => {
    const { data, w, h } = sampleTo(sharpnessCanvasRef, video, SHARPNESS_SAMPLE_SIZE)
    const grey = new Float32Array(w * h)
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      grey[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    let sum = 0
    let sumSq = 0
    let n = 0
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x
        const lap = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w]
        sum += lap
        sumSq += lap * lap
        n += 1
      }
    }
    if (!n) return 0
    const mean = sum / n
    return sumSq / n - mean * mean
  }

  // Synchronous, so the readiness loop can run it inline: detectForVideo is a
  // blocking call, and both pixel passes read from an offscreen canvas.
  const evaluateFrame = useCallback((video, poseKey) => {
    if (!video || !video.videoWidth) return null

    const brightness = measureBrightness(video)
    if (brightness < BRIGHTNESS_MIN) return { ok: false, message: 'Too dark — move to better light' }
    if (brightness > BRIGHTNESS_MAX) return { ok: false, message: 'Too bright — reduce glare' }

    if (measureSharpness(video) < SHARPNESS_VAR_MIN) {
      return { ok: false, message: 'Too blurry — hold still' }
    }

    const landmarker = landmarkerRef.current
    if (!landmarker) return { ok: true, message: 'Ready' } // degraded: no face/angle gating

    let result
    try {
      // detectForVideo rejects non-monotonic timestamps; skip repeat frames.
      const t = video.currentTime
      if (t === lastVideoTimeRef.current) return null
      lastVideoTimeRef.current = t
      result = landmarker.detectForVideo(video, performance.now())
    } catch {
      return { ok: true, message: 'Ready' } // inference died mid-session — fall back rather than block
    }

    const matrices = result?.facialTransformationMatrixes ?? []
    const faceCount = result?.faceLandmarks?.length ?? 0
    if (faceCount === 0) return { ok: false, message: 'No face detected — center your face' }
    if (faceCount > 1) return { ok: false, message: 'Only one person in frame' }

    const matrix = matrices[0]?.data
    if (!matrix) return { ok: true, message: 'Ready' }
    const { yaw } = decomposeMatrix(matrix)
    const message = yawMessage(poseKey, YAW_SIGN * yaw)
    if (message) return { ok: false, message }

    return { ok: true, message: 'Ready' }
  }, [])

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
    // The stream stays up between poses — stopping and restarting it three times
    // is a permission-prompt-shaped way to lose people halfway through.
    await send(blob)
    setPreview(null)
  }

  const captureAndSendRef = useRef(captureAndSend)
  captureAndSendRef.current = captureAndSend

  const shoot = async () => {
    const video = videoRef.current
    if (!video) return
    await loadLandmarker()
    const result = evaluateFrame(video, current?.key)
    if (result && !result.ok) {
      setBlockMsg(result.message)
      return
    }
    setBlockMsg(null)
    await captureAndSend(video)
  }

  const triggerAutoShot = useCallback(async () => {
    const video = videoRef.current
    const pose = next
    if (!video || !pose) return
    setBlockMsg(null)
    setActive(pose.key)
    autoPendingRef.current = pose.key
    await captureAndSendRef.current(video)
  }, [next])

  const triggerAutoShotRef = useRef(triggerAutoShot)
  triggerAutoShotRef.current = triggerAutoShot

  // Everything the readiness loop needs to read without being re-created (and
  // thereby restarting the rAF chain) on every render.
  const gateRef = useRef(null)
  gateRef.current = {
    poseKey: current?.key ?? null,
    armed: auto && !autoPaused && !busy && !complete && !preview,
    idle: !busy && !complete && !preview,
  }

  // Continuous readiness loop, FaceID-style: no countdown, no fixed delay. It
  // polls the landmarker on a throttle and accumulates hold time for as long as
  // every check passes at once; any failure zeroes the progress and the user
  // simply keeps going — only a real capture rejection pauses auto mode.
  useEffect(() => {
    if (!on) {
      setHold(0)
      holdStartRef.current = null
      return
    }
    lastDetectRef.current = 0
    lastVideoTimeRef.current = -1

    const loop = (ts) => {
      rafRef.current = requestAnimationFrame(loop)
      if (ts - lastDetectRef.current < DETECT_INTERVAL_MS) return
      lastDetectRef.current = ts

      const gate = gateRef.current
      if (!gate.idle || firingRef.current || autoPendingRef.current) {
        holdStartRef.current = null
        setHold(0)
        setQuality(null)
        return
      }

      const result = evaluateFrame(videoRef.current, gate.poseKey)
      if (!result) return // frame not ready / duplicate — keep the last reading
      setQuality(result)

      if (!result.ok) {
        holdStartRef.current = null
        setHold(0)
        return
      }

      holdStartRef.current ??= ts
      const progress = Math.min(1, (ts - holdStartRef.current) / HOLD_MS)
      setHold(progress)

      if (progress >= 1 && gate.armed) {
        holdStartRef.current = null
        setHold(0)
        firingRef.current = true
        Promise.resolve(triggerAutoShotRef.current()).finally(() => {
          firingRef.current = false
        })
      }
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [on, evaluateFrame])

  // Resolves a capture that just finished. Only a rejection (backend error, or
  // the photo not landing in `captured`) pauses auto mode — mid-hold check
  // failures are handled by the loop itself.
  useEffect(() => {
    if (!auto || !on) return
    if (!autoPendingRef.current || busy) return
    const pending = autoPendingRef.current
    autoPendingRef.current = null
    if (error || !captured.includes(pending)) setAutoPaused(true)
  }, [auto, on, busy, captured, error])

  // Stop the camera once auto mode finishes the last pose.
  useEffect(() => {
    if (auto && complete && on) stop()
  }, [auto, complete, on, stop])

  const toggleAuto = () => {
    holdStartRef.current = null
    setHold(0)
    if (auto) {
      setAuto(false)
      setAutoPaused(false)
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
    holdStartRef.current = null
    setHold(0)
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await send(file)
  }

  const showResume = auto && autoPaused
  const ringReady = hold >= 1
  const RING_R = 46
  const RING_C = 2 * Math.PI * RING_R

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
          {/* Face-ID style hold ring: fills as the frame stays good, snaps to the
              ready colour when the hold completes and the shot fires. */}
          {on && !preview && !complete && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <svg viewBox="0 0 100 100" className="h-[86%] max-h-full -rotate-90">
                <circle
                  cx="50"
                  cy="50"
                  r={RING_R}
                  fill="none"
                  strokeWidth="3"
                  className="stroke-white/25"
                />
                <circle
                  cx="50"
                  cy="50"
                  r={RING_R}
                  fill="none"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - hold)}
                  className={`transition-[stroke-dashoffset] duration-150 ${
                    ringReady ? 'stroke-success' : 'stroke-brand'
                  }`}
                />
              </svg>
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
