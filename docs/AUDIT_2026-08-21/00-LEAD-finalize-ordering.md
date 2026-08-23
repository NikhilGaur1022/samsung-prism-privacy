# Lead note — the finalize ordering defect (root cause of the stuck/unredacted photos)

This traces `00-LEAD-live-api-and-pipeline.md` FINDING R-2 to its mechanism. It is one of the
highest-value findings in the audit because it explains a data-integrity fault with a clean fix.

## The mechanism

`backend/src/modules/sessions/session.service.js`, IMAGE branch of `finalizeSession()`:

```js
await prisma.$transaction(async (tx) => {
  if (links.length > 0) await tx.photoSubject.createMany({ data: links, skipDuplicates: true })
  if (revokedSubjectIds.length > 0) {
    await tx.faceDetection.deleteMany({ ... })          // line ~1027
    await tx.faceCluster.deleteMany({ ... })
  }
  await tx.session.update({
    where: { id: sessionId },
    data: { status: 'ARCHIVED', archivedAt: new Date() },   // line 1036  <-- COMMITTED HERE
  })
  await tx.sessionHandoff.upsert({ ... })                    // handoff created in the same tx
})

// Everything below runs after the commit and must never be able to undo it.
const { written: redacted, deferred } = await redactBystanders(sessionId)   // line 1054
await destroyGallery(sessionId)
```

**The session is marked `ARCHIVED` and its `SessionHandoff` row is created, committed, and durable
BEFORE the redaction that "archived" is supposed to imply has run at all.**

`redactBystanders()` (line 1200) is the *only* thing in the codebase that ever moves a photo off the
schema-default `piiStatus = PENDING` — it writes `CLEAN`/`MASKED` on success (line 1245) or
`DEFERRED` on a PII-service failure (line 1256). So if `redactBystanders` never completes — the
process is restarted, the request is aborted, an unexpected error is thrown before the per-photo
loop reaches a photo — the session is left **ARCHIVED, handed off, and holding unredacted originals
still marked PENDING**, with nothing to retry it.

That is exactly the observed state of session `COL-2225` (`e221257d…`): `ARCHIVED`,
`endedAt` 2026-08-18T19:28Z, **16 photos at `PENDING`**.

## Why nothing catches it

Three guards exist, and all three miss this case, each for a different reason:

1. **`handoff.service.js:92`** blocks handoff *ingest* on
   `OR: [{piiStatus:'DEFERRED'},{piiStatus:'FAILED'},{redactedPath:null}]`. The `redactedPath: null`
   clause **would** catch a PENDING photo — but this fires at ingest, long after the archive is
   committed and the handoff row exists. The session is already in the wrong state; this only stops
   it propagating further, silently.
2. **`ProcessedData.jsx:21-23`** `blockedCount()` counts only `DEFERRED + FAILED`, not `PENDING`,
   so the operator's warning banner never fires. Live proof that this is not theoretical: the whole
   database contains **0 DEFERRED, 0 FAILED and 27 PENDING**. The banner has never fired and cannot.
3. **`dashboard.service.js:157,205`** likewise counts only `['DEFERRED','FAILED']` for the
   agent's and the platform's "needs attention" tiles. Same blind spot, so the dashboards are
   quietly reporting zero problems while 27 photos sit unredacted, the oldest for 16 days.

`dashboard.service.js:201` is the one place that gets it right — it includes `{ redactedPath: null }`
alongside the two bad statuses. **That is the correct predicate, and it should be the shared one.**

## Second consequence on the same lines: revocation orphans biometric crops

`tx.faceDetection.deleteMany(...)` at line ~1027 deletes the detections belonging to a subject who
**revoked consent between tagging and finalize**. Nothing deletes the crop JPEGs those rows pointed
at (`recognition.service.js:127-129` wrote them to `sessions/<id>/crops/<detectionId>.jpg`).

So the consent-revocation path is a second manufacturing route for the orphaned biometric crops in
`00-LEAD-storage-integrity.md` FINDING ST-1 — and it is the worst possible one: **a person withdraws
consent, the system deletes the database record of their face, and their cropped face image stays on
disk indefinitely, invisible to discovery and unreachable by purge.**

## Fix

Do **not** simply move `redactBystanders` inside the transaction — it makes HTTP calls to the PII
worker and can legitimately defer, so it must not hold a database transaction open.

1. **Add an explicit gate state.** The session transitions to `REDACTING` (not `ARCHIVED`) in the
   transaction; a photo reaching a terminal `piiStatus` for every photo in the session is what
   promotes it to `ARCHIVED`. `SessionHandoff` is created only on that promotion.
2. **One shared predicate for "not finished".** Replace every hand-rolled
   `['DEFERRED','FAILED']` list with a single exported helper — `isUnresolved(photo)` meaning
   `piiStatus !== 'CLEAN' && piiStatus !== 'MASKED'`, **or** `redactedPath == null`. Invert the test
   so a new enum value fails safe. Apply it in `ProcessedData.jsx`, `dashboard.service.js:157,205`,
   `handoff.service.js`, `itemIndex.service.js:98`, `dsar.service.js:767`, `export.service.js:268`
   and `me.service.js:74` — that is the full list of sites that currently enumerate bad states.
3. **Enqueue, don't call.** `finalizeSession` should enqueue redaction for every photo rather than
   awaiting an inline pass, so a crash mid-loop leaves durable queue jobs instead of nothing.
   `enqueueRedaction` already uses `jobId: 'redact-<photoId>'`, so it is idempotent per photo.
4. **Reaper** for photos that sit non-terminal past a threshold, plus an operator queue that shows
   them. This also covers the stuck `RecognitionJob` (`COL-7224`, RUNNING ~2 days).
5. **Delete crop blobs with their rows** — in `finalizeSession`'s revocation branch and in
   `recognition.service.js:107`.

## Tests this needs

- Finalize a session while the PII worker is unreachable; assert the session does **not** reach
  `ARCHIVED`, no `SessionHandoff` exists, and every photo is `DEFERRED` with a queued retry job.
- Kill the process between the transaction commit and the redaction pass; assert the reaper
  re-drives it and the session eventually reaches `ARCHIVED`.
- Seed a session with one `PENDING` photo; assert `blockedCount()` reports it and the dashboard
  "needs attention" tiles include it.
- Revoke a subject's consent between tagging and finalize; assert their `FaceDetection` rows AND
  their crop files are both gone.
- A repository-wide test that greps for the literal `['DEFERRED','FAILED']` and fails, so the
  shared predicate cannot be bypassed again.
