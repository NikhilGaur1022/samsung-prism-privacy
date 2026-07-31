# PLAN.md — DSAR Request Handling System

Project: **PRISM** (repo dir: `samsung project`)
Author pass: 2026-07-31
Status: planning only — no implementation performed in this session.

---

## 0. Situation Assessment (read this before planning anything else)

This is **not** a greenfield build. PRISM already ships a substantial DSAR spine. The
job is gap-closure, not re-invention. Anything below marked **EXISTS** must be reused,
not rewritten.

### What already exists

| Capability | Where | State |
|---|---|---|
| DSAR request entity, 7-state lifecycle, SLA clocks | `backend/prisma/schema.prisma` → `DsarRequest`, `DsarStatus`, `DsarType`, `DsarChannel` | EXISTS, solid |
| Request CRUD/queue/assign/execute/approve/reject | `backend/src/modules/dsar/dsar.service.js` (553 ln), `dsar.routes.js` | EXISTS |
| Discovery walk ("everywhere this person exists", L2–L11 location codes) | `backend/src/modules/dsar/discovery.service.js` (271 ln) | EXISTS, read-only, over-reports by design |
| Access-package export (whole subject, ZIP, tokenised download, expiry) | `backend/src/modules/dsar/export.service.js` (430 ln) | EXISTS, **all-or-nothing** |
| Erasure executor (per-location purge job, resumable, hash-before-delete) | `backend/src/modules/dsar/purge.service.js`, `workers/purge.worker.js` | EXISTS, **whole-subject only** |
| Signed deletion certificate (ed25519, pseudonymised) | `backend/src/modules/dsar/certificate.service.js` | EXISTS |
| Evidence vault (`DsarEvidence`, hash + payload) | schema + `listEvidenceVault()` | EXISTS |
| Tamper-evident audit chain (hash-only) + access events | `lib/auditLog.js`, `lib/accessLog.js`, `AuditLog`, `AccessEvent` | EXISTS |
| Redaction pipeline (face blur + PII text, sealed media) | `lib/redactionQueue.js`, `workers/redaction.worker.js`, image-pii-worker :8002 | EXISTS, **triggered only by session tagging** |
| Photo ingest (multipart) | `POST /api/v1/sessions/:sessionId/photos` (multer, 20/req) | EXISTS, session-scoped |
| Media enumeration for a request | `listSubjectMedia()` → `GET /api/v1/dsar/:id/media` | EXISTS, unpaginated, read-only |
| Admin queue UI | `admin-portal/src/pages/dataAdmin/DsarQueue.jsx` (110 ln) | EXISTS, **thin** — list only, links to `/purge-export` |
| Subject-facing rights UI | `user-portal/src/pages/{RaiseRequest,RequestStatus,DataRights,Certificate}.jsx` | EXISTS |
| DB | Supabase Postgres (`aws-1-ap-south-1.pooler.supabase.com`), Prisma client, PgBouncer `connection_limit=20` | EXISTS |

### The real gaps (these are what this plan builds)

- **G1 — No import path for a person's existing data.** Photos only enter via a
  collection session. There is no "Admin imports this person's data" flow, and no
  data-type abstraction so non-photo types can be added later.
- **G2 — No per-item search surface.** `runDiscovery()` returns *locations*;
  `listSubjectMedia()` returns an unpaginated photo array. Neither is a paged,
  filterable, cross-type "everything for this person" result set. "All, not
  best-effort" is not currently provable.
- **G3 — No per-item actions.** Redact fires only from session tagging. Delete only
  exists as a whole-subject purge job. There is no per-item or bulk-selection
  redact / delete / mark-for-export.
- **G4 — Export is all-or-nothing** and `ACCESS`-type-only. No filtered/redacted-subset
  package.
- **G5 — Lifecycle visibility is the stated biggest pain point and is the weakest
  part of the UI.** No request-detail workspace, no per-request timeline, no
  open-vs-closed dashboard, no in-app close action.

### Architecture decisions taken up front

