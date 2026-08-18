import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Upload } from 'lucide-react'

// The worker reads clips with torchaudio, whose format support depends on which
// backend the image happens to have. MediaRecorder gives us webm/opus on Chrome
// and mp4/aac on Safari, neither of which is safe to assume decodable there — so
// everything is converted to 16 kHz mono PCM WAV in the browser before upload.
// That is also exactly what ECAPA-TDNN wants, so the resample has to happen
// somewhere regardless; doing it here keeps a five-second clip under 200 KB.
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

/**
 * Records or accepts a short speech clip and hands it up as a WAV blob.
 *
 * Deliberately offers no playback of anything already enrolled — that decision
 * lives in the backend (there is no agent-facing playback route) and this
 * component must not grow a way around it. The preview below is of the clip in
 * hand, before it is sent; once it is stored, nobody but the subject hears it.
 */
export default function VoiceCapture({ onCapture, busy, error, count = 0, max = 3, minSeconds = 3 }) {
  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const tickRef = useRef(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [localError, setLocalError] = useState(null)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = null
  }, [])

  // Without this the microphone indicator stays lit after the agent closes the
  // panel, which is both alarming and, on a shared field device, a live mic.
  useEffect(() => releaseStream, [releaseStream])

  const send = async (raw) => {
    let prepared
    try {
      prepared = await toWav16k(raw)
    } catch {
      setLocalError('That audio could not be read. Record again, or upload a WAV or MP3.')
      return
    }
    if (prepared.duration < minSeconds) {
      setLocalError(
        `Only ${prepared.duration.toFixed(1)}s of audio — at least ${minSeconds}s of continuous speech is needed.`,
      )
      return
    }
    await onCapture(prepared.blob)
  }

  const start = async () => {
    setLocalError(null)
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
        if (raw.size > 0) await send(raw)
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

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setLocalError(null)
    if (file) await send(file)
  }

  const full = count >= max
  const shown = localError ?? error

  return (
    <div className="rounded-card border border-border bg-canvas p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-ink">Voice enrollment</p>
        <p className="text-xs font-semibold text-ink-faint">
          {count} of {max} clips added
        </p>
      </div>

      <p className="mt-1.5 text-xs font-medium text-ink-faint">
        Ask the person to say their name and today&apos;s date, in their normal speaking voice, for
        at least {minSeconds} seconds. One clean clip is enough; more clips help if sessions are
        recorded in noisier rooms.
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

      {shown && <p className="mt-3 text-xs font-semibold text-danger">{shown}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={start}
            disabled={busy || full}
            className="flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <Mic size={14} strokeWidth={2} /> {busy ? 'Adding…' : 'Record clip'}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            <Square size={14} strokeWidth={2} /> Stop and add
          </button>
        )}

        <label
          className={`flex cursor-pointer items-center gap-1.5 rounded-lg bg-canvas px-3 py-1.5 text-xs font-semibold text-ink-muted ${
            busy || full || recording ? 'pointer-events-none opacity-40' : ''
          }`}
        >
          <Upload size={14} strokeWidth={2} /> Upload a clip
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
        <p className="mt-2 text-xs font-medium text-ink-faint">
          Maximum clips added. Delete one to replace it.
        </p>
      )}
    </div>
  )
}
