# Pipeline audit — face recognition (ingest → detect → cluster → match → tag)

Auditor scope: `backend/src/workers/recognition.worker.js`, `backend/src/modules/sessions/{recognition.service.js,session.service.js}`,
`backend/src/lib/{faceQueue,faceGallery}.js`, `backend/src/config/{redis,qdrant}.js`, `face-worker/main.py`,
and the `RecognitionJob` / `FaceDetection` / `FaceCluster` / `PhotoSubject` models.

All timestamps below are UTC unless noted. All commands were run against the live stack; every claim is
marked OBSERVED (ran a real command / read real code, quoted verbatim) or INFERRED (reasoned from OBSERVED
facts, e.g. well-documented library semantics I additionally confirmed against the exact installed package
source rather than memory).

---

## 0. Correction to the task brief — the threshold "mismatch" does not exist on the live system

The brief states: *"FACE_CLUSTER_THRESHOLD 0.4, FACE_MATCH_THRESHOLD 0.3 (env) vs the code default 0.38,
FACE_AUTO_TAG_THRESHOLD 0.5 (env) vs code default 0.55 — the .env and the code defaults DISAGREE."*

OBSERVED — `backend/.env:36,40,41`:
```
FACE_CLUSTER_THRESHOLD="0.4"
FACE_MATCH_THRESHOLD="0.38"
FACE_AUTO_TAG_THRESHOLD="0.55"
```
identical to the code defaults, `backend/src/modules/sessions/recognition.service.js:19,20,26`:
```js
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.38)
const AUTO_TAG_THRESHOLD = Number(process.env.FACE_AUTO_TAG_THRESHOLD ?? 0.55)
const CLUSTER_THRESHOLD = Number(process.env.FACE_CLUSTER_THRESHOLD ?? 0.4)
```
Checked every `.env*` file in the repo (`backend/.env`, `.env.bak.1787075989`, `.env.bak.audio.1787079271`,
`.env.example`, `deploy/prod.env.example`) — all six values agree, 0.4/0.38/0.55, everywhere.

OBSERVED — no OS-level override exists that could make the *live* process see something different:
```powershell
[Environment]::GetEnvironmentVariables('User')   | Where Name -like 'FACE_*'   -> (none)
[Environment]::GetEnvironmentVariables('Machine') | Where Name -like 'FACE_*'   -> (none)
Get-ChildItem Env: | Where Name -like 'FACE_*'                                  -> (none)
```
`scripts/start-all.ps1` sets no `FACE_*` variables before launching any service. dotenv only fills in gaps
process.env doesn't already have, and process.env has nothing FACE_*-shaped to begin with, so `backend/.env`
is what actually loads.

**Conclusion: there is no live discrepancy to fix.** `MATCH_THRESHOLD=0.38`, `AUTO_TAG_THRESHOLD=0.55`,
`CLUSTER_THRESHOLD=0.4` are what the running recognition worker uses, and they match the code's own
defaults exactly. I'm flagging this so no one spends effort "fixing" a mismatch that isn't there — the
premise in the brief appears to be stale or from an earlier state of the repo the `.env.bak.*` files don't
capture either.

### Comparison direction — checked end to end, correct

- `face-worker/main.py:63` — `/detect` returns `face.normed_embedding` — **L2-normalised** already.
- `recognition.service.js:29-33` — `cosine(a,b)` is a **plain dot product**, no division by norms. That is
  only valid because the inputs are pre-normalised — which they are (see above), and the running cluster
  centroid is explicitly re-normalised after every merge (`recognition.service.js:56-58`,
  `Math.hypot(...best.centroid)` then divide), so the invariant holds through incremental updates too.
- `faceGallery.js:26` — Qdrant collection created with `distance: 'Cosine'`. Qdrant's search score for a
  Cosine collection is the similarity itself (higher = better), not a distance — consistent with every
  comparison in the code being `score >= threshold` / `score > bestScore` (never inverted).
- Net: **no flipped-comparison bug**. The three-band decision (cluster / suggest / auto-tag) computes what
  it thinks it computes. This is a checked-clean item, not a defect — recorded here because the brief
  explicitly asked for it to be checked.

---

## 1. Real per-photo latency, measured live against the running face-worker

OBSERVED — 8 real, decrypted photos (`readFile()` — which transparently opens the sealed `PRSM` blob, see
`lib/storage.js:126-142`) from 8 different sessions (none from the stuck session, to avoid disturbing it),
each POSTed to `http://localhost:8001/detect` exactly the way `recognition.service.js:67-77` does it
(multipart `file`, same content-type), timed with `performance.now()` around the `fetch` + `res.json()`:

```
photo 72b0cb1a  702265B  faces=1  5127.8ms   <- cold model-cache warm-up, first call
photo 49978d76  589686B  faces=1  1531.8ms
photo 1685cffe  685627B  faces=1  2560.6ms
photo 3f19592e  544866B  faces=1  1904.3ms
photo 583cf861  578152B  faces=1  2556.9ms
photo 73352f2c  580921B  faces=1  2319.0ms
photo bab82043  535612B  faces=1  2333.5ms
photo bf7f25f5  551490B  faces=1  2626.5ms

n=8  mean=2620.1ms  min=1531.8ms  max=5127.8ms
steady-state (excluding the cold-start outlier), n=7: mean = 2261.8ms
```

