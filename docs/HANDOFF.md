# PRISM — final session handoff

**As of 2026-07-28.** Waves 0–6 are complete. The verification gate is green
(53/53). The code is committed. What remains is **environment work, a database
cleanup, and one final end-to-end test pass** — after which this ships.

This is intended to be the **last** handoff. The next session should finish §7,
run §8, and stop. Do not start new features.

> A hook truncates the Read tool on `docs/*.md` intermittently. If a doc reads as
> one line, `cat` it via Bash instead.

**Read order for a new session:** this file → `docs/DEPLOY.md` (go-live steps).
`docs/01_PRIVACY_DATAFLOW.md`, `02_ROLE_PERMISSION_MATRIX.md`,
`03_FILE_IMPLEMENTATION_PLAN.md`, `04_AGENT_EXECUTION_PLAN.md` are the spec —
open them to look up a rule, never to orient.

---

## 0. How to work this session — token discipline

The user has asked explicitly for token-efficient execution. These are not
suggestions.

### Use claude-mem for memory

`claude-mem` is installed and carries ~157k tokens of prior work at ~89%
compression. **Before investigating anything, search memory.**

```
mem-search skill              # semantic search over past sessions
get_observations([IDs])       # pull specific observations by ID
```

Session start injects an index of observation IDs with titles. Everything about
the six wave-5 bug fixes, the service topology, the Redis diagnosis and the
wave-6 endpoints is already in there. Re-deriving any of it by reading source
files is pure waste. The per-fact memory directory
(`~/.claude/projects/…/memory/MEMORY.md`) holds the durable cross-session facts;
`prism-wave5-gate-green.md` is the one to read first.

### Search order — cheapest first

1. **claude-mem** — has this already been established?
2. **GitNexus MCP** — `gitnexus_query({query:"concept"})`,
   `gitnexus_context({name:"symbol"})`. The index is **fresh** (1,972 symbols,
   5,513 relationships, 156 flows; re-run 2026-07-27). Pass
   `repo: "samsung project"` — multiple repos are indexed and it errors without
   it. This returns structure without reading files.
3. **Grep** with `output_mode:"files_with_matches"`, or content mode with a tight
   `head_limit`.
4. **Read** a specific line range (`offset`/`limit`), never a whole file.
5. Full-file read — last resort.

### Concrete techniques that saved the most last session

- **Never re-read a file you just edited.** Edit fails loudly if the match
  missed. Verification reads are the single largest avoidable cost.
- **Batch independent tool calls into one message.** Four service probes in one
  Bash call, not four calls.
- **Pipe long output through `tail`/`head`.** Test runs, DB queries, builds:
  `2>&1 | tail -20`. A full TAP dump is thousands of tokens to learn one number.
  Caveat learned the hard way: a buffering `grep` pipeline can hide a hang — for
  long runs, write TAP to a file and tail the file.
- **Query the DB with one `node -e` that prints a single JSON line**, not several
  round trips. Ask for counts, not rows: `count()` over `findMany()`.
- `git diff --stat` before `git diff`.

### When to use a subagent — and when not to

Agents cost a **cold start**: they re-derive context this session already holds.
That is the expensive path. The rule the user gave:

> **Never hand an important task to an agent. Use agents only when they are
> genuinely token-cheaper.**

**Worth delegating** (bounded, mechanical, verifiable by a build or a test):
- Mechanical portal rewiring against an already-decided API contract.
- Doc rewrites where every fact is supplied in the prompt.
- Wide fan-out searching (`Explore`) where only the conclusion is needed.

**Never delegate:**
- Anything touching consent, erasure, access logging, RBAC, or crypto.
- The final test gate, the merge, the DB cleanup, the production role switch.
- Anything §5 lists as "ask before doing".

**Verify agent output.** Last session an agent deleted the DPO's audit-entry list
from `ComplianceReports.jsx` on the theory that the new report replaced it. It
did not — `/audit-logs` is dataAdmin-only in `admin-portal/src/roles.js`, so that
list was the DPO's *only* view of individual ledger rows. Two agent claims about
the docs were also wrong (see §3). Agents are cheap labour, not cheap judgement.

