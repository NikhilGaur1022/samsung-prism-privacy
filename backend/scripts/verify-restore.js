import 'dotenv/config'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

import { readFile as readStoredFile } from '../src/lib/storage.js'
import { verifyCertificate } from '../src/modules/dsar/certificate.service.js'

// Does this restore actually work — and did it quietly undo an erasure?
//
// A restore that "succeeded" is not the same as a restore that produced a usable
// system, and in a privacy platform it is not even the same as a restore that
// was legal. Five questions, in the order that matters:
//
//   1. Do the keys I am holding match the ones this backup was taken with?
//   2. Is the sealed media byte-intact?
//   3. Can a real blob actually be opened?  <- the one that catches a lost KEK
//   4. Do the deletion certificates still verify?
//   5. Is everyone who was erased STILL erased?  <- the one nothing else catches
//
// Question 5 is the reason this script exists. Restoring a backup taken before
// an erasure brings that person back: their per-subject salt returns, their
// biometrics become readable, and the signed certificate saying they were
// destroyed becomes a false statement. Every other check in this file passes
// while that is true. The tombstone ledger — append-only, carried across
// backups, never rolled back with them — is the only thing that can see it.
//
// Usage:
//   node scripts/verify-restore.js --backup ./backups/<stamp>
//   node scripts/verify-restore.js --backup <dir> --ledger /path/to/tombstones.jsonl
//
// Exit code is the answer: 0 green, 1 red.

const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i === -1 ? null : args[i + 1]
}

const BACKUP = argValue('--backup')
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? './storage/media'

const prisma = new PrismaClient()
const results = []

// Three states, not two. A check that had nothing to look at did not pass - it
// abstained, and rolling that into the pass count is how a verifier ends up
// reporting GREEN on an empty system while proving nothing at all.
const PASS = 'pass'
const FAIL = 'fail'
const SKIP = 'skip'

function record(name, status, detail) {
  results.push({ name, status, detail })
  const badge = status === PASS ? ' ok ' : status === FAIL ? 'FAIL' : ' -- '
  console.log(`[ ${badge} ] ${name.padEnd(30)} ${detail}`)
}

function fingerprint(secret, label) {
  if (!secret) return null
  return createHash('sha256').update(`prism-key-fingerprint:${label}:`).update(secret).digest('hex').slice(0, 32)
}

// --- 1. keys ---------------------------------------------------------------

async function checkKeys(manifest) {
  const expected = manifest.keys.fingerprints
  const live = {
    MEDIA_KEK: process.env.MEDIA_KEK,
    MEDIA_KEK_PREVIOUS: process.env.MEDIA_KEK_PREVIOUS,
    FACE_EMBEDDING_KEY: process.env.FACE_EMBEDDING_KEY,
    DSAR_SIGNING_SEED: process.env.DSAR_SIGNING_SEED,
  }

  const wrong = []
  const missing = []

  for (const [name, expectedFp] of Object.entries(expected)) {
    if (!expectedFp) continue
    const actual = fingerprint(live[name], name)
    if (!actual) missing.push(name)
    else if (actual !== expectedFp) wrong.push(name)
  }

  if (missing.length || wrong.length) {
    const parts = []
    if (missing.length) parts.push(`not set: ${missing.join(', ')}`)
    if (wrong.length) parts.push(`WRONG KEY: ${wrong.join(', ')}`)
    record('keys-match-backup', FAIL, `${parts.join(' · ')} — media from this backup cannot be opened`)
    return false
  }

  const liveVersion = Number.parseInt(process.env.MEDIA_KEK_VERSION ?? '1', 10)
  if (liveVersion !== manifest.keys.kekVersion) {
    record(
      'keys-match-backup',
      FAIL,
      `KEK version is ${liveVersion}, backup was sealed at v${manifest.keys.kekVersion} — set MEDIA_KEK_PREVIOUS`,
    )
    return false
  }

  record('keys-match-backup', PASS, `all fingerprints match, KEK v${manifest.keys.kekVersion}`)
  return true
}

// --- 2. ciphertext integrity ----------------------------------------------

