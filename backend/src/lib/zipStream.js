import { Readable } from 'node:stream'
import { createDeflateRaw } from 'node:zlib'
import { Buffer } from 'node:buffer'

// A streaming ZIP64 writer.
//
// It replaces lib/zip.js, which assembled the whole archive with Buffer.concat
// and emitted no ZIP64 extensions. Against the measured 241.3 KB average stored
// image and the 5,000-images/day target, that writer runs out in days:
//
//   4 GiB offset limit      17,381 images    3.5 days
//   65,535-entry limit      65,535 images   13.1 days
//   V8 heap (concat first)  ~2–4 GB         sooner than either
//
// The heap ceiling is the worst of the three, and not because it is the first.
// The old writer materialises the entire archive in the API process before the
// response starts, so a large project download does not fail one request — it
// takes the whole API down for every other user at once.
//
// This writer never holds more than one entry's compressed chunk. Sizes and CRCs
// are not known until an entry has been written, so it uses the streaming-mode
// format: a data descriptor after each entry, the bit-3 flag set in both the
// local header and the central directory, and ZIP64 extra fields written
// unconditionally on every entry rather than only when a threshold is crossed —
// deciding per entry would mean knowing the final offset before writing it.
//
// Layout per entry:
//   local file header (sizes/CRC zeroed, bit 3 set, ZIP64 extra present)
//   deflate-raw or stored payload
//   ZIP64 data descriptor (8-byte sizes)
// then:
//   central directory (one record per entry, ZIP64 extra with offset + sizes)
//   ZIP64 end-of-central-directory record
//   ZIP64 end-of-central-directory locator
//   end-of-central-directory record (with 0xFFFF/0xFFFFFFFF sentinels)

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32Update(crc, buf) {
  let c = crc
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c
}

// MS-DOS date/time. Two-second granularity and no timezone; the authoritative
// timestamps live in the manifest, this only stops extractors showing 1980.
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

const SIG_LOCAL = 0x04034b50
const SIG_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_EOCD = 0x06054b50

const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_UTF8_NAMES = 0x0800

const ZIP64_EXTRA_ID = 0x0001
const VERSION_ZIP64 = 45 // 4.5, the version that introduced ZIP64

function writeU64(value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

/**
 * @typedef {object} ZipEntry
 * @property {string} name           path inside the archive
 * @property {Buffer|AsyncIterable<Buffer>|(() => AsyncIterable<Buffer>|Buffer|Promise<Buffer>)} data
 * @property {Date}   [date]
 * @property {boolean} [store]       skip deflate (default: decided by extension)
 */

// JPEG, PNG, WebP, MP4, MP3 and ZIP payloads are already compressed. Deflating
// them costs CPU and routinely GROWS them, which is how an archive ends up
// larger than the files inside it. The old writer compressed then compared,
// which needs the whole entry in memory — the thing this writer exists not to do
// — so the decision is made from the extension instead.
const ALREADY_COMPRESSED = /\.(jpe?g|png|gif|webp|avif|heic|mp4|mov|m4a|mp3|aac|ogg|opus|zip|gz|br)$/i

function shouldStore(entry) {
  if (typeof entry.store === 'boolean') return entry.store
  return ALREADY_COMPRESSED.test(entry.name)
}

async function* toChunks(data) {
  const resolved = typeof data === 'function' ? await data() : data
  if (Buffer.isBuffer(resolved)) {
    yield resolved
    return
  }
  if (resolved && typeof resolved[Symbol.asyncIterator] === 'function') {
    for await (const chunk of resolved) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    }
    return
  }
  if (resolved && typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
    for (const chunk of resolved) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    return
  }
  yield Buffer.from(resolved ?? '')
}

/**
 * Yields the bytes of a ZIP64 archive, one chunk at a time.
 *
 * `entries` may be an array or an async generator, so the caller can produce
 * entries lazily — reading each blob only when the archive reaches it, rather
 * than loading 5,000 images before the first byte goes out.
 *
 * @param {Iterable<ZipEntry>|AsyncIterable<ZipEntry>} entries
 * @param {(progress: {entries: number, bytes: number, name: string}) => void} [onProgress]
 */
