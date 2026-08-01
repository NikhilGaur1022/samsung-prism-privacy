# PRISM — handoff

**Written for a session with zero memory of the one that produced it.**
Read this and `PLAN.md`, and nothing else, before starting.

> **A Read-tool hook truncates `PLAN.md` and `docs/*.md` to line 1 and claims the
> file is already summarised. It is not.** Read them with
> `sed -n '1,240p' FILE` via Bash instead.

---

## 1. Phases completed

**PLAN.md Phases 5, 6 and 7 — item actions, selective export, lifecycle &
timeline.** 2026-08-01, all three in one session at the user's instruction
(PLAN says one phase per session; that was explicitly overridden).

Earlier handoffs, superseded but **not to be deleted**:

- `docs/HANDOFF_2026-08-01_phase4-item-search.md` — Phase 4. Still the authority
  on `itemSearch.service.js`, the `totals.all` contract and the index-staleness
  guard.
- `docs/HANDOFF_2026-07-31_phase2-item-indexer.md` — Phase 2. Its §4 (why
  `origin`/`meta` are create-only, why the tombstone sweep uses one app-side
  timestamp) is still the authority on indexer semantics.
- `docs/HANDOFF_2026-07-28_waves0-6.md` — the pre-DSAR platform, the `prism_app`
  migration, media encryption, and a §3 manual-verification checklist that is
  **still outstanding**.

**Phase 3 (import pipeline) is still skipped**, deliberately — see §3.

---

## 2. What was implemented

### Phase 5 — per-item and bulk actions

#### `backend/src/modules/dsar/itemAction.service.js` **(new, ~430 ln)**

| Export | Behaviour |
|---|---|
| `requestActions({dsarRequestId, itemIds \| filter, kind, reason}, admin, {inline})` | Resolves the selection, plans it, writes every `DsarItemAction` row in one transaction, then enqueues. Returns `{batchId, summary, actions}`. |
| `executeAction(actionId)` | Executes one recorded action. Returns a terminal row untouched, which is what makes an at-least-once queue safe. |
| `listActions(requestId, {batchId, status, limit}, admin)` | Batch progress + `counts` by status + `inFlight`. |
| `countInFlightActions(requestId)` | What the close guard calls. |

The four guarantees, and where each lives:

1. **Nothing happens that was not recorded first.** Rows are written and
   committed *before* any job is enqueued. A job that started before its row was
   visible could complete against a row that does not exist, and the retry would
   then look like a second, unexplained deletion.
2. **A DELETE on a shared frame is refused and downgraded to a REDACT.** Decided
   from the index's own `sharedSubjectCount`, never from anything the client
   sent, and **re-checked at execution time** — planning and execution can be
   minutes apart and another principal can be tagged onto the frame in between.
   Recorded as a `SKIPPED` DELETE **plus** a `REQUESTED` REDACT with a reason.
   Never a silent no-op: an operator who asked for a deletion is owed the news
   that they did not get one.
3. **"Select all" is resolved server-side.** `filter` is re-run against
   `subject_data_items` scoped to the request's own subject, capped at
   `MAX_BATCH` (500, `DSAR_ITEM_ACTION_MAX_BATCH`). An `itemIds` list naming an
   item outside the request's subject is a **403**, not a 404 — it is an
   authorization failure and deserves its own status in the logs.
4. **Idempotent.** `@@unique([dsarRequestId, itemId, kind])` + `skipDuplicates`,
   so a double-submitted batch collapses onto the first submission's rows. The
   service reads the rows back rather than trusting `createMany`'s count.

Other gates: actions are refused outside `DISCOVERY | EXECUTING | REVIEW` (409);
a DELETE with no written reason ≥10 chars is a 400; `dpo` and `dataOwner` get
403 on the write path but keep the read path.

`EXPORT` deliberately has **no side effect** — the row *is* the selection, and
Phase 6 packages whatever carries a `DONE` export action.

#### Scoped purge — `purge.service.js`, `certificate.service.js`

`createPurgeJob(requestId, admin, { items, batchId })` now plans a **scoped** job
from named item rows instead of a discovery walk. Three locations are
deliberately **absent** from a scoped plan and must stay absent:

- `SUBJECT_KEY` — destroying the per-subject DEK to honour one photo's deletion
  would make every *other* photo and enrollment of that subject permanently
  unreadable. Crypto-shredding is a whole-subject act.
- `CONSENT` and `PII` — subject-level; an item delete says nothing about either.

`issueCertificate()` **throws 409 on `scope === 'PARTIAL'`.** A completed scoped
job is structurally identical to a small completed erasure, and signing one would
be a false statement with our name on it. The absence of the three locations
above is the second, structural half of the same guard.

