import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger.js'
import { resolvePath } from './storage.js'
import { normalise, loadReferencedPaths } from './blobLifecycle.js'

// Walking the filesystem, rather than walking database rows.
//
// This is the whole answer to the finding. `discovery.service.js:153` and
// `purge.service.js:148` both enumerate a subject's blobs by reading the rows
// that point at them — so a file whose row is gone is invisible to discovery and
// unreachable by purge. 1,123 files (265 MB) were in exactly that state,
// including 383 cropped faces and 135 enrolment selfies, and an erasure could
// complete, a certificate be signed, and 518 biometric files remain on disk.
//
// A row-based test cannot catch a row-based bug. The only check that can is one
// that reads the disk.

const ROOT = process.env.STORAGE_ROOT ?? './storage/media'

/**
 * Every file under the media root, as normalised relative paths.
 *
 * @param {object} [options]
 * @param {string} [options.prefix] restrict the walk to one subtree.
 */
export async function listStoredFiles({ prefix } = {}) {
  const base = prefix ? path.join(ROOT, prefix) : ROOT
  const files = []

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        files.push(normalise(path.relative(ROOT, full)))
      }
    }
  }

  await walk(base)
  return files
}

/**
 * Every path prefix under which a subject's bytes could live.
 *
 * Deliberately broader than what discovery enumerates from rows: the point is to
 * find what the rows do not know about. It includes the per-subject enrolment
 * prefixes and, for the session-scoped media, every session the subject appeared
 * in — because a crop of their face lives under the SESSION's prefix, not
 * theirs, which is precisely why row-based discovery loses track of it.
 */
export async function subjectPathPrefixes(prisma, subjectId) {
  const [links, enrollments, voice, sessions] = await Promise.all([
    prisma.photoSubject.findMany({
      where: { subjectId },
      select: { photo: { select: { sessionId: true } } },
    }),
    prisma.subjectFaceEnrollment.findMany({ where: { subjectId }, select: { imagePath: true } }),
    prisma.subjectVoiceEnrollment.findMany({ where: { subjectId }, select: { audioPath: true } }),
    prisma.sessionParticipant.findMany({ where: { subjectId }, select: { sessionId: true } }),
  ])

  const sessionIds = new Set([
    ...links.map((l) => l.photo?.sessionId).filter(Boolean),
    ...sessions.map((s) => s.sessionId),
  ])

  return {
    // Files whose NAME contains the subject id — the per-person redacted cache
    // is written as `<photoId>.person-<subjectId>.jpg`, so a substring match is
    // the only way to find one whose row is gone.
    nameContains: [subjectId],
    prefixes: [
      `enrollments/${subjectId}`,
      `voice-enrollments/${subjectId}`,
      `subjects/${subjectId}`,
    ],
    sessionIds: [...sessionIds],
  }
}

/**
 * The same check, narrowed to one project.
 *
 * A project erasure deliberately leaves the subject's other projects, their
 * enrolments and their identity row intact, so `findSubjectResidue` is the wrong
 * question to ask about it: it sweeps every prefix for the subject and would
 * report the material this erasure was never meant to touch as residue.
 *
 * What IS residue at this scope: a file under one of THIS project's sessions that
 * carries the subject's id in its name and that no row references — the
 * per-person derivative cache (`<photoId>.person-<subjectId>.jpg`) being the case
 * that motivated the whole-subject sweep in the first place.
 *
 * Returns evidence, never deletes. Same contract as findSubjectResidue.
 */
export async function findProjectResidue(prisma, subjectId, projectId) {
  const sessions = await prisma.session.findMany({
    where: { projectId },
    select: { id: true },
  })
  if (sessions.length === 0) return []

  const { referenced } = await loadReferencedPaths()
  const prefixes = sessions.map((s) => normalise(`sessions/${s.id}`))

  // Walk each session subtree rather than the whole root: a project is a small
  // slice of a deployment's media, and the whole-root walk is the expensive part.
  const files = []
  for (const prefix of prefixes) {
    files.push(...(await listStoredFiles({ prefix })))
  }

  return files.filter((file) => {
    if (referenced.has(file)) return false
    // Only files that name the subject. A stray unreferenced blob belonging to
    // someone else in the same session is a real problem, but it is not THIS
    // principal's erasure being incomplete, and refusing their certificate over
    // it would be both wrong and unfixable by them.
    return file.includes(subjectId)
  })
}

/**
 * Files on disk that could belong to this subject and that no row references.
 *
 * This is the erasure-completeness check. It returns the evidence, it does not
 * delete: deciding to destroy bytes on the strength of a heuristic name match is
 * a human's call, and the reaper's quarantine step is where that happens.
 */
export async function findSubjectResidue(prisma, subjectId) {
  const { referenced } = await loadReferencedPaths()
  const { nameContains, prefixes } = await subjectPathPrefixes(prisma, subjectId)
  const files = await listStoredFiles()

  const residue = files.filter((file) => {
    if (referenced.has(file)) return false
    if (prefixes.some((p) => file.startsWith(normalise(p)))) return true
    if (nameContains.some((needle) => file.includes(needle))) return true
    return false
  })

  return residue
}

/**
 * Every file on disk that no row anywhere references.
 *
 * `loadReferencedPaths` throws rather than returning a short list if it cannot
 * read a model, and that behaviour is load-bearing: a partial reference set
 * would classify live media as orphaned, and an orphan sweep that deletes
 * referenced media is far worse than the orphans it was cleaning up.
 */
export async function findOrphans() {
  const { referenced, rowsRead } = await loadReferencedPaths({ assertComplete: true })
  const files = await listStoredFiles()

  if (rowsRead === 0 && files.length > 0) {
    // Every path column empty while the disk is full means the read failed, not
    // that the database is empty. Refusing here is the difference between a
    // no-op and deleting the entire media store.
    throw new Error(
      `Refusing to sweep: ${files.length} files on disk but not one referenced path was read. ` +
        'This looks like a failed read, not an empty database.',
    )
  }

  const orphans = files.filter((f) => !referenced.has(f))

  let bytes = 0
  const sized = []
  for (const file of orphans) {
    try {
      const stat = await fs.stat(resolvePath(file))
      bytes += stat.size
      sized.push({ path: file, sizeBytes: stat.size })
    } catch {
      sized.push({ path: file, sizeBytes: null })
    }
  }

  logger.info(
    { files: files.length, referenced: referenced.size, orphans: orphans.length, bytes },
    'storage sweep',
  )

  return { orphans: sized, totalFiles: files.length, referencedCount: referenced.size, bytes }
}

/**
 * Rows whose blob is missing from disk — the mirror problem.
 *
 * 167 of these existed, 88 of them SubjectDataItem rows, which is the DSAR
 * index. So a DSAR access package either failed at read time or silently
 * shipped short, while `totals.all` — the completeness claim the grid renders —
 * counted items that could not be produced.
 */
export async function findDanglingReferences() {
  const { referenced } = await loadReferencedPaths()
  const files = new Set(await listStoredFiles())

  const dangling = [...referenced].filter((p) => !files.has(p))
  return dangling
}