export async function* zipStream(entries, onProgress) {
  const central = []
  let offset = 0n
  let count = 0

  const emit = function* (buf) {
    offset += BigInt(buf.length)
    yield buf
  }

  for await (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const { time, date } = dosDateTime(entry.date ?? new Date())
    const store = shouldStore(entry)
    const localOffset = offset

    // --- local file header ---------------------------------------------------
    // Sizes and CRC are zero here: they are not known yet, which is exactly what
    // the data-descriptor flag announces. ZIP64 extra is present with zeroed
    // sizes for the same reason.
    const zip64Extra = Buffer.alloc(4 + 16)
    zip64Extra.writeUInt16LE(ZIP64_EXTRA_ID, 0)
    zip64Extra.writeUInt16LE(16, 2)
    writeU64(0).copy(zip64Extra, 4)
    writeU64(0).copy(zip64Extra, 12)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(VERSION_ZIP64, 4)
    local.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8_NAMES, 6)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(0, 14) // crc32, in the descriptor
    local.writeUInt32LE(0xffffffff, 18) // compressed size -> ZIP64
    local.writeUInt32LE(0xffffffff, 22) // uncompressed size -> ZIP64
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(zip64Extra.length, 28)

    yield* emit(local)
    yield* emit(nameBuf)
    yield* emit(zip64Extra)

    // --- payload -------------------------------------------------------------
    let crc = -1
    let rawSize = 0n
    let compSize = 0n

    if (store) {
      for await (const chunk of toChunks(entry.data)) {
        crc = crc32Update(crc, chunk)
        rawSize += BigInt(chunk.length)
        compSize += BigInt(chunk.length)
        yield* emit(chunk)
      }
    } else {
      // The deflate stream is a duplex: written on one side, iterated on the
      // other, with both halves running concurrently. That concurrency is the
      // point — zlib buffers, so a single input chunk usually produces no output
      // at all, and a loop that writes then waits for output deadlocks on the
      // first entry. Backpressure still holds in both directions: `write()`
      // returning false parks the producer, and the consumer's `for await` parks
      // the whole generator.
      const deflate = createDeflateRaw()

      let pumpError = null
      const pump = (async () => {
        for await (const chunk of toChunks(entry.data)) {
          crc = crc32Update(crc, chunk)
          rawSize += BigInt(chunk.length)
          if (!deflate.write(chunk)) {
            await new Promise((resolve, reject) => {
              deflate.once('drain', resolve)
              deflate.once('error', reject)
            })
          }
        }
        deflate.end()
      })().catch((err) => {
        pumpError = err
        deflate.destroy(err)
      })

      for await (const out of deflate) {
        compSize += BigInt(out.length)
        yield* emit(out)
      }

      await pump
      if (pumpError) throw pumpError
    }

    const finalCrc = (crc ^ -1) >>> 0

    // --- ZIP64 data descriptor ----------------------------------------------
    const descriptor = Buffer.alloc(24)
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(finalCrc, 4)
    writeU64(compSize).copy(descriptor, 8)
    writeU64(rawSize).copy(descriptor, 16)
    yield* emit(descriptor)

    central.push({
      name: nameBuf,
      crc: finalCrc,
      compSize,
      rawSize,
      localOffset,
      time,
      date,
      method: store ? 0 : 8,
    })

    count += 1
    onProgress?.({ entries: count, bytes: Number(offset), name: entry.name })
  }

  // --- central directory -----------------------------------------------------
  const centralStart = offset

  for (const e of central) {
    // Offset and both sizes go in the ZIP64 extra unconditionally. Choosing per
    // record would mean the record's own length depends on a value computed from
    // the records before it, and getting that wrong produces an archive that
    // opens in one tool and not another.
    const extra = Buffer.alloc(4 + 24)
    extra.writeUInt16LE(ZIP64_EXTRA_ID, 0)
    extra.writeUInt16LE(24, 2)
    writeU64(e.rawSize).copy(extra, 4)
    writeU64(e.compSize).copy(extra, 12)
    writeU64(e.localOffset).copy(extra, 20)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(SIG_CENTRAL, 0)
    record.writeUInt16LE(VERSION_ZIP64, 4) // version made by
    record.writeUInt16LE(VERSION_ZIP64, 6) // version needed
    record.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8_NAMES, 8)
    record.writeUInt16LE(e.method, 10)
    record.writeUInt16LE(e.time, 12)
    record.writeUInt16LE(e.date, 14)
    record.writeUInt32LE(e.crc, 16)
    record.writeUInt32LE(0xffffffff, 20)
    record.writeUInt32LE(0xffffffff, 24)
    record.writeUInt16LE(e.name.length, 28)
    record.writeUInt16LE(extra.length, 30)
    record.writeUInt16LE(0, 32) // comment length
    record.writeUInt16LE(0, 34) // disk number
    record.writeUInt16LE(0, 36) // internal attrs
    record.writeUInt32LE(0, 38) // external attrs
    record.writeUInt32LE(0xffffffff, 42) // local offset -> ZIP64

    yield* emit(record)
    yield* emit(e.name)
    yield* emit(extra)
  }

  const centralSize = offset - centralStart

  // --- ZIP64 EOCD ------------------------------------------------------------
  const eocd64 = Buffer.alloc(56)
  eocd64.writeUInt32LE(SIG_EOCD64, 0)
  writeU64(44).copy(eocd64, 4) // size of this record minus 12
  eocd64.writeUInt16LE(VERSION_ZIP64, 12)
  eocd64.writeUInt16LE(VERSION_ZIP64, 14)
  eocd64.writeUInt32LE(0, 16) // this disk
  eocd64.writeUInt32LE(0, 20) // disk with central dir
  writeU64(central.length).copy(eocd64, 24)
  writeU64(central.length).copy(eocd64, 32)
  writeU64(centralSize).copy(eocd64, 40)
  writeU64(centralStart).copy(eocd64, 48)

  const eocd64Offset = offset
  yield* emit(eocd64)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(SIG_EOCD64_LOCATOR, 0)
  locator.writeUInt32LE(0, 4)
  writeU64(eocd64Offset).copy(locator, 8)
  locator.writeUInt32LE(1, 16)
  yield* emit(locator)

  // --- classic EOCD, with sentinels so ZIP64-unaware tools say so -----------
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length > 0xffff ? 0xffff : central.length, 8)
  eocd.writeUInt16LE(central.length > 0xffff ? 0xffff : central.length, 10)
  eocd.writeUInt32LE(centralSize > 0xffffffffn ? 0xffffffff : Number(centralSize), 12)
  eocd.writeUInt32LE(centralStart > 0xffffffffn ? 0xffffffff : Number(centralStart), 16)
  eocd.writeUInt16LE(0, 20)
  yield* emit(eocd)
}

/** Node Readable over the same generator, for piping straight to a response. */
export function zipReadable(entries, onProgress) {
  return Readable.from(zipStream(entries, onProgress))
}

/**
 * Whole-archive convenience for callers that genuinely want a Buffer — the
 * signed DSAR access package, which is sealed under a per-export DEK and has to
 * exist as bytes before it can be encrypted.
 *
 * It is capped, because "give me the whole thing in memory" is the operation
 * that took the API down, and a cap that raises a clear error is better than an
 * OOM that takes every other request with it.
 */
export async function zipToBuffer(entries, { maxBytes = 512 * 1024 * 1024 } = {}) {
  const chunks = []
  let total = 0

  for await (const chunk of zipStream(entries)) {
    total += chunk.length
    if (total > maxBytes) {
      throw new Error(
        `Archive exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB in-memory ceiling. ` +
          'Stream it with zipStream() instead of buffering it.',
      )
    }
    chunks.push(chunk)
  }

  return Buffer.concat(chunks, total)
}