`createPurgeJob`'s "is there already an open job" lookup now filters
`scope: 'FULL'`. Without that filter, a scoped job left `PARTIAL` by a failed
item delete would be returned as "the open erasure" and the whole-subject purge
would **never be planned at all**. That was the single most dangerous line in
this phase.

#### Queue + worker

- `backend/src/lib/itemActionQueue.js` **(new)** — mirrors `redactionQueue.js`.
- `backend/src/workers/itemAction.worker.js` **(new)** — concurrency **1**, same
  reason as `purge.worker.js`: two deletes can land on one frame and the rebuild
  of the survivors' derivative must not interleave with another job's delete of
  the original. Exhausted retries → terminal `FAILED` + audit row, so the close
  guard blocks and the operator sees why instead of finding a row stuck in
  `RUNNING` forever.
- `npm run worker:item-action`.

### Phase 6 — selective export packaging

`buildAccessPackage(id, admin, { selection })` where `selection` is
`'ALL'` (default, unchanged behaviour) | `'SELECTED'` | `{itemIds}` | `{filter}`.

Selection resolves over the **item index**, not over photos, so the package and
the item grid describe the same objects with the same ids — and it is applied
**before** anything is read from storage, so an unselected photo is never
decrypted at all.

Manifest is now `version: 2` and gains a `selection` block:
`{mode, complete, itemCount, excludedCount, excludedBySelection,
redactedSubstitutions, note}`. `complete` is `false` for anything but `'ALL'`,
the `README.txt` says so in plain words, and the evidence row's label carries the
mode. **A narrowed package that did not say so could be read as the complete §11
answer** — that is the whole risk this phase manages.

Each manifest photo entry gains `sharedFrame`, and an unselected one carries
`reason: 'NOT_SELECTED — …'` so the manifest still lists everything held.

The `type !== 'ACCESS'` block is relaxed to `type !== 'ACCESS' && !admin`: a
handler may build a working copy while working an erasure or a grievance, and it
is recorded as `EvidenceKind.EXPORT_PACKAGE` exactly like the §11 one so it
cannot be produced off the record. An unattributed caller still gets a 400.

**`lib/zip.js` was NOT made streaming — see §3.** Instead
`PACKAGE_MAX_BYTES` (512 MB, `DSAR_PACKAGE_MAX_BYTES`) fails a too-large build
with a 413 and an instruction, rather than taking the API process down.

### Phase 7 — lifecycle, timeline, queue

- **`backend/src/modules/dsar/lifecycle.js` (new)** — the coarse
  Open / In Progress / Closed map, single source of truth, exported to both
  portals. The 7-state `DsarStatus` stays: certificates, the SLA board, the
  transition table and every existing test are written against it. An unmapped
  status resolves to `OPEN` so a request can never fall out of every tab.
- **`backend/src/modules/dsar/timeline.service.js` (new)** —
  `getRequestTimeline(requestId, admin)` merges transitions, evidence, item
  action **batches** (one entry per batch, not per item — a 200-item bulk delete
  is one decision, and 200 rows would bury everything else), purge jobs, access
  events and the certificate into one shape:
  `{at, kind, summary, actor, refId, hash, detail}`. Pseudonymous throughout.
  **`AuditLog` is hash-only**, so every "what" is read from the typed tables and
  the chain is attached as `integrity: {auditEntries, firstHash, lastHash,
  verifyWith}` — tamper-evidence, never content.
- **`dsar.service.listQueue()`** now returns `{items, nextCursor, counts}` with
  keyset paging over `(slaDueAt ASC, id ASC)`, a `coarse` tab filter,
  `assignedAdminId`, per-request counters (`itemsFound`, `itemsRedacted`,
  `itemsDeleted`, `itemsExported`) from **two** grouped queries for the whole
  page rather than four per row, and tab badges counted over the whole filtered
  set. `withSla()` adds `coarseStatus` to every request everywhere.
- **`dsar.service.closeRequest()`** — the explicit close. Distinct from
  `approveResolution()` on purpose: approval is the DPO signing off, closing is
  the handler declaring the work finished, and the close is the one that must
  check nothing is still running. **409 while any action is `REQUESTED` or
  `RUNNING`.** Writes closure evidence (who, why, `failedActions`) in the same
  transaction as the status change. A `FAILED` action is recorded but does not
  block — that is a decision the operator is allowed to make; hiding it is not.

### New endpoints

| Endpoint | Roles |
|---|---|
| `POST /api/v1/dsar/:requestId/items/actions` | `dataAdmin`, `super_admin` |
| `GET /api/v1/dsar/:requestId/items/actions?batchId=&status=&limit=` | `dpo`, `dataAdmin`, `super_admin` |
| `POST /api/v1/dsar/:requestId/package` | `dataAdmin`, `super_admin` |
| `GET /api/v1/dsar/:requestId/timeline` | `dpo`, `dataAdmin`, `super_admin` |
| `POST /api/v1/dsar/:requestId/close` | `dpo`, `dataAdmin`, `super_admin` |

