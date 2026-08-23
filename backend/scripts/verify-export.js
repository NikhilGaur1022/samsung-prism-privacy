#!/usr/bin/env node
/**
 * Downloads a built project export and checks that it is what it claims to be.
 *
 * The point of the archive is that someone holding it, months later, can answer
 * "who is in this file, and which session and project did it come from" without
 * access to the platform. That property is either true of the bytes or it is
 * not, and reading the code cannot tell you which. So this opens the ZIP and
 * checks:
 *
 *   1. every manifest row names a file that is actually in the archive
 *   2. every file's SHA-256 matches the hash the manifest recorded
 *   3. every row carries the provenance fields the README promises
 *   4. every subjectRef in a row resolves in subjects.json
 *   5. the JPEGs carry the signed EXIF stamp, and it agrees with the manifest
 *
 * Usage:
 *   node scripts/verify-export.js <projectId> <exportId>
 */
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile as fsWriteFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const BASE = process.env.DEMO_API_URL ?? 'http://127.0.0.1:4000'
const PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? 'Prism@2026!'
const [projectId, exportId] = process.argv.slice(2)

if (!projectId || !exportId) {
  console.error('usage: node scripts/verify-export.js <projectId> <exportId>')
  process.exit(2)
}

let pass = 0
let fail = 0
const ok = (m) => {
  pass += 1
  console.log(`  PASS  ${m}`)
}
const bad = (m) => {
  fail += 1
  console.log(`  FAIL  ${m}`)
}

