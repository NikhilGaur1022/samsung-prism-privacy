# Lead note — live API measurement, pipeline state, and export inventory (2026-08-21)

All OBSERVED against the running stack with real cookies. Dataset is tiny (110 photos, 36 sessions,
66 DSAR items), which makes the timings below a **floor**, not a forecast.

---

## FINDING E-1 (P0, export) — there is no project-wide export. Not the route, not the button.

Enumerated every route defined across `backend/src/modules/*/*.routes.js` (**156 route
definitions**). The complete project surface is:

```
GET   /api/v1/projects
POST  /api/v1/projects
GET   /api/v1/projects/:projectId
PATCH /api/v1/projects/:projectId
POST  /api/v1/projects/:projectId/submit | /approve | /reject | /close
GET   /api/v1/projects/:projectId/assignments | /sessions | /handoffs | /report
```

`/report` returns 765 bytes of JSON counts. **No route in the application returns project-scoped
media or an archive.** The only packaging path that exists anywhere is subject-scoped DSAR:

```
POST /api/v1/dsar/:requestId/package          (operator builds)
POST /api/v1/me/dsar/:requestId/package-token (subject mints a single-use token)
GET  /api/v1/me/dsar/:requestId/package       (subject downloads)
```

The UI agrees. `admin-portal/src/pages/dataOwner/ProcessedData.jsx` — the Data Owner's "finished
data" screen, the natural home for this — is read-only: a project `<select>`, a session roll-up
(`photoCount`, `participantCount`, handoff pill, status pill), and rows that navigate to
`/sessions/:id/photos`. **There is no download control on it, and no `download`/`export`/`package`
call in `admin-portal/src/lib/api.js` outside the DSAR ones.**

