# DSAR lifecycle / discovery / item index / item actions / purge / certificates — audit findings

Scope: `backend/src/modules/dsar/*`, `backend/src/workers/{purge,itemAction,retention}.worker.js`,
`backend/src/lib/{purgeQueue,itemActionQueue,cleanup,consent,revocation}.js`.

All evidence below is labeled OBSERVED (live curl / live DB query / live filesystem diff) or
INFERRED (static code reading only). Live testing used the `dataadmin` and `dpo` cookie jars
against `http://localhost:4000`, Prisma against the live Postgres, and a direct filesystem walk of
`backend/storage/media`.

This module is, on the whole, unusually carefully engineered — extensive in-code reasoning about
invariants, fail-closed defaults in most places, and comments that pre-empt exactly the questions
an auditor would ask. The findings below are the places where that discipline has gaps, plus one
place (the null-`sha256` recording bug) where a completely different subsystem's data-integrity
defect quietly disables this module's core guarantee.

---

## FINDING 1 (P0) — `POST /dsar/:id/discovery` 500s for real subjects; the item index silently
serves stale totals for the same reason. Root cause: `Recording.sha256` is NULL in the DB for 6
live rows, violating the non-nullable Prisma schema type.

**OBSERVED live**, reproduced end-to-end on the exact request the brief pointed at:

```
$ curl -s -w "\nHTTP:%{http_code}\n" -b cookies.dataadmin.txt -X POST \
    http://localhost:4000/api/v1/dsar/5a13e5a1-9fe6-46c1-9a56-55e0dd64b377/discovery
{"error":"\nInvalid `prisma.recording.findMany()` invocation:\n\n\nError converting field
\"sha256\" of expected non-nullable type \"String\", found incompatible value of \"null\"."}
HTTP:500
```

Root cause, isolated by calling `indexSubject()` directly against the live DB:

```
$ node --input-type=module -e "import { indexSubject } from './src/modules/dsar/itemIndex.service.js';
  await indexSubject('de351590-aea7-457a-a784-2241dcf2fc66')"
THREW: PrismaClientKnownRequestError
Invalid `prisma.recording.findMany()` invocation:
Error converting field "sha256" of expected non-nullable type "String", found incompatible value of "null".
```

Raw SQL against the live DB confirms 6 `recordings` rows system-wide have `sha256 IS NULL` (and
`size_bytes IS NULL` alongside it — both columns are `@default(...)`-non-nullable in
`prisma/schema.prisma`, so these were explicitly written `NULL`, not merely omitted):

```
all null-sha256 recordings: [
  { id: "59cf67bd-...", session_id: "3e8eb64e-...", status: "ANALYZED",  sha256: null, created_at: "2026-08-15T22:09:32Z" },
  { id: "e5d7287c-...", session_id: "09aa9054-...", status: "REDACTED",  sha256: null, created_at: "2026-08-15T22:52:09Z" },
  { id: "d4787869-...", session_id: "09aa9054-...", status: "REDACTED",  sha256: null, created_at: "2026-08-15T22:46:41Z" },
  { id: "fd49d7cd-...", session_id: "0f801cb1-...", status: "REDACTED",  sha256: null, created_at: "2026-08-16T11:52:40Z" },
  { id: "93f16417-...", session_id: "df093b18-...", status: "ANALYZED", sha256: null, created_at: "2026-08-19T06:52:27Z" },
  { id: "3756c42d-...", session_id: "139dcdc2-...", status: "REDACTED",  sha256: null, created_at: "2026-08-19T04:20:44Z" },
]
```