1. **Item abstraction over a polymorphic table, not one table per data type.**
   New `SubjectDataItem` row per (subject, data-type, source object). Photos backfill
   into it; future types (documents, transcripts, form records) add a `DataItemType`
   enum value and one resolver, nothing else. Keeps discovery/action/export code
   type-agnostic.
2. **Item index is derived, never authoritative.** `SubjectDataItem` is a *projection*
   maintained by the discovery walk + import; the underlying `Photo`/`PhotoSubject`
   rows stay the source of truth. A stale index can be rebuilt idempotently. This
   avoids a second consistency problem on erasure-critical data.
3. **Actions are recorded, then executed asynchronously.** `DsarItemAction` row is
   written in the request transaction (`REQUESTED`), a BullMQ job executes it, the row
   moves to `DONE`/`FAILED`. Never fire-and-forget: an action with no row is an action
   with no audit trail, and this system's whole point is auditability.
4. **Reuse the existing purge executor for deletes.** A per-item delete becomes a
   scoped `PurgeJob` with a location subset, not a new deletion code path. One
   deletion code path = one thing to certify.
5. **Multi-subject photos are never hard-deleted.** Existing
   `discovery.multiSubjectPhotos` rule holds: a photo with other principals on it gets
   *re-redacted for the requesting subject*, never removed. Enforced server-side, not
   in the UI.
6. **Storage stays sealed-blob + Supabase Postgres metadata.** Do not move media into
   Supabase Storage — media is envelope-encrypted under `MEDIA_KEK`; migrating it
   would break sealed-media guarantees and the deletion certificate's location model.
   Supabase is the metadata/lifecycle store, which is what the MCP tooling is used for.
7. **Scale posture:** everything list-shaped is keyset-paginated; every action path is
   queue-backed and idempotent; every new table gets its access index up front. No
   endpoint may load a subject's full photo set into memory.

### Status → user-facing lifecycle mapping

Spec asks for Open → In Progress → Closed. Do **not** replace the 7-state enum
(certificates, SLA board and tests depend on it). Map instead, in one shared module:

| Coarse | `DsarStatus` |
|---|---|
| Open | `RECEIVED`, `TRIAGE` |
| In Progress | `DISCOVERY`, `EXECUTING`, `REVIEW` |
| Closed | `CLOSED`, `REJECTED` |

---

## 1. Phases

Each phase is one session. Each ends with: tests green, `gitnexus_detect_changes()`
clean, `docs/HANDOFF.md` rewritten (see §3).

---

### Phase 1 — Baseline verification + data model

**Goal:** prove current state against the live DB, then land the schema for items,
actions and imports. Nothing else.

**Do**
- Verify live schema via Supabase MCP: `mcp__supabase__list_tables`,
  `mcp__supabase__list_migrations`. Confirm the 12 local migrations match the remote.
- `mcp__supabase__get_advisors` (security + performance) — record findings, don't fix yet.

**Files**
- `backend/prisma/schema.prisma` — add:
  - `enum DataItemType { PHOTO }` (extensible)
  - `enum DataItemOrigin { COLLECTION_SESSION, IMPORT, ENROLLMENT }`
  - `model SubjectDataItem` — `id`, `subjectId`, `type`, `origin`, `sourceTable`,
    `sourceId`, `projectId?`, `sessionId?`, `storagePath?`, `contentHash?`,
    `capturedAt?`, `sharedSubjectCount Int @default(1)`, `redactedAvailable Boolean`,
    `deletedAt?`, `indexedAt`, `meta Json?`
    - `@@unique([subjectId, type, sourceTable, sourceId])`
    - `@@index([subjectId, type, capturedAt])`, `@@index([subjectId, deletedAt])`
  - `enum DsarItemActionKind { REDACT, DELETE, EXPORT }`
  - `enum DsarItemActionStatus { REQUESTED, RUNNING, DONE, FAILED, SKIPPED }`
  - `model DsarItemAction` — `id`, `dsarRequestId`, `itemId`, `kind`, `status`,
    `requestedByAdminId`, `batchId?`, `reason?`, `error?`, `hashBefore?`,
    `requestedAt`, `completedAt?`
    - `@@unique([dsarRequestId, itemId, kind])` (idempotency)
    - `@@index([dsarRequestId, status])`, `@@index([batchId])`
  - `model ImportBatch` — `id`, `subjectId`, `type`, `projectId?`, `createdByAdminId`,
    `itemsTotal`, `itemsDone`, `itemsFailed`, `status`, `note?`, timestamps
  - relations onto `DsarRequest` (`itemActions`) and `Subject` (`dataItems`, `importBatches`)