async function checkMediaChecksums(manifest) {
  // A backup taken with --skip-media has no media by design. Reporting that as
  // a failure trains people to ignore a red line, which is worse than the line
  // not being there.
  if (manifest.media?.skipped) {
    record('media-checksums', SKIP, 'backup was taken with --skip-media')
    return
  }

  let listing
  try {
    listing = await fs.readFile(path.join(BACKUP, 'media.sha256'), 'utf8')
  } catch {
    record('media-checksums', FAIL, 'no media.sha256, and the backup does not say media was skipped')
    return
  }

  const lines = listing.split('\n').filter((l) => l.trim())
  if (lines.length === 0) {
    record('media-checksums', SKIP, 'no media in this backup')
    return
  }

  let checked = 0
  const bad = []
  for (const line of lines) {
    const [digest, rel] = line.split(/\s{2,}/)
    if (!rel) continue
    try {
      const buf = await fs.readFile(path.join(BACKUP, 'media', rel))
      if (createHash('sha256').update(buf).digest('hex') !== digest) bad.push(rel)
    } catch {
      bad.push(`${rel} (missing)`)
    }
    checked += 1
  }

  record(
    'media-checksums',
    bad.length === 0 ? PASS : FAIL,
    bad.length === 0 ? `${checked} sealed files intact` : `${bad.length} of ${checked} corrupt or missing`,
  )
}

// --- 3. can a real blob be opened -----------------------------------------

/**
 * The check that a row-level restore verification cannot make.
 *
 * Everything else here can pass on a system whose KEK is gone: rows restore,
 * checksums match, certificates verify under a signing key derived from a
 * different source. Only actually decrypting something proves the media survived
 * as media rather than as noise.
 */
async function checkBlobDecrypts() {
  const candidates = await prisma.photo.findMany({
    where: { redactedPath: { not: null } },
    select: { id: true, redactedPath: true },
    take: 5,
  })

  if (candidates.length === 0) {
    record('blob-decrypts', SKIP, 'no media rows to sample')
    return
  }

  const opened = []
  const failed = []

  for (const photo of candidates) {
    try {
      const buf = await readStoredFile(photo.redactedPath)
      if (!buf || buf.length === 0) failed.push(`${photo.redactedPath} (empty)`)
      else opened.push(photo.redactedPath)
    } catch (err) {
      failed.push(`${photo.redactedPath}: ${err.message}`)
    }
  }

  if (opened.length === 0) {
    record('blob-decrypts', FAIL, `could not open any of ${candidates.length} sampled blobs — ${failed[0] ?? ''}`)
    return
  }

  record(
    'blob-decrypts',
    failed.length === 0 ? PASS : FAIL,
    failed.length === 0
      ? `${opened.length} sampled blobs decrypted and non-empty`
      : `${opened.length} opened, ${failed.length} failed — ${failed[0]}`,
  )
}

// --- 4. certificates still verify -----------------------------------------

async function checkCertificates() {
  const certs = await prisma.deletionCertificate.findMany({
    select: { id: true },
    orderBy: { issuedAt: 'desc' },
    take: 10,
  })

  if (certs.length === 0) {
    record('certificates-verify', SKIP, 'no certificates issued yet - nothing verified')
    return
  }

  const bad = []
  for (const cert of certs) {
    try {
      const result = await verifyCertificate(cert.id)
      if (!result?.valid) {
        // Distinguish the two failures, because they mean different things: a
        // hash mismatch is a tampered or corrupted payload, a signature failure
        // under a matching keyId is a wrong signing key.
        const why = !result?.hashMatches
          ? 'payload hash mismatch'
          : !result?.keyMatches
            ? `issued under signing key ${result.signingKeyId}, current is ${result.currentKeyId}`
            : 'signature does not verify'
        bad.push(`${cert.id}: ${why}`)
      }
    } catch (err) {
      bad.push(`${cert.id}: ${err.message}`)
    }
  }

  record(
    'certificates-verify',
    bad.length === 0 ? PASS : FAIL,
    bad.length === 0 ? `${certs.length} certificates verify` : `${bad.length} failed — ${bad[0]}`,
  )
}

// --- 5. did the restore resurrect anyone ----------------------------------

