#!/usr/bin/env node
/**
 * Writes every .env this project needs, with fresh secrets.
 *
 * The alternative — committing the working .env files — would put the media
 * key-encrypting-key and the DSAR signing seed into git history. The first
 * decrypts every photo, recording and face embedding the platform holds; the
 * second forges deletion certificates and the provenance stamps embedded in
 * exported images. Git history is permanent, so that is a one-way door.
 *
 * This gets a reviewer to the same working state without it: the non-secret
 * configuration is committed in env/*.example and already correct, and the six
 * values that must never be shared are minted here, per machine.
 *
 * Usage:
 *   node scripts/setup-env.mjs            # write any file that does not exist
 *   node scripts/setup-env.mjs --force    # overwrite, backing up what is there
 *   node scripts/setup-env.mjs --check    # report status, write nothing
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const CHECK = args.includes('--check')

/** template in env/ -> where it has to land for the app to read it */
const TARGETS = [
  ['backend.env.example', 'backend/.env'],
  ['admin-portal.env.example', 'admin-portal/.env'],
  ['user-portal.env.example', 'user-portal/.env'],
  ['audio-worker.env.example', 'ai-core/audio-worker/.env'],
]

/**
 * 32 bytes for the key material, 48 for the HMAC and JWT secrets.
 *
 * base64 rather than hex for the keys because MEDIA_KEK is decoded as base64,
 * and base64url for the token secrets so nothing in them can terminate a line
 * or need escaping in a .env parser.
 */
const SECRETS = {
  MEDIA_KEK: () => randomBytes(32).toString('base64'),
  DSAR_SIGNING_SEED: () => randomBytes(32).toString('base64'),
  FACE_EMBEDDING_KEY: () => randomBytes(32).toString('base64'),
  JWT_ADMIN_SECRET: () => randomBytes(48).toString('base64url'),
  JWT_SUBJECT_SECRET: () => randomBytes(48).toString('base64url'),
  AUDIT_HMAC_SECRET: () => randomBytes(48).toString('base64url'),
}

const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

/** Replaces every GENERATE placeholder with a fresh value. */
function fillSecrets(text) {
  let out = text
  const minted = []
  for (const [name, make] of Object.entries(SECRETS)) {
    const pattern = new RegExp(`^${name}="GENERATE"`, 'm')
    if (pattern.test(out)) {
      out = out.replace(pattern, `${name}="${make()}"`)
      minted.push(name)
    }
  }
  return { out, minted }
}

function main() {
  console.log('\nPRISM environment setup\n')

  let wrote = 0
  let skipped = 0
  const mintedAll = new Set()

  for (const [template, target] of TARGETS) {
    const src = path.join(ROOT, 'env', template)
    const dst = path.join(ROOT, target)

    if (!existsSync(src)) {
      console.log(`  ${yellow('!')} ${target.padEnd(32)} template missing (${template})`)
      continue
    }

    const exists = existsSync(dst)

    if (CHECK) {
      console.log(`  ${exists ? green('✓') : yellow('·')} ${target.padEnd(32)} ${exists ? 'present' : 'not created yet'}`)
      continue
    }

    if (exists && !FORCE) {
      console.log(`  ${dim('·')} ${target.padEnd(32)} ${dim('exists, left alone')}`)
      skipped += 1
      continue
    }

    // Never destroy a working configuration silently. --force is for replacing
    // a file you no longer want, not for losing the one you still need.
    if (exists && FORCE) {
      const backup = `${dst}.bak.${Date.now()}`
      copyFileSync(dst, backup)
      console.log(`  ${dim('·')} ${dim(`backed up existing to ${path.basename(backup)}`)}`)
    }

    const { out, minted } = fillSecrets(readFileSync(src, 'utf8'))
    writeFileSync(dst, out)
    minted.forEach((m) => mintedAll.add(m))
    console.log(`  ${green('✓')} ${target.padEnd(32)} written${minted.length ? ` (${minted.length} secrets minted)` : ''}`)
    wrote += 1
  }

  if (CHECK) {
    console.log('')
    return
  }

  console.log('')
  if (mintedAll.size) {
    console.log(`Minted ${mintedAll.size} secrets, unique to this machine:`)
    console.log(dim(`  ${[...mintedAll].join(', ')}`))
    console.log('')
  }
  if (skipped) {
    console.log(dim(`${skipped} file(s) already existed and were left alone. Use --force to replace them.`))
    console.log('')
  }

  console.log('One value cannot be generated, and nobody can share theirs:')
  console.log('')
  console.log('  HF_TOKEN in ai-core/audio-worker/.env')
  console.log(dim('    pyannote is licence-gated per Hugging Face account, so a borrowed'))
  console.log(dim('    token would not work for you. Accept the terms on both models, then'))
  console.log(dim('    create a read token:'))
  console.log(dim('      https://huggingface.co/pyannote/speaker-diarization-3.1'))
  console.log(dim('      https://huggingface.co/pyannote/segmentation-3.0'))
  console.log(dim('      https://huggingface.co/settings/tokens'))
  console.log('')
  console.log(dim('    Leave it empty to run without audio. Image, video and text are'))
  console.log(dim('    unaffected.'))
  console.log('')
  console.log('Email needs nothing: EXPOSE_DEV_OTP returns the sign-in code on screen.')
  console.log('')
  console.log('Next:')
  console.log('  1. docker compose --profile localdb up -d      (from backend/)')
  console.log('  2. npx prisma migrate deploy                    (from backend/)')
  console.log('  3. node backend/scripts/dev-seed-admins.js')
  console.log('  4. npm run dev                                  (from the root)')
  console.log('')
  console.log(dim('  Verify at any point with: node backend/scripts/preflight.js'))
  console.log('')

  if (wrote === 0 && skipped > 0) process.exit(0)
}

main()
