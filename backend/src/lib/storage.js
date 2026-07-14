import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.env.STORAGE_ROOT ?? './storage/media'

// Local-disk implementation of the media store, swappable for MinIO/S3 later —
// every caller goes through these four functions and never touches fs directly.
export function resolvePath(relativePath) {
  return path.join(ROOT, relativePath)
}

export async function writeFile(relativePath, buffer) {
  const fullPath = path.join(ROOT, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, buffer)
  return fullPath
}

export async function readFile(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath))
}

export async function deleteFile(relativePath) {
  await fs.rm(path.join(ROOT, relativePath), { force: true })
}
