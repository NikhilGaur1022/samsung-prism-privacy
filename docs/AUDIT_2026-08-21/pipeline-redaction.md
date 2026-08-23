# Redaction pipeline / image PII worker — audit findings (2026-08-21)

Domain: `backend/src/workers/redaction.worker.js`, `backend/src/lib/redactionQueue.js`,
`backend/src/modules/sessions/session.service.js` (redaction paths ~1130-1360),
`ai-core/image-pii-worker/*.py`, `face-worker/main.py`, `PiiStatus` enum.

All DB/Redis/HTTP evidence below is OBSERVED against the live stack (Postgres :5433, Redis
:6379, image-pii-worker :8002, face-worker :8001) unless marked INFERRED. Diagnostic scripts
were written under `backend/` only because Node module resolution requires it (dotenv/@prisma/
ioredis live in `backend/node_modules`); every one of them was deleted after use — nothing was
left behind, and no application file was edited.

---

## FINDING 1 (P0, active privacy breach) — revoking consent between tagging and finalize makes that person's face ship UNBLURRED, not blurred

This is the most severe thing found in this domain: it is the exact inverse of the documented
"max-privacy" invariant, and it fires on the very first publish of a session, not on some later
edge case.

**The comment's stated intent** (`session.service.js:993-994`):
```js
// Last consent gate. Someone can revoke between tagging and finalize — if so,
// their photo links are never written and their faces are erased outright.
```

**What the code actually does**, `session.service.js:995-1032` (inside `finalizeSession`'s IMAGE
path, before the archive transaction commits):
```js
const revokedSubjectIds = tagged
  .map((c) => c.taggedSubjectId)
  .filter((id) => id && !consentBySubject.has(id))
...
await prisma.$transaction(async (tx) => {
  if (links.length > 0) {
    await tx.photoSubject.createMany({ data: links, skipDuplicates: true })
  }
  if (revokedSubjectIds.length > 0) {
    await tx.faceDetection.deleteMany({
      where: { clusterId: { in: tagged.filter((c) => revokedSubjectIds.includes(c.taggedSubjectId)).map((c) => c.id) } },
    })
    await tx.faceCluster.deleteMany({
      where: { sessionId, taggedSubjectId: { in: revokedSubjectIds } },
    })
  }
  ...
})
```

This **hard-deletes the `FaceDetection` rows** (and their `FaceCluster`) for anyone whose consent
lapsed between tagging and finalize. `FaceDetection.bbox` is the *only* thing that tells the
redaction step where that person's face is in the pixels.

Then, right after the transaction commits, `redactBystanders(sessionId)` runs
(`session.service.js:1054`, `1200-1276`):
```js
const photos = await prisma.photo.findMany({
  where: photoIds ? { id: { in: photoIds } } : { sessionId },
  include: {
    faces: { select: { bbox: true, tagStatus: true } },   // <-- fresh query, AFTER the delete
    subjects: { select: { subjectId: true } },
  },
})
...
const bystanders = photo.faces
  .filter((f) => f.tagStatus !== 'TAGGED')
  .map((f) => f.bbox)
```

Because the revoked subject's `FaceDetection` rows no longer exist in the database by the time
this query runs, their face is **not present in `photo.faces` at all** — not as a bystander, not
as anything. `bystanders` never contains their bbox. `redactImage()` is never told to blur that
region. The photo is written to `redactedPath` and marked `piiStatus: 'CLEAN'` or `'MASKED'`
(depending on unrelated PII text) with **that person's face fully visible**, exactly the frame
the pipeline was supposed to certify as safe to hand off.

