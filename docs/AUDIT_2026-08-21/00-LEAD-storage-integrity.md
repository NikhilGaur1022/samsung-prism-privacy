# Lead note — storage/DB integrity, measured against the live system (2026-08-21)

Method: enumerated every `*Path` field in `schema.prisma` (15 of them across 11 models), read every
one out of the live database, walked `./storage/media` (the real `STORAGE_ROOT`), and compared the
two sets in both directions. All 11 sources queried successfully — no silent skips.

> **A false start worth recording, because it is a trap for the next person.** My first pass used
> `subjectFaceEnrollment.storagePath` and got 141 "orphaned" enrollment files. The field is actually
> `imagePath`; the query threw and my `catch` swallowed it. An earlier pass also compared DB paths
> (`sessions/X/...`) against disk paths (`media/sessions/X/...`) and reported 110/110 photos missing.
> Both numbers were wrong. The probe below fails loudly on a bad source instead. **Any orphan-sweep
> tooling built from this plan must do the same** — a storage reaper that silently mis-resolves a
> field name would delete live data.

Path fields, for whoever builds the reaper:

| Model | Field(s) |
|---|---|
| `SubjectFaceEnrollment` | `imagePath` |
| `SubjectVoiceEnrollment` | `audioPath` |
| `Photo` | `storagePath`, `redactedPath` |
| `FaceDetection` | `cropPath` |
| `DsarEvidence` | `storagePath` |
| `PurgeJobLocation` | `storagePath` |
| `SubjectDataItem` | `storagePath` |
| `Recording` | `storagePath`, `redactedPath` |
| `VideoAsset` | `storagePath`, `redactedPath` |
| `VideoFaceTrack` | `cropPath` |
| `TextDocument` | `storagePath`, `redactedPath` |

---

## FINDING ST-1 (P0, privacy/compliance) — 83% of the media store is unreferenced, including 518 biometric files

```
files under ./storage/media                     1353
distinct paths referenced by any DB row          396
ORPHAN BLOBS (on disk, no row points at them)   1123   (265.12 MB)
```

By kind:

| Kind | Orphaned files | What it is |
|---|---|---|
| `crops` | **383** | cropped **face** images — biometric data |
| `redacted` | 286 | published redacted derivatives |
| `photos` | 263 | original captures |
| `enrollments` | **135** | enrolment **selfies** — biometric data |
| `sessions` | 29 | other session artefacts |
| `dsar` | 27 | built `package.zip` export packages |

**1,123 of 1,353 files — 83% of the media store — are referenced by nothing.**

Why this is a P0 rather than a housekeeping item: **`discovery.service.js` and `purge.service.js`
both enumerate blobs by walking database rows**, not by walking the filesystem
(`discovery.service.js:153` and `purge.service.js:148` both `select: { cropPath }` from
`FaceDetection`). A file with no row is therefore **invisible to discovery and unreachable by purge**.

So today: an erasure request completes, a `DeletionCertificate` is signed, and **383 orphaned face
crops and 135 orphaned enrolment selfies remain on disk** — biometric data the certificate attests
was destroyed. That is the single most serious class of defect a privacy platform can have, because
the artefact that says "we erased it" is the thing that is wrong.

**The main manufacturing route is known.** `recognition.service.js:107-108`:

```js
await prisma.faceDetection.deleteMany({ where: { photo: { sessionId } } })
await prisma.faceCluster.deleteMany({ where: { sessionId } })
```

Every re-run of a session drops the rows and **nothing deletes the crop files those rows pointed at**
(`recognition.service.js:127-129` writes `sessions/<id>/crops/<detectionId>.jpg`). 108 live
`FaceDetection` rows against 491 crop files on disk is exactly the residue of repeated re-runs.

**Fix, in order:**
1. Make blob deletion transactional with row deletion — a `deleteBlobsFor(detectionIds)` called in
   the same unit of work, or a tombstone table the reaper drains.
2. Build a **storage reaper** that walks the filesystem, resolves against every path field above, and
   quarantines (not deletes) unreferenced blobs past a grace period. Fail loudly on any source query
   error; never delete on a partial read of the reference set.
3. Extend **discovery** to include a filesystem sweep of the subject's path prefixes, so a
   completeness claim is filesystem-backed rather than row-backed.
4. Run a **one-off remediation** over the existing 265 MB before go-live, and record it.