`e5d7287c-...`, `fd49d7cd-...` and `3756c42d-...` are all in the segment set of subject
`de351590-aea7-457a-a784-2241dcf2fc66` (106 live `AudioSegment` rows for that subject). **Any
Prisma query anywhere in the app that selects `Recording.sha256` over a resultset touching one of
these 6 rows throws** — and both `discovery.service.js:130-141` (`runDiscovery`'s recordings walk)
and `itemIndex.service.js:283-286` (`indexSubject`'s `RECORDING_SELECT`, which selects `sha256:
true`) do exactly that for this subject.

Consequences, chained and each independently confirmed:

1. **`POST /dsar/:id/discovery` 500s** (shown above) — this is the *first mandatory step* of every
   DSAR type (`dsar.routes.js:193-203`, `dsar.service.js:358-395`). It cannot be retried into
   success; the bug is data, not a transient fault.
2. Because `runDiscoveryForRequest()` never completes, the request **never leaves `RECEIVED`**.
   `GET /dsar/5a13e5a1.../` shows, live, right now:
   ```
   "status": "RECEIVED", "assignedAdminId": null, "dpoAdminId": null,
   "sla": { "internalDueAt": "2026-08-06T15:12:55.706Z", "daysRemaining": 9,
            "breached": false, "internalBreached": true }
   ```
   This request was raised **2026-07-30**. It is **15 days past its internal 7-day SLA** and **9
   days from its statutory 30-day deadline**, and it is *structurally impossible* to move it
   forward through the normal API because the very first step throws. The sibling request on the
   same subject, `75eae901-...` (type `ACCESS`, raised 2026-08-05), is in the identical state for
   the identical reason.
3. If this subject's other DSAR were an `ERASE`, `createPurgeJob()` (`purge.service.js:294`) calls
   `runDiscovery()` unscoped and would throw the same 500 — **erasure is impossible for this
   subject**, not merely delayed, until the bad rows are fixed.
4. **Every read of the item grid degrades silently instead of failing loudly.**
   `itemSearch.service.js:256-286` (`verifyIndex`) is the self-healing guard the code's own
   comments describe as load-bearing ("a divergence must either be fixed or reported — never
   silently served as if it were the truth"). OBSERVED live on `GET
   /dsar/5a13e5a1.../items?limit=1`:
   ```json
   "totals": { "all": 66, "matching": 66, "deleted": 25, "byType": { "PHOTO": 66 },
               "byOrigin": { "ENROLLMENT": 3, "COLLECTION_SESSION": 63 } },
   "index": { "expected": 101, "indexed": 66, "consistent": false, "repaired": false }
   ```
   `sourceLiveCount()` (`itemSearch.service.js:237-247`) correctly computes the *true* source count
   as 101 (it includes the subject's 15 recordings + 1 voice enrollment on top of the 66
   photo/enrollment rows). `verifyIndex` sees 66 ≠ 101, logs `ITEM_INDEX_DIVERGED`, and attempts
   the documented repair-on-read by calling `indexSubject()` — which throws the identical
   `sha256` error, is caught, logged as `ITEM_INDEX_REPAIR_FAILED`, and **the response still ships
   `totals.all: 66`** with only `index.consistent: false` as a signal. Nothing in
   `admin-portal` renders that field (confirmed by grep — see Finding 7). An operator reading
   "66 items, this is everything" is reading a number that is wrong by 35 items, **every single
   time they load this screen**, with no way for the self-healing mechanism to ever recover on its
   own, because the underlying data defect never changes.
5. **Every AUDIO item for this subject is invisible to the DSAR item grid.**
   `SELECT sourceTable, count(*) FROM subject_data_items GROUP BY sourceTable` returns, live,
   right now: `{ subject_face_enrollments: 28, photo_subjects: 63 }` — **zero** rows anywhere in
   the whole table have `sourceTable IN ('recordings', 'subject_voice_enrollments')`, despite 29
   live recordings and 255 live `AudioSegment` rows system-wide, and despite this exact subject
   being a confirmed speaker in 15 of those recordings. The item index has *never* successfully
   indexed a single audio item, for any subject, ever, in this database. An ACCESS request served
   from this grid omits every recording and the voice enrollment; an ERASE request driven off this
   grid cannot select or delete a single audio item.

**This is one bug with five independently observable symptoms**, and it demonstrates the exact
failure mode the audit brief asked about: a store (audio) is architecturally covered by discovery
and the item index, but a live data-integrity defect elsewhere (a NULL a supposedly non-nullable
column) silently disables that coverage for real subjects, and the two purpose-built defenses
against exactly this (`verifyIndex`'s repair loop, `runDiscovery`'s non-fatal index-refresh
try/catch at `discovery.service.js:471-478`) both catch the exception and **serve a degraded
answer instead of surfacing an error the operator can act on**.

- `backend/src/modules/dsar/discovery.service.js:130-141` — unguarded `await
  prisma.recording.findMany(...)`, no try/catch around this specific query (the try/catch at
  line 471 only wraps the `indexSubject()` call at the very end, not this one).
- `backend/src/modules/dsar/itemIndex.service.js:65-78,262-287` — `RECORDING_SELECT` selects
  `sha256: true`; `indexSubject()` has no try/catch of its own, relying on callers.
- `backend/src/modules/dsar/itemSearch.service.js:256-286` — `verifyIndex()`'s repair swallows the
  exception and reports `repaired:false` with no way to distinguish "nothing to repair" from
  "repair attempted and crashed" in the shape the admin portal actually renders.
- Root data defect: 6 `recordings` rows with `sha256 IS NULL` / `size_bytes IS NULL` — likely a
  recording-finalize path that writes the row before the checksum step runs, or the checksum step
  errors out non-fatally (out of scope for this audit's module list, but flagged because it is the
  actual root cause; worth handing to whoever owns `backend/src/modules/recordings/`).

**Fix, three parts:**
1. Immediate: backfill the 6 rows with a real sha256 (recompute from the file on disk) or, if the
   file is gone, an explicit sentinel your queries can filter on — but *do not* leave a
   non-nullable column holding NULL in production.
2. Structural: `Recording.sha256` should either be genuinely nullable in the Prisma schema (if
   "unknown yet" is a valid state) or the write path that creates a Recording row must be
   transactional with computing the checksum so the row never exists without one.
3. Defensive: `runDiscovery()`'s recordings query and `indexSubject()`'s `RECORDING_SELECT` should
   not be able to take down the whole discovery/index-repair flow because of one bad row —
   catch per-recording, or select the raw column and coerce nulls in JS, so 5 good recordings don't
   get held hostage by 1 bad one for every subject who happens to be audible in it.
4. Observability: `verifyIndex`'s `repaired:false` needs to be distinguishable in the API response
   from "nothing needed repair", and the admin portal needs to render `index.consistent === false`
   as a visible banner, not a field nobody reads (see Finding 7).

---

## FINDING 2 (P0) — Text documents can be discovered but can never be purged: `purge.service.js`
has no execution handler for L18, L19, or SPAN. Any full-subject ERASE for a subject with text data
can never reach COMPLETED, so it can never be certified or closed.

`discovery.service.js:363-410` walks `TextSpan`/`TextDocument` and emits `L18`
(`TextDocument.storagePath`), `L19` (`TextDocument.redactedPath`) and `SPAN` (`TextSpan`
attribution) locations into the discovery result — and `createPurgeJob()`'s unscoped path
(`purge.service.js:294-302`) takes `discovery.locations` verbatim, so these locations **are**
planned into every full-subject `PurgeJob`.

But `purge.service.js`'s `handlers` object (`purge.service.js:337-547`) defines handlers for
`LINK, L3, L7, L6, L2, SEGMENT, L15, L14, L4, L5_ROW, L16, L17_ROW, ROSTER, CONSENT, PII, L9, L10,
L8, L11, SUBJECT_KEY` — **`L18`, `L19` and `SPAN` are absent**, confirmed by grep (zero matches for
`L18`/`L19`/`'SPAN'` anywhere in the file outside the discovery-side comment that names the gap).
`PHASE_ORDER` (line 34-56) also omits all three.

Trace through `executePurgeJob()` (line 555-642): for an `L18`/`L19`/`SPAN` location, `phaseOf(loc)`
returns the location code itself (the function only special-cases `SubjectKey`/`L5`/`L17`), then
`const handler = handlers[phase]` is `undefined`, which hits the `if (!handler)` branch
(line 579-586): the location is marked **`FAILED`** with `error: 'No handler for phase "L18"'`,
and `failures += 1`. This is not a maybe — it is unconditional for every subject who has any text
document.

Downstream, this is fail-*closed* in the narrow sense that matters most (no false certification —
credit where due, see the note on `certificate.service.js` below) but it is fail-**permanent** in
a way the platform has no remedy for:

- `complete = done === total && failures === 0` (line 621) — always false when an L18/L19/SPAN
  location exists, so `job.status` becomes `'PARTIAL'`, never `'COMPLETED'`.
- `issueCertificate()` (`certificate.service.js:68-73`) throws 409 unless `job.status ===
  'COMPLETED'` — **no certificate can ever be issued.**
- `execute()` (`dsar.service.js:442-454`) only calls `issueCertificate` when `finished.status ===
  'COMPLETED'`; otherwise the request "stays EXECUTING and the SLA clock keeps running" (the
  code's own comment) — forever, because retrying `executePurgeJob` re-runs the same
  `L18`/`L19`/`SPAN` locations into the same `FAILED` outcome every time (no handler exists to fix
  by retrying).
- `approveResolution()` and `closeRequest()` (`dsar.service.js:481-486, 543-548`) both refuse to
  close an `ERASE`/`WITHDRAWAL_ERASURE` request with no certificate.

**Net effect: a subject with any text-document data can never have their erasure request
completed, certified, or closed, through any path the platform exposes — permanently, not until
some manual DB intervention.**

**OBSERVED live**: subject `de351590-aea7-457a-a784-2241dcf2fc66` — the exact subject the brief
designated for testing — has 4 live `TextSpan` rows (`totalTextSpans: 8` system-wide, split 4/4
across `de351590` and a second document set). No `ERASE`/`WITHDRAWAL_ERASURE` request currently
exists for this subject in the live data (their two open requests are `CORRECT` and `ACCESS`), so I
could not additionally reproduce the `PARTIAL`-forever purge live without raising a new erasure
against real fixture data, which I judged too destructive for a shared multi-agent audit
environment (see "what I could not check"). The code-level proof above — the `handlers` object
provably missing 3 of the keys `PHASE_ORDER`/discovery jointly require — does not depend on that
live reproduction; it is a static fact about the file, and it is corroborated by the discovery.js
comment that already half-admits it ("purge.service.js plans its own location list and has no
L18/L19/SPAN handler yet, so an erasure will not touch these").

- `backend/src/modules/dsar/purge.service.js:337-547` (`handlers`), `34-56` (`PHASE_ORDER`),
  `575-586` (unhandled-phase branch)
- `backend/src/modules/dsar/discovery.service.js:363-410` (locations planned, never executable)
- `backend/src/modules/dsar/certificate.service.js:67-73` (correctly refuses to certify — not the
  bug, but the point where the deadlock becomes permanent and user-visible as a 409)

**Fix:** add `L18`/`L19`/`SPAN` handlers mirroring the `L6`/`L15`/`L2`/`L14`/`SEGMENT` pattern
already used for photos and audio (rebuild-with-redaction for a shared document, delete when sole
subject, strip attribution from `TextSpan` rather than deleting it). This is the same pattern
applied three more times, not new design work — the hard part (the multi-subject-safe erasure
model) is already built and tested for two other modalities.

---

## FINDING 3 (P0) — 383 of 491 face-crop files on disk (78%) are orphaned: no `FaceDetection` row
references them. Discovery cannot find them; purge cannot erase them.

**OBSERVED live**, direct diff of the live DB against the live filesystem:

```
DB cropPath rows: 108 distinct: 108
files on disk under */crops/*: 491
orphaned (on disk, no DB row): 383
DB rows pointing at missing files: 0
```

Every one of the 108 live `FaceDetection.cropPath` values resolves to a real file (0 dangling DB
references — the *live* side of the system is internally consistent). But **383 additional crop
files exist on disk that no database row of any kind points at**, spread across dozens of session
directories (sample: `023d39bc-...`, `02d08ecd-...` [×5], `02e004a3-...`, `07135e61-...` [×3],
`0d48b3a0-...` [×3], ...). Confirmed sealed under the same encryption as live media (magic bytes
`5052534d` = "PRSM", matching the lead's finding for stored photos — not plaintext on disk, but see
below for why that does not make them erasable):

```
$ xxd -l16 storage/media/sessions/.../crops/8d6a85dd-....jpg
00000000: 5052 534d 0120 94c8 27c1 2070 0886 71e7  PRSM. ..'. p..q.
```

`discovery.service.js:272-279` builds L3 locations exclusively from `FaceDetection` rows — it never
lists the `crops/` directory or reconciles it against the DB. `purge.service.js`'s `L3` handler
(line 343-347) shreds exactly `loc.storagePath`, which is only ever populated from a live
`FaceDetection.cropPath`. **Neither code path can see a file that fell out of the `FaceDetection`
table.** The most plausible mechanism, from the ~4.5:1 orphan:live ratio and every affected session
having a `crops/` directory: repeated re-runs of face detection/recognition during development each
wrote a fresh batch of crop files under new UUIDs without deleting the previous batch's files when
the corresponding `FaceDetection` rows were replaced — but the mechanism doesn't change the
finding: **right now, in the live store, most face-crop imagery on disk is unreachable by any DSAR
mechanism.**

Why "sealed" does not neutralize this for the DSAR guarantee: purge only ever destroys the
per-subject encryption key (`SUBJECT_KEY`, `purge.service.js:539-546`) as the **last phase of a
FULL, unscoped erasure**. The much more commonly supported operator action — a single-item
`DELETE` from the item grid (`itemAction.service.js`, `ItemGrid.jsx`) — explicitly does **not**
touch the subject key (`locationsForItems()`'s own comment, `purge.service.js:85-92`: "Destroying
the per-subject DEK to honour the deletion of one photo would make every OTHER photo... 
permanently unreadable"). So for the primary, everyday erasure path, the orphaned crop's key stays
live indefinitely — the file is not merely "on disk encrypted", it is on disk **and decryptable by
the running application** for as long as the subject has any other retained data, which for an
active subject is most of the time. Even for a full erasure, the crop is never named on the
`DeletionCertificate` (it isn't a location at all — nothing found it), so the certificate's
`residualNote` ("the per-subject encryption key has been destroyed, rendering biometric material...
undecryptable") is stated as if it accounts for everything, when it happens to cover this only as
an unacknowledged side effect, and only in the full-erasure case.

- `backend/src/modules/dsar/discovery.service.js:271-279` (L3 walk, `FaceDetection`-only)
- `backend/src/modules/dsar/purge.service.js:343-347` (L3 handler, same restriction)
- Live evidence: 491 files under `backend/storage/media/sessions/*/crops/*`, 108 with a DB row, 383
  without (script used: file walk + `SELECT cropPath FROM face_detections`, diff on relative path)

**Fix:** a periodic (or pre-discovery, or pre-purge) reconciliation sweep that lists every file
under each session's `crops/` directory and either (a) deletes any file with no matching
`FaceDetection.cropPath` if it is confirmed to be recognition-rerun debris, or (b) if there is any
chance an orphan is still a legitimate crop of a real, un-tagged face, surfaces it as an L3-shaped
discovery location keyed by path rather than by a `FaceDetection.id` that no longer exists — because
right now the second case is indistinguishable from the first, which is itself evidence the walk
needs to start from disk, not only from the DB, for this one location type.

---

## FINDING 4 (P0) — `FaceCluster` rows are never discovered, never purged. Live: 4 rows tagged to
a real DSAR subject, spanning 79 face detections across 4 sessions.

**OBSERVED live**:

```
clusters tagged to our 3 live dsar subjects: [
  { id: "d8899f61-...", sessionId: "e221257d-...", taggedSubjectId: "de351590-...",
    suggestedSubjectId: "de351590-...", repFaceId: "f7aba0e4-...", faceCount: 16, tagStatus: "TAGGED" },
  { id: "eaaf0245-...", sessionId: "04f886f4-...", ..., faceCount: 21, tagStatus: "TAGGED" },
  { id: "a5a5d8f1-...", sessionId: "b3152141-...", ..., faceCount: 20, tagStatus: "TAGGED" },
  { id: "69a62b3a-...", sessionId: "338c7d6e-...", ..., faceCount: 22, tagStatus: "TAGGED" }
]
```

All 4 are `TAGGED` and both `taggedSubjectId` and `suggestedSubjectId` point at
`de351590-aea7-457a-a784-2241dcf2fc66` — one of the 3 live DSAR subjects. `grep -rn "faceCluster"
src/modules/dsar` returns **zero matches**: `discovery.service.js` never queries `FaceCluster`, so
none of this — the cluster row itself, its `repFaceId` (a representative crop reference), its
`taggedSubjectId`/`suggestedSubjectId` identity links — appears in a discovery result, an access
package, or the item index. `purge.service.js`'s `handlers` has no `FaceCluster`-touching code
either.

Two concrete consequences:

1. **Completeness**: an ACCESS request for this subject never surfaces "you were identified in 4
   face-tagging clusters covering 79 detections" — the discovery walk simply doesn't ask.
2. **Erasure**: after any future erasure of this subject, `face_clusters.tagged_subject_id` and
   `.suggested_subject_id` keep pointing at `de351590-...`'s (by then anonymized-in-place, not
   deleted — see the `PII` handler) `Subject` row forever; nothing ever clears them. And
   `repFaceId` is a bare `String? @db.Uuid` column with **no `@relation`** in
   `prisma/schema.prisma:649-685` — it is not foreign-key-enforced, so when purge's `L3` handler
   deletes the `FaceDetection` row it points at, `repFaceId` silently dangles with no cascade and no
   code that notices.

- `backend/src/modules/dsar/discovery.service.js` — no `prisma.faceCluster` reference anywhere in
  the file (confirmed by grep)
- `backend/prisma/schema.prisma:649-685` (`FaceCluster` model; `repFaceId` has no `@relation`)
- Live query: `SELECT * FROM face_clusters WHERE tagged_subject_id IN (...)` → 4 rows, as above

**Fix:** add a `FaceCluster` walk to `runDiscovery()` (by `taggedSubjectId` and
`suggestedSubjectId`) and a purge step that nulls both identity columns (and `repFaceId`/`repTrackId`
if the row they point at was destroyed) on erasure — mirroring the `SetNull` pattern already used
correctly for `FaceDetection.taggedSubjectId` and `VideoFaceTrack.taggedSubjectId`.

---

## FINDING 5 (P0 latent / P2 today) — Video (`VideoAsset`/`VideoFaceTrack`/`VideoPiiSpan`/
`VideoSubject`) and import batches (`ImportBatch`, L12/L13) are 100% absent from both discovery and
purge. Zero live rows today, so no active leak — but the gap is total, and one is already
schema-documented as imminent.

Grep confirms zero references to `videoAsset`/`VideoAsset`/`videoSubject`/`videoFaceTrack` and zero
references to `importBatch`/`ImportBatch` anywhere in `discovery.service.js` or `purge.service.js`.
`LOCATIONS.L12_IMPORT_ORIGINAL`/`L13_IMPORT_REDACTED` (`discovery.service.js:26-27`) are **defined
constants that are never assigned to a single location** anywhere in the file — dead vocabulary,
confirmed by grep (`L12`/`L13` appear only in their own definition line).

`DataItemType.VIDEO` (`prisma/schema.prisma:1153-1159`) carries a comment written by whoever added
it, asserting an erasure path exists: *"Same rule as AUDIO: the capture path
(video.service.analyzeVideo) and the erasure path (purge.service L16/L17 +
rebuildRedactedVideoForRemaining) landed in the same change..."* — **this is false on the current
`main`**: `L16`/`L17` are the *voice enrollment* codes (`discovery.service.js:36-37`), not video;
`rebuildRedactedVideoForRemaining` does not exist in `purge.service.js` (grep, zero matches); and
`itemIndex.service.js`'s `SOURCE` map has no `VIDEO` entry at all. Either the comment describes work
that was reverted, or it describes work that was never actually landed and the comment shipped
ahead of the code. Either way it is actively misleading to the next engineer who reads it and
assumes video erasure is covered.

Live state confirms this is not yet an active data-loss incident: `videoAssets: 0`,
`importBatches: 0` (both queried directly against the live DB). Kept as P0 in the schema/severity
sense (a store that, per the brief's own framing, discovery misses is a P0 legal hole) but scored
down to P2-today because there is currently nothing in either store for a live erasure to fail to
touch. **This will become a live P0 the moment either feature is used** — video-worker is already
listed as an opt-in profile in the topology, and the enum/schema plumbing for both is already fully
built, which is exactly the situation ("data class that can be collected but not erased makes the
deletion certificate a false statement" — the schema's own words, about video, written before the
erasure path it promised was actually skipped) the codebase's own comments say must never ship.

- `backend/prisma/schema.prisma:1434-1577` (`VideoAsset`/`VideoFaceTrack`/`VideoPiiSpan`/
  `VideoSubject`), `1270-1294` (`ImportBatch`)
- `backend/src/modules/dsar/discovery.service.js:26-27` (dead `L12`/`L13` constants)
- Live: `videoAssets: 0`, `importBatches: 0` (Prisma count queries against the live DB)

**Fix:** either wire the discovery/purge walk for video and import batches now (cheap while both
are at zero rows — no backfill risk), or pull `DataItemType.VIDEO` and the L12/L13 constants back
out until the erasure path is real, and fix the stale comment either way so it stops asserting
something untrue.

---

## FINDING 6 (P1) — Retention's 7-day original-TTL sweep has no concept of an open DSAR or a legal
hold, and can permanently starve a later multi-subject erasure's rebuild step.

`grep -rn "legalHold\|LegalHold\|legal_hold\|litigationHold"` across `prisma/schema.prisma`,
`src/modules/dsar`, `src/workers`, `src/lib` returns **zero matches** — the concept does not exist
anywhere in this codebase. `retention.worker.js:sweepOriginals()` (line 33-73) and
`sweepRecordingOriginals()` (line 96-140) shred `Photo.storagePath`/`Recording.storagePath` 7 days
(`ORIGINAL_TTL_DAYS`, default 7) after `session.archivedAt`, gated only on the redaction having
already confirmed CLEAN/MASKED/REDACTED — with **no join to `DsarRequest`, no check for an open
request on any subject linked to the photo, and no hold flag of any kind.**

Chained consequence, traced through the erasure code itself (this part is well-built and fails
*closed*, not open — noted as such): when a **second** subject on a multi-subject photo later
erases, `purge.service.js`'s `L6` handler calls `rebuildRedactedForRemaining(photoId)`
(`session.service.js:1295`), which needs to `readFile(photo.storagePath)` to re-blur. If retention
has already shredded that original (which, on the default 7-day clock, is very plausible — it is
far shorter than the 30-day statutory DSAR window, so *any* multi-subject photo whose session went
quiet for a week before a second erasure lands has already lost its rebuild source), `readFile`
throws, and `rebuildRedactedForRemaining`'s catch block (`session.service.js:1321-1335`) correctly
retracts the stale derivative (`piiStatus: DEFERRED, redactedPath: null`) and re-enqueues a
redaction retry that **will fail identically forever**, because the file it needs is gone and
nothing regenerates it. The `L6` location for this erasure never resolves to `DONE`, so — same
chain as Finding 2 — the purge job is stuck `PARTIAL` forever, no certificate, no close, for the
*remaining, non-erasing* subject's data on that photo, triggered by nothing more than routine
housekeeping running on schedule.

This is not a data-loss bug (nothing is served incorrectly; the fail-closed retraction is correct)
but it is a real, structural SLA/liveness bug: the platform's own default retention clock (7 days)
is shorter than the time a real DSAR realistically takes to reach execution, and the interaction
between the two subsystems (retention worker, purge executor) has no operator-visible signal beyond
a `PurgeJobLocation` stuck `FAILED` and a `PurgeJob` stuck `PARTIAL` that nobody is specifically
alerted to reconcile.

- `backend/src/workers/retention.worker.js:33-73, 96-140` (no DSAR/hold check)
- `backend/src/modules/sessions/session.service.js:1295-1335` (`rebuildRedactedForRemaining`,
  correctly fails closed, but with no recovery path once the source is gone)
- `backend/src/modules/dsar/purge.service.js:355-370` (`L6` handler, calls into the above)

**Fix:** either (a) add a real legal-hold / open-DSAR gate to `sweepOriginals`/
`sweepRecordingOriginals` so an original with any open, non-`ACCESS`-only DSAR touching one of its
subjects is skipped until that DSAR closes, or (b) if an original is destroyed and a later
rebuild finds it gone, fall back to destroying the *whole* photo rather than leaving it in an
unrecoverable `DEFERRED`/`FAILED` limbo — that direction is at least self-resolving and, per the
codebase's own stated principle for the audio equivalent ("destroys more, not less... the correct
direction to fail"), consistent with how this exact tradeoff is already handled one location down
the list at `L14`.

---

## FINDING 7 (P1) — The item-index divergence signal (`index.consistent`) is computed correctly but
rendered nowhere in the admin portal; an operator has no way to learn the completeness number they
are looking at is wrong.

Confirmed by grep: `sharedSubjectCount`/`shared`/downgrade language *is* wired into
`admin-portal/src/components/ItemGrid.jsx` and `admin-portal/src/pages/dataAdmin/
DsarRequestDetail.jsx` (see Finding 11's positive note — that part is done well), but neither file,
nor any other `.jsx` under `admin-portal/src`, references `index.consistent`, `index.repaired`, or
`index.expected` — the three fields `listSubjectItems()` (`itemSearch.service.js:337-350`) returns
specifically so a UI *can* show this. The API contract exists; the consumer of it does not. Given
Finding 1 proves this field is `false` right now, live, for a real subject with a real breached SLA,
this is not a hypothetical gap.

- `backend/src/modules/dsar/itemSearch.service.js:337-350` (the `index` object)
- `admin-portal/src` — zero matches for `index.consistent` / `index.repaired` (grep)

**Fix:** render `index.consistent === false` as a blocking banner on the DSAR item grid ("this
completeness count could not be verified — do not treat it as final"), not a silent field.

---

## FINDING 8 (P1) — `buildAccessPackage`'s request-type gate is dead code on the only path that
reaches it; any admin can build a full §11 access package against any DSAR type. Confirmed live on
a real `CORRECT`-type request.

`export.service.js:124-125`:
```js
if (request.type !== 'ACCESS' && !admin) {
  throw new ApiError(400, `DSAR type ${request.type} does not produce an access package`)
}
```
The only caller that reaches this function through the API is `POST /:requestId/package`
(`dsar.routes.js:259-274`), which is mounted behind `requireAdminAuth` for the whole router
(`dsar.routes.js:16`) — `req.admin` is **never** null on this path, so `!admin` is always false and
the type check can never fire for the one caller that exists. (The `admin`-less branch appears to
anticipate a subject-initiated build path that either doesn't exist yet or lives elsewhere — I
found no such caller.)

**OBSERVED live**: `GET /dsar/5a13e5a1.../` (type `CORRECT`) lists, in its `evidence[]`, three
`EXPORT_PACKAGE` rows labeled *"DPDP §11 access package — selected subset (SELECTED)"* and one
labeled *"DPDP §11 access package"*, all built 2026-08-05 — a full data-access package, produced
against a request whose type is a *correction* request, not an access request. Whether or not this
particular instance was a deliberate operator action, the code has no gate preventing it: any
`dataAdmin`/`super_admin` can build a §11-labeled access package while working a `CORRECT`,
`GRIEVANCE`, or even an in-flight `WITHDRAWAL_ERASURE` request, with no distinguishing record that
the package was built under a type it wasn't scoped for.

- `backend/src/modules/dsar/export.service.js:116-125`
- `backend/src/modules/dsar/dsar.routes.js:259-274` (the only reachable caller, always admin)

**Fix:** if admin-initiated cross-type export is intentional (e.g., as evidence for a grievance
investigation), say so in the check and log it distinctly; if not, gate on `request.type ===
'ACCESS'` unconditionally and give operators who need evidence for another request type the
`attachEvidence`/vault path instead.

---

## FINDING 9 (P2) — `indexSubject()`'s tombstone sweep can resurrect an item a concurrent scoped
DELETE just purged. (INFERRED — not reproduced live; see rationale.)

`indexSubject(subjectId)` (`itemIndex.service.js:261-327`) reads live source rows, then unconditionally
writes each with `deletedAt: null` (`entries` construction, lines 289-307, `photoItem`/`recordingItem`
never set a `deletedAt`), then sweeps anything **not** touched this pass into a tombstone
(`indexedAt: { lt: at }`). There is no lock or version check between the initial read and the final
write.

Interleaving that breaks the invariant: a full rebuild (triggered by `runDiscoveryForRequest()`,
re-runnable at any time the request is `RECEIVED`/`TRIAGE`/`DISCOVERY` — `dsar.service.js:358-364`)
reads `photoSubject` link `X` at T0. Concurrently, a scoped item-action `DELETE`
(`itemAction.service.js:377-424`, reachable once the request is `DISCOVERY`/`EXECUTING`/`REVIEW`)
destroys link `X` via `createPurgeJob(...,{items:[live]})` → `executePurgeJob` → the `LINK` handler
(`purge.service.js:338-341`) at T0.5, then calls `markItemDeleted(item.id)` at T1, tombstoning the
`subjectDataItem` row. The rebuild's `writeAll(entries, at)` runs at T1.5 and **unconditionally
writes `deletedAt: null`** for the entry built from the link it read at T0 — un-tombstoning a row
that was correctly, permanently deleted half a step earlier. The item index (and therefore
`totals.matching`/`totals.deleted` and the `GET /items` grid) would show the item as still held
until the *next* rebuild's tombstone sweep catches up (which requires the underlying
`PhotoSubject`/`Recording` row to still be absent, which it is — so the next rebuild does correct
it, but only the next one).

I judged this too narrow a timing window to force reliably against the shared live dataset without
either (a) actually executing an irreversible per-item `DELETE` against real fixture rows other
audit agents may depend on, or (b) racing two requests with sub-100ms precision against a database
whose query latency I cannot control from outside — so this is reported as **INFERRED from a
complete, traced code read**, not observed. The two states genuinely can overlap in production: an
operator (or an automated retry) can re-run discovery while a *previous* batch's item-action workers
are still draining the queue, since both are permitted simultaneously by `ACTIONABLE_STATUSES`
(`DISCOVERY`/`EXECUTING`/`REVIEW`) and discovery's own allowed statuses (`RECEIVED`/`TRIAGE`/
`DISCOVERY`) overlapping at `DISCOVERY`.

- `backend/src/modules/dsar/itemIndex.service.js:261-327` (`indexSubject`, unconditional
  `deletedAt: null` write, no optimistic lock against `markItemDeleted`)
- `backend/src/modules/dsar/itemAction.service.js:377-424` (`executeAction`'s DELETE branch)

**Fix:** either serialize `indexSubject(subjectId)` against in-flight `DsarItemAction` execution for
the same subject (advisory lock or a version/generation counter compared before the write), or have
`writeItem` skip writing `deletedAt: null` over a row whose current `deletedAt` is newer than the
rebuild's own `at` timestamp.

---

## FINDING 10 (P2) — Item-index completeness self-check (`sourceLiveCount`) has no TEXT term; it
is structurally blind to exactly the class of data Finding 2 shows purge can't erase either.

`sourceLiveCount()` (`itemSearch.service.js:237-247`) sums `photoSubject` + `subjectFaceEnrollment`
+ `subjectVoiceEnrollment` + `recording` counts. It has no `textSpan`/`textDocument` term, and
`itemQuerySchema` (`dsar.routes.js:52-61`) doesn't even list `TEXT` as a valid `type` filter value.
This means the one mechanism designed to catch "the index and the source tables disagree"
(`verifyIndex`, the same function Finding 1 shows is already failing for audio) **could never have
caught a text-document gap even if it were working perfectly** — text was never part of what
"expected" counts in the first place. The function's own doc comment states the rule it is supposed
to follow ("This MUST enumerate exactly what `indexSubject()` writes a live row for... a source
missing here is not a harmless omission") and text documents violate that rule the same way
recordings once did, per the comment's own admission ("Recordings were missing here until voice
enrollments were added and made the same mistake visible").

- `backend/src/modules/dsar/itemSearch.service.js:225-247`
- `backend/src/modules/dsar/dsar.routes.js:52-61` (`itemQuerySchema.type` enum has no `TEXT`)

**Fix:** decide whether text documents are meant to be in the item grid at all (Finding 2's fix
implies they should be, symmetrically with audio); if so, add the term here and add `TEXT` to the
type enum; if text is deliberately out of scope for item-level actions, the discovery-side comment
and this file should say so consistently instead of one admitting the gap and the other pretending
it doesn't exist.

---

## FINDING 11 (P2) — Qdrant face/voice galleries have zero DSAR awareness; the backstop that tears
down a crashed job's gallery is "not scheduled by the app itself yet." Live Qdrant is empty right
now, so no active leak — but nothing would notice one.

`grep -in qdrant src/modules/dsar/*.js` → zero matches. Per-session/per-recording Qdrant
collections (`lib/faceGallery.js`, `lib/voiceGallery.js`) are working storage for clustering during
an active recognition/voice-analysis run, torn down at finalize — but the backstop that cleans up a
collection left behind by a **crashed** run, `cleanupOrphanGalleries`/`cleanupOrphanVoiceGalleries`
(`lib/cleanup.js:43-104`), is explicitly, by its own comment, "not scheduled by the app itself yet —
run manually or via an external scheduler." The lead's report (`00-LEAD-live-api-and-pipeline.md`,
FINDING R-1) already proved a `RecognitionJob` can get stuck `RUNNING` for days with nothing
reaping it — exactly the crash/stall condition this backstop exists for.

**OBSERVED live**: `curl http://localhost:4000:6333/collections` (Qdrant) currently returns `[]` —
no leaked collection exists right now, so I could not catch one in the act. This is reported as a
structural gap (zero DSAR-side awareness, plus a documented-as-unscheduled cleanup) rather than a
confirmed active leak.

- `backend/src/lib/cleanup.js:40-104`
- `backend/src/modules/dsar/discovery.service.js` — no Qdrant reference (grep)
- Live: `GET http://localhost:6333/collections` → `{"result":{"collections":[]}}`

**Fix:** schedule `cleanupOrphanGalleries`/`cleanupOrphanVoiceGalleries` (the retention worker's own
loop is the obvious home, alongside its other sweeps), and add a Qdrant collection-existence check
to `runDiscovery()` so a leaked gallery is at least visible in a discovery result rather than
depending on the sweep having run recently.

---

## FINDING 12 (P2) — `assign()` has no transition guard past the RECEIVED special case; an admin
can silently reassign a CLOSED or REJECTED request.

`dsar.service.js:316-349`: `if (request.status === 'RECEIVED') assertTransition('RECEIVED',
'TRIAGE')` is the only guard. For any other status — including the two terminal ones, `CLOSED` and
`REJECTED` — `assign()` proceeds straight to `prisma.dsarRequest.update({ data: { assignedAdminId,
... , status: request.status } })`, changing `assignedAdminId` (and potentially `dpoAdminId`) on a
request the lifecycle model considers finished, with a full audit log entry (`DSAR_ASSIGNED`) as if
it were a normal in-flight handoff. Every other terminal-state boundary in this file
(`approveResolution`, `closeRequest`, `rejectRequest`, `execute`) is explicitly guarded; this one
is not.

- `backend/src/modules/dsar/dsar.service.js:316-349`

**Fix:** `assign()` should reject (409) when `request.status` is `CLOSED` or `REJECTED`, matching
every sibling mutator in the file.

---

## FINDING 13 (P3) — `dsar.service.js`'s `pseudonymise()` is unsalted and never rotates, unlike
`certificate.service.js`'s equivalent, which explicitly is.

`dsar.service.js:44-46`:
```js
export function pseudonymise(subjectId) {
  return `SUB-${createHash('sha256').update(subjectId).digest('hex').slice(0, 8)}`
}
```
used across `getRequest`, `listQueue`, `listSubjectMedia`, `listItemsForRequest`, and both timeline
functions — i.e. every dpo-facing pseudonym in the module. Compare `certificate.service.js:18-23`:
```js
function pseudonymFor(subjectId, keyId) {
  return `SUB-${createHash('sha256').update(`${keyId}:${subjectId}`).digest('hex').slice(0, 12)}`
}
```
explicitly salted with the signing key id specifically *so that* "the same subject does not present
the same pseudonym across a key rotation boundary, which would let an auditor link certificates
over time" (the function's own comment). The DSAR-module version has no such mechanism: it is a
permanent, 32-bit-truncated, unsalted identifier for a given subject, visible to every `dpo` for
every request that subject ever raises, for the life of the system. This is a reasonable, probably
intentional tradeoff for day-to-day DPO workflow (a DPO plausibly *needs* to recognize "this is the
same person's third request" without being told who they are) — flagged at P3 because the
inconsistency with the certificate module's explicitly-reasoned design suggests it wasn't a
deliberate choice so much as an oversight, and because 32 bits of hash space is a real (if small at
current subject counts) collision surface for a moderately large subject register.

- `backend/src/modules/dsar/dsar.service.js:41-46`
- `backend/src/modules/dsar/certificate.service.js:18-23`

**Fix:** either document the tradeoff explicitly (permanent pseudonym is intentional for DPO
workflow continuity) or widen the truncation and consider a comment cross-referencing the
certificate module's reasoning so a future reader doesn't have to rediscover the inconsistency.

---

## FINDING 14 (P3) — Raw Prisma error text, including internal model/field names, is returned
verbatim in API error responses.

**OBSERVED live** (same response as Finding 1):
```json
{"error":"\nInvalid `prisma.recording.findMany()` invocation:\n\n\nError converting field
\"sha256\" of expected non-nullable type \"String\", found incompatible value of \"null\".",
"correlationId":"c14b4152-2a88-4f43-b7a0-880d50fbdd5d"}
```
This is orthogonal to the DSAR-specific findings above but worth recording because it was caught
live in this module's own error path: the client-facing `error` field is the exception's raw
`.message`, including the Prisma model name, method, and column name. Outside this audit's primary
domain (general error-handling middleware is presumably covered elsewhere), but flagged here because
it directly affects how this module's failures look to a caller — an admin portal, or worse a
scripted integration, sees internal schema details on every 500.

- Observed via the Finding 1 curl transcript above; the generic error handler middleware is out of
  this module's file list, not further traced here.

---

## Explicitly verified as sound (no finding — stated so this isn't miscounted as unchecked)

- **Shared-frame downgrade (DELETE→REDACT) is enforced server-side, twice.**
  `itemAction.service.js:planActions()` (line 124-172) downgrades at *plan* time from
  `item.sharedSubjectCount`, and `executeAction()`'s DELETE branch (line 377-388) **re-checks**
  `live.sharedSubjectCount > 1` at *execution* time against a fresh read, independent of what was
  planned minutes earlier. The admin portal (`ItemGrid.jsx:159-169`,
  `DsarRequestDetail.jsx:243-249,934-942`) shows the exact count and the consequence before the
  operator confirms. I could not execute this live end-to-end (see below) but traced both
  enforcement points in full and they agree with what the UI promises.
- **Certificate issuance correctly refuses partial/incomplete erasures.**
  `certificate.service.js:55-76` refuses a `PARTIAL`-scope job outright, refuses any job not
  `COMPLETED`, refuses any job with an unfinished location, and refuses if the subject key was not
  destroyed — all before signing. This is the one place a false "fully erased" attestation could
  slip through, and it doesn't.
- **Lifecycle transitions are enforced server-side** via `assertTransition()`
  (`dsar.service.js:25-39`), consistently applied at every mutator except `assign()` (Finding 12).
  Four illegal transitions confirmed live, all 409:
  ```
  POST /dsar/7d1f25de.../execute  (RECEIVED) -> 409 "requires DISCOVERY or EXECUTING"
  POST /dsar/7d1f25de.../approve  (RECEIVED, as dpo) -> 409 "Cannot move ... RECEIVED to CLOSED"
  POST /dsar/7d1f25de.../close    (RECEIVED) -> 409 "Cannot move ... RECEIVED to CLOSED"
  POST /dsar/7d1f25de.../items/actions (RECEIVED) -> 409 "Item actions require ... DISCOVERY, EXECUTING, REVIEW"
  ```
- **Subject-facing timeline allowlist holds.** `SUBJECT_MILESTONES`
  (`timeline.service.js:302-309`) is a positive allowlist, not a redaction pass, and the function
  explicitly strips actor identity, `AccessEvent` rows, hashes, and per-item ids before returning —
  traced end to end, no leak found.
- **`totals.all` vs `totals.matching` contract holds when the index itself is healthy.** Confirmed
  on the unaffected subject (`7d1f25de...`/`5c1211e5...`): `totals: {all:0, matching:0, deleted:0}`,
  `index: {expected:0, indexed:0, consistent:true}` — self-consistent. The contract's *implementation*
  is correct; Finding 1 shows what happens when the number it's built from is wrong upstream.

---

## What I could not check

- **Full-subject ERASE execution end-to-end**, including certificate issuance and the
  `SUBJECT_KEY` crypto-shred, was not run live. Doing so against the only subjects in the live
  dataset would have meant either (a) irreversibly destroying real fixture data multiple other
  concurrent audit agents' findings reference by exact row counts (e.g. "66 indexed items"), or
  (b) creating a brand-new `ERASE` request for one of the two subjects and running it into a state
  that would, per Finding 2, get permanently stuck `PARTIAL` — which I judged an acceptable
  demonstration but not one I could cleanly undo afterward for whoever audits this environment next.
  Findings 2 and 6's certificate/rebuild-deadlock behavior are therefore traced fully in code and
  corroborated by live schema/data facts (live TextSpan rows on the test subject; live retention
  worker code path), but not watched failing end-to-end inside a real `PurgeJob` row.
- **Live REDACT/DELETE item-action execution** (as opposed to the request/validation path, which
  was tested live) — every live DSAR request is currently `RECEIVED`, and `requestActions()`
  requires `DISCOVERY`/`EXECUTING`/`REVIEW` (`itemAction.service.js:199-204`). The one subject whose
  request I could safely test guardrails against (`5c1211e5-...`) has zero indexed items, so even if
  I forced it into `DISCOVERY` there would be nothing to act on; the other subject's discovery 500s
  (Finding 1), so I could not reach `DISCOVERY` for them without first fixing that bug. The
  downgrade logic itself is verified in full by code trace (see "verified as sound" above).
- **Finding 9's race** (index rebuild vs. concurrent item-action delete) is inferred from a complete
  code trace, not reproduced under real concurrency — see the rationale inline in that finding.
- **Whether `PurgeJob`/`itemAction` BullMQ workers are currently running as live processes** — the
  brief's topology table lists the HTTP services and AI workers explicitly but not these two Node
  BullMQ consumers or the retention worker's loop process. I read their code and traced the inline
  (`inline:true`) execution paths, which don't depend on a worker process being up, but did not
  independently confirm a `purge.worker.js`/`itemAction.worker.js`/`retention.worker.js` process is
  currently alive on this machine.
- **The `DsarEvidence` retention question I initially suspected** (that purge might leave subject
  PII embedded in `EXPORT_PACKAGE` evidence payloads) turned out to be unfounded on inspection —
  the payload is metadata only (token hash, wrapped export key, counts). I did **not**, however,
  get to fully evaluate whether `DISCOVERY_RESULT` evidence rows (which do embed the full raw
  discovery walk, unpseudonymized) should be considered part of this domain's purge surface or
  someone else's; I've recorded the observation but stopped short of writing it up as a full,
  numbered finding given the ambiguity over whether audit-trail evidence is meant to be
  purge-exempt by design (consistent with how `ProjectConsent`/`Subject` rows are deliberately kept,
  anonymized-in-place, elsewhere in this same file) versus a genuine gap. Worth a follow-up
  specifically on `dsar_evidence.payload` retention policy.
- **Root cause of the 6 NULL-`sha256` recording rows** (Finding 1) — I traced the blast radius
  exhaustively but did not trace *why* the recording finalize/checksum path can leave a row in this
  state, since that code lives outside this audit's module list (`backend/src/modules/recordings/`).
  Flagging for whoever owns that module.