---

## 1. Verification gate — green

```
cd backend && LOG_LEVEL=silent RBAC_REQUEST_TIMEOUT_MS=8000 npm test
→ # tests 53 / # pass 53 / # fail 0 / exit 0   (~240s)
```

| Suite | Tests | Covers |
|---|---|---|
| `tests/e2e/full-lifecycle.test.js` | 11 | notice → project → approval → consent → enrolment → capture → recognition → tagging → finalize → redaction → handoff |
| `tests/e2e/dsar-erasure.test.js` | 10 | erasure on a photo holding two people; certificate; withdrawal-triggered erasure |
| `tests/e2e/rights-surface.test.js` | 12 | **new** — §11 access surface, project-oversight scoping, vault payload leaks, break-glass targeting, package-token single use |
| `tests/security/rbac-matrix.test.js` | 4 | all **114** mounted routes × 7 principals against matrix §B |
| `tests/security/crypto.test.js` | 9 | envelope encryption, shredding, crypto-shred |
| `tests/security/audit-chain.test.js` | 7 | HMAC chain, RLS append-only |

Scripts: `npm test`, `test:security`, `test:e2e`, `fixtures:e2e`, `preflight`,
`bootstrap-admin`, `worker:start`, `worker:redaction`, `worker:purge`,
`worker:retention`. There is no `worker:recognition` script — `worker:start` *is*
that worker (`worker` is the same file under `--watch` for dev). Full inventory
in §10.

### Five services must be up or the e2e suites fail loudly

| Service | Start command | Port |
|---|---|---|
| Postgres | Supabase `wblmtdrcohhjfyqvvobl` — remote, `.env` points at it | — |
| Redis | `C:\Users\gaur3\redis\redis-server.exe --port 6379 --save "" --appendonly no` | 6379 |
| Qdrant | `C:\Users\gaur3\Desktop\qdrant-portable\qdrant.exe` | 6333 |
| face-worker | `face-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8001` | 8001 |
| image-pii-worker | `ai-core/image-pii-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8002` | 8002 |

Start them with PowerShell `Start-Process`. The suites fail in a `before` hook
rather than skipping — a green "0 tests" is the worst result a compliance gate
can give.

Two full-suite runs stalled past 600s last session. The cause was **not code**:
Redis had died mid-session and both Python workers with it. **Check the five
ports before blaming a test:**

```bash
~/redis/redis-cli.exe ping                       # PONG  (note: local redis-cli has no -t flag)
curl -s -m 2 localhost:6333/healthz localhost:8001/health localhost:8002/health
```

### Fixtures

`backend/tests/fixtures/{solo-a,group,enroll-b}.jpg` are **not committed**
(`.gitignore` excludes `*.jpg`). Rebuild with `npm run fixtures:e2e`, which
derives them from real photos in `backend/storage/media`. Synthetic images are
useless — ArcFace detects nothing in them.

---

## 2. The ten invariants — enforcement and proof

| # | Invariant | Enforced in | Proven by |
|---|---|---|---|
| 1 | No mock/seed/dummy data anywhere | seed scripts + `admin-portal/src/data/` deleted | `preflight` check `no-mock-data` — **scans code only, not the DB. See §6.1** |
| 2 | `project_consent_matrix` is the sole consent authority | `finalizeSession`, purge, DSAR read only `ProjectConsent` | lifecycle test 3 |
| 3 | Embeddings never leave the process | explicit `select`s; encrypted column | lifecycle test 7; rbac test 3 |
| 4 | `Photo.storagePath` never overwritten | `redactBystanders` always writes a new object | lifecycle test 5 |
| 5 | Erasure is per `PhotoSubject` link, never per photo | `purge.service` `LINK` → `L6` → `L2` ordering | erasure tests 6, 7 |
| 6 | AccessEvent written *before* decryption; log failure fails the read | `middleware/logAccess.js` + `recordAccess` throws | lifecycle test 8 |
| 7 | AuditLog stores hashes only | `payloadHash` + `payloadDigest`, no payload column | lifecycle test 10; erasure test 10 |
| 8 | Redaction/PII failure fails closed | `PiiUnavailableError` → `piiStatus=DEFERRED`, no raw fallback | lifecycle test 6 |
| 9 | Secrets from env; preflight refuses prod defaults | `scripts/preflight.js` | run it |
| 10 | Least privilege in `requireRole` + service-layer scope | per-route guards | rbac test 4 |