`GET /api/v1/dsar` gained `coarse`, `assignedAdminId`, `cursor`, `limit`.

All five are in **both** `docs/02_ROLE_PERMISSION_MATRIX.md` §B and
`backend/tests/security/rbac-matrix.test.js` — the bidirectional CI gate. §D
gained three rows: the bulk action bar (must state the exact count and the
shared-frame downgrade), the Timeline tab (never invent content for a hash-only
audit entry), and the dashboard queue.

### Migration `20260801000001_purge_job_scope`

```sql
CREATE TYPE "PurgeJobScope" AS ENUM ('FULL','PARTIAL');   -- guarded, idempotent
ALTER TABLE "purge_jobs" ADD COLUMN "scope" "PurgeJobScope" NOT NULL DEFAULT 'FULL';
ALTER TABLE "purge_jobs" ADD COLUMN "meta"  JSONB;
CREATE INDEX "purge_jobs_dsar_request_id_scope_status_idx"
  ON "purge_jobs" ("dsar_request_id","scope","status");
```

`DEFAULT 'FULL'` is the correct backfill — every job that existed was planned
from a complete discovery walk. No new table, so no RLS/grant block: a column
inherits its table's policy and grants (`purge_jobs` got both in
`20260725000002_rls_audit_access`).

### Bug found and fixed en route: **every BullMQ enqueue was throwing**

`enqueueRedaction` used `jobId: \`redact:${photoId}\`` and `enqueuePurge` used
`purge:${id}`. **BullMQ v5 rejects a custom job id containing `:`**
(`"Custom Id cannot contain :"`) because that is its own Redis key delimiter. Both
threw on every call — deferred photos were never retried and the out-of-band
erasure path never ran at all. All three queues now use a hyphen. This predates
this session and was invisible because both callers are on paths the test suite
exercised only inline.

### New tests (26)

| File | Tests | Deps |
|---|---|---|
| `tests/integration/dsar-item-actions.test.js` | 11 | DB + Redis |
| `tests/integration/dsar-export-selection.test.js` | 9 | DB + media store |
| `tests/integration/dsar-timeline.test.js` | 6 | DB + media store + Redis |

---

## 3. What was explicitly NOT done

- **Phase 3, the import pipeline, is still not built.** Nothing in `src/`
  references `ImportBatch`; `backend/src/modules/import/` does not exist. The
  import leg is proven by seeded fixture, not by code.
- **`lib/zip.js` was not made streaming.** PLAN asks for it. `storage.writeFile`
  seals the whole blob under one AES-GCM envelope and there is no partial-seal
  API to stream into; inventing one would put an unsealed temp file on disk,
  which is exactly what the sealed-media guarantee exists to prevent. A byte
  ceiling with a 413 was taken instead. **Revisit only alongside a chunked
  sealing API in `blobCrypto.js` — not as a zip change.**
- **No UI.** `admin-portal` is untouched. Phase 8 owns all of it, including the
  `ErrorBoundary` that still does not exist anywhere in the codebase.
- **No `EXPLAIN ANALYZE` / scale pass.** Phase 9.
- **Supabase MCP is still `Unauthorized`** — `mcp__supabase__execute_sql`
  returns `Unauthorized. Please provide a valid access token`. The user asked
  for migrations via Supabase MCP; it does not work, so
  `20260801000001` was applied with `prisma db execute --url $ADMIN_DATABASE_URL`
  then `prisma migrate resolve --applied`. **Same remote DB, same result.** Fix
  `SUPABASE_ACCESS_TOKEN` before Phase 9, which needs `get_advisors`.
- **Subject-facing timeline is not built** — Phase 9 owns
  `GET /api/v1/me/dsar/:id/timeline` and the redacted view.
- `POST /:requestId/package` does **not** mail the token. Same as before: the raw
  token is returned once to the caller.

---

## 4. Key decisions + rationale

1. **A scoped purge is a persisted `scope`, not an inference from location
   counts.** Two independent guards — the enum check in `issueCertificate()` and
   the structural absence of `SUBJECT_KEY`/`CONSENT`/`PII` from a scoped plan.
   One guard on the path that signs a legal document is not enough.
2. **The open-job lookup filters `scope: FULL`.** Otherwise a stuck scoped job
   suppresses the whole-subject erasure forever. Silent, and catastrophic.
3. **The shared-frame downgrade is re-checked at execution.** Planning-time
   truth is not execution-time truth on a system with a tagging path.
4. **`EXPORT` has no side effect.** The row is the selection. One place decides
   what is in a package, and it is the same place the operator ticked.
