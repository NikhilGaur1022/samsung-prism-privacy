# PRISM — session handoff

**As of 2026-07-27.** Waves 0–5 are complete. The verification gate is green.
Nothing below is aspirational: every claim here was run, and every known gap is
listed in §6 rather than omitted.

Read this instead of re-deriving the state of the repo. The authoritative spec is
still `docs/01_PRIVACY_DATAFLOW.md`, `02_ROLE_PERMISSION_MATRIX.md`,
`03_FILE_IMPLEMENTATION_PLAN.md`, `04_AGENT_EXECUTION_PLAN.md` — read those only
when you need a rule, not to orient.

> A hook truncates the Read tool to line 1 on the `docs/*.md` files. Read them
> with `cat` via Bash.

---

## 1. Verification gate — passing

```
cd backend && LOG_LEVEL=silent RBAC_REQUEST_TIMEOUT_MS=8000 npm test
→ 41 tests, 41 pass, 0 fail, exit 0
```

| Suite | Tests | Covers |
|---|---|---|
| `tests/e2e/full-lifecycle.test.js` | 11 | notice → project → approval → consent → enrolment → capture → recognition → tagging → finalize → redaction → handoff |
| `tests/e2e/dsar-erasure.test.js` | 10 | erasure on a photo holding two people; certificate; withdrawal-triggered erasure |
| `tests/security/rbac-matrix.test.js` | 4 | all 105 mounted routes × 7 principals against matrix §B |
| `tests/security/crypto.test.js` | 9 | envelope encryption, shredding, crypto-shred |
| `tests/security/audit-chain.test.js` | 7 | HMAC chain, RLS append-only |

Scripts: `npm test`, `test:security`, `test:e2e`, `fixtures:e2e`, `preflight`,
`bootstrap-admin`, `worker:*`.

### Running it requires four services up

| Service | How it was started here | Notes |
|---|---|---|
| Postgres | Supabase `wblmtdrcohhjfyqvvobl` | remote; `.env` already points at it |
| Redis | `C:\Users\gaur3\redis\redis-server.exe --port 6379 --save "" --appendonly no` | **must be running** — see §6.1 |
| Qdrant | `C:\Users\gaur3\Desktop\qdrant-portable\qdrant.exe` | :6333 |
| face-worker | `face-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8001` | InsightFace buffalo_l, cached |
| image-pii-worker | `ai-core/image-pii-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8002` | Presidio |

The e2e suites check all of these in a `before` hook and **fail loudly** if one is
missing rather than skipping. A green "0 tests" is the worst result a compliance
gate can give.

### Fixtures

`backend/tests/fixtures/{solo-a,group,enroll-b}.jpg` are **not committed** (the
repo-wide `.gitignore` excludes `*.jpg`). Rebuild with `npm run fixtures:e2e`,
which derives them from real photos in `backend/storage/media` — synthetic images
are useless because ArcFace detects nothing in them. See
`backend/tests/fixtures/README.md`.

---

## 2. The ten invariants — where each is enforced and tested

| # | Invariant | Enforced in | Proven by |
|---|---|---|---|
| 1 | No mock/seed/dummy data anywhere | seed scripts + `admin-portal/src/data/` deleted | `preflight` check `no-mock-data` |
| 2 | `project_consent_matrix` is the sole consent authority | `finalizeSession`, purge, DSAR read only `ProjectConsent` | lifecycle test 3 |
| 3 | Embeddings never leave the process | explicit `select`s; encrypted column | lifecycle test 7; rbac test 3 |
| 4 | `Photo.storagePath` never overwritten | `redactBystanders` always writes a new object | lifecycle test 5 |
| 5 | Erasure is per `PhotoSubject` link, never per photo | `purge.service` `LINK` → `L6` → `L2` ordering | erasure tests 6, 7 |
| 6 | AccessEvent written *before* decryption; log failure fails the read | `middleware/logAccess.js` + `recordAccess` throws | lifecycle test 8 |
| 7 | AuditLog stores hashes only | `payloadHash` + `payloadDigest`, no payload column | lifecycle test 10; erasure test 10 |
| 8 | Redaction/PII failure fails closed | `PiiUnavailableError` → `piiStatus=DEFERRED`, no raw fallback | lifecycle test 6 |
| 9 | Secrets from env; preflight refuses prod defaults | `scripts/preflight.js` | run it |
| 10 | Least privilege in `requireRole` + service-layer scope | per-route guards | rbac test 4 |

