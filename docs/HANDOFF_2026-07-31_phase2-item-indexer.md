# PRISM — handoff

**Written for a session with zero memory of the one that produced it.**
Read this and `PLAN.md`, and nothing else, before starting.

---

## 1. Phase completed

**PLAN.md Phase 2 — item indexer (backfill + incremental).** 2026-07-31.

Phase 1 (schema for `SubjectDataItem` / `DsarItemAction` / `ImportBatch`) landed
earlier the same day; its handoff is superseded by this file. The pre-Phase-1
platform (waves 0–6) is described in `docs/HANDOFF_2026-07-28_waves0-6.md` —
**do not delete that file**, it holds the only narrative record of the
`prism_app` migration, the media-encryption rollout, and a §3 manual-verification
checklist that is still outstanding.

---

## 2. What was implemented

The item index now reflects reality. `subject_data_items` went from 0 rows to a
maintained projection of `photo_subjects` + `photos` + `subject_face_enrollments`.
**No route, no RBAC change, no migration this phase** — so
`docs/02_ROLE_PERMISSION_MATRIX.md` and `backend/tests/security/rbac-matrix.test.js`
are untouched and still correct.

### `backend/src/modules/dsar/itemIndex.service.js` **(new, ~250 ln)**

| Export | Behaviour |
|---|---|
| `SOURCE` | `{ PHOTO_SUBJECT: 'photo_subjects', ENROLLMENT: 'subject_face_enrollments' }` — the `sourceTable` vocabulary. |
| `isRedactedAvailable(photo)` | `redactedPath != null && piiStatus ∉ {DEFERRED, FAILED}`. Same rule `listSubjectMedia()` uses. |
| `indexSubject(subjectId, {at})` | Full rebuild for one subject. Upserts every photo link + enrollment, then tombstones anything it did not touch. Returns `{subjectId, indexed, live, tombstoned}`. |
| `indexPhotoSubject(link, {at})` | Incremental: one link. Also refreshes `sharedSubjectCount` on every **other** principal's item for the same frame. Accepts a row or an id; returns `null` if the link vanished. |
| `indexPhotoSubjects(links, {at})` | Bulk incremental wrapper, used by finalize. |
| `markItemDeleted(itemId, {at})` | Tombstone. Idempotent — a retried worker does not rewrite `deletedAt`. Returns `null` for an unknown id. |
| `rebuildAll({batchSize, after, onSubject})` | Keyset walk over subjects, resumable by subject id. |

Item shape: photo items carry `projectId` (via `photo.session.projectId`),
`sessionId`, `storagePath`, `contentHash = photo.sha256`,
`capturedAt = takenAt ?? createdAt`, `sharedSubjectCount = photo.subjects.length`.
Enrollment items are `type=PHOTO, origin=ENROLLMENT`, no project, no session,
`sharedSubjectCount = 1`, `redactedAvailable = false`; a soft-deleted enrollment
enters the index already tombstoned.

### `backend/src/modules/dsar/discovery.service.js`

`await indexSubject(subjectId)` at the end of the walk, inside a `try/catch` that
logs and swallows. Return shape unchanged. See §4.2 for why it is non-fatal.

### `backend/src/modules/sessions/session.service.js` → `finalizeSession()`

After `redactBystanders()` and `destroyGallery()`, re-reads the links the
transaction created and calls `indexPhotoSubjects()`. Also try/catch-swallowed
(`logger.error`). Ordering is deliberate: `redactBystanders()` is what writes
`Photo.redactedPath`, so indexing earlier would record "no redacted copy".

### `backend/scripts/backfill-item-index.js` **(new)**

`node scripts/backfill-item-index.js [--batch-size=100] [--after=<subjectId>] [--subject=<id>] [--quiet]`.
Prints one line per subject; the last id printed is the exact `--after=` resume
point, so a killed run re-does at most one subject.

### `backend/tests/unit/itemIndex.test.js` **(new, 7 tests)**

First file under `tests/unit/`. Covers idempotency (index twice → same row ids,
`tombstoned=0`), live-count-equals-link-count, `sharedSubjectCount` on solo vs
shared frames, enrollment origin, sibling shared-count refresh on incremental
tag, tombstone-not-delete, and `markItemDeleted` idempotency.

It seeds tables **directly** rather than through `tests/e2e/world.js`. Deliberate:
the indexer's contract is with the rows, and going through the capture services
would drag the face worker, Qdrant and Redis into a test of a function that reads
three tables. It needs only a reachable database.

---

## 3. What was explicitly NOT done

- **No `AccessEvent` is written when the index is refreshed.** Indexing is a
  system-internal projection refresh, not an admin browsing a person's data. The
  logging obligation lands in Phase 4, where an admin actually reads the items
  (`action=SEARCH`).
