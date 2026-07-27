#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { prisma } from '../src/config/prisma.js'
import { isSealed, readHeader, sealBlob } from '../src/lib/blobCrypto.js'
import {
  MissingKekError,
  derivePathKey,
  deriveProjectKey,
  getSubjectKey,
  kekAvailable,
  zeroKey,
} from '../src/lib/keyring.js'
import { decryptEmbedding, encryptEmbedding } from '../src/lib/embeddingCrypto.js'
import { scopeForPath } from '../src/lib/storage.js'

// One-shot backfill: seal every plaintext blob written before envelope
// encryption existed, and stamp the keyId on the row that owns it.
//
// Idempotent and resumable, by construction rather than by bookkeeping:
//   * "already done" is a property of the bytes on disk (the PRSM magic), not a
//     checkpoint file that can disagree with reality after a crash;
//   * each file is sealed into a sibling temp file and renamed over the original,
//     so a crash leaves either the intact plaintext (re-runs) or the finished
//     ciphertext (skipped) and never a half-written blob;
//   * the DB stamp is derived from the file's own header, so the window between
//     "file sealed" and "row stamped" self-heals on the next run.
//
// This is the one place in the codebase allowed to touch `fs` directly: it has to
// read bytes that lib/storage.js would try to decrypt, and write bytes that
// lib/storage.js would try to encrypt a second time.

const ROOT = process.env.STORAGE_ROOT ?? './storage/media'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const VERBOSE = args.includes('--verbose')
const LIMIT = (() => {
  const flag = args.find((a) => a.startsWith('--limit='))
  return flag ? Number.parseInt(flag.split('=')[1], 10) : Infinity
})()
const ONLY = (() => {
  const flag = args.find((a) => a.startsWith('--only='))
  return flag ? flag.split('=')[1].split(',') : null
})()

const stats = {
  photosSealed: 0,
  redactedSealed: 0,
  cropsSealed: 0,
  enrollmentsSealed: 0,
  embeddingsResealed: 0,
  orphansSealed: 0,
  alreadySealed: 0,
  stamped: 0,
  missing: 0,
  failed: 0,
}

let budget = LIMIT

function selected(section) {
  return !ONLY || ONLY.includes(section)
}

function log(...parts) {
  console.log(...parts)
}

function debug(...parts) {
  if (VERBOSE) console.log(...parts)
}

async function keyForRelative(relativePath, override) {
  const { scope, scopeId } = override ?? scopeForPath(relativePath)
  if (scope === 'subject') return getSubjectKey(scopeId)
  if (scope === 'project') return deriveProjectKey(scopeId)
  return derivePathKey(scopeId)
}

/**
 * @returns {Promise<{status:'sealed'|'already'|'missing'|'failed', keyId:string|null}>}
 */
async function sealInPlace(relativePath, scopeOverride) {
  const fullPath = path.join(ROOT, relativePath)

  let buffer
  try {
    buffer = await fs.readFile(fullPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      stats.missing += 1
      debug(`  missing  ${relativePath}`)
      return { status: 'missing', keyId: null }
    }
    throw error
  }

  if (isSealed(buffer)) {
    stats.alreadySealed += 1
    // Not a no-op: the row may still be unstamped from an interrupted run.
    return { status: 'already', keyId: readHeader(buffer).keyId }
  }

  if (budget <= 0) return { status: 'skipped', keyId: null }

  const { key, keyId } = await keyForRelative(relativePath, scopeOverride)
  if (DRY_RUN) {
    zeroKey(key)
    budget -= 1
    log(`  would seal ${relativePath} -> keyId ${keyId}`)
    return { status: 'sealed', keyId }
  }

  const tmpPath = `${fullPath}.sealing`
  try {
    const sealedBytes = sealBlob(buffer, key, keyId)
    const handle = await fs.open(tmpPath, 'w')
    try {
      await handle.writeFile(sealedBytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmpPath, fullPath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true })
    stats.failed += 1
    console.error(`  FAILED   ${relativePath}: ${error.message}`)
    return { status: 'failed', keyId: null }
  } finally {
    zeroKey(key)
  }

  budget -= 1
  debug(`  sealed   ${relativePath}`)
  return { status: 'sealed', keyId }
}

async function stampIfNeeded(model, where, currentKeyId, keyId) {
  if (DRY_RUN || !keyId || currentKeyId === keyId) return
  await model.update({ where, data: { encKeyId: keyId } })
  stats.stamped += 1
}

// --- L2 originals + L6/L7 derivatives -------------------------------------
async function migratePhotos() {
  const pageSize = 200
  let cursor

  for (;;) {
    const photos = await prisma.photo.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, storagePath: true, redactedPath: true, encKeyId: true },
    })
    if (photos.length === 0) break
    cursor = photos[photos.length - 1].id

    for (const photo of photos) {
      if (budget <= 0) return

      const original = await sealInPlace(photo.storagePath)
      if (original.status === 'sealed') stats.photosSealed += 1

      let derivativeKeyId = null
      if (photo.redactedPath) {
        const derivative = await sealInPlace(photo.redactedPath)
        if (derivative.status === 'sealed') stats.redactedSealed += 1
        derivativeKeyId = derivative.keyId
      }

      // Original and derivative live under the same session prefix and therefore
      // share a keyId; the derivative is only a fallback for rows whose original
      // has already been retention-swept off disk.
      await stampIfNeeded(prisma.photo, { id: photo.id }, photo.encKeyId, original.keyId ?? derivativeKeyId)
    }
  }
}

