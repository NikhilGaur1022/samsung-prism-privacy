# PRISM — handoff

> **SUPERSEDED as the entry point.** The current handoff is
> `docs/HANDOFF_2026-08-17_phase3-dead-code.md` — production-readiness plan,
> Phases 0–2 complete, Phase 3 next. Start there. This file remains the
> authority on the completed nine-phase DSAR work described below.
>
> Earlier links in the same chain, each superseded by the next:
> `docs/HANDOFF_2026-08-16_production-readiness.md` (Phase 0 done, Phase 1 next),
> `docs/HANDOFF_2026-08-16_phase2-audio.md` (Phase 1 done, Phase 2 next).

**Written for a session with zero memory of the one that produced it.**
Read this and `PLAN.md`, and nothing else, before starting.

> **A Read-tool hook truncates `PLAN.md` and `docs/*.md` to line 1 and claims the
> file is already summarised. It is not.** Read them with
> `Get-Content FILE` (PowerShell) or `sed -n '1,240p' FILE` (Bash) instead.

---

## 1. Phases completed

**PLAN.md is finished.** Phases 3, 8 and 9 landed on 2026-08-01, in one session
at the user's instruction. That closes the last three of the nine, and with them
the five gaps PLAN §0 was written against (G1–G5).

Earlier handoffs, superseded but **not to be deleted**:

- `docs/HANDOFF_2026-08-01_phases5-7.md` — Phases 5, 6 and 7. Still the authority
  on the scoped-purge guards, the `version: 2` package manifest, and why the
  timeline groups by batch. Its §7 trap list is still current.
- `docs/HANDOFF_2026-08-01_phase4-item-search.md` — Phase 4. Still the authority
  on `itemSearch.service.js`, the `totals.all` contract and the index-staleness
  guard.
- `docs/HANDOFF_2026-07-31_phase2-item-indexer.md` — Phase 2. Its §4 (why
  `origin`/`meta` are create-only, why the tombstone sweep uses one app-side
  timestamp) is still the authority on indexer semantics, and it is what makes
  the import path below correct.
- `docs/HANDOFF_2026-07-28_waves0-6.md` — the pre-DSAR platform, the `prism_app`
  migration, media encryption, and a §3 manual-verification checklist that is
  **still outstanding**.

---

## 2. What was implemented

### Phase 3 — the import pipeline (the leg that was skipped three times)

Until this, a photograph could only enter through a collection session. A privacy
platform that can only answer for data it collected itself is not answering the
question §11 asks.

`backend/src/modules/import/` **(new)** — `import.service.js`,
`import.routes.js`, `import.validators.js`. Mounted at `/api/v1/imports`,
`dataAdmin`/`super_admin` only.

Three things make an import different from a capture, and all three are
**recorded rather than smoothed over**:

1. **No session.** `Photo.sessionId` is null. Every consumer that walks
   `photo.session` must treat it as optional — skipping a session-less photo is a
   DSAR completeness hole, not a display bug.
2. **No capture-time consent.** If the admin names a project *and* a live
   `ProjectConsent` exists, the item inherits it. Otherwise
   `PhotoSubject.consentId` stays null and the item carries
   `meta.lawfulBasis = 'IMPORT_UNVERIFIED'` plus `meta.consentGap` naming *why*
   (`NONE` / `REVOKED` / `PURGED`). Manufacturing a consent row to satisfy the FK
   would have been forging the record this system exists to keep honest.
3. **Identification is an assertion, not a match.** `meta.identification =
   'ADMIN_ASSERTED'`, because "how do you know this is them" is the first
   question an auditor asks.

Order inside `ingestItem()` is not negotiable: seal the blob → `Photo` +
`PhotoSubject` + `SubjectDataItem` **in one transaction** → refresh the
projection → enqueue redaction. The index row is written *here* rather than left
to the indexer, because `itemIndex.photoItem()` labels every photo link
`COLLECTION_SESSION` and `writeItem` sets `origin`/`meta` on create only.
Creating it here with `origin=IMPORT` is what makes the label survive every later
rebuild — **an imported photo that rebuilt as a collected one would erase the
lawful-basis gap from the record**, which is the single worst thing this leg can
do. There is a test for exactly that.

Blobs go to `subjects/<uid>/imports/<sha256>.jpg`. That path is load-bearing:
`storage.scopeForPath()` maps `subjects/` to the **per-subject DEK**, so an
imported photo is reachable by the same crypto-shred as a captured one. Filed
anywhere else it would survive the shred and a signed certificate would be
attesting to an erasure that did not reach it.