async function login() {
  const res = await fetch(`${BASE}/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dataowner@prism.local', password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  return (res.headers.getSetCookie() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ')
}

/**
 * Reads a ZIP without a ZIP library.
 *
 * The archive is written with data descriptors and ZIP64 (see lib/zipStream.js),
 * so the local headers carry zeroed sizes — the central directory at the end is
 * the only reliable index. That is what is walked here.
 */
function readZip(buf) {
  // End of central directory: scan backwards for the signature.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('not a zip: no end-of-central-directory record')

  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)

  // ZIP64 locator sits immediately before the EOCD when the counts overflowed.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20
    if (buf.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64 locator missing')
    const zip64 = Number(buf.readBigUInt64LE(locator + 8))
    if (buf.readUInt32LE(zip64) !== 0x06064b50) throw new Error('zip64 EOCD missing')
    count = Number(buf.readBigUInt64LE(zip64 + 32))
    cdOffset = Number(buf.readBigUInt64LE(zip64 + 48))
  }

  const files = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`)
    const method = buf.readUInt16LE(p + 10)
    let compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    // ZIP64 extra field overrides the 32-bit sizes, in a fixed order.
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e < end) {
        const id = buf.readUInt16LE(e)
        const size = buf.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          // uncompressed then compressed, each present only if it overflowed
          if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(q))
            q += 8
          }
          if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q))
          break
        }
        e += 4 + size
      }
    }

    files.set(name, { method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

async function extract(buf, entry) {
  // Local header length is variable; read its own name/extra lengths.
  const o = entry.localOffset
  if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error('bad local header')
  const nameLen = buf.readUInt16LE(o + 26)
  const extraLen = buf.readUInt16LE(o + 28)
  const start = o + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)

  if (entry.method === 0) return raw
  const { inflateRawSync } = await import('node:zlib')
  return inflateRawSync(raw)
}

async function main() {
  console.log(`Verifying export ${exportId}\n`)
  const cookie = await login()

  const res = await fetch(`${BASE}/api/v1/projects/${projectId}/exports/${exportId}/download`, {
    headers: { Cookie: cookie },
  })
  if (!res.ok) throw new Error(`download failed: ${res.status} ${await res.text()}`)
  const buf = Buffer.from(await res.arrayBuffer())
  console.log(`  downloaded ${(buf.length / 1024).toFixed(0)} KB\n`)

  const files = readZip(buf)
  console.log(`  archive holds ${files.size} entries\n`)

  for (const required of ['manifest.json', 'subjects.json', 'README.txt']) {
    if (files.has(required)) ok(`${required} present`)
    else bad(`${required} MISSING`)
  }

  if (!files.has('manifest.json')) {
    console.log('\nCannot continue without a manifest.')
    process.exit(1)
  }

  const manifest = JSON.parse((await extract(buf, files.get('manifest.json'))).toString('utf8'))
  const subjectMap = JSON.parse((await extract(buf, files.get('subjects.json'))).toString('utf8'))
  const knownRefs = new Set(subjectMap.subjects.map((s) => s.subjectRef))

  console.log('')
  console.log(`  project   ${manifest.project.name}`)
  console.log(`  counts    ${JSON.stringify(manifest.counts)}`)
  console.log(`  subjects  ${subjectMap.subjects.map((s) => `${s.subjectRef.slice(0, 12)}…=${s.fullName}`).join(', ')}`)
  console.log('')

  // 1 + 2: every row names a real file whose bytes hash to what was recorded.
  let hashChecked = 0
  let missing = 0
  let mismatched = 0
  for (const row of manifest.files) {
    const entry = files.get(row.file)
    if (!entry) {
      missing += 1
      bad(`manifest names ${row.file}, which is not in the archive`)
      continue
    }
    const bytes = await extract(buf, entry)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== row.contentHash) {
      mismatched += 1
      bad(`${row.file}: sha256 mismatch`)
    }
    hashChecked += 1
  }
  if (missing === 0) ok(`all ${manifest.files.length} manifest rows name a file in the archive`)
  if (mismatched === 0 && hashChecked > 0) ok(`all ${hashChecked} files match their recorded sha256`)

  // 3: the provenance fields the README promises, on EVERY row whatever its kind.
  const REQUIRED = ['file', 'mediaType', 'itemId', 'captureSessionId', 'sessionCode', 'subjectRefs', 'redaction', 'contentHash']
  const incomplete = manifest.files.filter((r) => REQUIRED.some((k) => r[k] === undefined))
  if (incomplete.length === 0) {
    ok(`every row carries ${REQUIRED.length} provenance fields (who / which session / which project)`)
  } else {
    bad(`${incomplete.length} row(s) missing provenance: ${JSON.stringify(incomplete[0])}`)
  }

  // 4: refs resolve.
  const danglingRefs = new Set()
  for (const row of manifest.files) {
    for (const ref of row.subjectRefs ?? []) if (!knownRefs.has(ref)) danglingRefs.add(ref)
  }
  if (danglingRefs.size === 0) ok('every subjectRef in the manifest resolves in subjects.json')
  else bad(`${danglingRefs.size} subjectRef(s) do not resolve: ${[...danglingRefs].slice(0, 3).join(', ')}`)

  // Coverage by media type, so a silently photos-only archive is visible.
  const byType = manifest.files.reduce((acc, r) => {
    acc[r.mediaType ?? 'UNKNOWN'] = (acc[r.mediaType ?? 'UNKNOWN'] ?? 0) + 1
    return acc
  }, {})
  console.log(`\n  media in archive: ${JSON.stringify(byType)}`)

  // 5: the embedded EXIF stamp, read back with the platform's own reader and
  // its signature checked.
  //
  // Deliberately NOT a substring scan for the project id: the stamp is a compact
  // signed token (PRISM1.<payload>.<sig>.<keyId>) whose fields live inside a
  // base64url body, so grepping the raw bytes for a uuid finds nothing and
  // reports a working stamp as missing. readStamp locates it by its own prefix
  // and verifyStamp checks the Ed25519 signature — which is the property that
  // actually matters, since an unsigned stamp is a claim rather than evidence.
  const { readStamp } = await import('../src/lib/imageMetadata.js')
  const stampedRows = manifest.files.filter((r) => r.mediaType === 'PHOTO' && r.stamped)

  if (stampedRows.length === 0) {
    console.log('  (no stamped JPEG in this archive to check)')
  } else {
    let verified = 0
    let problems = []
    for (const row of stampedRows) {
      const bytes = await extract(buf, files.get(row.file))
      const result = await readStamp(bytes)
      if (!result.found) {
        problems.push(`${row.file}: ${result.reason}`)
        continue
      }
      if (!result.valid) {
        problems.push(`${row.file}: signature ${result.reason}`)
        continue
      }
      // The stamp has to agree with the manifest, or one of the two is lying.
      const p = result.payload ?? {}
      const refsMatch =
        JSON.stringify([...(p.subjectRefs ?? [])].sort()) ===
        JSON.stringify([...(row.subjectRefs ?? [])].sort())
      if (p.projectId !== manifest.project.id) problems.push(`${row.file}: projectId disagrees`)
      else if (p.captureSessionId !== row.captureSessionId) problems.push(`${row.file}: session disagrees`)
      else if (!refsMatch) problems.push(`${row.file}: subjectRefs disagree`)
      else verified += 1
    }

    if (problems.length === 0) {
      ok(`all ${verified} stamped photo(s) carry a valid Ed25519 stamp agreeing with the manifest`)
      const sample = await readStamp(await extract(buf, files.get(stampedRows[0].file)))
      console.log(`  stamp payload: ${JSON.stringify(sample.payload)}`)
    } else {
      bad(`${problems.length} stamp problem(s): ${problems.slice(0, 3).join(' | ')}`)
    }
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`)
  process.exit(1)
})