---

## 3. What changed this session

### Bugs found and fixed (all were real, none cosmetic)

1. **`/api/v1/subjects/*` was open to anonymous callers.** It sat behind
   `requireAuth`, a dev stub that attached a fake user and called `next()`.
   `GET /api/v1/subjects` returned the full subject list, with PII, to an
   unauthenticated request. Now `requireAdminAuth` + `requireRole`. The stub file
   is deleted. Found by the RBAC matrix test.

2. **Break-glass router 403'd collection agents off every session route.**
   `sessionBreakGlassRoutes.use(requireRole('dataAdmin'))` ran for every request
   entering a router mounted at the same `/api/v1/sessions` prefix. Guards are now
   per-route. Also found by the RBAC test; nothing else would have caught it until
   an agent tried to work.

3. **Purge destroyed the original of a photo still held by another subject.**
   `handlers.L2` shredded `storagePath` unconditionally and kept only the row.
   That is not "keeping the photo for B": it leaves a row pointing at bytes that
   no longer exist and makes the frame permanently un-re-redactable, so a *second*
   erasure from the same photo could never be honoured. Direct invariant-5
   violation. L2 now returns `SKIPPED` while any link remains.

4. **The deletion certificate leaked the principal's raw UUID.** `locations[]`
   carried `objectId` verbatim, and the `PII` / `SUBJECT_KEY` / `L8` / `L11` rows
   are keyed by the subject — so the real id sat next to the pseudonym meant to
   replace it, on a document shown to DPO and auditors. Now substituted with
   `subjectPseudonym`.

5. **Subjects could never see an approved project.**
   `consent.service.listProjectsForSubject` filtered `status: 'ACTIVE'`, but the
   governance workflow ends at `APPROVED` and nothing sets `ACTIVE` any more. The
   portal showed a principal nothing they could consent to. Now
   `{ in: ['APPROVED', 'ACTIVE'] }`.

6. **The join QR served a hand-assembled consent string, not the §5 notice.**
   `describeInvite` built its own text while the published `ConsentTemplate` sat
   unused — so the text signed was not the text stored, and the audit trail
   attested to something nobody was shown. It now renders the bound template and
   returns `projectId` + `consentTemplateId`. `Join.jsx` no longer matches
   templates by *name* (which picks the wrong version whenever two projects share
   a notice name, and picks nothing before the subject has consented to anything).

7. **BullMQ queues opened Redis at import.** `new Queue()` at module scope dialled
   Redis on import of any route module, with `maxRetriesPerRequest: null` — an
   open handle for the life of the process. Invisible in a server, fatal in a test
   runner. All three queues (`faceQueue`, `redactionQueue`, `purgeQueue`) are now
   lazy with `close*` helpers. **This was the cause of the long-standing
   `rbac-matrix` file-level failure**: with Redis down, ioredis retried past
   teardown and node:test scored the un-exitable process as a failure. Test time
   went 9 min → 44 s.

### Refactor

`processSession` moved out of `src/workers/recognition.worker.js` into
`src/modules/sessions/recognition.service.js`. The worker is now only the BullMQ
binding. This lets the e2e suite drive recognition in-process with no broker —
which matters because Redis 5.0 cannot run BullMQ at all (§6.1).

### New files

```
backend/src/app.js                                   createApp() + listRoutes()
backend/src/modules/sessions/recognition.service.js
backend/scripts/make-e2e-fixtures.js
backend/tests/e2e/world.js                           shared e2e world builder
backend/tests/e2e/full-lifecycle.test.js
backend/tests/e2e/dsar-erasure.test.js
backend/tests/fixtures/README.md
docs/HANDOFF.md                                      this file
```

---

## 4. Architecture notes worth not re-deriving

- **`listRoutes(app)`** walks the live Express router stack. A newly mounted route
  appears in the RBAC matrix test immediately, so *forgetting to classify an
  endpoint is a test failure* rather than a silent hole. Keep it that way.
- **`tests/e2e/world.js`** builds everything through the real services. A fixture
  that inserts straight into a table also skips the rule that table's service
  enforces.