Per-photo cost in `processSession()` is dominated by this one call — the other per-photo work (sharp
`metadata()`, one `faceDetection.create`, `cropFace()` extract/resize/encode, one sealed `writeFile` of the
crop, one `faceDetection.update`, one `recognitionJob.update`) is local CPU/disk work in the low tens of ms
by comparison, not separately measured here but structurally minor next to a ~2.3s network+inference call.

**Working number for all arithmetic below: ~2.3s/photo steady-state, up to ~2.6s/photo including
variance, ~5.1s on the very first call after a face-worker restart (model warm-up).**

---

## 2. The 30s BullMQ lock — what it actually gates, verified against the installed package

OBSERVED — `backend/node_modules/bullmq` is version **5.80.2**. Read the actual defaults out of the
installed source rather than relying on memory (`node_modules/bullmq/dist/cjs/classes/worker.js:34`):

```js
{ drainDelay: 5, concurrency: 1, lockDuration: 30000, maximumRateLimitDelay: 30000,
  maxStalledCount: 1, stalledInterval: 30000, autorun: true, runRetryDelay: 15000 }
```
and `lockRenewTime = lockDuration / 2` (`worker.js:63-64`) = **15000ms**.

### The arithmetic the brief asked for

If lock renewal did **not** happen — i.e. treating the 30s lock as a hard per-job ceiling — the number of
photos a session could hold before a single continuous `/detect` pass "used up" the lock is:

```
30000ms / 2300ms per photo  ≈ 13 photos   (steady-state estimate)
30000ms / 2600ms per photo  ≈ 11 photos   (conservative estimate)
```
i.e. **roughly a dozen photos**. This is a real number worth having, because most field sessions will
exceed a dozen photos.

**But this is not actually how the lock behaves**, and I want to be precise rather than repeat a flawed
premise: BullMQ auto-renews the lock on a timer **independent of processor progress** — every
`lockRenewTime` (15s) *as long as the worker process is alive and its event loop isn't badly blocked*
(`worker.js` lock-extension is a separate interval, not tied to how far `processSession()` has gotten).
`processSession()`'s own work is essentially all `await`ed I/O (fetch, prisma, sharp — sharp offloads to
libuv's thread pool) with no CPU-heavy synchronous span long enough to miss a 15s renewal tick at session
sizes anywhere near production scale. **So under healthy operation, a session's photo count does not cap
against the 30s lock at all** — it can run for hours, renewing every 15s indefinitely.

**The 30s/15s numbers become the operative constraint only when the worker *process* dies mid-job** — crash,
OOM, `taskkill`, a rolling redeploy — because then lock renewal stops outright, not late. From that moment:
- The lock's remaining TTL is at most 30s (as little as ~0s if the process died right before a scheduled
  renewal, up to 30s if it died right after one).
- Any live `Worker` instance (including the same one restarting) runs a stalled-check every
  `stalledInterval` = 30s. I read the actual Lua script
  (`node_modules/bullmq/dist/cjs/scripts/moveStalledJobsToWait-9.js`) rather than assuming: on tick *N* it
  marks every currently-`active` job id as "potentially stalled" (adds it to a `stalled` SET); on tick
  *N+1* it checks each of those — if the job's `:lock` key is gone, it removes the job from `active`,
  increments a per-job `stc` (stalled count) counter via `HINCRBY`, and if `stc > maxStalledCount` (i.e.
  this is the **second** stall) tags the job hash with `defa = "job stalled more than allowable limit"` —
  **but pushes the job back onto `wait` in both cases**. The `defa` field is read back in
  `worker.js:616-617` (`getUnrecoverableErrorMessage`) the next time a worker dequeues that job: if set, the
  job is failed immediately **without ever calling the processor again** and **without consuming the
  configured `attempts:3` retry budget** — a stall-triggered failure is a separate, faster path than the
  `attempts`/`backoff` retry logic in `enqueueRecognition()` (`lib/faceQueue.js:37-38`), which only governs
  retries after the *processor itself* throws.
- **So the real window is**: up to ~30s of undetected death + up to one 30s stalled-check cycle to notice
  ≈ **30–60s worst case from process death to the job being requeued to `wait`** — independent of session
  size. A second death within that same requeued attempt fails the job outright inside ~60-90s more,
  bypassing the 3-attempt/backoff schedule entirely.

### What happens to `FaceDetection` rows across a stall-then-requeue, with 1 replica

`processSession()` re-runs from the top on any requeue: `deleteMany` wipes **every** `FaceDetection` and
`FaceCluster` row for the session (`recognition.service.js:107-108`), then redoes the full photo loop.
So a stall-and-recover with 1 replica is self-healing at the data-integrity level (no duplicate rows
survive) but **fully wasteful**: any photos already processed before the crash are thrown away and
redone at ~2.3s/photo. A session 90% through a 500-photo run (≈ 19 minutes of work) that crashes just
before the end restarts the entire 19-minute pass.

### With >1 replica (required for 5,000/day — see §7)