Compare this to the invariant the same function documents for every other non-consented state
(`session.service.js:1216-1219`):
```js
// Max-privacy rule: the ONLY box left visible is one tagged to a consented
// participant. Everything else is blurred — UNKNOWN, SKIPPED, PENDING, and even
// NOT_A_FACE. Blurring a declared non-face costs nothing; serving a real face
// that was mislabelled as "not a face" is an irreversible privacy leak.
```
A revoked subject is a *worse* case than a mislabelled one — the system correctly knows this
face must not be shown — yet the deletion of the detection row is exactly what makes it
un-blurrable. The fix documented in the comment ("their faces are erased outright") conflates
two different things that should not have been conflated: "stop storing their biometric
embedding" (legitimate, DPDP-aligned) and "stop the pixel-level redaction step from seeing where
their face is" (the bug). The correct remedy is to strip `taggedSubjectId`/`clusterId` and leave
the row (or its bbox) intact so `tagStatus !== 'TAGGED'` still catches it as a bystander — not to
delete the row before the pixel pass runs.

**Verification method:** static, from the transaction and the `redactBystanders` query above —
the control flow is deterministic (delete happens inside a committed transaction; the very next
statement is a fresh `findMany` that cannot see the deleted rows). I did not attempt to reproduce
this live because doing so requires creating a new session/photo/tag/revoke sequence — mutating,
persistent state outside the read-only queries the audit sandbox permits me to run without
flagging as a live mutation; the live DB currently has **zero** `ProjectConsent` rows in
`REVOKED` status (checked directly — see FINDING 2 for the query), so there is no live case to
point at. The claim rests entirely on reading the transaction and the query it feeds, which is
unambiguous.

**Blast radius:** every session where a data owner takes any non-trivial time between tagging
review and clicking finalize (which is the entire point of having a review step), during which
even one tagged subject's consent lapses (revoke, policy version change with no re-consent,
subject deactivation) for any reason. This is not a rare race — it is the *normal* shape of the
tagging→finalize gap the code explicitly says it is defending.

**Fix:** in the `revokedSubjectIds` branch, do not delete `FaceDetection` rows. Instead:
```js
await tx.faceDetection.updateMany({
  where: { clusterId: { in: revokedClusterIds } },
  data: { tagStatus: 'UNKNOWN', taggedSubjectId: null, clusterId: null },
})
```
so the bbox survives into `redactBystanders`'s bystander list. Delete the now-orphaned
`FaceCluster` rows only, or leave them and mark them dropped. Add a regression test: tag a
cluster, revoke that subject's consent, finalize, assert the resulting redacted derivative
actually blurs that face (e.g. assert the returned `X-Redacted-Faces` count from face-worker
includes it, or diff pixel bytes at the bbox against the original).

---

## FINDING 2 (P0, root cause of the live "27 PENDING / 0 DEFERRED" data) — the DEFERRED write inside `redactBystanders`'s catch block is itself unguarded, and a DB hiccup there permanently orphans every remaining photo in the batch with zero trace

This is the definitive answer to the brief's "single most important question": **why 27 PENDING
and zero DEFERRED, and were these photos ever enqueued.**

### The live evidence, assembled end to end

**Step 1 — which sessions hold the 27 PENDING photos, live query:**
```
COL-1414 (df5bbbe1…) ACTIVE     IMAGE  9 photos PENDING, recognitionJobs: []
COL-2225 (e221257d…) ARCHIVED   IMAGE 16 photos PENDING, recognitionJob: DONE
COL-7224 (faa3e6fd…) PROCESSING IMAGE  2 photos PENDING, recognitionJob: RUNNING
```
`COL-1414` and `COL-7224` are explained by the lead's R-1 (stalled recognition / abandoned
session) — they have never reached `TAGGING`, so `finalizeSession`'s IMAGE path (gated by
`assertStatus(session, 'TAGGING')`, `session.service.js:969`) has structurally never run and
redaction has correctly not started. That's 11 of the 27, and it's a session-lifecycle problem,
not a redaction-pipeline defect.

**`COL-2225` is the pipeline defect**, and it's the important 16. Live query:
```
status: ARCHIVED, endedAt: 2026-08-18T19:28:14Z, archivedAt: 2026-08-18T20:04:49.851Z
SessionHandoff: { status: 'PENDING_INGEST', photoCount: 16, subjectCount: 1, linkCount: 16 }
16/16 photos: piiStatus = PENDING, redactedPath = null
```
The `SessionHandoff` row **only gets created inside the `$transaction` at
`session.service.js:1022-1051`**, with real, non-zero `linkCount`/`subjectCount` values computed
from actual tagged clusters — this proves `finalizeSession`'s IMAGE path ran the full tagging
check, consent gate, and transaction commit successfully. The session genuinely, correctly,
archived.