---

## 3. What the last two sessions changed

### Wave 6 — nine new endpoints, all RBAC-classified

Route count went 105 → 114, verified by booting the app and calling
`listRoutes`. All nine are classified in `tests/security/rbac-matrix.test.js`.

| Route | Purpose | Roles |
|---|---|---|
| `GET /api/v1/me/photos` | DPDP §11 — how many photos the principal appears in, grouped by project (`me.service.js listMyPhotos`) | subject |
| `GET /api/v1/me/photos/:photoId/redacted` | The principal's own copy of a frame, everyone else blurred, access-logged | subject |
| `POST /api/v1/me/dsar/:requestId/package-token` | Mints a fresh single-use download token | subject |
| `GET /api/v1/projects/:projectId/sessions` | Project session oversight, no participant identities | dataOwner/dpo/dataAdmin/super_admin |
| `GET /api/v1/projects/:projectId/handoffs` | Project handoff oversight | same |
| `GET /api/v1/projects/:projectId/report` | Project-scoped report | same |
| `GET /api/v1/dashboard/compliance-report` | Server-side accountability report over a stated window | dpo/dataOwner/dataAdmin/super_admin |
| `GET /api/v1/dsar/evidence` | Vault-wide evidence index — content hashes only, **never payloads** | dpo/dataOwner/dataAdmin/super_admin |
| `GET /api/v1/dsar/:requestId/media` | Break-glass targeting, ids only, scoped to the request's own subject | dpo/dataAdmin/super_admin |

Design points worth not re-deriving:

- `readPersonRedactedPhotoForSubject(photoId, subjectId)` in `session.service.js`
  takes **no `admin` and performs no session-ownership check** — the
  authorization *is* the `PhotoSubject` link, re-proved inside the function
  rather than trusted from the caller. It shares `buildPersonRedacted` with the
  agent-facing route so the two cannot diverge.
- `GET /dsar/evidence` strips `payload` and `storagePath` before returning. The
  `EXPORT_PACKAGE` evidence payload holds a **live download token hash** —
  returning it would hand out the package.
- `getComplianceReport` returns `onTimeRate: null` on an empty set, never 0% or
  100%. A report claiming "100% on time" because nothing closed is worse than one
  that says nothing.

### Portals rewired (both build clean)

`admin-portal`: `lib/api.js` gained six readers; `Dashboard.jsx` `resolveHref`
now matches full path segments (closes the last portal contract gap);
`dataOwner/{ProcessedData,ProjectReports}.jsx` rewritten; `dpo/ComplianceReports.jsx`
gained `ComplianceReportPanel` **and kept the raw audit list**;
`dataAdmin/EvidenceVault.jsx` defaults to the vault-wide view;
`dataAdmin/PurgeExport.jsx` gained `MediaBrowser` feeding `BreakGlassModal`.

`user-portal`: `lib/api.js` gained `getMyPhotos`, `getMyRedactedPhoto` (blob),
`createDsarPackageToken`; `MyData.jsx` gained `PhotoThumb`, which only requests
an image when `viewable === true`; `SecureInbox.jsx` **paste-a-token form removed
entirely** — the token now lives only in a `const` inside the async handler.

### Two operational bugs found while verifying

1. **`/health/deep` never probed Redis.** With Redis down, the redaction, purge
   and retention queues stop silently — the API keeps answering while deferred
   work is never retried. Now probed, and **bounded by a 1500ms `Promise.race`**:
   ioredis queues a command against a dead server and retries it, so an un-raced
   `ping` turns a probe that should answer `redis: false` in a millisecond into
   one that hangs for the whole retry policy. A health check that hangs reports
   nothing at all.
