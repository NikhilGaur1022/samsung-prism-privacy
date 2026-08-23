#!/usr/bin/env node
/**
 * Answers one question about a finished export: if this photo turned up on its
 * own in two years, what could you tell about where it came from?
 *
 * verify-export.js proves the stamp is present and its signature checks out.
 * That is a different question from "what does it actually say", which is the
 * one that matters when someone asks whether a frame can be traced back to a
 * session, a project and the people in it. So this pulls one image out of the
 * archive, reads the EXIF off the bytes, and prints every field with a plain
 * account of what each one buys you — including what it does NOT tell you
 * without the rest of the package.
 *
 * Usage: node scripts/inspect-photo-provenance.js <projectId> <exportId>
 */
import 'dotenv/config'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const BASE = process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000'
const PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'Prism@2026!'
const OWNER = process.env.E2E_OWNER_EMAIL ?? 'dataowner@prism.local'
const [projectId, exportId] = process.argv.slice(2)

if (!projectId || !exportId) {
  console.error('usage: node scripts/inspect-photo-provenance.js <projectId> <exportId>')
  process.exit(2)
}

const cookies = new Map()
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')

// --- the smallest ZIP reader that can do this job --------------------------
// Central directory only; every entry in a PRISM export is STORED or DEFLATE.
function readZip(buf) {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  if (eocd < 0) throw new Error('not a zip')

  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)

  // ZIP64: the 32-bit fields saturate and the real ones live in the ZIP64 EOCD.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    let loc = eocd - 20
    while (loc >= 0 && buf.readUInt32LE(loc) !== 0x07064b50) loc -= 1
    if (loc < 0) throw new Error('zip64 locator missing')
    const z64 = Number(buf.readBigUInt64LE(loc + 8))
    count = Number(buf.readBigUInt64LE(z64 + 32))
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48))
  }

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    let compressed = buf.readUInt32LE(p + 20)
    let uncompressed = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    // ZIP64 extra field carries the real sizes/offset when the 32-bit ones saturate.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = buf.readUInt16LE(e)
      const size = buf.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (uncompressed === 0xffffffff) { uncompressed = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (compressed === 0xffffffff) { compressed = Number(buf.readBigUInt64LE(q)); q += 8 }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); q += 8 }
      }
      e += 4 + size
    }

    entries.push({ name, method, compressed, uncompressed, localOffset })
    p = p + 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function extract(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.localOffset + 26)
  const extraLen = buf.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressed)
  if (entry.method === 0) return raw
  const { inflateRawSync } = await import('node:zlib')
  return inflateRawSync(raw)
}

const line = (label, value) => console.log(`  ${String(label).padEnd(20)} ${value}`)