**Step 2 — the audit trail for this session stops mid-function.** `AuditLog` rows for
`e221257d-1ef3-4565-b71d-3528d495af93`, in order:
```
SESSION_STARTED, PARTICIPANT_ADDED, GALLERY_BUILT, SESSION_ENDED, RECOGNITION_COMPLETED
```
**No `SESSION_FINALIZED`. No `GALLERY_DESTROYED`. No `SESSION_HANDED_OFF`.** Those three are
written at `session.service.js:1087-1115` — strictly *after* the calls to `redactBystanders()`
(1054) and `destroyGallery()` (1055). Since the transaction *before* those calls definitely
committed (the handoff row exists with real counts) but *nothing after* those two calls ever
ran, the failure is inside `redactBystanders()` or `destroyGallery()`, and it happened as an
**uncaught, function-level throw** — not a per-photo failure, because a per-photo failure inside
`redactBystanders`'s loop is caught and still lets the function return normally, reach
`destroyGallery`, and reach the audit-log writes.

**Step 3 — none of the 16 (or any of the 27) ever touched the retry queue.** Every job in the
`redaction-retry` BullMQ queue is keyed `redact-<photoId>` (deterministic, `redactionQueue.js:43`).
I enumerated every one of the 27 live PENDING photo ids against Redis directly:
```js
for (const id of pendingIds) {
  const exists = await r.exists(`bull:redaction-retry:redact-${id}`)
}
// total pending ids checked: 27, matches found in redaction-retry queue: 0
```
**Zero matches**, for all 27. The queue is not empty — it holds 61 historical job hashes (30 in
the `failed` zset, 31 `completed`) from *other*, now-resolved photos, including one genuinely
useful piece of corroborating evidence: job `redact-2fa50545-…` recorded
`failedReason: "redaction still failing for photo 2fa50545-…"` — the literal string thrown by
`redaction.worker.js:41` — proving the DEFERRED→retry→dead-letter path **does work correctly
when it is actually reached**. The problem is specifically that these 27 photos never reached it.