2. **`config/redis.js` had no `error` listener**, so an outage sprayed raw
   ioredis stacks to stderr — outside the structured log, in a system whose logs
   are evidence. Now one `logger.warn` line per attempt; the process stays alive,
   which is correct: the API must keep serving reads while the queues are down,
   and `/health/deep` is what reports that they are.

### Six earlier bug fixes (wave 5, kept for context)

Anonymous access to `/api/v1/subjects`; the break-glass router 403'ing collection
agents off every session route; purge destroying the original of a photo another
subject still held; the deletion certificate leaking the principal's raw UUID
next to its pseudonym; subjects never seeing an `APPROVED` project; the join QR
serving hand-assembled consent text instead of the bound `ConsentTemplate`; and
BullMQ opening Redis at module import (test time 9 min → 44 s once made lazy).

### Docs

`DEPLOY.md` written. `DPIA.md` and `RUNBOOK_BREACH.md` corrected — two agent
claims in them were wrong and were fixed: envelope encryption is **BUILT** in
`storage.js` for L2/L4/L6/L7/L8 (merely opt-in via `MEDIA_KEK`), not a GAP; and
there is no `worker:recognition` script. `02_ROLE_PERMISSION_MATRIX.md` gained
rows for all nine new endpoints.

---

## 4. Architecture notes worth not re-deriving

- **`listRoutes(app)`** walks the live Express router stack, so a newly mounted
  route appears in the RBAC test immediately — *forgetting to classify an
  endpoint is a test failure*, not a silent hole. Keep it that way.
- **`tests/e2e/world.js`** builds everything through the real services. A fixture
  that inserts straight into a table also skips the rule that table's service
  enforces.
- **The rate limiter answers before the guard** on `/auth/subject/login|verify`.
  The RBAC harness records those as *inconclusive* and prints them rather than
  scoring them — scoring a 429 as "denied" lets a genuinely open route hide
  behind the limiter.
- **`PHASE_ORDER` in `purge.service.js` is load-bearing.** `LINK` → `L6` → `L2`,
  `SUBJECT_KEY` last. Reversing `L6`/`L2` yields a photo that can never be
  re-redacted; destroying the key first makes everything after it unhashable.
- **`phaseOf()` derives from persisted columns only.** Discovery's
  rebuild-vs-delete hint is deliberately not trusted at execution time — minutes
  may have passed and another subject may have unlinked.
- **`Subject`'s primary key is `masterUserId`, not `id`.** `select: {id:true}` on
  `Subject` throws.
- **Mount order in `app.js` is deliberate** and commented. `agentEnrollmentRoutes`,
  `meRoutes`, `joinRoutes`, `sessionInviteRoutes` and `sessionBreakGlassRoutes`
  all sit *before* the routers whose broad guards or bare `/:id` params would
  otherwise swallow them.

---

## 5. Ask before doing

Unchanged standing instruction from the user:

- dropping any existing table
- changing the `photo_subjects` shape
- altering `finalizeSession`'s transaction boundary

None of these have been done. **§7.1 deletes rows — get explicit confirmation of
the exact `WHERE` clauses before running it.**

---

## 6. Open items — nothing here is hidden or worked around

### 6.1 The database carries test residue — **top blocker, found 2026-07-28**

Measured against the live Supabase project:

```
adminUsers 43   — 41 of them @test.invalid, 1 'probe-…'   ← 95% test residue
subjects   25   — 12 E2E/RBAC fixtures, 3 "ERASED", 3 duplicate "niga" rows,
                   9 named demo people (Ravi Kumar, Anita Desai, Karthik Raman, …)
projects    8   — 7 named "E2E Project <hex>", 1 legacy ACTIVE (§6.6)
sessions   17    photos 101    photoSubject links 62
subjectFaceEnrollment 29        ← biometric templates for fixture identities
accessEvents 142  auditLogs 731  dsarRequests 6
deletionCertificates 0   subjectKeys 0
```

