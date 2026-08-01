# PRISM — handoff

**Written for a session with zero memory of the one that produced it.**
Read this and `PLAN.md`, and nothing else, before starting.

---

## 1. Phase completed

**PLAN.md Phase 4 — search & discovery API (per-item, paged, complete).**
2026-07-31.

Earlier handoffs, all superseded but **not to be deleted**:

- `docs/HANDOFF_2026-07-31_phase2-item-indexer.md` — Phase 2, the item indexer.
  Its §4 (why `origin`/`meta` are create-only, why the tombstone sweep uses one
  app-side timestamp) is still the authority on indexer semantics.
- `docs/HANDOFF_2026-07-28_waves0-6.md` — the pre-DSAR platform, the `prism_app`
  migration, media encryption, and a §3 manual-verification checklist that is
  **still outstanding**.

**Phase 3 (import pipeline) is still skipped**, deliberately — see §3.

---

## 2. What was implemented

The item index is now readable. `subject_data_items` went from "maintained but
unread" to the surface that carries the completeness claim of a DSAR response.

### `backend/src/modules/dsar/itemSearch.service.js` **(new, ~300 ln)**

| Export | Behaviour |
|---|---|
| `searchSubjects({q, limit, cursor}, {admin, req})` | Exact + prefix identity search over `fullName`, `email` (citext), `employeeRef`, and `masterUserId` **exact only**. Keyset over `(fullName ASC, masterUserId ASC)`. Returns each subject plus a live `itemCount` from one `groupBy` (not N+1). Writes one `AccessEvent{action:SEARCH, objectType:SUBJECT_PII}` per **returned** subject, sequentially and fail-closed. |
| `listSubjectItems({subjectId, type, origin, projectId, from, to, includeDeleted, cursor, limit})` | One page + `totals` + `index` health. Keyset over `(capturedAt DESC NULLS LAST, id DESC)`. |
| `listItemsForRequest(requestId, admin, query, {req})` | Route entry point: resolves the request → 404, role-gates → 403, writes one `AccessEvent{action:SEARCH, objectType:SUBJECT_DATA_ITEM, dsarRequestId}`, then delegates. Response is pseudonymous (`subjectRef: SUB-xxxxxxxx`) and carries no `storagePath`. |

`totals` shape, and why it has four members rather than one:

- `all` — `count()` of live items for the subject **ignoring every filter**. This
  is the completeness claim ("we hold N things about this person"). A filtered
  page that reported its own filtered total would let a narrowed view read as a
  complete one.
- `matching` — count under the current filters (what the grid is paging through).
- `deleted` — tombstone count, so "3 items were destroyed" is visible without
  `includeDeleted`.
- `byType` / `byOrigin` — `groupBy` counts over live items; `byOrigin.IMPORT` is
  what surfaces unverified-lawful-basis data at a glance.

Item shape: `itemId, type, origin, sourceTable, sourceId, projectId, sessionId,
capturedAt, contentHash, sharedSubjectCount, shared, redactedAvailable,
deletedAt, lawfulBasis (from meta), indexedAt`. `shared` is precomputed so the
Phase 5/8 UI can say "this frame has other people on it, delete will become
redact" *before* the operator clicks.

### The index-staleness guard (`verifyIndex()`)

Every call to `listSubjectItems()` counts the source tables
(`photo_subjects` + non-soft-deleted `subject_face_enrollments`) and compares
with live index rows. On divergence it logs `alert: ITEM_INDEX_DIVERGED`, calls
`indexSubject()` **once**, recounts, and returns
`index: { expected, indexed, consistent, repaired }`. Still divergent after the
repair → `alert: ITEM_INDEX_INCOMPLETE` at error level and `consistent:false` in
the payload; the listing is still served, but never as if it were the truth.

This is the promise Phase 2 deferred. Both swallow sites now log under a fixed,
alertable key instead of silently:

- `discovery.service.js` → `logger.error({alert:'ITEM_INDEX_REFRESH_FAILED', at:'runDiscovery'})`
  (was a bare `console.error`).
- `session.service.js` → same key, `at:'finalizeSession'`.