So the requirement "when an entire project is downloaded, every photo contains persistent
metadata…" has **two** unbuilt halves, not one. The download itself must be designed and built:
route, RBAC (dataOwner own-project only? dataAdmin? DPO approval?), scope (originals vs redacted
derivatives only — note `ProcessedData.jsx`'s own comment says "Raw originals stay out of reach"),
consent filtering (revoked subjects must not be in the archive), audit (`AccessEvent` of kind
`EXPORT`), and the streaming/ZIP64 work in `00-LEAD-metadata-and-scale.md` FINDING S-1.

**This is the single largest piece of net-new work in the plan and it gates the metadata
requirement**, because export is the only point at which "which project, which person" is settled.

---

## FINDING P-1 (P1, performance) — the DSAR item grid is ~1.3-2.9s for 50 items

Five consecutive runs of `GET /api/v1/dsar/:id/items`, warm DB, local, 66 items total:

```
run1 1.971s   run2 1.799s   run3 1.364s   run4 1.340s   run5 1.308s
```

Response: `{ requestId, requestStatus, requestType, subjectRef, items[50], nextCursor, totals, index }`
with `totals = { all:66, matching:66, deleted:25, byType:{PHOTO:66}, byOrigin:{ENROLLMENT:3, COLLECTION_SESSION:63} }`.

Cursor pagination **is** implemented (page size 50, `nextCursor` returned) — good. The problem is
**per-page cost: ~26ms per item at a steady state of 1.3s.** Two compounding causes to confirm in
the service:

1. Per-item enrichment (`sharedSubjectCount`, `redactedAvailable`, `contentHash`, recording
   fields) looks like per-row work rather than a set-based join.
2. `totals` re-aggregates the **entire** item set on every page request — `all`, `matching`,
   `deleted`, `byType`, `byOrigin`. That is by design (the `totals.all` completeness contract is
   deliberate and documented in the handoff, and must be kept), but it must become a single
   grouped query, and ideally a cached one, or it is a full scan per keystroke of the filter.

This is what the browser pass caught as an unresolved skeleton at 2.6s
(`00-LEAD-browser-pass.md` OBSERVED-5). At a project holding 5,000 items it is the difference
between a usable screen and a stalled one.

## FINDING P-2 (P1, performance) — `/projects/:id/sessions` is N+1

`GET /api/v1/projects/:projectId/sessions` = **1.039s for 35 sessions** (~30ms/session), 9.8 KB.
Each row carries `photoCount`, `participantCount`, `piiStatusCounts` and `handoff` — four
per-session aggregates. This is the Data Owner's main screen and it degrades linearly with project
size. Rewrite as grouped aggregates plus one join.

For contrast, the endpoints that do no per-row work are fine: `/dashboard/summary` 208ms,
`/dsar/sla` 163ms, `/projects` 181-197ms, `/dsar/:id` 228ms, `/audit` 234ms for 100 rows.
**The pattern is not "the API is slow" — it is "every endpoint that computes per-row aggregates is
slow".** That is one root cause with a handful of sites, which makes it cheap to fix properly.

## FINDING P-3 (P1, compliance) — 93% of the access-event ledger is unreachable through the API

```
GET /api/v1/access-events?limit=200   -> 200 rows
GET /api/v1/access-events?limit=201   -> 400 Validation failed
GET /api/v1/access-events?cursor=…    -> 100 rows (cursor silently ignored)
```

`audit.routes.js:29-41` — `accessQuerySchema` has `actorId`, `objectType`, `objectId`,
`dsarRequestId`, `limit` (max 200) and **no `cursor`**. `audit.service.js:189` —
`take: query?.limit ?? 100`, with **no cursor and no skip**. Zod strips the unknown `cursor` key
silently rather than rejecting it, so a client passing one gets a 200 and quietly wrong results.

The live table holds **2,966 `AccessEvent` rows**. The newest 200 are reachable. **The other 2,766
cannot be retrieved through the API at all, by any caller, ever.**

`AccessEvent` is the "who looked at whose biometric data, and when" ledger — the record a DPO needs
during a breach investigation and the thing `docs/RUNBOOK_BREACH.md` is written around. A ledger
you cannot read past its newest page is not an audit trail.

By contrast `auditRoutes.get('/')` **does** support `cursor` (`audit.service.js:61-62`,
`cursor:{id}, skip:1`) — but its response is `{ items }` with **no `nextCursor` field**, so a client
has to know to reuse the last row's id. Add `nextCursor` to both for a consistent contract.

*(Correcting my own earlier note: `?take=500` appearing to be "ignored" was my error — the param is
`limit`, not `take`. `limit` works correctly on `/audit`. The access-event cursor gap above is
real and separately verified.)*

---

## FINDING R-1 (P0, pipeline) — work is stuck, and has been for days, with nothing reporting it

Live DB state:

```
session status      : ACTIVE 26 · ARCHIVED 9 · PROCESSING 1
photo piiStatus     : CLEAN 83 · PENDING 27          (0 DEFERRED, 0 FAILED)
recognitionJob      : DONE 5 · RUNNING 1
```

- **Session `COL-7224` has been `PROCESSING` since 2026-08-19T20:00Z — about two days** — with a
  `RecognitionJob` still `RUNNING`. There is no reaper, no stalled-job timeout surfaced, and no
  screen that says so. The session simply never finishes.
- **27 of 110 photos (25%) are `piiStatus = PENDING`**, the oldest since **2026-08-05 — sixteen
  days**. Spread across three sessions: `df5bbbe1…` 9 photos, `e221257d…` 16, `faa3e6fd…` 2.

## FINDING R-2 (P0, data integrity) — a session was ARCHIVED with 16 never-redacted photos, and the UI calls it fine

Session `COL-2225` (`e221257d…`) is **`ARCHIVED`**, `endedAt` 2026-08-18T19:28Z, and holds
**16 photos still at `piiStatus = PENDING`**. Archival did not require redaction to have completed.

Worse, the screen built to catch exactly this does not catch it.
`admin-portal/src/pages/dataOwner/ProcessedData.jsx:21-23`:

```js
function blockedCount(piiStatusCounts) {
  return (piiStatusCounts?.DEFERRED ?? 0) + (piiStatusCounts?.FAILED ?? 0)
}
```

`PENDING` is not counted. The page's own comment says *"A DEFERRED or FAILED frame is one redaction
never confirmed on, which blocks that session's handoff — invisible from session status alone, so
it is called out on its own row"*. The intent is right; the implementation misses the **most common**
never-confirmed state. And the live data proves it: there are **zero** DEFERRED and **zero** FAILED
rows in the whole database, and **27** PENDING. The warning banner has never fired and cannot fire.

So a data owner looking at `COL-2225` today sees `ARCHIVED` + "Not handed off"/handoff pill and **no
warning at all**, while 16 unredacted frames sit in it.

**Fix (three parts, all needed):**
1. `blockedCount` must include `PENDING` (and any future non-terminal state) — invert the test to
   "not CLEAN" rather than enumerating bad states, so a new enum value fails safe.
2. The archive/handoff transition must **refuse** while non-CLEAN frames exist, server-side.
3. A reaper for stalled `RecognitionJob`/`PENDING` work, with a visible operator queue.

**Test after fix:** seed a session with one PENDING photo, assert archive returns 409; assert the
`blockedCount` banner renders; assert the reaper re-enqueues a job whose lock expired.

---

## Notes carried to the plan

- `GET /api/v1/dsar/:id/actions` returns **404** while `/items` and `/timeline` on the same request
  return 200. Either the path differs from what I guessed or the route is genuinely absent — worth
  one check against the route list rather than an assumption.
- Zod schemas strip unknown query keys silently across the API. That is the default and it is what
  let the ignored `cursor` go unnoticed. Consider `.strict()` on query schemas so a client typo is a
  400 rather than silently wrong data.
- Access token TTL `15m`, refresh `7d` (`backend/src/lib/tokens.js:6-7`) — sane.
- 26 of 36 sessions are `ACTIVE` and never ended. Mostly dev residue, but it means the "end session"
  path is under-exercised and there is no cleanup of abandoned sessions.

---

# LEAD CONFIRMATION (appended 2026-08-21) — the P0 that stops everything

The `api-validation-fileupload` auditor reported that `req.user` does not exist. I reproduced it
independently, and the situation is worse than reported.

```
POST /api/v1/subjects   (as agent@prism.local, valid cookie)
  -> HTTP 500  {"error":"Cannot read properties of undefined (reading 'id')"}

POST /api/v1/subjects   (unauthenticated — what user-portal Register.jsx actually does)
  -> HTTP 401  {"error":"Not authenticated"}

subjects created by either probe: 0
```

`grep -rn "req\.user" backend/src` returns **exactly four hits, all in one file**, and nothing
anywhere sets it — `requireAdminAuth.js:26` attaches `req.admin`:

```
backend/src/modules/subjects/subject.controller.js:13   registerSubject(input, req.user.id)
backend/src/modules/subjects/subject.controller.js:42   updateConsent(..., req.user.id)
backend/src/modules/subjects/subject.controller.js:52   updateStatus(..., req.user.id)
backend/src/modules/subjects/subject.controller.js:62   updateGroup(..., req.user.id)
```

`subject.routes.js:19-20` puts the whole router behind
`requireAdminAuth` + `requireRole('collectionAgent','super_admin')`, while
`user-portal/src/lib/api.js:23-25` has `registerSubject()` POST to that same
`/api/v1/subjects`. So the data principal's own self-registration page cannot ever reach it.

**The corroborating detail the auditor did not have:** every one of the 9 subjects in the live
database has `registrationChannel: "SELF"` — they were created while some earlier path still
worked (the dev-stub `requireAuth` that `subject.routes.js:9-18` describes as removed). There is
now **no working route by which any new data subject can be onboarded, by anyone.**

Consequences:
- Production requirement 1 (upload -> processing -> export) has **no entry point**. Every
  downstream feature is unreachable for any new person.
- Three more admin operations are dead the same way: consent update, status update, group update.
- The failure is a raw `TypeError` surfaced verbatim to the operator
  (`SubjectVerification.jsx:297` does `setFormError(err.message)`).
- **No test catches it.** `rbac-matrix.test.js` asserts status *classes*, and a 500 is neither a
  401 nor a 403, so the matrix passes.

**Fix:** replace `req.user.id` with `req.admin.id` in all four handlers, and decide the
self-registration story deliberately — either a separate public `POST /auth/subject/register`
with its own rate limit and validation, or remove the user-portal Register page. Do not simply
loosen the guard on `/api/v1/subjects`; that router returns subject PII and its
collectionAgent/super_admin floor is correct.

**Test:** an integration test that registers a subject as an agent and asserts 201 plus the row;
a route-contract test asserting no handler references a request property no middleware sets
(a lint rule or a grep-based test would have caught this class outright).