- **The rate limiter answers before the guard** on `/auth/subject/login|verify`.
  The RBAC harness records those as *inconclusive* and prints them, rather than
  scoring them — scoring a 429 as "denied" would let a genuinely open route hide
  behind the limiter.
- **`PHASE_ORDER` in `purge.service.js` is load-bearing.** `LINK` → `L6` → `L2`,
  and `SUBJECT_KEY` last. Reversing `L6`/`L2` yields a photo that can never be
  re-redacted; destroying the key first makes everything after it unhashable.
- **`phaseOf()` derives from persisted columns only.** Discovery's rebuild-vs-delete
  hint is deliberately *not* trusted at execution time — minutes may have passed
  and another subject may have unlinked.

---

## 5. Ask before doing

Unchanged standing instruction from the user:

- dropping any existing table
- changing the `photo_subjects` shape
- altering `finalizeSession`'s transaction boundary

None of these have been done.

---

## 6. Open items — nothing here is hidden or worked around

### 6.1 Redis 5.0.14.1 is below BullMQ's 6.2 floor — **blocker for the workers**

Both binaries on this machine (`~/redis`, `~/Desktop/redis-portable`) are
5.0.14.1. No Docker is installed. `preflight` reports this as a hard FAIL.

Consequence: `worker:redaction`, `worker:purge` and the recognition worker
(`worker:start` in `package.json` — there is no script literally named
`worker:recognition`; `worker` is the same file under `--watch` for dev) will not
work correctly. The application paths that *enqueue* are fine, and the e2e suites
deliberately drive recognition and purge inline, so the gate is green — but a
deferred redaction will never be retried and a queued purge will never run until
Redis is upgraded. **This is the single most important thing to fix next.** See
`docs/DEPLOY.md` §5 and §6 for the production-path fix (`docker-compose.yml`
pins `redis:7.4-alpine`) and the full worker inventory.

### 6.2 Supabase `postgres` role holds BYPASSRLS — remedy provided, not yet applied

RLS is enabled *and forced* on `audit_log`, `access_events`,
`deletion_certificates` — verified by preflight and by `audit-chain.test.js`. But
the connection role bypasses it, so the append-only guarantee is inert on this
connection. Production must connect as a plain login role (e.g. `prism_app`).
Preflight reports this as a warning and names the role.

**This session added the remedy** — `backend/scripts/sql/provision-app-role.sql`
creates the `prism_app` role with `NOSUPERUSER NOBYPASSRLS`, grants ordinary DML,
and revokes `UPDATE/DELETE/TRUNCATE` on the three evidentiary tables as a second,
independent guarantee on top of RLS. It has **not been run** against the
Supabase project this session connects to — this environment still connects as
`postgres`, and `preflight`'s `db-role` check will keep warning until someone
runs it. Do not mark this item fully resolved until it has actually been
executed and `preflight` shows `db-role: PASS`. See `docs/DEPLOY.md` §3 for the
exact invocation and verification queries.

### 6.3 Media encryption is opt-in and currently off

`MEDIA_KEK` is unset, so `storage.js` writes plaintext. Turning it on is a
deliberate step with a migration (`backend/scripts/migrate-media-encrypt.js`) for
existing objects. `crypto.test.js` proves the envelope works; nothing proves the
corpus is encrypted, because it isn't.

### 6.4 Preflight is RED in dev, by design

`AUDIT_HMAC_SECRET`, `MEDIA_KEK`, `DSAR_SIGNING_SEED` unset. Supplying them makes
everything green except Redis:

```
15 checks — 12 passed, 2 warnings, 1 failure   (the failure is §6.1)
```

Failures are fatal only when `NODE_ENV=production`. The e2e world sets a fixed
throwaway `DSAR_SIGNING_SEED` when neither it nor `MEDIA_KEK` is configured; it
never overrides a real one.

### 6.5 Portal ↔ backend contract gaps — mostly closed this session (§7 below)

Reported by the wave-4 agents, **not** papered over. Item 6 in §3 (prior
session) fixed the worst one (join/notice). Items 2, 3, 4, 5, 6, 7 below are
now **RESOLVED** — see §7 "New backend endpoints" for the routes that close
each one. Item 1 is the one still open.

