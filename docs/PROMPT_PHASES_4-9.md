# Session prompt — PLAN.md Phases 4–9

Paste the block below into a fresh session. It is written for a session with zero
memory of this one. One phase per session; rewrite `docs/HANDOFF.md` between them.

---

You are continuing the PRISM DSAR buildout. Read `PLAN.md` §1 (phases), §2
(cross-cutting rules) and `docs/HANDOFF.md` before writing any code. **A Read-tool
hook truncates `PLAN.md` and `docs/*.md` to line 1 and claims the file is already
summarised — it is not. Read them with `sed -n '1,240p' FILE` via Bash instead.**

## Where the work stands (2026-07-31)

- **Phase 1 done** — `SubjectDataItem`, `DsarItemAction`, `ImportBatch` + RLS and
  `prism_app` grants. 16 migrations local.
- **Phase 2 done** — `backend/src/modules/dsar/itemIndex.service.js`, backfill script,
  `backend/tests/unit/itemIndex.test.js`. `subject_data_items` is a maintained
  projection; **nothing reads it yet**. Backfill verified on dev: 3 subjects, 50 items,
  25 live, idempotent.
- **Phase 3 NOT done — schema only.** Migration `20260731000003_import_pipeline` landed
  and resolved both blockers: `photos.session_id` and `photo_subjects.consent_id` are
  now **nullable**. `backend/src/modules/import/` does not exist; nothing in `src/`
  references `ImportBatch`. Phases 4–9 do not depend on Phase 3 code — build them
  against session-origin data and treat `origin='IMPORT'` as a case the code must
  handle, not a case you can seed yet.
- Everything is committed as `8f7b153 "bug fixes"` (it also swept in an earlier
  session's frontend work and a hardening pass on the image redaction pipeline).
  Working tree clean.
- **Tests: 60/60 green** — `cd backend && npm test`, ~270 s.

## Build phases 4 → 9 in order, one per session

Full file lists, acceptance criteria and rationale are in `PLAN.md` — do not
re-derive them. Summary of what each phase is and the trap it carries:

1. **Phase 4 — item search/discovery API.** `itemSearch.service.js`,
   `GET /api/v1/dsar/subjects/search`, `GET /api/v1/dsar/:requestId/items`.
   *Traps:* `totals.all` must be a `count()` over the index, never `items.length` —
   that number is the completeness claim. Identity search is exact + prefix only, **no
   fuzzy matching** (a wrong match is a breach). `AccessAction` in
   `prisma/schema.prisma:869` has no `SEARCH` member — adding it is a migration.
   `logAccess` is fail-closed, so an unresolvable object type aborts the request.
2. **Phase 5 — per-item + bulk actions.** `itemAction.service.js`,
   `itemActionQueue.js`, `itemAction.worker.js`.
   *Traps:* `sharedSubjectCount` includes the subject themself, so the shared-photo
   guard is `> 1` → downgrade DELETE to REDACT, recorded as a `SKIPPED`+`REDACT` pair,
   never a silent no-op. Bulk-by-filter resolves server-side; never trust a
   client-sent id list for "select all". Run
   `gitnexus_impact({target:"createPurgeJob", direction:"upstream", repo:"samsung project"})`
   before extending it — certificate issuance reads `locationsTotal`/`keyDestroyedAt`
   off that job, and a scoped job (`meta.scope='PARTIAL'`) must be excluded from
   `issueCertificate()`. **Do not delegate this phase to a subagent.**
3. **Phase 6 — selective export packaging.** `export.service.js` gains
   `selection = {itemIds} | {filter} | 'ALL'`; `'ALL'` must preserve current behaviour
   so existing package tests stay green. Streaming ZIP — never buffer a package.
4. **Phase 7 — lifecycle, timeline, queue aggregation.** `lifecycle.js`,
   `timeline.service.js`, `GET /:requestId/timeline`, `POST /:requestId/close`.
   *Trap:* **`AuditLog` stores a payload hash only — no plaintext.** Render "what
   happened" from the typed tables (`DsarEvidence`, `DsarItemAction`, `PurgeJob*`,
   `AccessEvent`) and use `AuditLog` purely as tamper-evidence. Closing with a
   non-terminal `DsarItemAction` must 409. `listQueue()` changes are consumed by
   `DsarQueue.jsx`, `RequestOversight.jsx`, `SlaMonitoring.jsx` — impact-check first.