De-duplication is explicit (sha256 within the subject), because
`Photo@@unique([sessionId, sha256])` stops de-duplicating the moment `sessionId`
is null — Postgres treats NULLs as distinct.

Two supporting fixes in `session.service.js`, both needed by the shared redaction
path once photos can be session-less:

- `redactBystanders(sessionId, {photoIds})` now selects on `photoIds` **alone**
  when they are given. The old `where: { sessionId, id: {in} }` became
  `sessionId: null` for an import, which matches *every import in the database*.
- the derivative path is derived from `photo.sessionId`, not the argument, so an
  import writes to `subjects/<uid>/imports/redacted/` instead of
  `sessions/null/redacted/` — outside the key scope that could open it.

And one in `itemIndex.service.js`: the photo-link select now includes
`consent.projectId`, and `photoItem()` falls back to it. It is the only route
back to a project for an import (there is no session to read one off), and
without it a rebuild nulled the `projectId` an import wrote, dropping the item
out of every project-filtered view.

### Phase 8 — the admin UI

`admin-portal/src/lib/api.js` gained `searchDsarSubjects`, `listDsarItems`,
`requestDsarItemActions`, `listDsarItemActions`, `getDsarTimeline`,
`buildDsarPackage`, `closeDsar` and the five import calls.

New components: `ErrorBoundary`, `ItemGrid`, `BulkActionBar`, `TimelineList`,
`ConfirmDialog`. New pages: `DsarRequestDetail`, `ImportData`. `DsarQueue` was
rewritten into the dashboard.

Contractual, not cosmetic:

- **`totals.all` is rendered next to `totals.matching`, always.** `all` ignores
  every filter — it is the completeness claim. A filtered screen that showed only
  its own count would read as "this is everything we hold".
- **"Select all matching" sends the FILTER, not a harvested id list.** The grid
  only ever holds one page, so a client-built "all" would be "all of page one".
  The server re-resolves it against the request's own subject and caps it.
- **The destructive confirm states the exact count**, states that shared frames
  will be **redacted instead of deleted**, and requires the word `DELETE` typed.
  The server performs the downgrade either way; the point is that the operator is
  not surprised by it.
- **The timeline never invents content.** `audit_log` is hash-only, so an entry
  with no summary gets its kind and nothing else.
- **The `ErrorBoundary` wraps the router.** There was none anywhere in this
  codebase, which is why a render crash presented as a blank white page — it cost
  a whole session on `/requests/new`.

The Close button is gated on `status === 'REVIEW'`, matching the transition
table. The server 409s either way; a button that is live from `DISCOVERY` teaches
the operator that the button is unreliable rather than that the request is not
ready.

`RequestOversight.jsx` (dpo) now links into the same workspace — pseudonymous
throughout, so a DPO supervises a request end to end without learning whose it is.

### Phase 9 — subject timeline, scale, e2e, docs

**`getSubjectTimeline(requestId, subjectId)`** in `timeline.service.js`, behind
`GET /api/v1/me/dsar/:requestId/timeline`. It is built from an **allowlist of
milestone kinds**, not by redacting the operator timeline — a view built by
removing fields leaks the next field somebody forgets to remove. Four things are
deliberately absent: internal actor identities, `AccessEvent` rows, evidence
hashes and the audit chain, and per-item ids (counts only). Another principal's
request id is a **404, not a 403**: confirming that an id exists is itself
information about someone else.

`user-portal/src/pages/RequestStatus.jsx` renders the coarse status as the
primary badge and the milestone list, with a sentence stating plainly that
internal handling records exist and are available through the DPO — the omission
is a policy, and a principal who assumed this was the complete record would be
assuming something untrue.

**Migration `20260801000002_phase9_scale_indexes`** (applied):

```sql
CREATE INDEX IF NOT EXISTS "dsar_requests_sla_due_at_id_idx" ON "dsar_requests" ("sla_due_at","id");
CREATE INDEX IF NOT EXISTS "photos_sha256_idx"                ON "photos" ("sha256");
```

The first: `listQueue()` walks `ORDER BY (sla_due_at ASC, id ASC)` under a coarse
tab filter, which is `status IN (…)` and not a single value — so
`[status, sla_due_at]` cannot serve the sort and the planner read every matching
row. The second: the import de-dup probe was a sequential scan of the whole photo
table on every file of every batch.

**`tests/integration/dsar-full-lifecycle.test.js` (new, 9 tests)** — import →
search → per-item redact → bulk delete → selective export → close → operator
timeline → subject timeline. Under `integration/` rather than `e2e/` on purpose:
it drives services directly and needs no face worker, no Qdrant and no
image-pii-worker, so it runs in the ordinary suite.