More replicas do not change per-job lock semantics (BullMQ still gives at most one active lock per
`jobId`), but they change the blast radius of a crash: if replica A dies mid-job, replica B (or C, …)
keeps pulling and completing *other* sessions' jobs from `wait` while A's job sits stalled-and-recovering.
The risk that grows with replica count is the opposite one: a **rolling deploy that bounces several
replicas near-simultaneously** can now orphan **several** sessions' jobs at once instead of one, each
independently going through the deleteMany-and-redo cycle above.

---

## 3. The stuck job — session `COL-7224` (`faa3e6fd-9a1a-4d2a-b6c7-23a9a430ac49`)

### 3.1 Live DB state (OBSERVED, queried directly via Prisma)

```
SESSION   status=PROCESSING  endedAt=2026-08-19T20:00:01.876Z  archivedAt=null
JOB       id=d6f09006-a12b-4582-a485-270dc5af23be
          status=RUNNING  photosTotal=2  photosDone=1  facesFound=1
          startedAt=2026-08-19T20:00:02.240Z  finishedAt=null
PHOTOS    2 photos, both piiStatus=PENDING
FaceDetection count for this session: 1   FaceCluster count: 0
Query time: 2026-08-20T19:18:18.308Z
```

`photosDone=1` of `photosTotal=2` with `facesFound=1`: the job detected exactly one face on the first
photo, wrote its `FaceDetection` row, updated progress — and then hung inside the **second** photo's
`await detectFaces(buffer, filename)` call (`recognition.service.js:116`), which is a `fetch()` with **no
timeout, no `AbortSignal`** (established by the lead; confirmed here by direct code read, same line).
**Elapsed at time of query: 23h18m16s.** (The lead's earlier note said "~2 days"; same session/job ids,
just measured at an earlier point — not a contradiction, the job has now been stuck for longer.)

### 3.2 What's actually happened to the job in Redis (OBSERVED — read every BullMQ key directly)

```
bull:face-recognition:d6f09006-a12b-4582-a485-270dc5af23be   -> HGETALL returns {}  (key does not exist)
bull:face-recognition:active                                  -> []
bull:face-recognition:wait                                    -> []
bull:face-recognition:stalled                                 -> []
bull:face-recognition:failed  (zset)  -> 6 entries, none is d6f09006-...
bull:face-recognition:completed (zset) -> 11 entries, none is d6f09006-...
bull:face-recognition:d6f09006...:lock -> GET null, TTL -2 (key doesn't exist)
```
**The job does not exist anywhere in BullMQ/Redis — not active, not waiting, not stalled, not failed, not
completed.** This rules out the "stalled twice, marked failed" path from §2 (that path leaves the job
hash in place with `defa` set and it lands in the `failed` zset — this one is nowhere).

### 3.3 Why — INFERRED, but tightly corroborated by OBSERVED facts

```
redis INFO -> uptime_in_seconds: 44681         (~12.4h — this Redis/Memurai process instance is younger
                                                 than the job)
              aof_enabled: 0                    (no append-only durability — RDB snapshots only)
              rdb_last_save_time / rdb_saves: 41 (periodic snapshotting is active, but is not continuous)
job.startedAt = 2026-08-19T20:00:02Z   (~23h18m before the query)
now           = 2026-08-20T19:18:18Z
```
`uptime_in_seconds` (44681s ≈ 12.4h) is **shorter** than the time elapsed since the job started
(~23h18m ≈ 83,896s). That means the Redis/Memurai server process itself restarted at roughly
2026-08-20T07:15Z — **after** the job began, **before** now. With `aof_enabled:0`, the *only* durability
this Redis instance has is periodic RDB snapshots; anything written between the last snapshot before that
restart and the restart itself does not survive it. The job's `active`-list membership, its hash, and its
lock are exactly the kind of frequently-mutating, in-flight state most likely to fall in that gap.

I cannot prove the precise mechanism beyond this (I don't have a way to inspect what the last RDB
snapshot before the restart actually contained), so this is **INFERRED**, not observed directly — but it
is the only explanation consistent with every fact I *can* observe: the job is not merely stalled (BullMQ's
own stall-then-fail path would have left a hash and a `failed` zset entry, and it left neither), and the
worker process itself independently restarted at `2026-08-20T21:04` local (see 3.4) without ever emitting
a `completed` or `failed` log line for this job either.

### 3.4 The recognition worker process also restarted, and never touched this job again

```
.run/logs/w-recognition.out.log  (OBSERVED, full contents, 1 line):
[21:04:34.714] INFO (4848): Recognition worker listening on queue "face-recognition"
.run/logs/w-recognition.err.log: empty
```
The current worker process (pid 4848) started at **21:04:34 local on Aug 20** and has logged **zero**
`recognition job completed` or `recognition job failed` events since — i.e. since it started, it has not
processed (or re-processed) a single job, stuck or otherwise. Combined with `RecognitionJob.startedAt`
still reading `2026-08-19T20:00:02.240Z` (unchanged — `processSession()` always resets `startedAt` to
`new Date()` on every run, `recognition.service.js:99-102`, so a re-run would show a fresh timestamp) and
`photosDone` still `1`: **this job was never picked back up, by any worker, at any point.**

### 3.5 What would ever recover it — checked directly against the code: **nothing, automatically**