Three distinct problems, most severe first:

1. **Shipping this database ships test data into production.** Invariant 1 says
   no mock/seed/dummy data anywhere — but `preflight`'s `no-mock-data` check
   scans the **code**, not the database. The nine named demo subjects almost
   certainly came from the deleted seed scripts (`backend/prisma/seed*.js`,
   removed from the tree but never purged from the DB). They hold **face
   enrollments** — biometric templates for people who never consented, in a
   system built to prove exactly the opposite.
2. **`deletionCertificates` is 0 while three `ERASED` subjects exist.**
   `tests/e2e/world.js:286` calls `prisma.deletionCertificate.deleteMany(...)`
   in teardown — against an RLS-forced append-only table — **and it succeeds.**
   That is empirical proof that §6.2 is live rather than theoretical: the
   connection role's BYPASSRLS makes the append-only guarantee inert. Once
   `prism_app` is in use this teardown will correctly start failing, and
   `world.js` must stop deleting evidence rather than have the privilege
   re-granted.
3. **E2E teardown is not reliably running.** `destroyWorld` deletes admin users
   matching `e2e-<tag>-`, yet 41 remain — interrupted runs leave residue. Not a
   correctness bug, but it is why the counts above are so large.

Remedy in §7.1. **This is a data decision — confirm the `WHERE` clauses with the
user before deleting anything.**

### 6.2 Supabase `postgres` role holds BYPASSRLS — remedy written, **not applied**

RLS is enabled *and forced* on `audit_log`, `access_events`,
`deletion_certificates`, verified by preflight and `audit-chain.test.js`. The
connection role bypasses it, so on this connection the append-only guarantee does
nothing (see §6.1 item 2 for proof).

`backend/scripts/sql/provision-app-role.sql` is the remedy — creates `prism_app`
with `NOSUPERUSER NOBYPASSRLS`, grants ordinary DML, and revokes
`UPDATE/DELETE/TRUNCATE` on the three evidentiary tables so the guarantee does
not rest on RLS alone. **It has not been run.** `preflight`'s `db-role` check
keeps warning until it is. Invocation and verification queries: `DEPLOY.md` §3
and the header comment of the SQL file.

### 6.3 Media encryption is opt-in and currently off

`MEDIA_KEK` is unset, so `storage.js` writes plaintext. The envelope scheme is
built and proven by `crypto.test.js`; nothing proves the *corpus* is encrypted,
because it isn't. Turning it on has a required ordering (§7.3) and a migration
for existing objects. `storage.js` already throws at boot if encryption is off
under `NODE_ENV=production`, so this cannot be forgotten into production — the
process refuses to start.

### 6.4 Preflight is RED in dev, by design

With `AUDIT_HMAC_SECRET`, `MEDIA_KEK`, `DSAR_SIGNING_SEED` unset:

```
15 checks — 10 passed, 1 warning, 4 failures
```

Three failures are the missing secrets; the fourth is the Redis version; the
warning is `db-role`. Failures are fatal only when `NODE_ENV=production`. The e2e
world sets a throwaway `DSAR_SIGNING_SEED` when neither it nor `MEDIA_KEK` is
configured, and never overrides a real one.

### 6.5 Local Redis 5.0.14.1 is below BullMQ's 6.2 floor — **dev-only**

Both local binaries are 5.0.14.1 and Docker is not installed, so
`worker:redaction`, `worker:purge` and `worker:start` cannot retry deferred work
*on this machine*. The e2e suites drive recognition and purge inline, so the gate
is green regardless. **Production is unaffected** — `backend/docker-compose.yml`
pins `redis:7.4-alpine`. Do not treat this as a code defect; an earlier revision
of this file mis-filed it as the top blocker.

### 6.6 One legacy `ACTIVE` project

"Face Recognition Training v4.2" (2026-07-13) predates the approval workflow, was
never DPO-approved, and is therefore correctly non-collectable. Deleting it is a
data decision, folded into §7.1.