- `backend/prisma/migrations/<ts>_dsar_item_index/migration.sql` — generated, then
  applied to Supabase via `mcp__supabase__apply_migration` (not `prisma migrate deploy`
  against prod).
- `backend/prisma/migrations/<ts>_dsar_item_index_rls/migration.sql` — RLS + grants for
  the three new tables mirroring `20260728000001_lock_down_public_grants`. **The app
  connects as `prism_app`, not `postgres` — new tables get explicit grants or every
  query 403s.**

**Acceptance:** `npx prisma generate` clean; `mcp__supabase__list_tables` shows the
three tables with RLS on; existing 53 tests still pass; no route changes.

**Delegate:** migration SQL boilerplate + grant statements → Sonnet subagent, reviewed
by main. Schema design itself → main model.

---

### Phase 2 — Item indexer (backfill + incremental)

**Goal:** `SubjectDataItem` reflects reality for every existing subject.

**Files**
- `backend/src/modules/dsar/itemIndex.service.js` **(new)** —
  `indexSubject(subjectId)` (idempotent upsert from `PhotoSubject` + `Photo` +
  `SubjectFaceEnrollment`), `indexPhotoSubject(link)`, `markItemDeleted(itemId)`,
  `rebuildAll({ batchSize })`.
- `backend/src/modules/dsar/discovery.service.js` — after the walk, call
  `indexSubject()` so discovery and the item index can never disagree. Discovery's
  return shape is unchanged (callers/tests depend on it).
- `backend/src/modules/sessions/session.service.js` — on photo↔subject tag write, call
  `indexPhotoSubject()`. **Run `gitnexus_impact({target:"tagPhotoSubject", direction:"upstream"})`
  before touching this file — it is on the hot tagging path.**
- `backend/scripts/backfill-item-index.js` **(new)** — batched, resumable CLI.
- `backend/tests/unit/itemIndex.test.js` **(new)** — idempotency (index twice → one
  row), multi-subject count correctness, deleted-item exclusion.

**Acceptance:** backfill over the dev DB produces item counts matching
`listSubjectMedia()` for 3 sampled subjects; re-running changes 0 rows.

**Delegate:** the backfill script + test fixtures → Sonnet. Indexer logic → main.

---

### Phase 3 — Import pipeline

**Goal:** an Admin can import a named person's photos into the system, correctly
identified and immediately discoverable.

**Files**
- `backend/src/modules/import/import.service.js` **(new)** — `createBatch()`,
  `ingestItem({ batchId, file })`: seal blob via `lib/blobCrypto.js` +
  `lib/storage.js` (same path convention as session photos), create `Photo` +
  `PhotoSubject` with `origin=IMPORT`, hash, then `indexPhotoSubject()`. Enqueue
  redaction so imported photos get the same PII treatment as captured ones.
- `backend/src/modules/import/import.routes.js` **(new)** —
  - `POST /api/v1/imports` — open a batch for a subject (`dataAdmin`, `super_admin`)
  - `POST /api/v1/imports/:batchId/items` — multipart, ≤20 files/req (mirror session
    multer config)
  - `POST /api/v1/imports/:batchId/close`
  - `GET /api/v1/imports?subjectId=` / `GET /api/v1/imports/:batchId`
- `backend/src/app.js` — mount `/api/v1/imports`. Mount order matters; place with the
  other admin routers, after `meRoutes`.