5. **Phase 8 — admin UI: DSAR dashboard + request workspace.** New
   `DsarRequestDetail.jsx`, `ImportData.jsx`, `ItemGrid`, `BulkActionBar`,
   `TimelineList`, `ConfirmDialog`, plus `ErrorBoundary.jsx` — **there is no error
   boundary anywhere in this codebase**, which is why render crashes show as blank
   pages. Destructive confirms must state exact counts and say that shared photos are
   redacted, not deleted; no "delete all" without a typed confirmation. Presentational
   components may go to Sonnet; the item-grid + bulk-selection state machine stays on
   the main model.
6. **Phase 9 — subject-facing status, hardening, scale.** Subject sees milestones,
   never internal actor identities. `EXPLAIN ANALYZE` the item-search and queue
   queries, add missing indexes, re-run advisors, e2e
   `dsar-full-lifecycle.test.js`, docs pass (`01_PRIVACY_DATAFLOW`, `DPIA`,
   `02_ROLE_PERMISSION_MATRIX`, `RUNBOOK_BREACH`).

## Rules that hold for every one of these phases

- **RBAC matrix is the CI gate.** Every new endpoint goes into **both**
  `docs/02_ROLE_PERMISSION_MATRIX.md` and `backend/tests/security/rbac-matrix.test.js`.
  That test enforces bidirectionally — an endpoint missing from the matrix fails the
  build.
- **Fail closed.** RBAC, access logging, action guards. A failure blocks; it never
  degrades silently. This matches the existing posture (`logAccess` aborts on write
  failure; the image-PII worker returns 503 rather than "no PII found").
- **Phase 2's one deliberate exception:** index refresh is non-fatal in
  `runDiscovery()` and `finalizeSession()` — safe only while nothing reads the index.
  **Phase 4 is the moment that stops being true.** When DSAR completeness is served
  from `subject_data_items`, "index refresh failed" must become visible: a monitored
  log line at minimum, not a silent catch.
- **Index rows carry `origin` and `meta` written on create and never updated** —
  `indexSubject()` labels anything it finds via `photo_subjects` as
  `COLLECTION_SESSION`, so an IMPORT row must be created by the import path itself.
  Never let a rebuild launder `meta.lawfulBasis='IMPORT_UNVERIFIED'` into consented.
- **Nothing is hard-deleted from the index** — `deletedAt` tombstones. A missing row
  proves nothing; the timeline has to prove an item existed and was destroyed.
- **No new table without RLS + `prism_app` grants in the same migration.**
- **Never lose `MEDIA_KEK`.** Anything touching sealed blobs goes through
  `lib/blobCrypto.js` / `lib/keyring.js`.
- **GitNexus first:** `gitnexus_impact({target, direction:'upstream', repo:'samsung project'})`
  before editing an existing symbol; `gitnexus_detect_changes()` before committing;
  `gitnexus_rename` never find-and-replace. Two repos are indexed, so `repo` is required.
- **API is on port 4000**, not 3000.

## Running the suite

```
cd backend && docker compose up -d   # qdrant 6333, redis 6379, face-worker 8001, image-pii-worker 8002
curl -sf http://localhost:8001/health # face-worker takes ~4 min cold (pulls buffalo_l)
npm test
```

`tests/unit/*.test.js` needs only the database — run it alone with
`node --test tests/unit/itemIndex.test.js` when the workers are down. The three e2e
files fail their `preconditions` subtest without the workers and cascade into ~33
confusing `Cannot read properties of undefined` failures.

`image-pii-worker` **is** in `backend/docker-compose.yml` (older handoffs say it is
separately managed — that is stale). Its python tests:
`docker compose exec image-pii-worker python -m unittest discover -s tests`.

## Known-broken, still outstanding

- **Supabase MCP returns `Unauthorized`.** Phase 1's `get_advisors` pass never ran and
  Phase 9's scale/advisor pass needs the token fixed. Fix it before Phase 9.
- The five-check manual portal pass in `docs/HANDOFF_2026-07-28_waves0-6.md` §3 is
  still not done. **Do not delete that file.**
- `face-worker/__pycache__/main.cpython-313.pyc` got committed in `8f7b153`; it wants
  gitignoring.
- Phase 3 (import pipeline code) is skipped. Phase 4's PLAN acceptance test mentions an
  imported photo — seed it as a `PhotoSubject` with a null `consentId` and a null
  `sessionId` directly (both columns are nullable now), or drop that leg of the
  assertion and note it in the handoff.

## Finish every phase with

1. `cd backend && npm test` green.
2. `gitnexus_detect_changes({repo:"samsung project"})` — changes match expected scope.
3. `docs/HANDOFF.md` rewritten per `PLAN.md` §3 (phase number + name + date, what was
   implemented, what was explicitly NOT done, key decisions + rationale, current system
   state, next phase, traps). Archive the previous one as
   `docs/HANDOFF_<date>_<phase>.md` rather than overwriting it.