### 6.7 `backend/teardown-probe.test.mjs` is untracked scratch

A diagnostic from the Redis hunt, deliberately excluded from the commit. It also
has a bug — it creates `probe-<run>@test.invalid` but deletes `probe-<run>-`, so
it leaks a row per run (one is in the DB now). Delete the file in §7.1.

---

## 7. What is left to do — the complete remaining list

Code work is **done**. Everything below is environment, data, or verification.

Current git state:

```
branch wave6-production-readiness   165f9d1 feat: DPDP compliance platform, waves 0-6
                                    (126 files, +16,734 / −1,887)
main                                b87f069   ← not merged, nothing pushed
dirty:     AGENTS.md, CLAUDE.md     (GitNexus header counts only, from the re-index)
untracked: backend/teardown-probe.test.mjs
```

### 7.1 Clean the database — **confirm with the user first**

Proposed scope, narrowest first:

```
adminUser              email contains '@test.invalid'        (41 rows)
adminUser              email startsWith 'probe-'             (1 row)
project                name startsWith 'E2E Project '        (7, cascade children first)
subject                the 12 E2E/RBAC fixtures + 3 duplicate 'niga' rows
subject                the 9 seed-derived demo people + their face enrollments
project                'Face Recognition Training v4.2' (§6.6)
```

Order matters — children before parents: `subjectFaceEnrollment`, `photoSubject`,
`sessionParticipant`, `projectConsent` before `subject`; sessions and photos
before `project`. Do **not** delete from `audit_log`, `access_events` or
`deletion_certificates`: those are append-only, and the fact that a delete
currently *would* succeed is the bug, not a licence.

Then delete `backend/teardown-probe.test.mjs`, re-count, and confirm the numbers
are what was intended before continuing.

### 7.2 Provision the least-privilege role (§6.2)

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
psql "$ADMIN_DATABASE_URL" -v password="'<generated>'" -f backend/scripts/sql/provision-app-role.sql
```

Repoint `DATABASE_URL` **and** `DIRECT_URL` at `prism_app`, then confirm:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;  -- (f, f)
```

`npm run preflight` must show `db-role: PASS`. **Expect `world.js` teardown to
start failing on `deletionCertificate.deleteMany`** — that is the control
working. Fix by narrowing teardown, not by re-granting the privilege.

### 7.3 Set production secrets and roll out media encryption

```bash
AUDIT_HMAC_SECRET   openssl rand -hex 32
DSAR_SIGNING_SEED   openssl rand -hex 32     # Ed25519 seed — rotating it invalidates
                                             # verification of every past certificate
MEDIA_KEK           openssl rand -base64 32
```

Ordering is not optional (`DEPLOY.md` §4): set `MEDIA_KEK` → deploy → run
`backend/scripts/migrate-media-encrypt.js` over existing objects → set
`MEDIA_REQUIRE_SEALED=on` → redeploy. Flipping `MEDIA_REQUIRE_SEALED` before the
sweep makes every pre-existing object unreadable.

### 7.4 Merge and push

```bash
git add AGENTS.md CLAUDE.md && git commit -m "chore: refresh GitNexus index header"
git checkout main && git merge --ff-only wave6-production-readiness
git push
```

Run `gitnexus_detect_changes()` before committing, per CLAUDE.md.

### 7.5 Deploy per `docs/DEPLOY.md`

Redis ≥6.2 (`docker-compose.yml` already pins 7.4), `prisma migrate deploy`, and
the long-lived workers — `worker:start`, `worker:redaction`, `worker:purge`.
`DEPLOY.md` §6 lists what silently breaks if each is not running.

---

## 8. Final test sequence — run in order, stop on first failure