- `backend/src/modules/import/import.validators.js` **(new)** — zod; mime allowlist,
  size cap, subject-exists + not-`ERASED` check (import into an erased subject must 400).
- `backend/tests/integration/import.test.js` **(new)**.
- `docs/02_ROLE_PERMISSION_MATRIX.md` + `backend/tests/security/rbac-matrix.test.js` —
  add the four new endpoints. **The RBAC matrix test is the gate; new endpoints not in
  the matrix fail CI.**

**Consent decision to state explicitly in the code:** imported data has no capture-time
consent record. Import writes a `ProjectConsent`-linked item only if a `projectId` is
supplied and an active consent exists; otherwise the item is flagged
`meta.lawfulBasis = 'IMPORT_UNVERIFIED'` and surfaces as such in discovery. Do not
silently manufacture consent.

**Acceptance:** import 5 photos for a subject → they appear in
`GET /api/v1/dsar/:id/items` (Phase 4) and in `runDiscovery()` under L2.

---

### Phase 4 — Search & discovery API (per-item, paged, complete)

**Goal:** "search a person, get **all** their data" — provably complete, not best-effort.

**Files**
- `backend/src/modules/dsar/itemSearch.service.js` **(new)** —
  `searchSubjects({ q, limit, cursor })` (name/email/employeeRef/masterUserId, exact +
  prefix; **no fuzzy matching on identity — a wrong match is a privacy breach**) and
  `listSubjectItems({ subjectId, type, origin, projectId, from, to, includeDeleted, cursor, limit })`
  returning `{ items, nextCursor, totals: { byType, all } }`.
  `totals.all` is a `count()` over the index, not `items.length` — this is what makes
  completeness assertable in the UI.
- `backend/src/modules/dsar/dsar.routes.js` — add:
  - `GET /api/v1/dsar/subjects/search`
  - `GET /api/v1/dsar/:requestId/items`
  - keep `GET /:requestId/media` as-is (deprecate in docs, do not delete — tests and
    `PurgeExport.jsx` use it).
- `backend/src/lib/accessLog.js` usage — every item search is an `AccessEvent`
  (`actorType=ADMIN`, action=`SEARCH`). Handlers browsing a subject's data is exactly
  the thing that must be logged. Note: `logAccess` is fail-closed; verify the new
  object type resolves or requests will abort (known trap, see memory 5231/5232).
- `backend/src/modules/audit/…` — add `SEARCH` to `AccessAction` if absent (migration).
- `backend/tests/integration/dsar-item-search.test.js` **(new)** — completeness test:
  seed N photos across 3 sessions + 1 import, assert `totals.all === N` and full
  pagination yields exactly N distinct ids.

**Acceptance:** completeness test green; p95 < 300 ms for a 5 000-item subject.

---

### Phase 5 — Per-item + bulk actions (redact / delete / export-select)

**Goal:** the action surface. Highest-risk phase — deletion is irreversible.

**Files**
- `backend/src/modules/dsar/itemAction.service.js` **(new)** —
  - `requestActions({ dsarRequestId, itemIds | selectAllFilter, kind, reason, admin })`
    → creates `DsarItemAction` rows in one transaction, returns `batchId`.
    Bulk-by-filter resolves server-side (never trust a client-sent id list for
    "select all") and caps at a configurable ceiling per batch.
  - Guards, all server-side and all fail-closed:
    - `DELETE` on an item with `sharedSubjectCount > 1` → downgraded to `REDACT`,
      recorded as `SKIPPED` + `REDACT` pair with reason. Never a silent no-op.
    - actions only permitted while request status ∈ `DISCOVERY | EXECUTING | REVIEW`.
    - `hashBefore` captured before any delete (mirrors `PurgeJobLocation`).
  - `executeAction(actionId)` — REDACT → `enqueueRedaction`; DELETE → scoped
    `PurgeJob` via `purge.service.createPurgeJob(…, { locationSubset })`;
    EXPORT → mark item selected (no side effect until Phase 6).