**Docs.** `01_PRIVACY_DATAFLOW` §1 gained the import subgraph and §2 gained
**L12/L13** (imported original + derivative, subject-DEK scoped) with a note that
the item index is a projection and not a fourteenth copy. `DPIA` gained **R11**
(imported data may have no lawful basis at all under the consent-only posture —
recorded, not solved) and **R12** (imported frames are PII-masked but **not**
face-blurred, because detection is session-driven). `RUNBOOK_BREACH` gained §4.2a
on scoping an exposure from the item index, including that a divergence alert
makes any figure taken from it a **floor, not a total**.

### New endpoints

| Endpoint | Roles |
|---|---|
| `POST /api/v1/imports` | `dataAdmin`, `super_admin` |
| `GET /api/v1/imports` | `dataAdmin`, `super_admin` |
| `POST /api/v1/imports/:batchId/items` (≤20 files) | `dataAdmin`, `super_admin` |
| `POST /api/v1/imports/:batchId/close` | `dataAdmin`, `super_admin` |
| `GET /api/v1/imports/:batchId` | `dataAdmin`, `super_admin` |
| `GET /api/v1/me/dsar/:requestId/timeline` | `subject` (own only) |

All six are in **both** `docs/02_ROLE_PERMISSION_MATRIX.md` §B and
`backend/tests/security/rbac-matrix.test.js` — the bidirectional CI gate. §D
gained two rows (the import screen, the subject timeline).

---

## 3. What was explicitly NOT done

- **Imported photographs are not face-blurred.** DPIA R12. PII text masking runs
  through the ordinary `enqueueRedaction` path; face blurring needs
  `FaceDetection` rows, which the recognition worker produces and the recognition
  worker is driven by a session. `meta.faceDetection = 'NOT_RUN'` is written on
  every imported item so this is visible per-row rather than as a footnote.
  **Closing it is a recognition-worker change, not an import-service one** — it
  was left alone rather than half-built.
- **`lib/zip.js` is still not streaming.** Unchanged from the previous handoff and
  for the same reason: `storage.writeFile` seals a whole blob under one AES-GCM
  envelope, there is no partial-seal API, and inventing one would put an unsealed
  temp file on disk. `PACKAGE_MAX_BYTES` (512 MB) fails a too-large build with a
  413 instead. Revisit only alongside a chunked sealing API in `blobCrypto.js`.
- **No `EXPLAIN ANALYZE` was run.** PLAN asks for it. Supabase MCP is still
  `Unauthorized` and the dev database's largest subject has ~25 items, so a
  measurement here would have been theatre. The two indexes above were added from
  reading the query plans by hand against the `ORDER BY` clauses. **The p95 < 300 ms
  claim for a 5 000-item subject remains unmeasured.**
- **`mcp__supabase__get_advisors` has still never run** — same `Unauthorized`.
  Migrations were applied with `prisma migrate deploy` under `ADMIN_DATABASE_URL`.
  Fix `SUPABASE_ACCESS_TOKEN` before anyone needs the advisor pass.
- **No import UI test.** The service is covered by 9 integration tests; the React
  page is not, because this codebase has no frontend test harness at all.
- **The §3 five-check manual portal pass** in
  `docs/HANDOFF_2026-07-28_waves0-6.md` is *still* outstanding. It has survived
  four handoffs now.

---

## 4. Key decisions + rationale

1. **The import writes its own `SubjectDataItem` row inside the ingest
   transaction.** Not left to `indexPhotoSubject()`, because the indexer's
   `origin`/`meta` are create-only by design (Phase 2 handoff §4) and it labels
   every link `COLLECTION_SESSION`. This is the single line that keeps an
   unverified lawful basis from laundering itself into a consented one on the next
   rebuild.
2. **`projectId` is stamped on an imported item only when a live consent was
   actually inherited.** A batch opened against a project whose consent is revoked
   has no project-scoped basis, and stamping the id anyway would show the item in
   that project's view as though it belonged there. It also keeps the value
   rebuild-stable, since `itemIndex` re-derives it from the link's consent and
   gets null in exactly the same cases.
3. **Imported blobs live under `subjects/<uid>/`.** Anywhere else and they survive
   `destroySubjectKey()`, and the certificate becomes a false statement.
4. **No consent is ever manufactured.** `PhotoSubject.consentId` is nullable
   precisely so the honest answer is representable. The gap is recorded with its
   reason and surfaced in three places (discovery, the item grid, the import UI).