Both remain non-fatal for the reasons in the Phase 2 handoff §4.2 (blocking an
erasure, or reporting failure for a committed transaction, is worse than a stale
projection). What changed is that a failure is now *visible and self-repairing*
rather than invisible.

### `backend/src/modules/dsar/dsar.routes.js`

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /api/v1/dsar/subjects/search?q=&limit=&cursor=` | `dataAdmin`, `super_admin` | Returns names and emails. Matrix §D withholds subject identity from `dpo` and `dataOwner` outright, so they are denied here even though they can work the request itself. |
| `GET /api/v1/dsar/:requestId/items?type=&origin=&projectId=&from=&to=&includeDeleted=&cursor=&limit=` | `dataAdmin`, `dpo`, `super_admin` | Same floor as `/:requestId/media`: pseudonymous, ids only. |

`GET /:requestId/media` is untouched and still mounted — `PurgeExport.jsx` and
`rights-surface.test.js` use it. Deprecate in docs later, do not delete.

Zod: `q` is 2–200 chars; item filters are enum + date + uuid only, deliberately
**no free-text filter** over a person's data.

### Migration `20260731000004_access_search_action` (local + Supabase, applied)

```sql
ALTER TYPE "AccessAction"     ADD VALUE IF NOT EXISTS 'SEARCH';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'SUBJECT_DATA_ITEM';
CREATE INDEX IF NOT EXISTS "subject_data_items_subject_id_deleted_at_captured_at_id_idx"
  ON "subject_data_items" ("subject_id","deleted_at","captured_at" DESC,"id" DESC);