- `backend/src/modules/dsar/purge.service.js` — extend `createPurgeJob` to accept an
  optional item/location subset. **`gitnexus_impact({target:"createPurgeJob", direction:"upstream"})`
  first — certificate issuance reads `locationsTotal`/`keyDestroyedAt` off this job and
  a scoped job must not be certifiable as a full erasure.** A scoped job sets
  `meta.scope='PARTIAL'` and is explicitly excluded from `issueCertificate()`.
- `backend/src/workers/itemAction.worker.js` **(new)** — BullMQ consumer, retries with
  backoff, terminal `FAILED` with error text.
- `backend/src/lib/itemActionQueue.js` **(new)** — mirror `redactionQueue.js`.
- `backend/src/modules/dsar/dsar.routes.js` — `POST /:requestId/items/actions`,
  `GET /:requestId/items/actions?batchId=`.
- `backend/tests/integration/dsar-item-actions.test.js` **(new)** — shared-photo
  downgrade, idempotent double-submit, partial-batch failure isolation.

**Acceptance:** bulk delete of 200 items across 2 sessions completes with 200 terminal
rows, 0 orphaned blobs, shared photos redacted-not-deleted, no certificate issued.

**Do not delegate this phase.**

---

### Phase 6 — Selective export packaging

**Files**
- `backend/src/modules/dsar/export.service.js` — `buildAccessPackage(id, { selection })`
  where `selection` = `{ itemIds }` | `{ filter }` | `'ALL'` (default, preserves current
  behaviour and existing tests). Manifest gains `selection`, `itemCount`,
  `excludedCount`, `redactedSubstitutions` so the package self-describes what was and
  wasn't included. Relax the `type !== 'ACCESS'` block to also allow a handler-initiated
  export on any type, recorded as `EvidenceKind.EXPORT_PACKAGE`.
- `backend/src/lib/zip.js` — streaming write if not already; a package must not be
  buffered in memory.
- `backend/src/modules/dsar/dsar.routes.js` — `POST /:requestId/package` (build with
  selection) alongside the existing token/download flow.
- `backend/tests/integration/dsar-export-selection.test.js` **(new)** — manifest counts
  match selection; redacted variants substituted for shared photos; hash stable.

**Acceptance:** existing `dsar-erasure.test.js` and package tests unchanged and green.

---

### Phase 7 — Lifecycle, timeline & audit aggregation API

**Goal:** fix the stated core pain — "what requests exist, what state, what happened".

**Files**
- `backend/src/modules/dsar/lifecycle.js` **(new)** — the coarse-status map from §0,
  single source of truth, exported to both portals.
- `backend/src/modules/dsar/timeline.service.js` **(new)** —
  `getRequestTimeline(requestId, actor)` merging, time-ordered, one shape:
  `DsarRequest` transitions · `DsarEvidence` · `DsarItemAction` · `PurgeJob`/`PurgeJobLocation`
  · `AccessEvent` (searches/views on this subject during the request window) ·
  `AuditLog` hash-chain entries. Each entry: `at`, `actor`, `kind`, `summary`, `refId`,
  `hash?`. **`AuditLog` is hash-only — the timeline must render "what" from the typed
  tables and use `AuditLog` solely as tamper-evidence.**
- `backend/src/modules/dsar/dsar.service.js` — `listQueue()` gains
  `coarseStatus`, `assignedTo`, keyset pagination, and per-request counters
  (`itemsFound`, `itemsRedacted`, `itemsDeleted`, `itemsExported`). Impact-check first:
  `DsarQueue.jsx`, `RequestOversight.jsx`, `SlaMonitoring.jsx` consume it.
- `backend/src/modules/dsar/dsar.routes.js` — `GET /:requestId/timeline`,
  `POST /:requestId/close` (explicit close: validates every `DsarItemAction` is
  terminal, writes resolution note + evidence, transitions to `CLOSED`). Closing with
  in-flight actions must 409.
- `backend/tests/integration/dsar-timeline.test.js` **(new)**.