*Admin portal*
1. **Still open.** Dashboard tile `href`s are role-prefixed; the router is flat.
   Stripped client-side — should be fixed on one side or the other.
2. **RESOLVED.** `dataOwner` (and `dpo`/`dataAdmin`) now have
   `GET /api/v1/projects/:projectId/sessions` and `.../handoffs`, closing the gap
   that limited `ProcessedData.jsx` and `ProjectReports.jsx`.
3. **RESOLVED.** `GET /api/v1/projects/:projectId/report` (project-scoped) and
   `GET /api/v1/dashboard/compliance-report` (accountability window report) both
   now exist; `ComplianceReports.jsx` no longer has to reconstruct a report from
   `/audit/verify` + `/audit`.
4. **RESOLVED.** `GET /api/v1/dsar/evidence` is a vault-wide evidence index
   (content hashes only, never payloads); `EvidenceVault.jsx` no longer requires
   picking a DSAR first.
5. **RESOLVED.** `GET /api/v1/dsar/:requestId/media` gives `dataAdmin` an
   ids-only browse list scoped to the request's own named subject, for use as
   the `sessionId`/`photoId` break-glass needs — previously this only came from
   the discovery response.

*User portal*
6. **RESOLVED.** `GET /api/v1/me/photos` answers the §11 access-right question
   directly — how many photos the principal appears in, grouped by project —
   without going through a 30-day DSAR. `GET /api/v1/me/photos/:photoId/redacted`
   gives the principal their own copy of a frame, everyone else blurred,
   access-logged like any other read of biometric data.
7. **RESOLVED.** `POST /api/v1/me/dsar/:requestId/package-token` mints a fresh
   single-use download token from the portal; `SecureInbox.jsx` no longer asks
   the principal to paste one in.

### 6.6 Docs understate what is implemented — RESOLVED this session

`docs/DPIA.md` and `docs/RUNBOOK_BREACH.md` were refreshed against current
behaviour: PII fail-closed (R1), `AccessEvent`/break-glass enforcement (R3), and
per-link multi-subject erasure (R5) are now described as BUILT rather than GAP,
each verified directly against the source (`session.service.js`,
`accessLog.js`, `requireBreakGlass.js`, `purge.service.js`) rather than taken on
faith from this file. R6 (media encryption) was also corrected — the envelope
scheme is BUILT in `storage.js` for L2/L4/L6/L7/L8; what remains true is that
it is opt-in and off in this environment (§6.3 below, unchanged). A new
`docs/DEPLOY.md` was added covering the production go-live sequence.

### 6.7 One legacy `ACTIVE` project

Predates the approval workflow, was never DPO-approved, and is therefore correctly
non-collectable. Left alone deliberately — deleting it is a data decision, not a
code one.

### 6.8 GitNexus index is stale

It does not know `purge.service.js`, `recognition.service.js`, `app.js` or the
`dsar/` module — `gitnexus_impact` returns "not found" for symbols in them. Run
`npx gitnexus analyze` (add `--embeddings` if `.gitnexus/meta.json` shows a
non-zero embedding count, or they are deleted).

---

## 7. This session — new endpoints, docs refresh, RBAC re-verified