**Test:** seed a session, run recognition twice, assert crop-file count equals `FaceDetection` count;
run an erasure and assert zero files remain anywhere under the subject's prefixes.

## FINDING ST-2 (P0, data integrity) — 167 database rows point at files that no longer exist

```
DANGLING REFS (row exists, file is gone): 167
  SubjectDataItem  88
  Recording        46
  TextDocument     13
  Photo            20
```

Spot-checked three of the dangling `Photo` paths — the containing directory
`sessions/e448e93a-b673-4162-8cf9-8bd53c6142b6/photos` **exists and contains 0 files**, while `Photo`
rows still point into it.

This is the mirror of ST-1 and it is just as bad in the opposite direction. `SubjectDataItem` is the
**DSAR item index** — the table the discovery workspace and the export builder read. 88 of its 91
rows (the live table holds 91) point at files that are gone. Consequences:

- A DSAR **access** package built for one of these subjects will fail at read time, or silently ship
  a short package — either way the legal deliverable is wrong.
- The item grid counts them in `totals.all`, so the completeness claim the handoff is careful about
  (`totals.all` is "the completeness claim") is **counting items that cannot be produced**.
- An erasure will mark locations purged that were already absent, which is harmless, but the
  certificate then attests to erasing something whose absence was never explained.

**Fix:** an integrity checker that runs as a scheduled job and on export-build; export must **fail
loudly** on a missing blob rather than skipping it; and `SubjectDataItem` needs a
`blobMissing`/`verifiedAt` column so the grid can show the truth instead of an uncheckable count.

**Test:** delete a blob out from under a `SubjectDataItem`, assert the package build 409s with a
named item rather than producing a short archive.

## FINDING ST-3 (P1, security architecture) — RLS covers the audit surface but not the media tables

```
public tables:              42
tables with RLS enabled:     9
```

RLS is enabled on exactly:
`access_events`, `audit_log`, `data_subjects`, `deletion_certificates`, `dsar_item_actions`,
`import_batches`, `session_handoffs`, `subject_data_items`, `subject_face_enrollments`.

RLS is **not** enabled on the core collection tables: `photos`, `sessions`, `projects`,
`photo_subjects`, `face_detections`, `face_clusters`, `recordings`, `audio_segments`,
`project_consent_matrix`, `session_participants`, `text_documents`, `video_*`,
`subject_voice_enrollments`, and the rest.

That is not necessarily wrong — the app connects as `prism_app` (NOSUPERUSER, NOBYPASSRLS) and the
append-only guarantee on `audit_log` / `access_events` / `deletion_certificates` is the load-bearing
use of it. But it means **isolation between projects, sessions and subjects on all media tables rests
entirely on application-level `where` clauses**. Every one of those clauses is a place an IDOR can
live, and there is no database-level backstop.

Note the asymmetry that a reviewer will pick up: `subject_face_enrollments` has RLS,
`subject_voice_enrollments` does not — the same class of biometric data, protected differently.
That is almost certainly an oversight from the Phase-2 voice work rather than a decision, and it is
the kind of inconsistency that undermines confidence in the whole model.

**Decide and document one of two positions**, because "partial RLS" satisfies no reviewer:
(a) RLS is only for the append-only ledgers — then say so in `docs/01_PRIVACY_DATAFLOW.md` and add
    `subject_voice_enrollments` to the ledger set or explicitly exclude it with a reason; or
(b) RLS is the isolation backstop — then extend it to every subject-scoped table, which is a
    migration plus a session-variable convention plus a test per table.

I recommend (a) plus a comprehensive automated IDOR test matrix, because (b) is a large change to
retrofit and the `prism_app` role design already implies (a) was the intent.

---

## What is actually SOUND here — recorded so the baseline is not misrepresented

Relational integrity inside the database is **clean**. Measured live:

```
face_detections with no photo        0
photo_subjects with no photo         0
photos with null session             0
photo_subjects with null consent     0
audio_segments with no recording     0
```

Zero relational orphans across every join I tested. The foreign keys and the write paths that
maintain them are doing their job. **The integrity problem in this system is entirely at the
filesystem boundary, not in the schema** — which is good news for the fix, because it localises the
work to blob lifecycle management rather than a schema rework.

Combined with the encryption-at-rest result from `00-LEAD-metadata-and-scale.md` (all 1,293 stored
JPEGs sealed, zero plaintext), the picture is: **the database layer and the crypto layer are in good
shape; the blob lifecycle layer does not exist.**