**Acceptance:** for a request that went import → search → bulk redact → export → close,
the timeline shows every step with actor and time, in order.

---

### Phase 8 — Admin UI: DSAR dashboard + request workspace

**Files**
- `admin-portal/src/lib/api.js` — add: `searchDsarSubjects`, `listDsarItems`,
  `requestDsarItemActions`, `listDsarItemActions`, `getDsarTimeline`, `buildDsarPackage`,
  `closeDsar`, import endpoints.
- `admin-portal/src/pages/dataAdmin/DsarQueue.jsx` — rewrite into the dashboard:
  Open / In Progress / Closed tabs with counts, SLA-breach column, assignee, item
  counters, search box, keyset paging. Rows link to the new detail route (not
  `/purge-export`).
- `admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx` **(new)** — the workspace:
  header (subject pseudonym, type, coarse + fine status, SLA), tabs
  **Data** (paged item grid, per-item checkbox, select-all-matching, per-item Redact /
  Delete / Export, bulk action bar with confirm dialog naming exact counts) ·
  **Timeline** · **Evidence** · **Close** (blocked while actions in flight).
- `admin-portal/src/pages/dataAdmin/ImportData.jsx` **(new)** — subject picker →
  drag-drop upload → batch progress.
- `admin-portal/src/components/ItemGrid.jsx`, `BulkActionBar.jsx`,
  `TimelineList.jsx`, `ConfirmDialog.jsx` **(new)**.
- `admin-portal/src/App.jsx` + `roles.js` + nav — routes `/dsar`, `/dsar/:requestId`,
  `/import`; role-gate to `dataAdmin`/`dpo`/`super_admin`.
- `admin-portal/src/components/ErrorBoundary.jsx` **(new)** — there is currently **no
  error boundary anywhere in the codebase**, which is why render crashes present as
  blank pages (cost a whole debugging session on `/requests/new`). Wrap the router.

**Deletion UX rule:** destructive confirms must state the exact count and that shared
photos will be redacted instead of deleted. No "Delete all" without a typed
confirmation.

**Delegate:** presentational components (`TimelineList`, `ConfirmDialog`, styling
passes) → Sonnet against existing `admin-portal/src/components` conventions. The item
grid + bulk-selection state machine → main.

---

### Phase 9 — Subject-facing status, hardening, scale

**Files**
- `user-portal/src/pages/RequestStatus.jsx` — coarse status + a redacted timeline
  (subject sees their own request's milestones, never internal actor identities).
- `user-portal/src/lib/api.js` — timeline endpoint for `/me/dsar/:id`.
- `backend/src/modules/me/me.routes.js` — subject-scoped timeline (own request only).
- Scale pass: `EXPLAIN ANALYZE` the item-search and queue queries via
  `mcp__supabase__execute_sql`; add missing indexes; confirm no N+1 in the item grid.
  Re-run `mcp__supabase__get_advisors` and clear anything the new tables introduced.
- `backend/tests/e2e/dsar-full-lifecycle.test.js` **(new)** — import → search →
  per-item redact → bulk delete → selective export → close → timeline assertion.
- `backend/tests/security/rbac-matrix.test.js` — final pass, all new endpoints.
- Docs: `docs/01_PRIVACY_DATAFLOW.md` (import as a new inbound edge; item index as a
  new L-code or an explicit note that it holds no media), `docs/DPIA.md` (import
  lawful-basis gap), `docs/02_ROLE_PERMISSION_MATRIX.md`, `docs/RUNBOOK_BREACH.md` if
  the item index changes the containment story.

---

## 2. Cross-cutting rules for every phase

- **GitNexus first.** Before editing any existing symbol:
  `gitnexus_impact({ target, direction: 'upstream' })`. Report HIGH/CRITICAL to the user
  before proceeding. Before committing: `gitnexus_detect_changes()`. Never
  find-and-replace a rename — use `gitnexus_rename`.
- **Supabase via MCP.** Schema inspection (`list_tables`, `list_migrations`),
  migrations (`apply_migration`), ad-hoc queries (`execute_sql`), health
  (`get_advisors`, `get_logs`). Do not hand-run SQL against prod outside MCP.
  Prisma remains the app's runtime data layer — MCP is the *development and operations*
  channel, not a second runtime client.
- **Fail-closed everywhere.** Access logging, RBAC, action guards. A failure must block,
  not degrade silently — this is the existing codebase's posture (`logAccess` already
  aborts on write failure) and new code must match it.