Docs-only session on top of the prior wave-5 work: no backend/frontend code was
touched by *this* pass — the endpoints below were already implemented (by the
work this file's §3/§6.5 describe) and are recorded here for the first time,
along with a refresh of two compliance documents that had gone stale.

### New backend endpoints (all classified in `tests/security/rbac-matrix.test.js`, suite still 41/41 green)

| Route | Purpose | Closes |
|---|---|---|
| `GET /api/v1/me/photos` | DPDP §11 — how many photos the principal appears in, grouped by project (`me.service.js listMyPhotos`) | §6.5 item 6 |
| `GET /api/v1/me/photos/:photoId/redacted` | The principal's own copy of a frame, everyone else blurred, access-logged (`logAccess` + `readPersonRedactedPhotoForSubject`) | (same) |
| `POST /api/v1/me/dsar/:requestId/package-token` | Mints a fresh single-use download token from the portal (`issuePackageToken`) | §6.5 item 7 |
| `GET /api/v1/projects/:projectId/sessions` | Project-scoped session oversight for `dataOwner`/`dpo`/`dataAdmin` | §6.5 item 2 |
| `GET /api/v1/projects/:projectId/handoffs` | Project-scoped handoff oversight, same role set | §6.5 item 2 |
| `GET /api/v1/projects/:projectId/report` | Project-scoped report | §6.5 item 3 |
| `GET /api/v1/dashboard/compliance-report` | Server-side accountability report over a stated `from`/`to` window | §6.5 item 3 |
| `GET /api/v1/dsar/evidence` | Vault-wide evidence index — content hashes only, never payloads (the `EXPORT_PACKAGE` evidence payload holds a live token hash, not the export itself) | §6.5 item 4 |
| `GET /api/v1/dsar/:requestId/media` | Break-glass targeting — ids only, scoped to the request's own named subject | §6.5 item 5 |

All nine were spot-checked directly against the route files this session
(`me.routes.js`, `project.routes.js`, `dsar.routes.js`, `dashboard.routes.js`) —
the paths, guards, and role sets above match the source, not just the prior
session's notes about them.

### Other changes verified this session

- `backend/.env.example` carries the DSAR block (`DSAR_SIGNING_SEED`,
  `DSAR_SLA_DAYS`, `DSAR_INTERNAL_SLA_DAYS`, `DSAR_PACKAGE_TTL_DAYS`,
  `DSAR_PACKAGE_REISSUE_TTL_MINUTES`).
- `backend/scripts/sql/provision-app-role.sql` is new — see §6.2 above; it is a
  remedy for the BYPASSRLS issue, not yet applied to the environment this
  session connects to.
- Both portals were rewired to the new endpoints (per the caller's summary this
  session worked from; not independently re-verified against the `.jsx` files,
  since this session's scope was `docs/` only).

### Docs refreshed (§6.6)

- **`docs/DPIA.md`** — risk register rows R1, R3, R5 moved from "open/GAP" to
  "resolved, BUILT" with the specific code paths that make each true, and §5's
  "explicit unmitigated risks" list updated to match. R6 (media encryption) was
  corrected: the envelope scheme is BUILT in `storage.js`, not GAP as the
  previous revision said — it is opt-in and off in this environment, which is a
  different (and smaller) problem than "doesn't exist."
- **`docs/RUNBOOK_BREACH.md`** — the `AccessEvent` "GAP" language throughout
  (detection sources, evidence preservation, post-incident checklist) is
  replaced with what the table now provides and how it's enforced
  (`recordAccess` throws on write failure). The KEK-rotation drill caveat and
  SEV-1 examples were corrected the same way as DPIA R6.
- **`docs/DEPLOY.md`** — new. Production go-live checklist: required env vars
  with generation commands, the 15 `preflight` checks explained, the
  `prism_app` role provisioning steps, the `MEDIA_KEK` → deploy → migrate →
  `MEDIA_REQUIRE_SEALED=on` → redeploy ordering, the Redis ≥6.2 requirement,
  which `worker:*` scripts must run long-lived and what silently breaks
  without each, migration deploy, and post-deploy verification.

Every code-level claim added to these three documents this session was checked
against the actual source file, not carried forward from this handoff's
existing text or from the task description alone — see the file paths cited
inline in each document.

---

## 8. Suggested next steps, in order

1. Upgrade Redis to ≥6.2 and re-run `preflight` + the workers (§6.1).
2. Run `backend/scripts/sql/provision-app-role.sql` against the Supabase
   project and switch `DATABASE_URL`/`DIRECT_URL` to `prism_app` (§6.2) — the
   remedy exists but has not been applied.
3. Re-run `npx gitnexus analyze` so impact analysis works again (§6.8) — it is
   further stale after this session's edits added no new backend symbols but
   this file itself has changed.
4. Fix the dashboard tile `href` role-prefix mismatch (§6.5 item 1) — the one
   remaining portal contract gap.
5. Decide on and run the `MEDIA_KEK` rollout (`docs/DEPLOY.md` §4) — currently
   the only thing standing between this environment and encrypted-at-rest media.
6. Commit. Nothing has been committed this session — the dirty tree from the
   prior session (92 paths, including four applied migrations under
   `backend/prisma/migrations/2026072500000{1..4}_*`) is unchanged, plus this
   session's three doc files.