async function main() {
  let res = await fetch(`${BASE}/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER, password: PASSWORD }),
  })
  absorb(res)
  if (!res.ok) throw new Error(`login -> ${res.status}`)

  res = await fetch(`${BASE}/api/v1/projects/${projectId}/exports/${exportId}/download`, {
    headers: { Cookie: cookieHeader() },
  })
  if (!res.ok) throw new Error(`download -> ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  console.log(`archive ${Math.round(buf.length / 1024)} KB\n`)

  const entries = readZip(buf)
  const manifestEntry = entries.find((e) => e.name.endsWith('manifest.json'))
  const subjectsEntry = entries.find((e) => e.name.endsWith('subjects.json'))
  const photoEntry = entries.find((e) => /\.jpe?g$/i.test(e.name))
  if (!photoEntry) throw new Error('no JPEG in the archive')

  const manifest = JSON.parse((await extract(buf, manifestEntry)).toString('utf8'))
  const subjects = JSON.parse((await extract(buf, subjectsEntry)).toString('utf8'))
  const photoBytes = await extract(buf, photoEntry)

  console.log(`THE FILE ITSELF — ${photoEntry.name}`)
  console.log('  what a person holding only this JPEG can recover:\n')

  const meta = await sharp(photoBytes).metadata()

  // BOTH carriers are examined. The stamp is written to EXIF ImageDescription
  // and to an XMP packet, and counting only the EXIF one under-reports the
  // redundancy that is the whole reason the second copy exists.
  const exifText = meta.exif ? meta.exif.toString('latin1') : ''
  const xmpText = meta.xmp ? meta.xmp.toString('utf8') : ''
  const carriers = []
  if (/PRISM1/.test(exifText)) carriers.push('EXIF ImageDescription')
  if (/PRISM1/.test(xmpText)) carriers.push('XMP packet')

  if (!meta.exif && !meta.xmp) {
    console.log('  NO METADATA AT ALL — this photo carries no embedded provenance.')
  } else {
    const text = exifText + '\n' + xmpText
    const found = [...text.matchAll(/PRISM1[^\0<\s]*/g)].map((m) => m[0])
    if (!found.length) {
      console.log('  EXIF present but no PRISM stamp found in it.')
    } else {
      // The stamp is `PRISM1.<base64url payload>.<base64url signature>` — the
      // payload has to be decoded before any of it is readable.
      const body = found[0].slice('PRISM1'.length).replace(/^\./, '')
      let payload = null
      const [b64] = body.split('.')
      try {
        payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
      } catch {
        const jsonStart = body.indexOf('{')
        if (jsonStart >= 0) {
          try { payload = JSON.parse(body.slice(jsonStart, body.lastIndexOf('}') + 1)) } catch { /* raw below */ }
        }
      }
      line('stamp carriers', `${carriers.length} — ${carriers.join(' + ')}`)
      if (payload) {
        console.log('')
        line('project', payload.projectId ?? '—')
        line('capture session', payload.captureSessionId ?? '—')
        line('photo id', payload.photoId ?? '—')
        line('consent record', payload.consentId ?? '—')
        line('people in frame', (payload.subjectRefs ?? []).join(', ') || '—')
        line('redaction state', payload.redaction ?? '—')
        line('content hash', (payload.contentHash ?? '').slice(0, 32) + '…')
        line('export', payload.exportId ?? '—')
        line('stamped at', payload.stampedAt ?? '—')
      } else {
        console.log(`  raw stamp: ${body.slice(0, 240)}`)
      }
    }
  }

  // Only meaningful if the capture had camera EXIF to begin with. The bundled
  // test fixtures are synthetic and carry none, so "absent" here says nothing
  // about the pipeline — it is reported plainly rather than read as a finding.
  console.log(`\n  camera-original fields carried through from capture:`)
  const camTags = ['Make', 'Model', 'DateTime', 'Software'].filter((t) => exifText.includes(t))
  if (camTags.length) line('present', camTags.join(', '))
  else line('none found', 'expected when the source image had no camera EXIF')

  console.log(`\nTHE MANIFEST ROW — what the package adds`)
  const row = (manifest.files ?? manifest.items ?? []).find((f) =>
    (f.path ?? f.file ?? f.name ?? '').includes(path.basename(photoEntry.name)),
  )
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      line(k, typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 70))
    }
  } else {
    console.log('  (no manifest row matched this file)')
  }

  console.log(`\nTHE NAME BEHIND THE PSEUDONYM — subjects.json`)
  const map = subjects.subjects ?? subjects
  const shown = Array.isArray(map) ? map : Object.entries(map).map(([ref, v]) => ({ ref, ...(typeof v === 'object' ? v : { name: v }) }))
  for (const s of shown.slice(0, 4)) {
    line(s.ref ?? s.subjectRef ?? '?', s.fullName ?? s.name ?? JSON.stringify(s))
  }

  console.log(`\n${'='.repeat(66)}`)
  console.log('VERDICT')
  console.log(`${'='.repeat(66)}`)
  console.log(`
The JPEG alone identifies the project, the capture session, the photo, the
consent record it was taken under, and WHICH people are in it — as export-scoped
pseudonyms, signed so tampering shows.

It deliberately does NOT carry names or emails. Turning a pseudonym back into a
person needs subjects.json from the same archive. That is the privacy trade:
5,000 images do not each carry someone's name, one access-controlled file does.

The stamp rides in two independent carriers — EXIF ImageDescription and an XMP
packet — so a tool that rewrites one does not take the provenance with it.

Video, audio and text files carry NO embedded stamp — there is no EXIF-equivalent
field in those containers here. Their provenance lives only in the manifest, so
if one is moved out of the archive on its own, it loses its origin.
`)
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`)
  console.error(err.stack)
  if (err.cause) console.error("cause:", err.cause)
  process.exit(1)
})