- **No new table without RLS + `prism_app` grants** in the same migration.
- **Never lose `MEDIA_KEK`.** Any code touching sealed blobs goes through
  `lib/blobCrypto.js` / `lib/keyring.js`.
- **API is on port 4000**, not 3000.

## 3. Handoff protocol (`docs/HANDOFF.md`)

Overwritten at the end of every phase. Written for a session with **zero** memory of
this one. Required sections:

1. **Phase completed** — number, name, date.
2. **What was implemented** — file-by-file, with new endpoints and their RBAC.
3. **What was explicitly NOT done** — including anything descoped mid-phase and why.
4. **Key decisions + rationale** — especially anything diverging from this PLAN.
5. **Current system state** — migrations applied (local + Supabase remote), tests
   passing count, services that must be running, known-broken things.
6. **Next phase** — the exact next phase from PLAN.md, plus anything discovered this
   phase that changes it.
7. **Traps** — non-obvious things that cost time (mount order, fail-closed logging,
   pool limits, blank-page-means-render-crash).

## 4. Token-minimisation strategy (secondary optimisation — quality wins ties)

| Technique | Used? | Where / why |
|---|---|---|
| **GitNexus MCP** (`query`/`context`/`impact`) | **Yes, primary** | 1 869 symbols, 5 420 relationships already indexed. Replaces grep-and-read for navigation and blast radius. Biggest single saving. Re-run `npx gitnexus analyze` after each phase's commit (a PostToolUse hook already does this). |
| **Claude Mem** (`$CMEM` observations) | **Yes** | Session-start timeline gives prior discoveries (~83% read savings measured). Use `get_observations([IDs])` for detail instead of re-reading files. Record one observation per phase with the decisions, not the diff. |
| **`HANDOFF.md`** | **Yes, authoritative** | The context carrier between sessions. A next session should read `HANDOFF.md` + `PLAN.md` and nothing else before starting. |
| **Subagents (Sonnet/Haiku)** | **Selectively** | Only mechanical work: migration SQL boilerplate, backfill scripts, test fixtures, presentational React components, docs table updates. Reviewed by the main model before commit. |
| **Repomix whole-project dump** | **No** | GitNexus + Claude Mem already cover navigation; a full dump would *increase* tokens here. |
| **Subagents for schema design, action guards, purge scoping, bulk-selection state** | **No — deliberately** | Irreversible-deletion and privacy-guard logic. Delegation risk exceeds token saving. Phase 5 is main-model only. |
| **Reading whole services to make a small edit** | **No** | Use `gitnexus_context({name})` then a targeted `Read` with `offset`/`limit`. |

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Scoped purge job mistaken for full erasure → false deletion certificate | `meta.scope='PARTIAL'`, explicit exclusion in `issueCertificate()`, test asserts no certificate for scoped jobs |
| Item index drifts from source tables → incomplete DSAR response | Index is derived + rebuildable; discovery rebuilds on every run; completeness test compares index count to source count |
| Bulk delete removes a photo containing other principals | Server-side `sharedSubjectCount` guard downgrades to redact; never a client-side check |
| Import fabricates a lawful basis | `IMPORT_UNVERIFIED` flag surfaced in discovery and DPIA |
| New tables invisible to `prism_app` → runtime 403s | RLS + grants in the same migration; smoke query via MCP after apply |
| Large subjects (10k+ photos) blow memory | Keyset pagination + streaming ZIP + queue-backed actions, enforced from Phase 4 onward |