- No reaper exists anywhere in the codebase (already established by the lead, `R-1`).
- The only code path that creates a `RecognitionJob` row and calls `enqueueRecognition()` is
  `endSession()` (`session.service.js:452-505`), and it is gated by `assertStatus(session, 'ACTIVE')`
  (line 454). This session is `PROCESSING`, not `ACTIVE` — `endSession()` will throw `409` on it forever.
- Grepped `session.routes.js` for every registered route (21 endpoints) — there is no
  retry/reprocess/requeue endpoint of any kind for recognition.
- **This row is permanently orphaned.** The only recovery is an operator with direct Postgres access
  manually resetting `Session.status` back to `ACTIVE` (and cleaning up or accepting the stray
  `RecognitionJob`/`FaceDetection` row) so `endSession()` can be called again through the app — there is
  no supported UI or API action for "this session's recognition died, please retry." The two photos stay
  `piiStatus=PENDING` and the session stays un-tagged, un-handoff-able, indefinitely.

### 3.6 What the collection agent sees, right now, and will keep seeing

`admin-portal/src/pages/collectionAgent/SessionDetail.jsx:391-396`:
```jsx
{session.status === 'PROCESSING' && (
  <div className="...text-warning">
    <Loader2 .../>
    Running face detection on {session.job?.photosTotal ?? session.photos.length} photos (
    {session.job?.photosDone ?? 0} done). You'll be taken to tagging automatically.
  </div>
)}
```
and `:254-258`:
```jsx
useEffect(() => {
  if (session?.status !== 'PROCESSING') return
  const timer = setInterval(reload, 3000)
  return () => clearInterval(timer)
}, [session?.status, reload])
```
The agent's browser, if the tab is left open, polls `GET /api/v1/sessions/:id` **every 3 seconds,
indefinitely** (23h18m and counting = ~28,000 polls so far for this one session, if anyone's left it
open) showing "Running face detection on 2 photos (1 done). You'll be taken to tagging automatically." —
**a promise that will never be kept.** See §8 for the broader gap this belongs to (FAILED sessions get
the identical non-treatment).

---

## 4. `deleteMany`-then-recreate — what two overlapping runs actually produce

This section required tracing several code paths together; I verified each piece directly rather than
reasoning abstractly.

### 4.1 How you get two overlapping runs for the same session at all

`endSession()` is the only creator of a `RecognitionJob` + enqueue call, and it is **not guarded against
concurrent invocation**:

```js
// session.service.js:452-489
export async function endSession(sessionId, admin) {
  const session = await loadSession(sessionId, admin)     // plain SELECT, no FOR UPDATE
  assertStatus(session, 'ACTIVE')                          // read-time check only
  ...
  const gallery = await buildSessionGallery(sessionId, admin.id)   // slow: Qdrant + N enrollment reads
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.recognitionJob.create({ data: { sessionId, photosTotal } })
    await tx.session.update({ where: { id: sessionId }, data: { status: 'PROCESSING', endedAt: new Date() } })
    //                         ^^^^ no `where: { status: 'ACTIVE' }` guard — last write wins
    return created
  })
  await enqueueRecognition(sessionId, job.id)
```
`loadSession()` (`session.service.js:24-46`) is `prisma.session.findUnique` — no row lock, no optimistic
version column, no unique constraint anywhere that would stop a second call. `RecognitionJob` has
**no unique constraint on `sessionId`** (confirmed against `prisma/schema.prisma:720-736` — it's a plain
`@@index([sessionId])`, one-to-many). `POST /:sessionId/end` (`session.routes.js:192-198`) has no
idempotency-key handling and no per-session mutex.

Two calls to `POST /sessions/:id/end` close enough together (a double-click on "End session & detect
faces", or a client retrying after a timeout on a flaky field connection — collection agents are
explicitly a mobile/on-site audience) both pass the `ACTIVE` read-check before either write lands. Each
independently:
- builds the gallery again (`buildSessionGallery` → `addEnrollmentPoint` always writes with a fresh
  `randomUUID()` point id, `faceGallery.js:52` — it **appends**, it does not upsert-by-subject. Two racing
  builds double every enrollment point in the **same shared Qdrant collection**, `session_{sessionId}`,
  keyed only by session id — not by job — so both runs search against one merged, doubled gallery),
- creates its **own** `RecognitionJob` row with its own fresh UUID,
- calls `enqueueRecognition(sessionId, jobId)` with a **different** BullMQ `jobId` each time — BullMQ only
  dedupes by exact `jobId` match, so this is two genuinely distinct jobs, not one deduplicated add.

I confirmed live that this hasn't happened yet in this dataset (small sample, low concurrency so far):
```
sessions with >1 RecognitionJob row: 0   (queried all 6+ RecognitionJob rows currently in the DB)
```
— but nothing in the code prevents it, and 5,000 images/day across many field agents on mobile networks
is exactly the traffic pattern (double-taps, retried timeouts) that triggers this race in production.

### 4.2 With 1 replica (concurrency:1): sequential, not simultaneous — but still destructive

`processSession()` never checks whether the session's status still matches what it expects, at any point
during its run. With one worker and `concurrency:1`, Job A runs to completion first (its own
`deleteMany` + full redo + final `$transaction` setting `session.status = 'TAGGING'`,
`recognitionJob.status = 'DONE'`). The moment that commits, an agent can start tagging clusters in the UI —
`getClusters`/`tagCluster`/`acceptSuggestions`/`mergeClusters`/`splitFaces` all only check
`assertStatus(session, 'TAGGING')` (`session.service.js:556,593,626,669`), which the session now
satisfies.