- **No API surface.** `SubjectDataItem` is populated but nothing serves it. That
  is Phase 4.
- **`DsarItemAction` and `ImportBatch` are still empty** — Phases 5 and 3.
- **Supabase MCP still unauthorized** (`Unauthorized. Please provide a valid
  access token…`). Phase 2 needed no migration so nothing was blocked, but
  `mcp__supabase__get_advisors` from Phase 1 is **still outstanding** and Phase 9's
  scale/advisor pass needs the token fixed.
- Nothing was committed. The tree still carries the earlier session's frontend
  work (§5).

---

## 4. Key decisions + rationale

1. **`origin` and `meta` are written on create and never on update.** An
   IMPORT-origin photo (Phase 3) will also have a real `PhotoSubject` row, so
   `indexSubject()` sees it too. Updating `origin` would relabel it
   `COLLECTION_SESSION` and wipe `meta.lawfulBasis = 'IMPORT_UNVERIFIED'` on the
   next rebuild — the index would quietly launder an unverified lawful basis into
   a consented one. **Phase 3 must not rely on `indexSubject()` to set `origin`;
   it has to create the item row itself (or upsert it first).**
2. **Index refresh is non-fatal in both call sites, against the codebase's
   otherwise fail-closed posture.** `runDiscovery()` is what `createPurgeJob()`
   builds an erasure from; failing the walk because a *rebuildable projection*
   could not be written would block a deletion the principal is entitled to. In
   `finalizeSession()` the transaction is already committed and the gallery
   already destroyed, so throwing would report failure for work that cannot be
   undone. Both log; the next discovery run repairs the index.
   *This is safe only because nothing yet reads the index. The moment Phase 4
   serves DSAR completeness from it, "index refresh failed" needs to become
   visible — a monitored log line at minimum, not a silent catch.*
3. **Stale rows are tombstoned via `indexedAt < at`, with `at` a single JS
   timestamp for the whole pass.** Letting `indexedAt` default to the DB clock and
   comparing against an app clock would make the sweep depend on clock skew and
   could tombstone rows written seconds earlier. Every row written in a pass gets
   exactly `at`; anything older was not seen this pass and its source row is gone.
4. **A row is never hard-deleted from the index.** `markItemDeleted` and the sweep
   both set `deletedAt`. The DSAR timeline has to be able to prove an item existed
   and was destroyed; a missing row proves nothing.
5. **`sharedSubjectCount` includes the subject themself** (so solo = 1), matching
   `subjectsOnPhoto` in `listSubjectMedia()`. Phase 5's guard is therefore `> 1`.
6. **`indexPhotoSubject()` updates the co-subjects' rows too.** Tagging a second
   person onto a frame changes what the *first* person is allowed to have deleted.
   Without that write the guard would read a stale `1` and authorise a delete of
   someone else's photo.

---

## 5. Current system state

**Tests: 60/60 pass** (`cd backend && npm test`) — the pre-phase 53 plus 7 new.
Runtime ~200 s.

**Migrations — 14 local, 14 applied.** Unchanged this phase.

**Backfill run against the dev DB — verified:**

```
subjects=3  items=50  live=25  tombstoned=0
subject de351590…  links=22 → itemsPhoto=22
                   enrollments=28 (3 live) → live enrollment items=3, total items=50
re-run: identical. 0 rows added, 0 removed, 0 tombstoned.
```

Matches PLAN's acceptance criterion (index counts equal `listSubjectMedia()`'s
source counts; re-running changes nothing). Note a re-run *does* bump `indexedAt`
on every row — that is the sweep boundary doing its job, not drift.

**Services that must be running for `npm test`** (the three e2e files fail their
`preconditions` subtest otherwise and cascade into ~33 confusing
`Cannot read properties of undefined` failures):

- Docker Desktop, then `cd backend && docker compose up -d` → `prism-qdrant`
  (6333), `prism-redis` (6379), `prism-face-worker` (8001).
- `prism-image-pii-worker` (8002) — **not in `backend/docker-compose.yml`**,
  separately managed container.
- Face worker takes **~4 min** to become healthy from cold (pulls models into the
  `backend_face_models` volume). Wait on `curl -sf http://localhost:8001/health`.
- `tests/unit/itemIndex.test.js` needs **only the database** — run it alone with
  `node --test tests/unit/itemIndex.test.js` when the workers are down.

**Known-broken / outstanding:**
- Supabase MCP unauthorized; Phase 1's advisor pass never ran.
- The §3 five-check manual portal pass from `docs/HANDOFF_2026-07-28_waves0-6.md`
  is still not done.