```bash
# 1. all five services up
~/redis/redis-cli.exe ping                                    # PONG
curl -s -m 2 localhost:6333/healthz localhost:8001/health localhost:8002/health

# 2. secrets set, prod-mode preflight
cd backend && NODE_ENV=production npm run preflight           # 15/15, exit 0
                                                              # db-role must be PASS

# 3. fixtures (gitignored — rebuild on every clean checkout)
npm run fixtures:e2e

# 4. the gate
LOG_LEVEL=silent RBAC_REQUEST_TIMEOUT_MS=8000 npm test        # 53/53, exit 0

# 5. portals
cd ../admin-portal && npm run build
cd ../user-portal  && npm run build

# 6. deep health against the running app
curl -s localhost:3000/health/deep    # {"postgres":true,"qdrant":true,"redis":true}, 200
```

Then a manual pass the automated suite cannot cover, because it is about what a
human actually sees:

- A principal logs into user-portal, opens **My Data**, sees a photo count and
  thumbnails — and **no other person's face unblurred**.
- Raise a DSAR from the portal and download the package **once**; the second
  attempt returns 410; re-issue mints a *different* token.
- A `dataOwner` opens a project they do not own → 403 on all three oversight
  reads.
- A DPO opens Compliance Reports and sees both the report **and** the raw audit
  entry list.
- A `dataAdmin` break-glass read writes an `AccessEvent` **before** the bytes are
  returned — verify the row exists.

If §8 is green, ship it.

---

## 9. If something breaks

1. `mem-search` first — the answer is probably already recorded.
2. Suite hangs or mass-fails → **check the five ports before reading any code.**
   That was the cause both times last session.
3. `gitnexus_query({query:"<symptom>", repo:"samsung project"})` →
   `gitnexus_context({name:"<suspect fn>", repo:"samsung project"})`.
4. Run `gitnexus_impact({target:"X", direction:"upstream", repo:"samsung project"})`
   **before** editing any symbol, and warn on HIGH/CRITICAL. Re-run
   `npx gitnexus analyze` after committing — **without** `--embeddings`
   (`.gitnexus/meta.json` shows `embeddings: 0`; omitting the flag when
   embeddings *do* exist deletes them).

---

## 10. Where things live

Written down so the next session navigates instead of searching. Prefer
`gitnexus_context({name, repo:"samsung project"})` over opening any of these.

### Backend — `backend/src/`

```
app.js                createApp() + listRoutes()   ← mount order is load-bearing (§4)
server.js             listen only; the split exists so the RBAC test mounts the real app
config/               prisma.js · qdrant.js · redis.js
modules/              audit auth-admin auth-subject consent consentTemplates
                      dashboard dsar enrollment handoff join me projects sessions subjects
                      (each: *.routes.js + *.service.js)
workers/              recognition · redaction · purge · retention   ← BullMQ bindings only
```

`src/lib/` — the pieces most work touches:

| File | Holds |
|---|---|
| `storage.js` | envelope encryption for L2/L4/L6/L7/L8; throws at boot if off under `NODE_ENV=production` |
| `blobCrypto.js` · `embeddingCrypto.js` · `keyring.js` | DEK/KEK, embedding column crypto, crypto-shredding |
| `auditLog.js` · `accessLog.js` | HMAC chain (hashes only); `recordAccess` **throws** so a failed log fails the read |
| `signingKey.js` | Ed25519 for deletion certificates — seeded by `DSAR_SIGNING_SEED` |
| `consent.js` · `revocation.js` | consent matrix reads; withdrawal |
| `faceGallery.js` | Qdrant; embeddings never leave the process |
| `faceQueue.js` · `redactionQueue.js` · `purgeQueue.js` | **lazy** — must not open Redis at import (§3) |
| `zip.js` · `tokens.js` · `otp.js` · `cookies.js` · `resend.js` · `cleanup.js` · `logger.js` | export packaging, opaque tokens, OTP, auth cookies, mail, retention sweep, pino |

`src/middleware/` — `requireAdminAuth` · `requireSubjectAuth` · `requireAnyPrincipal`
· `requireRole` · `requireBreakGlass` · `logAccess` · `rateLimiter` ·
`requestLogger` · `errorHandler`.

### Scripts — `backend/scripts/`