/**
 * The compliance landmine.
 *
 * Erase someone in March, restore a February backup in June, and their key
 * material is back. Their face data is readable again. Your signed certificate
 * says it was destroyed. That is a reportable breach that looks exactly like a
 * routine recovery, and it produces no error anywhere.
 *
 * The ledger is read from the LIVE path by default, not from inside the backup:
 * the copy inside the backup is as old as the backup, which is the very thing
 * being guarded against. `--ledger` overrides it for a rehearsal.
 */
async function checkNoResurrection(ledgerPath) {
  let raw
  try {
    raw = await fs.readFile(ledgerPath, 'utf8')
  } catch {
    record(
      'erased-stay-erased',
      FAIL,
      `no erasure ledger at ${ledgerPath} — cannot prove the restore did not undo an erasure`,
    )
    return
  }

  const tombstoned = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

  if (tombstoned.length === 0) {
    record('erased-stay-erased', SKIP, 'nobody has been erased yet - nothing to resurrect')
    return
  }

  const ids = tombstoned.map((t) => t.subjectId)
  const live = await prisma.subjectKey.findMany({
    where: { subjectId: { in: ids }, destroyedAt: null },
    select: { subjectId: true },
  })

  // A salt that came back is the actual resurrection: the key is derivable again.
  const withSalt = await prisma.subjectKey.findMany({
    where: { subjectId: { in: ids }, salt: { not: null } },
    select: { subjectId: true },
  })

  const resurrected = new Set([...live.map((r) => r.subjectId), ...withSalt.map((r) => r.subjectId)])

  if (resurrected.size > 0) {
    record(
      'erased-stay-erased',
      FAIL,
      `${resurrected.size} of ${tombstoned.length} erased subject(s) CAME BACK — re-erase immediately`,
    )
    console.log('\n  Subjects whose erasure this restore undid:')
    for (const id of resurrected) {
      const t = tombstoned.find((x) => x.subjectId === id)
      console.log(`    ${id}  erased ${t?.destroyedAt ?? 'unknown'}`)
    }
    console.log('')
    return
  }

  record('erased-stay-erased', PASS, `all ${tombstoned.length} tombstoned subjects remain destroyed`)
}

// --- main ------------------------------------------------------------------

async function main() {
  if (!BACKUP) {
    console.error('usage: node scripts/verify-restore.js --backup <dir> [--ledger <path>]')
    process.exitCode = 1
    return
  }

  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(path.join(BACKUP, 'MANIFEST.json'), 'utf8'))
  } catch {
    console.error(`No MANIFEST.json in ${BACKUP} — is that a backup directory?`)
    process.exitCode = 1
    return
  }

  console.log(`\nverifying restore against ${BACKUP}`)
  console.log(`backup taken ${manifest.createdAt}${manifest.gitCommit ? ` at ${manifest.gitCommit}` : ''}\n`)

  const ledgerPath =
    argValue('--ledger') ??
    manifest.tombstones?.ledgerPath ??
    path.join(path.dirname(STORAGE_ROOT), 'erasure-tombstones.jsonl')

  const keysOk = await checkKeys(manifest)
  await checkMediaChecksums(manifest)

  // Without the right keys, decryption failing tells you nothing you did not
  // already know, and reporting it twice buries the real cause.
  if (keysOk) await checkBlobDecrypts()
  else record('blob-decrypts', FAIL, 'skipped — the keys are wrong, so this cannot pass')

  await checkCertificates()
  await checkNoResurrection(ledgerPath)

  const passed = results.filter((r) => r.status === PASS).length
  const failed = results.filter((r) => r.status === FAIL).length
  const skipped = results.filter((r) => r.status === SKIP).length

  console.log('')
  console.log(`${results.length} checks - ${passed} passed, ${failed} failed, ${skipped} had nothing to check`)
  if (skipped) {
    console.log('')
    console.log('  A check with nothing to look at is not a check that passed. These go live')
    console.log('  on a system with real certificates and real erasures; until then this run')
    console.log('  proves less than the pass count suggests.')
  }
  console.log('')
  console.log(`restore: ${failed === 0 ? (skipped ? 'GREEN (partial)' : 'GREEN') : 'RED'}`)
  console.log('')

  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((err) => {
    console.error(`\n${err.message}\n`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