- Uncommitted work from an earlier session is still in the tree:
  `admin-portal/src/{App.jsx,lib/api.js,roles.js,pages/collectionAgent/SessionDetail.jsx,pages/dataOwner/ProcessedData.jsx}`,
  new untracked `admin-portal/src/pages/SessionPhotos.jsx` and
  `pages/dataAdmin/CollectionSessions.jsx`, `backend/src/app.js`, `enrollment.*`,
  `user-portal/src/components/SelfieCapture.jsx`.
  `gitnexus_detect_changes` reports **HIGH**, 26 symbols / 7 processes — **all 7
  affected processes are `SessionDetail`/`ProcessedData` cache flows from that
  earlier frontend work, none from Phase 2.** The `session.service.js` symbols it
  lists as touched (`assertStatus`, `createSession`, `endSession`, …) are
  line-offset artifacts of one added import plus one added block in
  `finalizeSession`. Do not read that HIGH as a Phase 2 regression, and do not
  commit the tree blind.

---

## 6. Next phase

**PLAN.md Phase 3 — import pipeline.** New `backend/src/modules/import/`
(`import.service.js`, `import.routes.js`, `import.validators.js`), mounted at
`/api/v1/imports` in `backend/src/app.js` after `meRoutes`, plus
`backend/tests/integration/import.test.js` and the four new endpoints added to
**both** `docs/02_ROLE_PERMISSION_MATRIX.md` and
`backend/tests/security/rbac-matrix.test.js` (that test is the CI gate — an
endpoint missing from the matrix fails the build).

Three things discovered that change Phase 3:

- **`PhotoSubject.consentId` is `String` — NOT NULL — with an FK onto
  `ProjectConsent`.** As the schema stands **you cannot create a `PhotoSubject` at
  all without a consent row**, so PLAN's `meta.lawfulBasis='IMPORT_UNVERIFIED'`
  path has nothing to hang on. Resolve it explicitly; it is a privacy decision,
  not a schema convenience: either (a) make `consentId` nullable and make every
  consumer handle null (audit `purge.service`, `export.service`,
  `discovery.service` first — a nullable `consentId` weakens the invariant that
  nothing is held without a recorded lawful basis), or (b) require a `projectId`
  with a live consent for every import and reject the rest.
- **Import must write its own `SubjectDataItem` row with `origin='IMPORT'`**, per
  §4.1. It cannot delegate that to `indexSubject()`, which labels everything it
  finds via `photo_subjects` as `COLLECTION_SESSION`. Once the row exists,
  rebuilds preserve its `origin` and `meta`.
- **`Photo.sessionId` is NOT NULL**, so an import still needs a `Session` row (or
  a schema change). Decide which before writing `ingestItem()`.

---

## 7. Traps

- **A Read-tool hook truncates `docs/*.md` and `PLAN.md` to line 1** and claims
  the file is already summarised. It is not. Re-reading with `offset`/`limit`
  returns "Wasted call — file unchanged". Use `sed -n '1,220p' FILE` via Bash.
  PLAN.md is 439 lines and reads as 1.
- **`DIRECT_URL` points at `prism_app`, which has no `CREATE` on schema `public`
  — by design.** `npx prisma migrate deploy` fails with `42501 permission denied
  for schema public` *and* records the migration as failed, blocking every later
  one until `prisma migrate resolve --rolled-back <name>`. Run migrations with the
  owner role from `ADMIN_DATABASE_URL`:
  ```powershell
  $admin = (Get-Content .env | Select-String '^ADMIN_DATABASE_URL=').Line -replace '^ADMIN_DATABASE_URL=','' -replace '"',''
  $env:DIRECT_URL = $admin; $env:DATABASE_URL = $admin
  npx prisma migrate deploy
  ```
  Prisma's dotenv does not override already-set process env vars. **Unset them
  afterwards.**
- **A new table with RLS on and no policy denies everything; a new table with no
  grant is a 42501 on first insert.** Both are invisible until runtime and both
  present as a broken feature, never as a permissions error. RLS + policy +
  `prism_app` grants in the same migration, then a round-trip smoke query *as
  `prism_app`*.
- **`prisma.subjectDataItem`'s compound-unique key name is
  `subjectId_type_sourceTable_sourceId`** — needed for every upsert against the
  index.
- The API listens on **4000**, not 3000.
- `logAccess` is fail-closed — it aborts the request if the `AccessEvent` write
  fails or the object id cannot be resolved. Phase 4 adds a `SEARCH` action over a
  new object type; if that type does not resolve, item search 500s rather than
  degrades.
- PgBouncer `connection_limit=20` (raised from 5, which caused selective photo
  load failures under grid load). Five services share the pool — the indexer
  writes in chunks of 20 upserts for that reason.
- Never lose `MEDIA_KEK`. Anything touching sealed blobs goes through
  `lib/blobCrypto.js` / `lib/keyring.js`.
