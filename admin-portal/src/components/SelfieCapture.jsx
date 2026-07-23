import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, RotateCcw, Upload } from 'lucide-react'

// getUserMedia needs HTTPS or localhost — over a LAN IP it silently yields nothing,
// so the file input is always rendered rather than offered only as a fallback.
export default function SelfieCapture({ onCapture, busy, error, count = 0, max = 3 }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [on, setOn] = useState(false)
  const [camError, setCamError] = useState(null)
  const [preview, setPreview] = useState(null)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setOn(false)
  }, [])

  // Without this the camera light stays on after the agent navigates away.
  useEffect(() => stop, [stop])

  const start = async () => {
    setCamError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 1280, height: 720 },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setOn(true)
    } catch (err) {
      setCamError(err.message ?? 'Could not open the camera')
    }
  }

  const shoot = async () => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) return
    setPreview(URL.createObjectURL(blob))
    stop()
    await onCapture(blob)
    setPreview(null)
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) await onCapture(file)
  }

  const full = count >= max

  return (
    <div className="rounded-card border border-border bg-canvas p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink">Face enrollment</p>
        <p className="text-xs font-semibold text-ink-faint">
          {count} of {max} photos added
        </p>
      </div>

      {(on || preview) && (
        <div className="mt-3 overflow-hidden rounded-lg bg-black">
          {preview ? (
            <img src={preview} alt="Captured selfie" className="aspect-video w-full object-contain" />
          ) : (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="aspect-video w-full object-cover"
            />
          )}
        </div>
      )}

      {(camError || error) && (
        <p className="mt-3 text-xs font-semibold text-danger">{camError ?? error}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!on ? (
          <button
            type="button"
            onClick={start}
            disabled={busy || full}
            className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Camera size={14} strokeWidth={2} /> Use camera
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={shoot}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <Camera size={14} strokeWidth={2} /> {busy ? 'Adding…' : 'Take photo'}
            </button>
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <RotateCcw size={14} strokeWidth={2} /> Cancel
            </button>
          </>
        )}

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted ${
            busy || full ? 'pointer-events-none opacity-40' : ''
          }`}
        >
          <Upload size={14} strokeWidth={2} /> Upload a photo
          <input
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={handleFile}
            disabled={busy || full}
          />
        </label>
      </div>

      {full && (
        <p className="mt-2 text-xs font-medium text-ink-faint">
          Maximum photos added. Delete one to replace it.
        </p>
      )}
    </div>
  )
}
