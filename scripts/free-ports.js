#!/usr/bin/env node
// Kills whatever is listening on the dev ports so `npm run up` starts from a
// clean slate instead of failing on EADDRINUSE — the usual cause being a
// previous run's processes left behind in another terminal.
//
// Deliberately conservative: a PID is only killed if it looks like a Node
// process. Something else on 4000 is far more likely to be a service the user
// cares about than a stale portal, so it is reported and left alone.
import { execFileSync } from 'node:child_process'

const PORTS = [4000, 5173, 5180]
const isWin = process.platform === 'win32'

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function listenersOn(port) {
  const pids = new Set()
  if (isWin) {
    for (const line of run('netstat', ['-ano']).split('\n')) {
      if (!line.includes('LISTENING')) continue
      const cols = line.trim().split(/\s+/)
      const local = cols[1] ?? ''
      // Match the port exactly — ":5173" must not also match ":51730".
      if (!new RegExp(`:${port}$`).test(local)) continue
      const pid = Number(cols.at(-1))
      if (Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
  } else {
    for (const pid of run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')) {
      const n = Number(pid.trim())
      if (Number.isInteger(n) && n > 0) pids.add(n)
    }
  }
  return [...pids]
}

function describe(pid) {
  if (isWin) {
    const row = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'])
    return (row.match(/^"([^"]+)"/) ?? [])[1] ?? 'unknown'
  }
  return run('ps', ['-p', String(pid), '-o', 'comm=']).trim() || 'unknown'
}

let killed = 0
for (const port of PORTS) {
  for (const pid of listenersOn(port)) {
    if (pid === process.pid) continue
    const name = describe(pid)
    if (!/^node(\.exe)?$/i.test(name)) {
      console.log(`  port ${port}: PID ${pid} is "${name}", not node — leaving it alone`)
      continue
    }
    try {
      if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(pid, 'SIGKILL')
      console.log(`  port ${port}: stopped node PID ${pid}`)
      killed++
    } catch (err) {
      console.log(`  port ${port}: could not stop PID ${pid} — ${err.message}`)
    }
  }
}
console.log(killed ? `Freed ${PORTS.join(', ')}.` : `Ports ${PORTS.join(', ')} already free.`)