```

`recordAccess()` is fail-closed, so an enum value the database does not know is a
503, not a degraded log line — both values had to exist before the endpoints
shipped. The index matches the keyset `ORDER BY` exactly and is mirrored in
`schema.prisma` with an explicit `map:` so `prisma migrate dev` sees no drift.
No new table, so no new RLS/grant work.

### `backend/tests/integration/dsar-item-search.test.js` **(new, 13 tests)**

First file under `tests/integration/`. Seeds rows directly (like
`tests/unit/itemIndex.test.js`) — **database only, no workers**:
`node --test tests/integration/dsar-item-search.test.js`.

Fixture: 3 sessions × 4 photos (one session on a second project), 1 frame per
session shared with a bystander, 1 enrollment selfie, 2 imported photos →
`EXPECTED_ITEMS = 15`. Covers `totals.all` ≠ page size, full cursor walk yields
every id exactly once, keyset stability across a manufactured
null-`capturedAt` tail, filters narrowing `matching` but never `all`,
IMPORT origin + `lawfulBasis` surviving a rebuild, shared-frame reporting,
tombstone visibility, exact/prefix-not-fuzzy identity matching (substring, typo
and uuid-prefix probes must all return nothing), 403 for `dpo`/`dataOwner` on
identity search, an `AccessEvent` per result, pseudonymity + no `storagePath` on
the request listing, 404/403 ordering, and divergence auto-repair.

### RBAC + docs

Both new endpoints added to `docs/02_ROLE_PERMISSION_MATRIX.md` §B **and**
`backend/tests/security/rbac-matrix.test.js` (the bidirectional CI gate). §D
gained two rows: the DSAR subject-search screen (exact+prefix only, never fuzzy)
and the request-workspace Data tab (never `storage_path`, never another
principal's id on a shared frame).

---

## 3. What was explicitly NOT done

- **Phase 3, the import pipeline, is still not built.** Nothing in `src/`
  references `ImportBatch`; `backend/src/modules/import/` does not exist. The
  import leg of Phase 4's acceptance test is seeded the way `ingestItem()` will
  have to write it — `Photo.sessionId = null`, `PhotoSubject.consentId = null`
  (both nullable since `20260731000003`), and the `SubjectDataItem` created by
  the import path itself with `origin='IMPORT'` and
  `meta.lawfulBasis='IMPORT_UNVERIFIED'`. That path is proven by test, not by
  code.
- **No per-item actions.** `DsarItemAction` is still empty — Phase 5.
- **No UI.** `admin-portal` is untouched this phase; `api.js` has no
  `searchDsarSubjects`/`listDsarItems` yet. Phase 8.
- **No `EXPLAIN ANALYZE` pass.** PLAN's "p95 < 300 ms for a 5 000-item subject"
  was not measured — the dev DB's largest subject has ~25 items. The covering
  index is in place; Phase 9 owns the measurement.
- **Supabase MCP is still `Unauthorized`**, so Phase 1's `get_advisors` pass has
  still never run. Migrations were applied with `prisma migrate deploy` under
  `ADMIN_DATABASE_URL` instead (see §7). **Fix the token before Phase 9.**
- Subject search does **not** write an `AccessEvent` for a zero-result query —
  no principal's data was read. If an auditor later wants "every term a handler
  typed", that is a new event type, not a change to this one.

---

## 4. Key decisions + rationale

1. **`totals.all` ignores the filters.** It is the completeness claim, not a
   result count. `matching` is the paging number. Conflating the two is exactly
   how a filtered screen becomes a false "this is everything we hold".
2. **Identity search is `startsWith` only, and uuids are exact-only.** A prefix
   of a uuid is not evidence about a person, and a fuzzy match on a DSAR search
   shows one principal another principal's data — a breach, not a bad result.
   The test asserts the negative cases (substring, transposition, id prefix)
   because that is the property that will rot first under a "search feels weak"
   complaint.
3. **Identity search is `dataAdmin`/`super_admin`; item listing admits `dpo`.**
   Matrix §D is explicit that dpo and dataOwner never see subject identity. The
   item grid is pseudonymous, so a DPO can supervise a request end to end without
   ever learning whose it is.
4. **One `AccessEvent` per returned subject, written sequentially before the
   response.** `recordAccess()` throws; a search whose read log could not be
   written must not return the people it found. Batched inserts were rejected —
   `recordAccess()` is the single fail-closed chokepoint and splitting it would
   create a second, weaker path.
5. **A divergent index is repaired, then reported — never silently served.**
   Phase 2's non-fatal catches were safe only while nothing read the index; the
   moment completeness is served from it, "refresh failed" has to surface. Cost
   is two `count()`s per listing, which is cheap next to serving an understated
   holding.
6. **Keyset, not offset, and `NULLS LAST` handled explicitly.** `capturedAt` is
   nullable and a null-capture item is a real case (future non-photo types, an
   import with no date). The cursor encodes `{capturedAt, id}` as base64url JSON;
   once the walk is in the null tail it stays there, and before it the tail is
   still reachable. A malformed cursor is a 400, not a silent full-table scan.
7. **`storagePath` is not returned.** Nothing in the workspace needs a blob path,
   and §D's "Data Admin — Lineage" allowance is for the lineage screen, not for
   an endpoint a dpo can call.

---

## 5. Current system state

**Tests: 73/73 pass** (`cd backend && npm test`) — the previous 60 plus 13 new.
Runtime ~5 min with all four containers up.

**Migrations — 16 local, 16 applied.** `prisma migrate deploy` under
`ADMIN_DATABASE_URL` applied **both** `20260731000003_import_pipeline` (which had
never reached the remote despite landing locally) and
`20260731000004_access_search_action`.

**Services for the full suite** (`cd backend && docker compose up -d`):
`prism-qdrant` 6333, `prism-redis` 6379, `prism-face-worker` 8001,
`prism-image-pii-worker` 8002. The face worker takes ~4 min from cold — wait on
`curl -sf http://localhost:8001/health`. The three `tests/e2e/*` files fail their
`preconditions` subtest without the workers and cascade into ~33 confusing
`Cannot read properties of undefined` failures.

`tests/unit/*` and `tests/integration/dsar-item-search.test.js` need **only the
database**.

**Known-broken / outstanding:**
- Supabase MCP `Unauthorized` — the advisor passes from Phase 1 and Phase 9 are
  both blocked on it.
- The §3 five-check manual portal pass in `docs/HANDOFF_2026-07-28_waves0-6.md`
  is still not done.
- `face-worker/__pycache__/main.cpython-313.pyc` is committed and wants
  gitignoring.
- `gitnexus_detect_changes({scope:'all'})` after this phase: **LOW**, 3 symbols,
  0 affected processes. Two of the three (`actorOf`, `detectPiiRegions`) are
  line-offset artifacts of edits made near them, not behaviour changes.