Also present in that same job dump: **repeated `FATAL: (ENOTFOUND) tenant/user prism_app`**
failures on `prisma.photo.findUnique()` (the retry worker's own DB call), clustered around
2026-08-01 04:31-05:21 and again matching a batch that sat unprocessed from 2026-08-16T18:19 to
2026-08-18T16:22 (a ~46-hour gap between enqueue and `finishedOn`). This is a Neon/serverless-
Postgres-style transient tenant-lookup failure, and it is not a one-off in this environment's
history — it recurs across at least three separate dates in the live job history.

**Step 4 — ruled out storage/decryption as the cause.** Read the actual sealed original for one
of `COL-2225`'s photos through the app's own `storage.readFile()` (`backend/src/lib/storage.js`,
envelope-decrypts on the way out):
```
OK sessions/e221257d…/photos/878d2fee….jpg  628799 bytes  74ms
```
Fast, clean read. Decryption/storage is not the failure.

### The specific code defect

`session.service.js:1248-1268`, the per-photo catch block inside `redactBystanders`:
```js
} catch (err) {
  const isPii = err instanceof PiiUnavailableError
  await prisma.photo.update({                              // <-- UNPROTECTED
    where: { id: photo.id },
    data: { piiStatus: 'DEFERRED', redactedPath: null },
  })
  deferred += 1
  logger.error(...)

  await enqueueRedaction({ sessionId, photoId: photo.id }).catch((queueErr) => {  // <-- protected
    logger.error({ err: queueErr, photoId: photo.id }, 'could not enqueue redaction retry')
  })
}
```
The `prisma.photo.update(...DEFERRED...)` write is a bare `await` with **no `.catch()` and no
surrounding `try`**. If it throws — and this environment has demonstrably experienced exactly
this class of transient Postgres error multiple times — the throw escapes the `catch(err)` block
itself (a throw inside a `catch` propagates past it, it does not get re-caught by the same
block), which aborts the `for (const photo of photos)` loop entirely and propagates uncaught out
of `redactBystanders()`, out of `finalizeSession()`, to the Express route handler as an unhandled
rejection.

By the time this happens: the whole-session archive transaction has **already committed**
(`session.service.js:1022-1051` runs *before* `redactBystanders` is even called), so the session
is irreversibly `ARCHIVED` with a live `SessionHandoff`. Every photo the loop had not yet reached
— which, for `COL-2225`, is all 16, meaning the double-fault happened on the very first photo
processed — is left at its schema-default `piiStatus: PENDING`, `redactedPath: null`:
- Never marked `DEFERRED` (the write that would have done that is what threw).
- Never enqueued (`enqueueRedaction` on line 1264 is unreachable — the throw happens two lines
  above it, before that call is ever made).
- Never counted by `blockedCount()` in the admin UI (lead's R-2 — `DEFERRED`/`FAILED` only).
- Never visible in the retry queue (nothing to look at — confirmed above).
- Never retried by anything, ever, because nothing in the system tracks "this session's
  redaction pass died mid-flight" as a fact — the session's own status (`ARCHIVED`) looks
  identical to a session that redacted cleanly.

**The exact same class of write appears correctly protected elsewhere in the same file** —
`rebuildRedactedForRemaining`, `session.service.js:1327-1331`:
```js
await prisma.photo
  .update({ where: { id: photo.id }, data: { piiStatus: 'DEFERRED', redactedPath: null } })
  .catch((updateErr) =>
    logger.error({ err: updateErr, photoId: photo.id }, 'could not retract stale redacted derivative'),
  )
```
This proves the failure mode was known and handled once — just not in the one function
(`redactBystanders`) that runs on every single session finalize.

### One safety net that DOES hold

`handoff.service.js:78-123`, `ingestHandoff()` — the actual downstream-consumption gate — is
correctly fail-closed and independently verified:
```js
const unmasked = await prisma.photo.count({
  where: { sessionId: handoff.sessionId, OR: [{ piiStatus: 'DEFERRED' }, { piiStatus: 'FAILED' }, { redactedPath: null }] },
})
if (unmasked > 0) throw new ApiError(409, `REDACTION_INCOMPLETE — ...`)
```
`redactedPath: null` covers `PENDING` too (not just `DEFERRED`/`FAILED`), so `COL-2225`'s handoff
**cannot** be ingested into the downstream Consent Mapping Engine while these 16 photos sit
un-redacted. That part of "fail closed" holds. What's missing is everything upstream of it: no
error surfaced to the agent who ran finalize (they got a 500 for a request that had, unknown to
them, already archived their session), no flag on the session distinguishing "genuinely finished
redacting" from "redaction crashed mid-batch," and no reaper that will ever revisit it. The
`PENDING_INGEST` handoff for `COL-2225` will sit blocked **forever** unless a human notices via a
raw DB query — exactly what this audit did.

**Fix (three parts):**
1. Wrap the `piiStatus: 'DEFERRED'` write in `redactBystanders`'s catch block in its own
   `.catch()`, matching the pattern already used in `rebuildRedactedForRemaining` and for
   `enqueueRedaction` two lines below it. On failure, log loud and keep iterating the remaining
   photos rather than aborting the whole batch.
2. Add a reaper (cron or a check inside the existing retention/purge worker) that finds
   `ARCHIVED` sessions holding photos with `redactedPath IS NULL AND piiStatus NOT IN
   ('DEFERRED','FAILED')` — i.e., `PENDING` orphans in an already-archived session — and
   re-invokes `redactBystanders(sessionId)` (idempotent: it always re-derives from
   `storagePath`, never from a stale derivative, so re-running is safe — see Finding 6).
3. Fix `blockedCount()` in `ProcessedData.jsx` to treat "not CLEAN" as blocked rather than
   enumerating `DEFERRED`/`FAILED` (already flagged by the lead, R-2) — this alone would have
   surfaced `COL-2225` in the UI today.

**Test after fix:** force `prisma.photo.update` to throw on the first photo of a multi-photo
batch (mock/stub in a unit test), assert the remaining photos in the loop still get processed
(either redacted or correctly DEFERRED+enqueued) rather than being silently skipped.

---

## FINDING 3 (P1, compliance) — a bare consent revocation on an already-archived session never touches the already-published derivative; only a full DSAR erasure does

Answering the brief's explicit question directly: **no, revoked-after-publish derivatives are
not regenerated**, except through one specific, narrower path.

`consent.service.js:95-134`, `revokeConsent()`:
```js
const rosterRows = await tx.sessionParticipant.findMany({
  where: { consentId: consent.consentId, session: { status: { in: ['ACTIVE', 'PROCESSING', 'TAGGING'] } } },
})
await tx.sessionParticipant.deleteMany({
  where: { consentId: consent.consentId, session: { status: { in: ['ACTIVE', 'PROCESSING', 'TAGGING'] } } },
})
```
This only touches sessions in `ACTIVE`/`PROCESSING`/`TAGGING`. **`ARCHIVED` is not in that list.**
A subject who revokes project consent after their session has already been finalized (photos
redacted, `PhotoSubject` links written, handoff possibly already `INGESTED`) triggers **no code
path at all** that walks their existing `PhotoSubject` links on archived sessions and rebuilds
the redacted derivative to drop them.

The only function that ever rebuilds a published derivative,
`rebuildRedactedForRemaining` (`session.service.js:1295-1356`), is invoked from exactly one place:
`purge.service.js:364`, inside the **DSAR erasure/purge flow** — i.e., only when the subject (or
an operator on their behalf) files a formal erasure request that reaches execution, not merely
when they revoke project consent. The other trigger, `enqueueRedaction` from
`itemAction.service.js:373`, fires for a `REDACT` DSAR item action (per-photo "remove me from
this frame"), also a DSAR-initiated action, not a bare `revokeConsent()` call.

Live check confirmed there are currently **zero** `ProjectConsent` rows with `status: 'REVOKED'`
in the database, so there is no live photo to point at showing the stale face — this is a
code-path gap (INFERRED, high confidence, from reading `revokeConsent`'s `where` clause against
the `SessionStatus` enum), not something reproducible from current data.

**Blast radius:** any subject who revokes consent (rather than filing a full DSAR erasure) after
their session archived keeps their face visible in every already-published redacted derivative
and every already-`INGESTED` handoff, indefinitely, with no automatic remediation. Under DPDP
§6/§8, a revoked consent should stop a person's identifiable image from continuing to be
distributed; today it only stops future capture.

**Fix:** on `revokeConsent`, also walk `PhotoSubject` rows for `consentId` on `ARCHIVED` sessions
and call `rebuildRedactedForRemaining` for each affected photo (same function the purge flow
already uses), or explicitly route revocation through the same erasure-execution machinery so
there's one code path instead of two.

---

## FINDING 4 (P1, performance / scale) — a single `/detect-pii` call measured at ~2.5s steady-state; `redactBystanders` runs it sequentially, synchronously, inside the `finalize` HTTP request, for every photo in the session

Measured against the live worker on :8002, real decrypted photo (628,799 bytes, pulled via the
app's own `storage.readFile()` from `COL-2225`):
```
run1: http=200 total=5.575s   (cold — RapidOCR lazy-inits its ONNX sessions on first call, main.py:59-67)
run2: http=200 total=2.604s
run3: http=200 total=2.459s
body: {"regions":[],"entities":[]}
```
For comparison, the face-worker `/redact` call (decode + re-encode, no boxes) on the same image:
```
run1: 0.649s  run2: 0.326s  run3: 0.308s
```

`redactBystanders` (`session.service.js:1200-1276`) processes a session's photos in a plain
`for (const photo of photos)` loop, `await`ing `detectPiiRegions` then conditionally
`redactImage` **one photo at a time**, and this entire loop runs synchronously inside the
`POST /:sessionId/finalize` request (`finalizeSession` calls it directly at line 1054, no queue,
no background job — the BullMQ queue only exists for *retries* of failures, not for the initial
pass).

At ~2.5s/photo steady state:
- A session with just **24 photos** already exceeds a typical 60s reverse-proxy/gateway idle
  timeout for the single `finalize` request.
- A session with **200 photos** (not unusual for a single collection event) takes **~500 seconds
  (>8 minutes)** of blocking, synchronous work inside one HTTP request, with zero progress
  feedback to the agent's screen — just a spinner (or a broken connection) for eight minutes.
- At the stated **5,000 images/day** target, `/detect-pii` alone consumes **~3.5 hours/day of
  serialized CPU time** (5000 × 2.5s = 12,500s) before face-worker's blur calls, before the
  *separate* per-photo `/detect` calls the recognition pass already makes
  (`recognition.service.js:69-77`, also unbounded/sequential, also uncaught on a non-200 — see
  Finding 5), and before any of this contends with the second image-pii-worker process that
  would need to run concurrently for a second finalize to proceed at all (FastAPI/uvicorn here
  appears to be single-worker; concurrent finalize calls from two different sessions would queue
  behind each other on the same OCR engine instance).

There is no per-photo timeout on this call either (already established by the lead for the PII
fetch generally) — this finding adds the specific consequence: because the whole-session archive
transaction commits *before* this loop runs (Finding 2), a hang on any single photo does not just
slow one request down, it leaves the session **permanently `ARCHIVED` with an incomplete,
unrecoverable redaction pass**, indistinguishable from Finding 2's failure mode, just triggered by
a stall instead of a thrown exception. Node's HTTP server here has no configured `timeout`/
`requestTimeout`/`headersTimeout` (`server.js` — grepped, none set), and even a client-side
disconnect would not cancel the in-flight `fetch()` (no `AbortController`, per the lead's
existing finding), so the loop keeps running to whatever end it reaches regardless of whether
anyone is still waiting for the response.

**Fix:** move the initial redaction pass off the request path entirely — enqueue one job per
session (or per photo) to a queue and let `finalizeSession` return once the transaction commits,
with the session's true redaction-complete state tracked separately (which also directly serves
Finding 2's need for a distinguishable "redaction incomplete" state). Batch/parallelize
`detect-pii` calls with a bounded concurrency instead of one-at-a-time. Add
`AbortSignal.timeout(...)` to every worker fetch (already flagged, reiterated because it is the
direct cause of the unbounded per-request latency measured here).

---

## FINDING 5 (P2, adjacent to redaction ordering) — recognition's own `/detect` call is equally sequential and uncaught, but this correctly BLOCKS finalize rather than corrupting output

Checked the brief's explicit "ordering vs recognition" question: **can redaction run before face
detection has completed for a session, producing an unredacted image marked clean?** Verified
**no** — this is structurally sound:

- `addPhoto` requires `assertStatus(session, 'ACTIVE')` (`session.service.js:233`) — once
  `endSession` moves a session to `PROCESSING`, no more photos can be added, so recognition
  always sees the complete photo set for that session.
- `recognition.service.js:105-142`, `processSession()`: `detectFaces()` throws uncaught on any
  non-2xx from face-worker's `/detect` (`recognition.service.js:69-76`), with **no try/catch
  around the loop body** — a single face-worker error aborts the whole recognition pass, the job
  never reaches `DONE`, and the transaction that would flip `session.status` to `TAGGING`
  (`recognition.service.js:206-209`) never runs. The session stays `PROCESSING`/eventually
  `FAILED`.
- `finalizeSession`'s IMAGE path requires `assertStatus(session, 'TAGGING')` AND
  `faceCluster.count({tagStatus:'PENDING'}) === 0` (`session.service.js:969-976`) — both gates
  are unreachable unless recognition genuinely completed for every photo.

So a photo cannot reach `redactBystanders` without face detection having successfully finished
for the entire session first — this part of the pipeline is correctly ordered. Flagged P2 only
because `detectFaces()`'s bare throw (no distinction between "face-worker down" vs "this one
image was malformed") means one bad image in an otherwise-healthy batch fails the *whole*
session's recognition pass and requires a full re-run, not a per-photo retry — a smaller-scale
version of the same "no partial-failure granularity" shape as Finding 2, worth hardening for the
same reason, but it does not produce an unsafe *output* the way Findings 1 and 2 do — it produces
a stuck-`PROCESSING` session (already covered by the lead's R-1).

---

## FINDING 6 (informational / positive) — idempotency is actually sound: every redaction path re-derives from the pristine original, never from a prior derivative

Explicitly checked for "double-blur" / blurring an already-blurred image:
- `redactBystanders`: `const original = await readFile(photo.storagePath)` (`:1225`) — always the
  original.
- `rebuildRedactedForRemaining`: `const original = await readFile(photo.storagePath)` (`:1315`)
  — also always the original.
- `redaction.worker.js:30-32`, the retry handler: `if (photo.redactedPath && photo.piiStatus !==
  'DEFERRED') return { skipped: 'ALREADY_REDACTED' }` — guards against reprocessing a photo that
  is already in a terminal, successfully-redacted state.

No code path anywhere reads `redactedPath` as an input to a further blur pass. A photo re-run
through redaction any number of times (retry, DSAR rebuild) always starts from the same
never-mutated original and produces one clean derivative, not a derivative-of-a-derivative. This
part of the design is correct and worth preserving as-is through any fix to Finding 2.

One related, **unverified-live** concern (blocked by the audit sandbox's mutation guard when I
attempted to test it directly against the live Redis queue, so this is INFERRED from BullMQ's
documented job-id semantics + the code's own options, not empirically reproduced here):
`enqueueRedaction` (`redactionQueue.js:38-51`) uses a permanent, deterministic `jobId:
'redact-<photoId>'` with `removeOnFail: false`. BullMQ's documented behavior for `Queue.add()` is
that a job whose id already exists in Redis (in **any** state — waiting, active, completed, *or*
failed, as long as its hash key hasn't been swept) is not re-added; the existing job is returned
unchanged. Combined with `removeOnFail: false`, a photo that is ever dead-lettered (`FAILED`
after 5 attempts) leaves a permanent `redact-<photoId>` hash in Redis. If that same photo later
needs redacting again through the normal `enqueueRedaction()` call — e.g. a DSAR `REDACT` item
action on a photo that previously dead-lettered, or an operator's manual re-trigger after fixing
whatever caused the original dead-letter — the call may silently no-op instead of creating new
work, because the old, terminal job with that id is still sitting in Redis. I could not confirm
or refute this empirically (the harness blocked the live re-`add()` test as a mutating action on
the live queue), so this is flagged P2/inferred, not asserted as proven. **Recommended
verification:** in a disposable/test Redis instance, dead-letter a job, then call
`enqueueRedaction` again with the same `photoId` and assert whether a genuinely new attempt runs.

---

## FINDING 7 (positive / verified fixed) — the `sessions/null/redacted/` path bug is fixed in the code that ships today, for both cases it needs to cover

`session.service.js:1236-1241`:
```js
// Derived from the photo's own session, not from the argument. An imported
// frame has no session, and `sessions/null/redacted/...` would have put a
// derivative outside the per-session key scope that opens it.
const redactedPath = photo.sessionId
  ? `sessions/${photo.sessionId}/redacted/${photo.id}.jpg`
  : `subjects/${photo.subjects[0]?.subjectId ?? 'orphan'}/imports/redacted/${photo.id}.jpg`
```
This derives from `photo.sessionId` — the freshly-queried DB column on the actual photo row —
rather than from the `sessionId` function parameter, which is what the retry worker and the
import enqueue path pass as `null` for a session-less photo
(`import.service.js:284`: `enqueueRedaction({ sessionId: null, photoId: photo.id })`;
`redaction.worker.js:34`: `redactBystanders(sessionId ?? photo.sessionId, { photoIds: [photoId] })`
— note this outer value is irrelevant to path construction anyway, since `photoIds` is supplied
and the inner function re-derives everything per-photo from the DB). Historical Redis job data
corroborates real `sessionId: null` imports were enqueued in the past
(`redact-af3f69c5-…`, `redact-86b20a13-…`, etc., all with `"sessionId":null` in their job data).

**Caveat:** the live DB currently holds **zero** photos with `sessionId: null` (`importBatch: 0`
per the shared brief, confirmed directly: `photo.findMany({where:{sessionId:null}})` → `[]`), so
this could only be verified at the **code** level today, not re-confirmed end-to-end against a
live import. The fix is real and correctly implemented; there is simply no current data to
re-run it against.

---

## What I could not check

- **Could not empirically reproduce Finding 1** (revoke-during-tagging leak) or **Finding 3**
  (revoke-after-archive no-op) against live data: the live DB has zero `REVOKED`
  `ProjectConsent` rows right now, and constructing a live repro (new session → enroll → capture
  → recognize → tag → revoke → finalize) would create new persistent state beyond what read-only
  auditing covers; both findings rest on direct reading of deterministic control flow instead.
- **Could not empirically confirm the BullMQ dead-letter-jobId-blocks-future-enqueue concern**
  (Finding 6, second half) — the harness's auto-mode classifier blocked a live `Queue.add()`
  test against the redaction-retry queue as a mutating action, so this remains inferred from
  BullMQ's documented semantics rather than observed here.
- **Could not directly inspect the running Node processes' stdout/stderr** for `w-redaction`
  (pid 7436), `api` (pid 23320), etc., to capture the literal exception and stack trace behind
  Finding 2's root cause — `.run/services.json` lists PIDs but not log file paths, and I did not
  attempt to attach to or restart any live process per the audit rules. The DB/audit-log/Redis
  triangulation in Finding 2 is strong (multiple independent signals converge on the same
  conclusion) but is circumstantial rather than a captured stack trace.
- **Did not fully audit `pii_recognizers.py` (403 lines) or `redaction.py` (92 lines)** in
  image-pii-worker beyond what `main.py` calls into (`redact_regions`, `CUSTOM_RECOGNIZERS`,
  `IDENTIFIER_ENTITIES`/`NER_ENTITIES`) — `main.py`'s fail-closed wrapping around every OCR/
  analyzer call was the focus per the brief's explicit "fail-closed claim" ask, and that part is
  verified solid (every internal exception in `find_pii_entities` raises `HTTPException(503)`,
  never returns an empty list on error).
- **Did not test the `prism-visual-pipeline` app** (`ai-core/prism-visual-pipeline/`) at all
  beyond confirming it is a separate, self-contained FastAPI app with its own `/api/upload/*`
  routes, its own redaction logic (`app/services/image_redactor.py` — plain Gaussian only, no PII
  text mosaic, no consent/tagStatus concept, matches strictly on Qdrant match/unmatch) that is
  **not** what `FACE_SERVICE_URL` (port 8001) actually serves in this live stack — the real
  backing service for `:8001` is `face-worker/main.py` at the repo root, which is what Findings
  in this report reference. Worth flagging to the lead as a separate, smaller item: this appears
  to be an orphaned/parallel prototype implementation of face redaction living in the repo
  alongside the one actually wired up and running — a maintenance/dead-code hazard (two
  divergent redaction implementations, only one of which is load-bearing) rather than a live
  pipeline defect, so I did not pursue it further under this domain.
- **Did not measure `/detect-pii` against images with actual dense printed text** (Aadhaar/PAN-
  card-style) to see whether OCR time scales further with text density — the one live sample
  pulled had zero OCR hits (`regions: []`), so the ~2.5s figure is a floor for *this* image's
  content, not necessarily an upper bound across the whole live photo set.