// --- L3 face crops ---------------------------------------------------------
async function migrateFaceCrops() {
  const pageSize = 500
  let cursor

  for (;;) {
    const faces = await prisma.faceDetection.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      where: { cropPath: { not: null } },
      select: { id: true, cropPath: true },
    })
    if (faces.length === 0) break
    cursor = faces[faces.length - 1].id

    for (const face of faces) {
      if (budget <= 0) return
      const result = await sealInPlace(face.cropPath)
      if (result.status === 'sealed') stats.cropsSealed += 1
    }
  }
}

// --- L4 enrollment selfies + L5 embeddings ---------------------------------
async function migrateEnrollments() {
  const pageSize = 200
  let cursor

  for (;;) {
    const enrollments = await prisma.subjectFaceEnrollment.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, subjectId: true, imagePath: true, embedding: true, encKeyId: true },
    })
    if (enrollments.length === 0) break
    cursor = enrollments[enrollments.length - 1].id

    for (const enrollment of enrollments) {
      if (budget <= 0) return

      // Selfies live at subjects/<uid>/..., so scopeForPath already resolves the
      // per-subject DEK; the override is here for rows whose imagePath predates
      // that layout.
      const selfie = await sealInPlace(enrollment.imagePath, {
        scope: 'subject',
        scopeId: enrollment.subjectId,
      })
      if (selfie.status === 'sealed') stats.enrollmentsSealed += 1

      let keyId = selfie.keyId

      // Re-seal the embedding under the same per-subject DEK. Legacy rows were
      // encrypted with the global FACE_EMBEDDING_KEY, which is not shreddable —
      // that is the entire reason this row has to move.
      if (enrollment.embedding && !isSealed(Buffer.from(enrollment.embedding))) {
        if (!DRY_RUN) {
          const { key, keyId: subjectKeyId } = await getSubjectKey(enrollment.subjectId)
          try {
            // The plaintext vector exists only inside this expression and is
            // never logged, never returned, never written anywhere but back into
            // the same column.
            const resealed = encryptEmbedding(decryptEmbedding(Buffer.from(enrollment.embedding)), {
              key,
              keyId: subjectKeyId,
            })
            await prisma.subjectFaceEnrollment.update({
              where: { id: enrollment.id },
              data: { embedding: resealed, encKeyId: subjectKeyId },
            })
          } finally {
            zeroKey(key)
          }
          keyId = null // already stamped in the same update
        }
        stats.embeddingsResealed += 1
      } else if (enrollment.embedding) {
        keyId = keyId ?? readHeader(Buffer.from(enrollment.embedding))?.keyId ?? null
      }

      await stampIfNeeded(prisma.subjectFaceEnrollment, { id: enrollment.id }, enrollment.encKeyId, keyId)
    }
  }
}

// --- anything on disk the database does not know about ---------------------
// Per-person derivative caches (L7) and stale artifacts have no row to walk, so
// the last pass sweeps the tree. A blob nobody indexes is still a blob of faces.
async function migrateOrphans() {
  async function walk(relativeDir) {
    let entries
    try {
      entries = await fs.readdir(path.join(ROOT, relativeDir), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }

    for (const entry of entries) {
      if (budget <= 0) return
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        await walk(relative)
        continue
      }
      if (entry.name.endsWith('.sealing')) {
        // Debris from an interrupted run: the rename never happened, so the
        // original is intact and this is safe to drop.
        if (!DRY_RUN) await fs.rm(path.join(ROOT, relative), { force: true })
        continue
      }
      if (relative.startsWith('exports/') || relative.startsWith('dsar/')) continue

      const result = await sealInPlace(relative)
      if (result.status === 'sealed') stats.orphansSealed += 1
    }
  }

  await walk('')
}

async function main() {
  if (!kekAvailable()) throw new MissingKekError()

  log(`migrate-media-encrypt: root=${ROOT}${DRY_RUN ? ' (dry run)' : ''}${LIMIT === Infinity ? '' : ` limit=${LIMIT}`}`)

  if (selected('photos')) {
    log('photos (L2 originals, L6/L7 derivatives)…')
    await migratePhotos()
  }
  if (selected('crops')) {
    log('face crops (L3)…')
    await migrateFaceCrops()
  }
  if (selected('enrollments')) {
    log('enrollments (L4 selfies, L5 embeddings)…')
    await migrateEnrollments()
  }
  if (selected('orphans')) {
    log('unindexed blobs…')
    await migrateOrphans()
  }

  log('\nresult:')
  for (const [key, value] of Object.entries(stats)) log(`  ${key.padEnd(18)} ${value}`)

  if (budget <= 0) {
    log('\nlimit reached — re-run to continue. The sweep resumes where it stopped.')
  } else if (stats.failed === 0) {
    log('\nnothing left unsealed. Set MEDIA_REQUIRE_SEALED=on to make plaintext blobs a hard error.')
  }

  if (stats.failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
