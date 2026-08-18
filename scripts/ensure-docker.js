#!/usr/bin/env node
// `docker` being on PATH says nothing about the daemon being up — Docker
// Desktop installs the CLI and exits, and a stopped daemon fails compose with
// an npipe/socket error that reads like a broken install rather than "not
// started". This starts it and waits, so `npm run up` is one command even from
// a cold boot.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const TIMEOUT_MS = 180_000
const POLL_MS = 3_000

const daemonUp = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function desktopPath() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(homedir(), 'AppData', 'Local', 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
          'C:\Program Files\Docker\Docker\Docker Desktop.exe',
        ]
      : ['/Applications/Docker.app']
  return candidates.find((p) => existsSync(p))
}

if (daemonUp()) {
  console.log('Docker daemon is running.')
  process.exit(0)
}

const app = desktopPath()
if (!app) {
  console.error('Docker daemon is not running and Docker Desktop was not found.')
  console.error('Start Docker manually, then re-run `npm run up`.')
  process.exit(1)
}

console.log('Docker daemon is not running — starting Docker Desktop...')
if (process.platform === 'win32') spawn(app, { detached: true, stdio: 'ignore' }).unref()
else spawn('open', ['-a', app], { detached: true, stdio: 'ignore' }).unref()

const deadline = Date.now() + TIMEOUT_MS
while (Date.now() < deadline) {
  await sleep(POLL_MS)
  if (daemonUp()) {
    console.log('Docker daemon is ready.')
    process.exit(0)
  }
  process.stdout.write('.')
}

console.error(
  `\nDocker did not become ready within ${TIMEOUT_MS / 1000}s. Open Docker Desktop and check for a ` +
    'prompt (WSL update, sign-in, or licence acceptance all block startup silently), then re-run `npm run up`.',
)
process.exit(1)
