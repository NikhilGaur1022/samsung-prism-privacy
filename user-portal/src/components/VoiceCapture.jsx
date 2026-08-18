import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Mic, RotateCcw, Square, Upload } from 'lucide-react'

// The worker reads clips with torchaudio, whose format support depends on which
// backend the image happens to have. MediaRecorder gives us webm/opus on Chrome
// and mp4/aac on Safari, neither of which is safe to assume decodable there — so
// everything is converted to 16 kHz mono PCM WAV here before upload. That is
// also exactly what the speaker model wants, so the resample has to happen
// somewhere regardless; doing it on the phone keeps a five-second clip under
// 200 KB, which matters on a field connection.
const TARGET_RATE = 16000

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function toWav16k(source) {
  const bytes = await source.arrayBuffer()
  const ctx = new (window.AudioContext ?? window.webkitAudioContext)()
  let decoded
  try {
    decoded = await ctx.decodeAudioData(bytes)
  } finally {
    ctx.close()
  }

  const offline = new OfflineAudioContext(
    1,
    Math.max(1, Math.ceil(decoded.duration * TARGET_RATE)),
    TARGET_RATE,
  )
  const node = offline.createBufferSource()
  node.buffer = decoded
  node.connect(offline.destination)
  node.start()
  const rendered = await offline.startRendering()

  const blob = encodeWav(rendered.getChannelData(0), TARGET_RATE)
  blob.name = 'voice.wav'
  return { blob, duration: decoded.duration }
}

// The sentence is fixed rather than free-form so the clip contains a spread of
// vowels and is long enough to be worth embedding, and so a person who has no
// idea what to say does not stand there in silence and record three seconds of
// room tone.
const PROMPT_SENTENCE =
  'The quick brown fox jumps over the lazy dog, and I am here for today’s session.'

// getUserMedia needs HTTPS or localhost — over a LAN IP it silently yields
// nothing, so the file input is always rendered rather than offered only as a
// fallback. Without it a phone that walked up to a session cannot enroll at all.
export default function VoiceCapture({ onCapture, busy, error, count = 0, max = 3, minSeconds = 3 }) {
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const tickRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [pending, setPending] = useState(null) // { blob, duration, url }
  const [localError, setLocalError] = useState(null)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = null
  }, [])

  // Without this the microphone indicator stays lit after the user navigates
  // away — a live mic nobody asked for, on their own phone.
  useEffect(() => releaseStream, [releaseStream])

  const clearPending = useCallback(() => {
    setPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
  }, [])

  useEffect(() => clearPending, [clearPending])

  const prepare = async (raw) => {
    let prepared
    try {
      prepared = await toWav16k(raw)
    } catch {
      setLocalError('That recording could not be read. Try again, or upload a file instead.')
      return
    }
    if (prepared.duration < minSeconds) {
      setLocalError(
        `That was only ${prepared.duration.toFixed(1)} seconds. Read the whole sentence — at least ${minSeconds} seconds of speech.`,
      )
      return
    }
    setPending({ ...prepared, url: URL.createObjectURL(prepared.blob) })
  }

  const start = async () => {
    setLocalError(null)
    clearPending()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream
      chunksRef.current = []

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        const raw = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        releaseStream()
        setRecording(false)
        if (raw.size > 0) await prepare(raw)
      }

      recorder.start()
      setRecording(true)
      setElapsed(0)
      tickRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    } catch (err) {
      setLocalError(err.message ?? 'Could not open the microphone')
    }
  }

  const stop = () => recorderRef.current?.stop()

  const confirm = async () => {
    if (!pending) return
    const { blob } = pending
    clearPending()
    await onCapture(blob)
  }

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setLocalError(null)
    if (file) await prepare(file)
  }

  const full = count >= max
  const shown = localError ?? error

  return (
    <div className="rounded-card border border-border bg-canvas p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink">Record your voice</p>
        <p className="shrink-0 text-xs font-semibold text-ink-faint">
          {count} of {max}
        </p>
      </div>

      <p className="mt-0.5 text-xs font-medium text-ink-muted">
        Read this out in your normal speaking voice, somewhere reasonably quiet:
      </p>
      <p className="mt-2 rounded-lg bg-surface px-3 py-2.5 text-sm font-semibold leading-relaxed text-ink">
        {PROMPT_SENTENCE}
      </p>

      {recording && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-danger-soft px-3 py-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />
          <span className="text-xs font-bold text-danger">
            Recording — {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
            {String(elapsed % 60).padStart(2, '0')}
          </span>
        </div>
      )}

      {/* Reviewed on the device before it is ever sent. Once it is stored, this
          is the only place it can be played back from other than the subject's
          own list — no agent or admin has a route to it. */}
      {pending && !recording && (
        <div className="mt-3 rounded-lg bg-surface p-3">
          <p className="text-xs font-semibold text-ink">
            {pending.duration.toFixed(1)} seconds — have a listen before you send it.
          </p>
          <audio controls src={pending.url} className="mt-2 w-full" />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              <Check size={14} strokeWidth={2} /> {busy ? 'Saving…' : 'Use this one'}
            </button>
            <button
              type="button"
              onClick={() => {
                clearPending()
                setLocalError(null)
              }}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <RotateCcw size={14} strokeWidth={2} /> Discard
            </button>
          </div>
        </div>
      )}

      {shown && <p className="mt-3 text-xs font-semibold text-danger">{shown}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={start}
            disabled={busy || full}
            className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Mic size={14} strokeWidth={2} /> {pending ? 'Record again' : 'Start recording'}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            <Square size={14} strokeWidth={2} /> Stop
          </button>
        )}

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted ${
            busy || full || recording ? 'pointer-events-none opacity-40' : ''
          }`}
        >
          <Upload size={14} strokeWidth={2} /> Upload instead
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleFile}
            disabled={busy || full || recording}
          />
        </label>
      </div>

      {full && (
        <p className="mt-2 text-xs font-medium text-ink-muted">
          You have added the maximum number of clips. Delete one to replace it.
        </p>
      )}
    </div>
  )
}