---

## 6. Next phase

**PLAN.md Phase 5 — per-item and bulk actions.** `itemAction.service.js`,
`itemActionQueue.js`, `itemAction.worker.js`, `POST /:requestId/items/actions`,
`GET /:requestId/items/actions?batchId=`. **PLAN says do not delegate this phase
to a subagent** — it is the irreversible-deletion path.

What Phase 4 leaves it:

- `listSubjectItems({ filter })` already resolves a filter server-side. Bulk
  "select all matching" must reuse `itemWhere()` from `itemSearch.service.js`
  rather than trusting a client-sent id list.
- Every item already carries `sharedSubjectCount` and `shared`. The guard is
  `sharedSubjectCount > 1` → downgrade `DELETE` to `REDACT`, recorded as a
  `SKIPPED` + `REDACT` pair, never a silent no-op.
- `AccessAction.SEARCH` and `AccessObjectType.SUBJECT_DATA_ITEM` now exist, so an
  action log entry over an item has an object type that resolves. **Any further
  new enum member is a migration, and `recordAccess()` 503s until it is applied.**
- Run `gitnexus_impact({target:'createPurgeJob', direction:'upstream', repo:'samsung project'})`
  before extending it: certificate issuance reads `locationsTotal` /
  `keyDestroyedAt` off that job, and a scoped job (`meta.scope='PARTIAL'`) must be
  excluded from `issueCertificate()`.

---

## 7. Traps

- **A Read-tool hook truncates `PLAN.md` and `docs/*.md` to line 1** and claims
  the file is already summarised. It is not. Use `sed -n '1,240p' FILE` via Bash.
  `PLAN.md` is 439 lines and reads as 1.
- **`DIRECT_URL` points at `prism_app`, which has no `CREATE` on schema
  `public`** — by design. `npx prisma migrate deploy` fails with `42501` *and*
  records the migration as failed, blocking every later one until
  `prisma migrate resolve --rolled-back <name>`. Run migrations as the owner:
  ```powershell
  $admin = (Get-Content .env | Select-String '^ADMIN_DATABASE_URL=').Line -replace '^ADMIN_DATABASE_URL=','' -replace '"',''
  $env:DIRECT_URL = $admin; $env:DATABASE_URL = $admin
  npx prisma migrate deploy
  $env:DIRECT_URL = $null; $env:DATABASE_URL = $null
  ```
  Prisma's dotenv does not override already-set process env vars. Unset after.
- **`access_events` is append-only for `prism_app`.** A test teardown that tries
  to `deleteMany()` its own events gets `42501 permission denied for table
  access_events` — and because it ran *before* the fixture cleanup, it left
  subjects, sessions and projects behind. Those leftovers then broke
  identity-search assertions on the **next** run with what looked like a
  fuzzy-match bug. Do not delete access events; make fixture names run-unique
  instead (`RUN` token).
- **Fixture emails must not be uuid-derived.** `email: '<masterUserId>@x.test'`
  makes the "a uuid prefix must not match" assertion fail through the email
  clause, which reads as a service bug and is not one.
- **`indexSubject()` overwrites `capturedAt` from `photo.takenAt ?? photo.createdAt`.**
  A seeded item with `capturedAt: null` does not stay null through a rebuild, so a
  null-tail pagination test has to manufacture the null after the last rebuild.
- **A new table with RLS on and no policy denies everything; a new table with no
  grant is a 42501 on first insert.** Both are invisible until runtime and both
  present as a broken feature, never as a permissions error. RLS + policy +
  `prism_app` grants in the same migration, then a smoke query *as `prism_app`*.
- **`prisma.subjectDataItem`'s compound-unique key name is
  `subjectId_type_sourceTable_sourceId`** — needed for every upsert.
- `logAccess`/`recordAccess` is fail-closed: it aborts the request if the
  `AccessEvent` write fails or an enum value does not exist in the database.
- PgBouncer `connection_limit=20`. Five services share the pool; the indexer
  writes in chunks of 20 for that reason.
- The API listens on **4000**, not 3000.
- Never lose `MEDIA_KEK`. Anything touching sealed blobs goes through
  `lib/blobCrypto.js` / `lib/keyring.js`.
