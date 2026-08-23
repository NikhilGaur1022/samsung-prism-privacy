// Browser-side conversion to 16 kHz mono PCM WAV.
//
// `new MediaRecorder(stream)` with no options gives WebM/Opus on Chrome and
// MP4/AAC on Safari. Wrapping those chunks in `new Blob(chunks, {type:
// 'audio/wav'})` relabels the bytes and converts nothing — the container is
// still WebM, and every downstream reader that trusts the label is wrong about
// what it is holding.
//
// That is not hypothetical. The session recorder shipped exactly that blob and
// the API stored `mimeType: audio/wav` from `file.mimetype`, so the audio
// worker's libsndfile read threw `Format not recognised` on every recording and
// fell through to the PyAV decoder — measured at 7.7s to decode 8.2s of audio,
// paid once in diarize plus once per speaker plus once in transcribe.
//
// So the conversion happens here, for real, once, before upload: decode through
// the browser's own codecs (which do know what a WebM is), resample to 16 kHz
// mono, and emit a genuine RIFF/WAVE. That is also precisely what pyannote,
// Whisper and ECAPA-TDNN each resample to internally, so the work has to happen
// somewhere regardless — and doing it here keeps a five-second clip under 200 KB.
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

/**
 * Decodes any container the browser can read and returns real 16 kHz mono WAV.
 *
 * @param {Blob|File} source
 * @returns {Promise<{blob: Blob, duration: number}>}
 */
export async function toWav16k(source) {
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

  return { blob: encodeWav(rendered.getChannelData(0), TARGET_RATE), duration: decoded.duration }
}

/** True only if the bytes actually start with a RIFF/WAVE header. */
async function isRealWav(source) {
  if (source.size < 12) return false
  const head = new Uint8Array(await source.slice(0, 12).arrayBuffer())
  const tag = (o, s) => String.fromCharCode(...head.slice(o, o + s.length)) === s
  return tag(0, 'RIFF') && tag(8, 'WAVE')
}

/**
 * Same conversion, handed back as a named File ready for a multipart upload.
 *
 * A file that really is a WAV is passed through untouched: re-decoding it gains
 * nothing, and `decodeAudioData` holds the whole thing as float32 in memory, so
 * round-tripping a long recording through it is how you turn a working upload
 * into an out-of-memory crash.
 *
 * The pass-through is decided by reading the first twelve bytes, NOT by
 * `source.type`. Trusting the label is the bug this module exists for — the
 * label said `audio/wav` and the bytes said WebM. A header check costs one
 * 12-byte slice and cannot be lied to.
 */
export async function toWavFile(source, name) {
  if (await isRealWav(source)) {
    return source instanceof File && source.name === name
      ? source
      : new File([source], name, { type: 'audio/wav' })
  }
  const { blob } = await toWav16k(source)
  return new File([blob], name.replace(/\.[^.]+$/, '') + '.wav', { type: 'audio/wav' })
}
