import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A grep test, and deliberately so.
//
// The nine sites that decided "is this photo finished with redaction" each did
// it by listing the states they thought were bad. That is not a bug you fix
// once: the next person to add a query will write the same list, because the
// same list is what the surrounding code looks like. So the old form is banned
// in source, and lib/photoState.js is the only place allowed to name the
// statuses at all.
//
// What this cannot catch: a query that spells the same mistake differently
// (`NOT: { piiStatus: 'CLEAN' }`, a raw SQL string). It catches the copy-paste,
// which is how all nine of them got there.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')

// The one module that is allowed to enumerate PiiStatus values.
const ALLOWED = new Set([path.join(SRC, 'lib', 'photoState.js')])

const BANNED_FORMS = [
  {
    // piiStatus: { in: ['DEFERRED', 'FAILED'] }  and its notIn/array variants
    pattern: /piiStatus\s*:\s*\{\s*(?:not)?[iI]n\s*:\s*\[[^\]]*['"](?:DEFERRED|FAILED|PENDING)['"]/,
    why: "enumerates PiiStatus values in a Prisma filter — use UNRESOLVED_PHOTO_WHERE / RESOLVED_PHOTO_WHERE from lib/photoState.js",
  },
  {
    // ['DEFERRED', 'FAILED'].includes(photo.piiStatus)
    pattern: /\[[^\]]*['"](?:DEFERRED|FAILED)['"][^\]]*\]\s*\.includes\s*\(\s*[A-Za-z_$][\w$.]*\.piiStatus/,
    why: 'tests piiStatus against a literal list — use isResolved()/isUnresolved() from lib/photoState.js',
  },
  {
    // (counts.PENDING ?? 0) + (counts.DEFERRED ?? 0) + (counts.FAILED ?? 0)
    //
    // The reporting spelling of the same mistake, and the one that survived the
    // first pass of this fix: two dashboards had already been widened to add
    // PENDING, which reads as correct and still drops the next enum value on the
    // floor. It is banned in the same breath as the query forms.
    pattern: /(?:PENDING|DEFERRED|FAILED)\s*\?\?\s*0\s*\)?\s*\+/,
    why: 'sums PiiStatus buckets by name — use countBlockedFrames() from lib/photoState.js',
  },
  {
    // piiStatus === 'DEFERRED' || piiStatus === 'FAILED'
    pattern: /\.piiStatus\s*===\s*['"](?:DEFERRED|FAILED)['"]\s*\|\|\s*[^\n]*\.piiStatus\s*===\s*['"](?:DEFERRED|FAILED)['"]/,
    why: 'ORs two piiStatus comparisons — use isUnresolved() from lib/photoState.js',
  },
]

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.js')) yield full
  }
}

// Comments in this codebase explain the states at length and must stay readable,
// so they are stripped before matching rather than allowlisted one by one.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('no module outside lib/photoState.js enumerates PiiStatus values', async () => {
  const violations = []

  for await (const file of walk(SRC)) {
    if (ALLOWED.has(file)) continue
    const code = stripComments(await readFile(file, 'utf8'))

    for (const { pattern, why } of BANNED_FORMS) {
      const lines = code.split('\n')
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          violations.push(`${path.relative(SRC, file)}:${i + 1} — ${why}\n    ${line.trim()}`)
        }
      })
      // Multi-line spellings of the same filter, e.g. a `where: {` broken across
      // lines by the formatter.
      if (pattern.test(code.replace(/\s+/g, ' ')) && !lines.some((l) => pattern.test(l))) {
        violations.push(`${path.relative(SRC, file)} — ${why} (spans multiple lines)`)
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Enumerated PiiStatus checks found. Every one of these silently omits PENDING,\n` +
      `the schema default and the state an un-run redaction leaves behind:\n\n` +
      violations.join('\n'),
  )
})

test('lib/photoState.js is where the terminal list actually lives', async () => {
  const source = await readFile(path.join(SRC, 'lib', 'photoState.js'), 'utf8')
  assert.match(source, /TERMINAL_PII_STATUSES/)
  assert.match(source, /'CLEAN'/)
  assert.match(source, /'MASKED'/)
  // The reporting counterpart lives here too, so the dashboards have
  // something to call instead of re-listing the enum.
  assert.match(source, /export function countBlockedFrames/)
})