5. **The batch ceiling is a blast radius, not a performance number.** 500 is
   deliberately small enough that deleting everything for a subject takes more
   than one click.
6. **A refused delete is `SKIPPED` with an error string, never dropped.** An
   operator who selected 40 items and got 38 actions must see the other two.
7. **The timeline groups by batch.** Per-item entries would make the one screen
   that answers "what happened" unreadable at exactly the moment it matters.
8. **The coarse status is a projection, not a column.** Storing it would create a
   second source of truth for request state, and they would drift.
9. **`closeRequest` is separate from `approveResolution`.** Same transition,
   different act, and only one of them needs the in-flight guard.
10. **The package byte ceiling over a streaming zip** — see §3. A 413 with an
    instruction beats an OOM, and beats an unsealed temp file by much more.

---

## 5. Current system state

**Tests: 99/99 pass** (`cd backend && npm test`) — 73 prior + 26 new. Runtime
~12 min with everything up.

**The e2e suites need four services.** With them down, 33 tests fail on their
`preconditions` assertion and nothing else — that is environmental, not a
regression:

```bash
docker start prism-qdrant prism-redis prism-face-worker prism-image-pii-worker
# or: docker compose up -d   (from backend/)
# health: :8001/health, :8002/health, :6333/collections, redis :6379
```

**Migrations — 17 local, 17 applied** (local `_prisma_migrations` and the remote
are the same database; there is no separate local Postgres).

**Services for full function:** API `:4000` (**not 3000**), Redis, Qdrant, face
worker `:8001`, image-pii worker `:8002`, and now
`npm run worker:item-action` alongside `worker:purge` / `worker:redaction` /
`worker:retention`.

**Known-broken / outstanding:**
- Supabase MCP `Unauthorized`.
- `face-worker/__pycache__/main.cpython-313.pyc` is tracked and wants
  gitignoring.
- The five-check manual portal pass in `docs/HANDOFF_2026-07-28_waves0-6.md` §3.
- **Nothing in this session is committed.** Phases 4–7 are all in the working
  tree.

---

## 6. Next phase

**PLAN.md Phase 8 — admin UI: DSAR dashboard + request workspace.**

Everything it needs from the backend exists. Wire `admin-portal/src/lib/api.js`
to: `GET /dsar` (now `{items, nextCursor, counts}` — **the shape changed, the old
caller reading a bare array will break**), `GET /dsar/subjects/search`,
`GET /dsar/:id/items`, `POST /dsar/:id/items/actions`,
`GET /dsar/:id/items/actions`, `POST /dsar/:id/package`,
`GET /dsar/:id/timeline`, `POST /dsar/:id/close`.

Import `lifecycle.js` for the tab map rather than re-deriving it in React.

Two UI rules are contractual, not cosmetic:
- A destructive confirm must state the **exact count** and that shared frames
  will be **redacted instead of deleted**. The server enforces the downgrade
  either way; the point is that the operator is not surprised by it.
- Wrap the router in an `ErrorBoundary`. There is still none anywhere in the
  codebase, which is why render crashes present as blank pages.

Then Phase 9: subject-facing timeline, `EXPLAIN ANALYZE` + advisors, the e2e
`dsar-full-lifecycle.test.js`, and the docs pass.

---

## 7. Traps

1. **`DeletionCertificate` has `issuedAt`, not `createdAt`.** Cost a test run.
2. **BullMQ v5 forbids `:` in a custom `jobId`.** See §2. If you add a queue, use
   a hyphen.
3. **`access_events` is append-only for `prism_app`.** `deleteMany` on it is a
   42501 — and in a `test.after` it aborts teardown *before* fixture cleanup,
   orphaning rows. Never clean that table in a test.
4. **`downloadPackage()` resolves the LATEST `EXPORT_PACKAGE` evidence row for
   the request.** Build two packages then redeem the first token and you get
   "Invalid download token", which looks like a crypto bug and is not.
5. **Migrations must run under `ADMIN_DATABASE_URL`.** `DIRECT_URL` points at
   `prism_app`, which has no `CREATE` on `public`.
6. **Route mount order.** Static segments before `/:requestId`.
   `/:requestId/items/actions` sits above `/:requestId/certificate` and must stay
   there.
7. **A blank page in the portal is a render crash**, not a failed fetch — until
   Phase 8 lands the error boundary.
8. **`indexSubject()` sets `capturedAt = takenAt ?? createdAt`**, so a seeded
   null `capturedAt` does not survive a rebuild. Manufacture that boundary with
   `updateMany` and restore it in a `finally`.
9. **The `_count` on a Prisma `select` needs the relation named**
   (`_count: { select: { subjects: true } }`), and it is how the export manifest
   knows a frame is shared.
10. **`listQueue()` no longer returns an array.** `me.routes.js` was updated;
    check anything else that destructured it.