| Script | Purpose |
|---|---|
| `preflight.js` | the 15 checks; fatal only under `NODE_ENV=production` |
| `sql/provision-app-role.sql` | §7.2 — **not yet run** |
| `migrate-media-encrypt.js` | §7.3 sweep over existing objects |
| `make-e2e-fixtures.js` | rebuilds the gitignored `*.jpg` fixtures |

**`backend/prisma/seed-admin.js` is not a seeder — do not delete it during the
§7.1 cleanup.** It is the single bootstrap escape hatch that creates the first
`super_admin`, because the invite flow needs an existing admin and at t=0 there
is none. It invents no data, only an identity; it **refuses to run once any admin
row exists**; it only ever creates `super_admin`; and it sets no password — the
account stays `INVITED` until a human accepts the printed single-use link. It is
consistent with invariant 1, not an exception to it.

### Migrations — `backend/prisma/migrations/`

The four that carry the compliance schema:

```
20260725000001_governance_dsar        20260725000003_audit_payload_digest
20260725000002_rls_audit_access       20260725000004_subject_erased_status
```

`…_rls_audit_access` is the one that enables **and forces** RLS on the three
evidentiary tables — the guarantee §6.2 is about.

### Portals

`admin-portal/src/` — `roles.js` (**nav authority**: `/audit-logs` is dataAdmin
only, which is why the DPO's audit list in `dpo/ComplianceReports.jsx` must
stay), `lib/api.js`, `pages/{dpo,dataOwner,dataAdmin,collectionAgent}/`.
`user-portal/src/` — `lib/api.js`, `pages/{MyData,SecureInbox,Join}.jsx`.

### Docs

`DEPLOY.md` go-live · `DPIA.md` risk register · `RUNBOOK_BREACH.md` ·
`01_PRIVACY_DATAFLOW.md` · `02_ROLE_PERMISSION_MATRIX.md` (executable — the RBAC
test *is* this table) · `03_FILE_IMPLEMENTATION_PLAN.md` ·
`04_AGENT_EXECUTION_PLAN.md`.

---

## 11. Sign-off — tick these and it ships

Nothing here is code. Work top to bottom; do not skip ahead.

```
[ ] 7.1  DB cleanup scope confirmed with the user, run, re-counted        §6.1
[ ]      backend/teardown-probe.test.mjs deleted                          §6.7
[ ] 7.2  provision-app-role.sql run; DATABASE_URL + DIRECT_URL → prism_app §6.2
[ ]      SELECT rolsuper, rolbypassrls → (f, f)
[ ]      world.js teardown no longer deletes deletion_certificates
[ ] 7.3  AUDIT_HMAC_SECRET, DSAR_SIGNING_SEED, MEDIA_KEK set in prod
[ ]      migrate-media-encrypt.js run BEFORE MEDIA_REQUIRE_SEALED=on      §6.3
[ ] 8.2  NODE_ENV=production npm run preflight → 15/15, db-role PASS
[ ] 8.4  npm test → 53/53, exit 0
[ ] 8.5  both portals build clean
[ ] 8.6  /health/deep → all three true, 200
[ ]      manual pass: My Data, DSAR single-use download, dataOwner 403,
         DPO sees report + audit list, break-glass writes AccessEvent first
[ ] 7.4  AGENTS.md/CLAUDE.md committed; ff-merge to main; push
[ ] 7.5  Redis ≥6.2 up; prisma migrate deploy; all four workers long-lived
```

**Rollback.** `main` is at `b87f069`; the whole delivery is the single commit
`165f9d1`, so `git revert` or resetting `main` undoes the code cleanly. Two steps
do **not** revert with it and must be planned separately: the `MEDIA_KEK` sweep
(re-encrypted objects need the KEK to read — never discard a KEK that has
encrypted anything) and the §7.1 deletes. Take a database snapshot before §7.1.

### Definition of done

Every box above ticked, §8 green including the manual pass, and §6.1–6.3 either
resolved or explicitly signed off by the user as accepted risk. `preflight` under
`NODE_ENV=production` exiting 0 is the single best proxy — it is the only check
that fails the build rather than warning.