Then Job B dequeues (same worker, next in `wait`) and runs `processSession()` **for the same session**,
which starts with, unconditionally:
```js
await prisma.faceDetection.deleteMany({ where: { photo: { sessionId } } })
await prisma.faceCluster.deleteMany({ where: { sessionId } })
```
**This hard-deletes every `FaceDetection` and `FaceCluster` row Job A created — including any manual
tagging an agent already did in the window between Job A finishing and Job B starting.** There is no
warning, no lock, no "a newer detection pass is about to discard your work" notice. Job B then redoes
detection+clustering from scratch and, at its own end, sets `session.status = 'TAGGING'` again (harmless
by itself) — but any `clusterId` the agent's already-loaded browser state is holding now points at rows
that no longer exist; the next `tagCluster(sessionId, staleClusterId, ...)` call hits
`prisma.faceCluster.update({ where: { id: clusterId } })` on a gone row → Prisma `P2025` → surfaces as an
error to the agent (at least visible, unlike the silent loss of *already-committed* tags a moment earlier).

### 4.3 The worse case: Job B outlives `finalizeSession()`

For an IMAGE session, `finalizeSession()` requires exactly `assertStatus(session, 'TAGGING')`
(`session.service.js:969`) — it has no way to know a second `RecognitionJob` is still queued or running
for the same session, because nothing tracks "is there an in-flight recognition job" as part of session
state; it only checks the current `status` string. So: Job A finishes → `TAGGING` → agent tags every
cluster → `finalizeSession()` succeeds → writes `PhotoSubject` links, archives the session, **calls
`redactBystanders()` and `destroyGallery(sessionId)`** (`session.service.js:1054-1055`) → session is now
`ARCHIVED`, with redacted derivatives on disk and a `SessionHandoff` row already emitted for downstream
consumers (potentially already read by a DSAR export by the time Job B runs, at 5,000/day scale).

Job B, still sitting in `wait` this whole time, now finally runs. It:
1. Wipes every `FaceDetection`/`FaceCluster` row for the session again (same code, unconditional).
2. Redetects and reclusters from scratch.
3. Calls `searchGallery(sessionId, cluster.centroid, 1)` (`recognition.service.js:159`) against a Qdrant
   collection that **`finalizeSession()` already destroyed** — `qdrant.search()` throws (collection not
   found); this is caught (`recognition.service.js:161-163`, `logger.warn(...)`, not re-thrown), so
   `match` stays `null` for **every** cluster in this pass — nothing auto-tags, nothing suggests, the
   entire roster comes back "unidentified."
4. Commits its final `$transaction`, which sets `session.status = 'TAGGING'` with **no status guard at
   all** (`recognition.service.js:203-209`, `where: { id: sessionId }` only).

**Net effect: a duplicate recognition job that outlives finalize silently un-archives an already-
finalized, already-redacted, already-handed-off session, flips it back to `TAGGING`, and replaces its
face data with a fresh, unmatched set that has zero relationship to the `PhotoSubject` links, the
`SessionHandoff` row, and the redacted images already produced (and potentially already exported to a
DSAR requester) from the *first* pass.** This is not a rare edge case that needs an adversary — it is the
direct, mechanical consequence of a double-`/end` click with no idempotency guard, at ordinary field-agent
concurrency, colliding with the app's own encouragement to move fast ("You'll be taken to tagging
automatically").

### 4.4 Enumerating the mis-association paths, as asked

- **Cluster merge/split** (`mergeClusters`/`splitFaces`, `session.service.js:624-716`): both operate on
  `clusterId`s the caller already has loaded; both are vulnerable to the same stale-id-after-Job-B-wipe
  failure mode in §4.2 (visible error, not silent). No flaw independent of the duplicate-job race.
- **Accept-suggestions** (`acceptSuggestions`, `:591-624`): promotes a cluster's `suggestedSubjectId` to
  `taggedSubjectId` in bulk. If it runs in the window after Job A finishes but before Job B's
  `deleteMany`, the agent's bulk-accept writes land on rows Job B is about to delete outright — the
  accept is silently lost, not misapplied to the wrong person, but lost.
  the wrong photo of the right person is fine; a whole cluster is one person, so nothing here mixes two
  identities within a cluster.
- **Manual tag** (`tagCluster`, `:554-591`): same stale-id/lost-write exposure as merge/split.
- **Import assertion**: out of this module's scope (imports don't go through `processSession()` — no
  path found in `recognition.service.js`/`session.service.js` that ties import ingestion to face
  recognition; not re-derived here, flagged only as unchecked in §"what I could not check").