5. **Import into an `ERASED` subject is a 409.** It would re-create data a signed
   certificate says was destroyed. Re-collection after erasure is a new consent
   event, not an import.
6. **The subject timeline is an allowlist, not a redaction.** A new internal event
   type cannot leak into the principal's view by default — it has to be added to
   `SUBJECT_MILESTONES` deliberately.
7. **Another principal's request is a 404 on the subject timeline.** A 403 would
   confirm the id exists.
8. **The scale pass added two indexes and measured nothing.** Stated as a gap
   above rather than dressed up: the indexes match the `ORDER BY` clauses exactly,
   which is a correctness argument, not a performance measurement.
9. **The lifecycle map is not duplicated in React.** `admin-portal/src/lib/
   lifecycle.js` holds **labels and tones only** — every request the API returns
   already carries a `coarseStatus` computed by
   `backend/src/modules/dsar/lifecycle.js`. A second copy of the mapping is how
   the dashboard and the API start disagreeing about whether a request is
   finished.

---

## 5. Current system state

**Tests: 117/117 pass** (`cd backend && npm test`) — 99 prior + 9 import + 9
full-lifecycle. Runtime ~14 min with everything up.

**Both portals build clean** (`npm run build` in `admin-portal` and
`user-portal`).

**The e2e suites need four services.** With them down, ~33 tests fail on their
`preconditions` assertion and nothing else — environmental, not a regression:

```bash
docker start prism-qdrant prism-redis prism-face-worker prism-image-pii-worker
# health: :8001/health, :8002/health, :6333/collections, redis :6379
```

**Migrations — 18 local, 18 applied.** Local `_prisma_migrations` and the remote
are the same database; there is no separate local Postgres.

**Services for full function:** API `:4000` (**not 3000**), Redis, Qdrant, face
worker `:8001`, image-pii worker `:8002`, and the four workers —
`npm run worker:redaction` / `worker:purge` / `worker:item-action` /
`worker:retention`.

**Known-broken / outstanding:**
- Supabase MCP `Unauthorized`.
- `face-worker/__pycache__/main.cpython-313.pyc` is tracked and wants
  gitignoring.
- The five-check manual portal pass in `docs/HANDOFF_2026-07-28_waves0-6.md` §3.
- DPIA R11 and R12 are open by design — read them before any production import.

---

## 6. Next

PLAN.md is done. In rough order of what actually matters:

1. **Resolve DPIA R11 before any real import run.** Under the consent-only
   posture there is no §7 fallback, so `IMPORT_UNVERIFIED` items are data this
   platform holds and cannot justify holding. Either capture consent through the
   ordinary flow, or amend DPIA §2 to claim a specific ground and re-sign it.
2. **Face detection on the import path** (DPIA R12). A recognition-worker change.
3. **Fix `SUPABASE_ACCESS_TOKEN`**, then run `get_advisors` and the
   `EXPLAIN ANALYZE` pass PLAN Phase 9 asked for and this session could not do.
4. **The manual portal verification pass** from the waves 0–6 handoff.
5. A frontend test harness. There is none, and Phase 8 shipped ~1 400 lines of
   React that only a human has looked at.

---

## 7. Traps

Everything in `docs/HANDOFF_2026-08-01_phases5-7.md` §7 still applies. New this
session:

1. **`redactBystanders(sessionId, {photoIds})` must select on the ids alone.**
   With a session-less photo, `where: { sessionId, id: {in} }` becomes
   `sessionId: null`, which matches every import in the database.
2. **`Photo@@unique([sessionId, sha256])` does nothing once `sessionId` is null.**
   Postgres treats NULLs as distinct. Import de-duplication is an explicit query
   in `ingestItem`, and it needs `photos_sha256_idx` to not be a table scan.
3. **`itemIndex.photoItem()` reads `link.consent.projectId` now.** If you change
   `PHOTO_LINK_SELECT`, keep `consent: { select: { projectId: true } }` — without
   it every imported item silently loses its project on the next rebuild.
4. **The transition table admits `CLOSED` only from `REVIEW`.** A test or a UI
   that closes straight out of `DISCOVERY` gets a 409, and it is correct.
5. **An imported photo has no session, so nothing cascades it.** A test that
   creates one must delete `prisma.photo` explicitly in teardown — the subject
   cascade takes the link and the index row but not the photo.
6. **`sharp` is required to ingest.** `ingestItem` normalises to JPEG, so a test
   fixture has to be a real image; `Buffer.from('not an image')` fails at the mime
   gate (415) before it ever reaches sharp, which is the intended order.
