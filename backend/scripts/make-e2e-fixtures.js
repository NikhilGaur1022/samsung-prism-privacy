#!/usr/bin/env node
/**
 * Derives the three images the end-to-end suite needs from real media already on
 * this machine.
 *
 * The e2e tests exercise a face pipeline. Synthetic images do not work — ArcFace
 * detects nothing in a drawn face, so a test built on generated pixels would pass
 * while proving nothing. Real photographs are therefore required, and real
 * photographs of identifiable people must not be committed to the repository of a
 * privacy product. So: they are derived locally, written to a gitignored
 * directory, and rebuilt with this script rather than checked in.
 *
 *   solo-a.jpg   exactly one face          — person A alone
 *   group.jpg    exactly two faces         — person A and person B together
 *   enroll-b.jpg the second face, cropped  — person B's enrollment selfie
 *
 * Person A's enrollment selfie is solo-a.jpg itself: enrolling from the same
 * frame that appears in the session makes the match score deterministic, which is
 * what a test needs. The pipeline being tested is the lifecycle, not the
 * recogniser's tolerance for pose.
 *
 * Source: backend/storage/media — the local media root. Nothing is downloaded and
 * nothing leaves the machine.
 *
 * Usage: node scripts/make-e2e-fixtures.js [--source <dir>] [--out <dir>]
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

import { isSealed, openBlob, readHeader } from '../src/lib/blobCrypto.js'
import { derivePathKey, kekAvailable } from '../src/lib/keyring.js'
import { scopeForPath } from '../src/lib/storage.js'

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'
const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : args[i + 1]
}

const SOURCE = path.resolve(argOf('--source', 'storage/media'))
const OUT = path.resolve(argOf('--out', 'tests/fixtures'))
const CROP_PADDING = 0.45

async function detect(buffer, filename) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename)
  const res = await fetch(`${FACE_SERVICE_URL}/detect`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`face service ${res.status}: ${await res.text()}`)
  return (await res.json()).faces ?? []
}

const cosine = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0)

// The corpus under STORAGE_ROOT is sealed once MEDIA_KEK is set and the
// migrate-media-encrypt sweep has run, so a bare fs read here would hand the face
// service ciphertext and find no faces at all. Unseal with the same path-scoped
// key storage.js would have used, rather than routing through storage.readFile —
// --source may point somewhere that is not STORAGE_ROOT.
async function readMedia(absolutePath, relativePath) {
  const buffer = await readFile(absolutePath)
  if (!isSealed(buffer)) return buffer
  if (!kekAvailable()) {
    throw new Error(
      `${relativePath} is sealed but MEDIA_KEK is unset — export it before rebuilding fixtures`,
    )
  }
  const { scopeId } = scopeForPath(relativePath)
  const { key, keyId } = derivePathKey(scopeId)
  return openBlob(buffer, key, readHeader(buffer).keyId ?? keyId)
}

async function* candidates(root) {
  let sessions = []
  try {
    sessions = await readdir(path.join(root, 'sessions'))
  } catch {
    return
  }
  for (const session of sessions) {
    const dir = path.join(root, 'sessions', session, 'photos')
    let files = []
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const file of files) yield path.join(dir, file)
  }
}

async function main() {
  const seenHashes = new Set()
  const solos = []
  const pairs = []

  for await (const file of candidates(SOURCE)) {
    // The same photo is copied under several session directories. Its basename is
    // its content sha256, so dedupe on that and skip the repeats.
    const key = path.basename(file)
    if (seenHashes.has(key)) continue
    seenHashes.add(key)

    let buffer
    let faces
    try {
      buffer = await readMedia(file, path.relative(SOURCE, file))
      faces = await detect(buffer, key)
    } catch (err) {
      console.error(`  ! ${key}: ${err.message}`)
      continue
    }

    if (faces.length === 1) solos.push({ file, buffer, faces })
    if (faces.length === 2) pairs.push({ file, buffer, faces })
  }

  if (!solos.length) throw new Error('no single-face photo found under ' + SOURCE)
  if (!pairs.length) throw new Error('no two-face photo found under ' + SOURCE)

  const area = (f) => (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])

  // Ranked, not picked outright: the crop of person B has to survive re-detection,
  // and whether it does depends on how many pixels their face occupies. Try the
  // roomiest candidates first and fall through on failure rather than declaring
  // the first choice the only choice.
  const ranked = pairs
    .filter((p) => cosine(p.faces[0].embedding, p.faces[1].embedding) < 0.42)
    .map((p) => ({ ...p, smallestFace: Math.min(area(p.faces[0]), area(p.faces[1])) }))
    .sort((a, b) => b.smallestFace - a.smallestFace)

  if (!ranked.length) {
    throw new Error('every two-face photo holds the same person twice — need two distinct people')
  }

  const failures = []

  for (const pair of ranked) {
    // Person A is whoever in the pair also appears alone somewhere — that solo shot
    // becomes A's enrollment and A's session photo.
    let soloA = null
    let personBIndex = null
    for (const solo of solos) {
      for (const [i, face] of pair.faces.entries()) {
        if (cosine(face.embedding, solo.faces[0].embedding) > 0.42) {
          soloA = solo
          personBIndex = 1 - i
          break
        }
      }
      if (soloA) break
    }

    if (!soloA) {
      failures.push(`${path.basename(pair.file)}: neither face appears in a solo photo`)
      continue
    }

    const enrollB = await cropForEnrollment(pair.buffer, pair.faces[personBIndex].bbox)

    // The crop must still be a detectable face, or the enrollment silently produces
    // no embedding and the roster is empty at match time — the exact failure this
    // project already hit once in production.
    const enrollFaces = await detect(enrollB, 'enroll-b.jpg')
    if (enrollFaces.length !== 1) {
      failures.push(
        `${path.basename(pair.file)}: person-B crop re-detected as ${enrollFaces.length} faces`,
      )
      continue
    }

    await mkdir(OUT, { recursive: true })
    await writeFile(path.join(OUT, 'solo-a.jpg'), soloA.buffer)
    await writeFile(path.join(OUT, 'group.jpg'), pair.buffer)
    await writeFile(path.join(OUT, 'enroll-b.jpg'), enrollB)

    console.log('wrote fixtures to', OUT)
    console.log('  solo-a.jpg   <-', soloA.file)
    console.log('  group.jpg    <-', pair.file)
    console.log('  enroll-b.jpg <- face', personBIndex, 'of group.jpg')
    return
  }

  throw new Error(
    `no usable two-person photo among ${ranked.length} candidates:\n  ` + failures.join('\n  '),
  )
}

async function cropForEnrollment(buffer, bbox) {
  const meta = await sharp(buffer).metadata()
  const [x1, y1, x2, y2] = bbox
  const w = x2 - x1
  const h = y2 - y1
  const left = Math.max(0, Math.round(x1 - w * CROP_PADDING))
  const top = Math.max(0, Math.round(y1 - h * CROP_PADDING))
  const width = Math.min(meta.width - left, Math.round(w * (1 + CROP_PADDING * 2)))
  const height = Math.min(meta.height - top, Math.round(h * (1 + CROP_PADDING * 2)))

  return sharp(buffer)
    .extract({ left, top, width: Math.max(1, width), height: Math.max(1, height) })
    // Upscaled rather than squashed to a fixed square: the detector wants enough
    // pixels on the face, and distorting the aspect ratio costs more than it buys.
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 95 })
    .toBuffer()
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