- **Re-run after an enrollment change**: `buildSessionGallery()` (`:348-450`) is called fresh inside every
  `endSession()` — so a *legitimate* re-run (not the race) always reflects the current roster/enrollments,
  which is correct. The actual wrong-subject risk here is narrower and specific to the race in §4.1: if a
  participant's consent is revoked (`dropRevokedParticipants`, `:282-306`) **between** Job A's gallery
  build and Job B's, Job A's gallery (built first, before the revoke) still holds that now-revoked
  subject's enrollment vector — and because both racing gallery builds write into the **same** Qdrant
  collection with nothing ever removing Job A's points, that revoked subject's vector persists in the
  shared gallery through Job B's run too (`destroyGallery` only runs at finalize or on final job
  failure, never between two racing builds). A face could therefore still auto-tag to a subject whose
  consent was revoked mid-window — a genuine, if narrow, mis-association path, and a consent violation in
  its own right (see §5).

---

## 5. Ordering hazards

- **Consent revoked mid-job**: `dropRevokedParticipants()` runs exactly once, synchronously inside
  `endSession()`, *before* the job is even enqueued (`session.service.js:456`). It is a one-time snapshot.
  Nothing in `processSession()` re-checks consent at any point during its run (no read of
  `ProjectConsent`/`Subject` state anywhere in `recognition.service.js`). A revoke that happens **after**
  `endSession()` has already started the job has zero effect on that run: the Qdrant gallery already has
  the revoked subject's vector, matching/auto-tagging proceeds against it exactly as if nothing changed.
  (`finalizeSession()` does re-check consent at the very end, `:993-997`/`:1026-1033`, and strips links +
  deletes tagged clusters for anyone revoked by finalize time — so the *final* archived state is
  eventually consent-correct for a single, non-racing run. The gap is specifically the recognition PASS
  itself being consent-blind while it executes, and — per §4.4 — persistently so across a racing rebuild.)
- **Subject deleted mid-job**: `FaceDetection.taggedSubjectId` and `FaceCluster.taggedSubjectId`/
  `suggestedSubjectId` reference `Subject.masterUserId` with `onDelete: SetNull`
  (`prisma/schema.prisma:641,658,681`) — Postgres applies that atomically at the moment of the actual
  `DELETE`, so **rows already written** before the delete get nulled out correctly regardless of the
  in-flight job. But a **new** `faceCluster.create({ data: { ..., taggedSubjectId: subjectId, ... } })`
  attempted *after* the subject row is gone (recognition.service.js:172-185) is a straightforward foreign
  key violation — Prisma throws, uncaught anywhere in `processSession()`'s cluster loop, and the whole job
  fails: retried per `attempts:3`/exponential backoff (5s→10s→20s), fails identically every time (the
  subject stays gone), and after 3 attempts the job is marked `FAILED` and the session `FAILED`. Correctly
  fails loud at the data layer; invisible in the UI regardless (§8).
- **Session finalized with jobs pending**: blocked for the *originating* job by `assertStatus(session,
  'TAGGING')` in `finalizeSession()` (image branch, line 969) — you cannot finalize while status is
  `PROCESSING`. **Not** blocked for a second, racing job (§4.3) — that is the actual reachable version of
  this hazard, and it is severe (un-archives a finalized session).
- **Photo deleted mid-job**: `deletePhoto()` requires `assertStatus(session, 'ACTIVE')`
  (`session.service.js:271`) — once `endSession()` has flipped the session to `PROCESSING`, the
  collection-agent-facing API can no longer delete photos out from under a running job. I did not verify
  whether any DSAR-erasure/purge code path can delete a `Photo` row irrespective of session status (that
  worker's photo-deletion logic lives in `purge.service.js`, out of this audit's assigned scope — flagged
  under "what I could not check").

---

## 6. Failure modes — face-worker down / timing out / garbage / 500

All four paths funnel through `detectFaces()` (`recognition.service.js:67-77`), called with **no
try/catch anywhere in its call site's loop** (`processSession()`'s `for (const photo of photos)`,
`:113-143`) — any throw propagates straight out of `processSession()` to the BullMQ job processor.

| Trigger | What happens in code | Result |
|---|---|---|
| **Down** (connection refused) | `fetch()` rejects (undici `TypeError`) | Uncaught → job throws → `attempts:3`, backoff 5s/10s/20s → all exhausted → `RecognitionJob.status=FAILED`, `Session.status=FAILED`, gallery destroyed (`recognition.worker.js:40-51`) |
| **500** | Explicitly checked: `if (!res.ok) throw new Error(...status...body)` (`:72-74`) | Same retry-then-FAILED path as above; this is the one path with a clear, specific error message |
| **Times out / hangs** | No `AbortSignal` anywhere — relies entirely on undici's default `headersTimeout`/`bodyTimeout` (300s each, per the lead's finding). Ties up the sole `concurrency:1` slot for up to 5 minutes minimum before undici itself errors, or indefinitely if the process dies first (§3 — this is what happened to `COL-7224`, though the 23h duration there is explained by the *process* dying, not by the fetch itself waiting that long: a live process would have had undici's 300s timeout fire long before 23 hours) | Same retry-then-FAILED path once it does error; total user-visible silence the entire time (§8) |
| **Garbage response** | `res.json()` throws on invalid JSON → same path. Valid JSON with `faces` missing → `body.faces ?? []` silently degrades to "0 faces found on this photo," **no error, no retry, no flag** — a worker-side bug on one image is indistinguishable from a genuinely empty photo. Valid JSON with a face entry missing/malformed `embedding` → `[...face.embedding]` in `clusterFaces()` throws (`undefined` not iterable) if `embedding` is `undefined` → same retry-then-FAILED path; but if `embedding` is present with the **wrong length**, `cosine()`'s loop (`recognition.service.js:29-33`, indexes to `a.length` without checking `b.length`) reads past `b`'s end, `b[i]` is `undefined`, `dot += a[i] * undefined` → `NaN`. `NaN > bestScore` is always `false` in JS, so a malformed-embedding face **never matches any existing cluster** and silently becomes its own new singleton cluster — no error, no log, just a phantom extra "person" in the tagging UI. |

**Headline: fail-closed on the outcomes that would actively mislabel someone** (a gallery-search failure
explicitly leaves a cluster `PENDING` for manual review rather than guessing — `:158-163` — and every
`attempts`-exhausted path lands on `FAILED`, never on a silently-accepted-as-if-successful result). **Not
fail-closed on observability**: malformed-but-not-throwing worker responses degrade into wrong-looking
output (extra phantom clusters, silently zero-face photos) with zero signal anywhere that anything went
wrong, and even the loud `FAILED` terminal state is invisible to every user (§8).

---

## 7. Backpressure at 5,000 images/day

**The real bottleneck is not `recognition.worker.js`'s `concurrency:1` — it's `face-worker` itself, and
it caps out at the same ceiling regardless of how many Node worker replicas you run.**

OBSERVED — how face-worker is launched, `scripts/start-all.ps1:180-181`:
```powershell
@('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8001')
```
No `--workers` flag → uvicorn's default of **one** worker process, one event loop.

OBSERVED — `face-worker/main.py:44-45,70-71`: `/detect` and `/embed` are declared `async def` and call
`face_app.get(bgr)` — insightface's synchronous, CPU-bound inference — **directly, with no
`await`/thread-offload**. FastAPI/Starlette only runs a *plain* `def` endpoint's body in a thread pool
automatically; an `async def` endpoint's synchronous body runs straight on the single event loop and
blocks it for the duration. `/redact` (`:149-150`) is the same shape.

**Consequence: `/detect`, `/embed`, and `/redact` all serialize through the same single-threaded process,
regardless of how many recognition-worker Node replicas send requests concurrently.** Scaling
`recognition.worker.js` replicas beyond what one face-worker process can actually serve buys nothing —
requests just queue at the OS/ASGI accept layer behind whatever `/detect` call got there first. Real
throughput scaling requires scaling **face-worker** (multiple uvicorn workers or process replicas behind
a load balancer, each with its own model loaded — ~300MB of insightface weights per process,
per `start-all.ps1:177-179`'s own comment), not just the Node side.

### Raw throughput arithmetic, using the measured 2.3s/photo steady-state

```
1 / 2.3s  ≈ 0.435 photos/sec  ≈  26.1/min  ≈  1,565/hour  ≈  37,565/day   (theoretical ceiling,
                                                                            face-worker running flat out,
                                                                            24/7, nothing else competing)
target:    5,000/day  ≈  208/hour  ≈  3.5/min
```
On raw arithmetic, 5,000/day sits comfortably inside the single-process ceiling (~13% utilization) — so
this is **not** a "the model is too slow" problem in isolation. It becomes one once you account for what
the ceiling actually has to share:
- `/redact` calls compete for the same single-threaded process (observed interleaved with `/detect` in
  `.run/logs/face.out.log`) — every bystander-blur at finalize time subtracts from the same budget.
- `/embed` calls for every new enrollment selfie do too.
- **Any single hung or slow request (§6, §3) freezes the entire process for its duration** — not just the
  session that triggered it. With no timeout on the Node side and a single-threaded server on the Python
  side, one pathological image (corrupt, absurdly large, a decode edge case that makes insightface spin)
  stalls `/detect`, `/embed`, and `/redact` for **every** in-flight and queued session simultaneously,
  system-wide, for as long as the hang lasts — worse than "one large session starves the others," it's
  "one bad photo anywhere starves the entire platform." `COL-7224` is a live, if now-resolved-by-process-
  restart, demonstration of exactly this shape of failure (§3), just not one I can currently show as an
  *ongoing* freeze — the face-worker is presently healthy and answered all 8 of my live `/detect` calls
  normally (§1).
- Session-level: with `concurrency:1` and no priority queue, a large session (hundreds of photos) does
  occupy the one Node-side processing slot for its full duration (hundreds × 2.3s = tens of minutes),
  during which every other session's job sits in `wait` untouched — this part is a straightforward,
  demonstrated consequence of `concurrency:1` with no preemption, independent of the face-worker
  single-process issue above.
- Memory: `processSession()` holds the full `detected` array (all embeddings for the whole session, 512
  floats each ≈ 2KB/face) in memory for the session's duration, plus buffers for whichever photo is
  currently being read/cropped. Not measured directly under load; at session scale (tens to low hundreds
  of faces) this is not a concern, but nothing bounds it if a single session ever holds thousands of
  photos.

**Bottom line: 5,000/day is within reach on raw model throughput, but the >1-replica scale-out this
volume requires does nothing to fix the two structural risks that actually threaten it — the single-
process face-worker as a system-wide single point of failure with no per-call timeout, and
`concurrency:1` with no preemption letting one large or one stuck session block every other session's
recognition indefinitely.**

---

## 8. Is job progress real or fabricated? Does a failed job surface anywhere a user sees?

**Progress is real, not fabricated** — traced the exact field flow: `recognition.service.js:138-142`
updates `RecognitionJob.photosDone`/`facesFound` after every photo inside the loop → `getSession()`
(`session.service.js:114-161`) includes `jobs: { orderBy: { createdAt: 'desc' }, take: 1 }` and returns it
as `job` → `SessionDetail.jsx:394-395` renders `session.job?.photosDone` / `session.job?.photosTotal`
directly from that response. No fabrication anywhere in the chain; this is the one part of the pipeline
that does exactly what it claims.

**A failed job does not surface anywhere a user sees.** Checked every render branch in
`SessionDetail.jsx` (the *only* place in either portal that reads `RecognitionJob`/session-processing
state at all — grepped for `photosDone|photosTotal|recognitionJob|facesFound|RecognitionJob` across all of
`admin-portal/src`, one file matched):
```jsx
action={
  capturing ? ( <button>End session & detect faces</button> )
  : session.status === 'ARCHIVED' ? ( <Link>View people</Link> )
  : ( <StatusPill tone="warning">Detecting faces…</StatusPill> )   // <-- catches PROCESSING **and** FAILED
}
```
`FAILED` is not `capturing` (not `ACTIVE`) and is not `ARCHIVED`, so it falls into the same `else` branch
as `PROCESSING` — a permanently failed session renders the identical **"Detecting faces…"** pill as one
still actively running. The progress banner right below it (`:391-397`) is gated on
`session.status === 'PROCESSING'` only, so once a session settles into `FAILED` that banner disappears
too — leaving just the generic "Detecting faces…" pill with zero further detail, zero retry action, zero
error message, and (per the polling `useEffect` at `:254-258`, also gated on `=== 'PROCESSING'`) the page
**stops auto-refreshing** at exactly the moment there's finally something worth telling the agent. Grepped
`admin-portal/src` for every `'FAILED'` string check: the only two hits are in
`dataAdmin/DsarRequestDetail.jsx`, for an unrelated DSAR-action status — **`Session.status === 'FAILED'`
is never checked anywhere in the admin portal.** A collection agent whose session's recognition
permanently failed (exhausted 3 attempts, per §6) has no way to discover that from the UI at all; the
only visible symptom is that "Detecting faces…" never goes away, identical to the still-processing case,
identical to what `COL-7224` looks like right now for a completely different reason (§3).

---

## What I could not check

- **Live reproduction of the double-`/end` race (§4.1–4.3).** I traced it precisely through the code and
  confirmed every precondition (no lock, no unique constraint, no idempotency key) directly, and confirmed
  the current dataset shows zero sessions with >1 `RecognitionJob` row — but I did not fire two concurrent
  `POST /sessions/:id/end` requests against a live `ACTIVE` session to observe the collision happen,
  because doing so would have created real orphaned data (duplicate Qdrant gallery points, a second
  `RecognitionJob` row, possibly a wasted redaction pass) in a shared, live audit environment other
  agents are also working against, and the audit rules prohibit mutating application state. This is a
  code-level proof, not a live-reproduced one.
- **Exact root cause of the Redis/Memurai data loss in §3.3.** I can observe that the server restarted
  sometime after the job began and that AOF is disabled, and that the job's Redis state is now completely
  gone rather than merely stalled — but I have no way to inspect *why* the restart happened or exactly
  what the last RDB snapshot before it contained. Marked INFERRED throughout, not asserted as certain.
  Whoever restarted Memurai/Redis on this host (or whatever crashed it) would know; I don't have that
  visibility from inside the app/OS as instructed (no service restarts permitted, and this one already
  happened before I started).
- **Import-path face/identity assertions.** The brief asked me to enumerate mis-association paths
  including "import assertion" — I found no code in `recognition.service.js`/`session.service.js` that
  ties bulk-import ingestion to face recognition at all, which suggests it's handled by a different
  module (`import.service.js`, referenced in a schema comment at `Photo` model but not read here) that is
  outside this audit's assigned file list. Not traced further.
- **Whether purge/DSAR-erasure can delete a `Photo` row mid-recognition-job irrespective of session
  status** (the "photo deleted mid-job" ordering question, from the erasure side rather than the
  session-API side). `purge.worker.js` exists and has a comment about concurrency:1 avoiding two purges
  touching the same photo, but the actual photo-deletion logic lives in a `purge.service.js`/erasure
  module I did not read — outside this audit's assigned scope (workers/recognition + sessions/session
  modules), and likely already covered by whichever auditor owns DSAR/erasure.
- **Video-track clustering interaction** (`FaceCluster.videoTrackCount`/`repTrackId`, `VideoFaceTrack`
  relation visible in the schema) — `video-worker` is not running (per the brief) and nothing in
  `recognition.service.js` touches these fields, so I did not chase whether a video-track-tagged cluster
  interacts with the photo-recognition race in §4 differently. Likely a separate worker's concern.
- **Sustained-load memory/CPU profile of `recognition.worker.js` under a real 5,000/day burst.** All
  latency numbers here are single-request, low-concurrency measurements against a live but otherwise idle
  dev stack; I did not (and was told not to) generate synthetic load at production volume.
