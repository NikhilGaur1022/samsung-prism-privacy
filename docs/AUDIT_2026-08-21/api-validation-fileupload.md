# PRISM audit — API input validation, error handling, file upload, HTTP contract

Auditor domain: `backend/src/modules/*/**.routes.js`, the zod validators,
`backend/src/middleware/errorHandler.js`, multer configuration, media serving,
HTTP contract quality.

All probes were run against the **live** stack on 2026-08-20/21 (`localhost:4000`,
Postgres `localhost:5433`, face-worker `localhost:8001`). Cookie jars for
`agent@prism.local`, `dataowner@prism.local`, `dpo@prism.local`,
`dataadmin@prism.local` were minted fresh via `POST /auth/admin/login`.

Every evidence block below is labelled **OBSERVED** (real command + real output
pasted) or **INFERRED** (read from code, not exercised).

Route inventory taken from the live Express router stack:

```
$ cd backend && node --input-type=module -e "
import 'dotenv/config'
const { createApp, listRoutes } = await import('./src/app.js')
console.log('TOTAL ROUTES:', listRoutes(createApp()).length)"
TOTAL ROUTES: 158
```

18 route modules, 158 mounted routes, **5 validation files**
(`auth-admin`, `auth-subject`, `enrollment`, `import`, `subjects`) — every other
module inlines its zod schemas in the routes file, and several forget to use them.

---

## 1. [P0] `req.user` does not exist — subject registration and all three subject
##      mutations return 500 on every call. The collection flow has no entry point.

`backend/src/middleware/requireAdminAuth.js:26` attaches **`req.admin`**:

```js
  req.admin = { id: payload.sub, role: payload.role }
```

`backend/src/modules/subjects/subject.controller.js` reads **`req.user.id`** in four
handlers:

```
backend/src/modules/subjects/subject.controller.js:13:    const subject = await subjectService.registerSubject(input, req.user.id)
backend/src/modules/subjects/subject.controller.js:42:    const subject = await subjectService.updateConsent(req.params.id, body, req.user.id)
backend/src/modules/subjects/subject.controller.js:52:    const subject = await subjectService.updateStatus(req.params.id, status, req.user.id)
backend/src/modules/subjects/subject.controller.js:62:    const subject = await subjectService.updateGroup(req.params.id, group, req.user.id)
```

A repo-wide scan finds `req.user` **only** in that one file — nothing ever sets it
(the dev-stub `requireAuth` that used to is gone; see the comment at
`subject.routes.js:9-18`).

**OBSERVED** — probe P5 / P4:

```
$ curl -s -i -b c.agent.txt -X POST 'http://localhost:4000/api/v1/subjects' \
   -H 'Content-Type: application/json' \
   -d '{"group":"VOLUNTEER","fullName":"Audit Probe","email":"audit.probe.donotcreate@example.invalid","registrationChannel":"AGENT"}'
HTTP/1.1 500 Internal Server Error
{"error":"Cannot read properties of undefined (reading 'id')","correlationId":"f650a846-2da4-4ffa-9397-2f0c8d90cdf3"}

$ curl -s -i -b c.agent.txt -X PATCH \
   'http://localhost:4000/api/v1/subjects/00000000-0000-4000-8000-000000000001/status' \
   -H 'Content-Type: application/json' -d '{"status":"ACTIVE"}'
HTTP/1.1 500 Internal Server Error
{"error":"Cannot read properties of undefined (reading 'id')","correlationId":"96dce29d-54e0-4182-895f-3a24c6e9c768"}
```

4 of the 6 routes on `subjectRoutes` are dead:
`POST /api/v1/subjects`, `PATCH /api/v1/subjects/:id/consent`,
`PATCH /api/v1/subjects/:id/status`, `PATCH /api/v1/subjects/:id/group`.

Blast radius in the UI (**OBSERVED** by reading the callers):

* `admin-portal/src/pages/collectionAgent/SubjectVerification.jsx:286` —
  the agent's "register subject" form. Fails with the raw TypeError shown to the
  operator (`setFormError(err.message)` at line 297).
* `user-portal/src/pages/Register.jsx:37` — the data principal's self-registration
  page. This one does not even get as far as the 500, because the route is behind
  `requireAdminAuth` + `requireRole('collectionAgent','super_admin')`
  (`subject.routes.js:19-20`):

```
$ curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:4000/api/v1/subjects \
   -H 'Content-Type: application/json' \
   -d '{"group":"VOLUNTEER","fullName":"X","email":"x.probe@example.invalid","registrationChannel":"SELF"}'
{"error":"Not authenticated","correlationId":"6d05c6aa-ebb5-4d2f-844c-1eb54b2afb01"}
HTTP 401
```

So the public self-registration page is a 401, and the agent-side registration is a
500. Production requirement 1 ("full flow works: upload → … → export") cannot start.

There is no test covering this: the RBAC matrix test only asserts status classes, and
a 500 is not a 401/403 so it does not trip.

---

## 2. [P0] `errorHandler` returns the raw internal `err.message` for every 5xx —
##      JS TypeErrors, libvips strings and Python heap addresses reach the client.

`backend/src/middleware/errorHandler.js:30-38`:

```js
  const statusCode = err.statusCode ?? 500
  if (statusCode >= 500) {
    logger.error({ err, correlationId: req.correlationId }, 'unhandled error')
  }
  res.status(statusCode).json({
    error: err.message ?? 'Internal server error',   // <-- unconditional
    details: err.details,
    correlationId: req.correlationId,
  })
```

There is no `NODE_ENV` branch, no allowlist, no "Internal server error" fallback for
unexpected throws. `err.message` is whatever threw.

**OBSERVED** — three distinct internal sources leaked in three probes:

```
# (a) a JavaScript TypeError from our own code
{"error":"Cannot read properties of undefined (reading 'id')","correlationId":"f650a846-…"}   HTTP 500

# (b) libvips/sharp internals, from posting non-image bytes labelled image/jpeg
$ curl -s -i -b c.agent.txt -X POST \
    "http://localhost:4000/api/v1/sessions/$S/photos" \
    -F "photos=@notimage.txt;type=image/jpeg;filename=evil.jpg"
HTTP/1.1 500 Internal Server Error
{"error":"Input buffer contains unsupported image format","correlationId":"f828acc0-…"}

# (c) the PYTHON face worker's PIL exception, INCLUDING A HEAP ADDRESS
$ curl -s -b c.agent.txt -X POST \
    "http://localhost:4000/api/v1/subjects/4ee0c3a2-…/enrollments" \
    -F 'selfie=@notimage.txt;type=image/jpeg;filename=..%2f..%2f..%2fevil.jpg'
{"error":"Unreadable image: cannot identify image file <_io.BytesIO object at 0x0000023001FD3BA0>",
 "correlationId":"46aa0683-…"}   HTTP 400
```

`0x0000023001FD3BA0` is a live heap address inside the face worker process, handed to
an API client. The 400/500 distinction does not matter — `errorHandler` passes the
message through in both cases, and `enrollment.service.js:35` deliberately forwards
`body?.detail` from the worker.

`err.details` is also passed through verbatim. Two places put internals in it:

* `errorHandler.js:22-28` — Prisma `P2002` returns `details: err.meta`, i.e. the
  physical unique-constraint target columns. **INFERRED** (no reachable P2002 found;
  every insert path I probed is pre-guarded — see §17).
* `enrollment.service.js:30` — `new ApiError(503, 'Face service unavailable',
  { cause: err.message })`, which on a connection failure is
  `connect ECONNREFUSED 127.0.0.1:8001` — internal service topology.
  **INFERRED** (the worker was up; I did not take it down).

Both portals surface `body.error` directly to the user
(`admin-portal/src/lib/api.js:52`, `user-portal/src/lib/api.js:13`:
`new Error(body?.error ?? ...)`), so these strings are rendered in the operator UI.

---

## 3. [P1] `logAccess` writes the AccessEvent **before** the uuid is validated —
##      arbitrary attacker-chosen strings land in the compliance ledger.

`backend/src/middleware/logAccess.js:120-141` resolves the object id straight off
`req.params` and calls `recordAccess()` **before** the handler runs. The handler is
where `uuid.parse()` happens (`session.routes.js:161-165` etc.). So the row is written
first and the 400 is raised second.

`AccessEvent.objectId` is `String` (plain `text`) in
`backend/prisma/schema.prisma:1035`, so anything at all is storable.

**OBSERVED** — probe G1:

```
$ MARK="AUDIT-PROBE-NOT-A-UUID-$(date +%s)"   # AUDIT-PROBE-NOT-A-UUID-1787252477
$ curl -s -w ' HTTP %{http_code}\n' -b c.agent.txt \
    "http://localhost:4000/api/v1/sessions/338c7d6e-…/photos/$MARK/file"
{"error":"Validation failed","details":[{"validation":"uuid","code":"invalid_string",
 "message":"Invalid uuid","path":[]}],"correlationId":"674022d0-…"} HTTP 400

$ node -e "… p.accessEvent.findMany({where:{objectId:{startsWith:'AUDIT-PROBE'}}}) …"
[ {
  "id": "2d61e5bc-5894-424b-91fa-c19fddc3b912",
  "objectType": "PHOTO",
  "objectId": "AUDIT-PROBE-NOT-A-UUID-1787252477",
  "action": "VIEW",
  "actorId": "42a7429f-2413-4a95-9238-0c3081518e1d",
  "ip": "::1",
  "createdAt": "2026-08-20T19:01:17.439Z"
} ]
```

The ledger now permanently asserts that the collection agent **viewed** a photograph
that does not exist. Consequences:

1. The AccessEvent ledger is the product's accountability artefact (DPDP §8). It is
   append-only and is fed to `/api/v1/access-events`, to DSAR timelines
   (`timeline.service.js`) and to the DPO. It can now be filled with fabricated
   "reads" attributed to any authenticated operator, by anyone who can reach the
   route as that operator.
2. It is an unbounded, unrate-limited INSERT primitive: one HTTP GET per row, no
   rate limiter on any data route (see §17), ~200 bytes/row. A loop fills the
   compliance table and its four indexes.
3. It poisons the `@@index([objectType, objectId])` used by discovery.

Affected routes — every `logAccess(...)` mount, because none of them validate the
param before the middleware:

```
session.routes.js:156   PHOTO                     /:sessionId/photos/:photoId/file
session.routes.js:175   FACE_CROP                 /:sessionId/faces/:faceId/crop
session.routes.js:258   REDACTED_PHOTO            /:sessionId/people/:subjectId/photos/:photoId/redacted
session.routes.js:365   REDACTED_PHOTO            /:sessionId/photos/:photoId/redacted
recording.routes.js:254 RECORDING                 /:sessionId/recordings/:recordingId/raw
recording.routes.js:277 REDACTED_RECORDING        /:sessionId/recordings/:recordingId/redacted
video.routes.js:115     REDACTED_VIDEO            /:sessionId/videos/:videoId/redacted
video.routes.js:134     FACE_CROP                 /:sessionId/video-tracks/:trackId/crop
document.routes.js:144  TEXT_DOCUMENT             /:sessionId/documents/:documentId/raw
document.routes.js:162  REDACTED_TEXT_DOCUMENT    /:sessionId/documents/:documentId/redacted
me.routes.js:100        REDACTED_PHOTO            /photos/:photoId/redacted
```

`session.routes.js:401` (`requireBreakGlass`) has the same shape — it resolves
`req.params.photoId` before any validation.

*(I created exactly one such row during this audit: `2d61e5bc-…`, objectId
`AUDIT-PROBE-NOT-A-UUID-1787252477`. It is append-only by design; I did not delete it.)*

---

## 4. [P1] Every multer limit and filter violation is a **500**, and the shape is
##      inconsistent across the five upload routes.

multer raises `MulterError` (`LIMIT_FILE_SIZE`, `LIMIT_FILE_COUNT`) which has a
`.code` but **no `.statusCode`**, so `errorHandler.js:30` defaults it to 500. Two of
the five `fileFilter`s reject with a bare `new Error(...)` — also 500. The other three
use `new ApiError(415, ...)`.

```
backend/src/modules/sessions/session.routes.js:27-33   memoryStorage, 25MB, 20 files,  cb(new Error(...))          -> 500
backend/src/modules/enrollment/enrollment.routes.js:12-18 memoryStorage, 10MB, 1 file, cb(new Error(...))          -> 500
backend/src/modules/import/import.routes.js:29-35      memoryStorage, 25MB, 20 files,  cb(new Error(...))          -> 500
backend/src/modules/enrollment/enrollment.routes.js:25-31 memoryStorage, 25MB, 1 file, cb(new ApiError(415, ...))  -> 415
backend/src/modules/recordings/recording.routes.js:53-65 diskStorage, 200MB, 1 file,   cb(new ApiError(415, ...))  -> 415
backend/src/modules/videos/video.routes.js:48-57       diskStorage, 200MB, 1 file,     cb(new ApiError(415, ...))  -> 415
backend/src/modules/documents/document.routes.js:11-14 memoryStorage, 10MB, NO fileFilter, NO files limit
```

**OBSERVED** — probes U1, U6, U7, E3, E4, E6:

```
# wrong mimetype, session photos
POST /api/v1/sessions/$S/photos   -F "photos=@notimage.txt;type=text/plain"
  HTTP/1.1 500  {"error":"Only image files are accepted","correlationId":"c94e6de0-…"}

# 26 MB file, over the 25 MB fileSize limit
POST /api/v1/sessions/$S/photos   -F "photos=@big.bin;type=image/jpeg"
  HTTP/1.1 500  {"error":"File too large","correlationId":"80379681-…"}

# 21 files, over the files:20 limit
POST /api/v1/sessions/$S/photos   (21 parts)
  HTTP/1.1 500  {"error":"Too many files","correlationId":"5c56b844-…"}

# same mistake on the enrolment route
POST /api/v1/subjects/$SUB/enrollments -F "selfie=@notimage.txt;type=text/plain"
  HTTP 500  {"error":"Only image files are accepted"}

# and on the import route
POST /api/v1/imports/…/items -F "photos=@notimage.txt;type=text/plain"
  HTTP 500  {"error":"Only image files are accepted"}

# but the voice route gets it right
POST /api/v1/subjects/$SUB/voice-enrollments -F "audio=@notimage.txt;type=text/plain"
  HTTP 415  {"error":"Only audio files are accepted"}
```

Consequences: the agent portal cannot distinguish "your file is too big" from "the
backend is broken" and its retry logic can't decide whether to retry; every ordinary
user mistake is written to the log at `logger.error` level
(`errorHandler.js:31-33`), which is alert-fatigue by construction at 5000 images/day.

Note also `session.routes.js:30-32`:

```js
  fileFilter: (_req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are accepted'), true)
  },
```
The second argument is always `true`; multer's contract is `cb(null, false)` to skip a
file. Here rejection is always fatal to the whole request, and the `true` is dead.

`document.routes.js:11-14` has **no `fileFilter` at all and no `files` count limit** —
any file type, any number of parts, 10 MB each.

---

## 5. [P1] `memoryStorage` on the high-volume paths: one POST costs up to 500 MB
##      resident, measured; nothing releases it and nothing rate-limits it.

`session.routes.js:28`, `enrollment.routes.js:13`, `enrollment.routes.js:26`,
`import.routes.js:30`, `document.routes.js:12` all use `multer.memoryStorage()`.
multer buffers **all** parts into `req.files` before the handler runs. There is no
total-request-size cap (express.json's 100 kb does not apply to multipart) and no
rate limiter on any upload route.

Configured worst case per request:
`limits: { fileSize: 25*1024*1024, files: 20 }` → **500 MB** of Buffers per in-flight
request on `POST /api/v1/sessions/:id/photos` and `POST /api/v1/imports/:id/items`.

**OBSERVED** — probe against the live API process (PID 25144), sampling
`PrivateMemorySize64` every 900 ms while a 20 × 10 MB batch uploaded at 20 MB/s:

```
baseline                       WS_MB=63.8   PM_MB=131.5
t=1                            WS_MB=82.8   PM_MB=137.2
t=3                            WS_MB=130.7  PM_MB=185.6
t=6                            WS_MB=184.6  PM_MB=238.4
t=9                            WS_MB=231.2  PM_MB=290.3
t=11 (upload complete)         WS_MB=277.2  PM_MB=331.8
t=14 (30 s later, idle)        WS_MB=277.0  PM_MB=330.4

curl result: HTTP 500 up=209718183 wall=10.736639s
             {"error":"Input buffer contains unsupported image format", …}
```

+200 MB of private bytes for a 200 MB payload — an exact 1:1, confirming full
residency — and it was still resident 30 s after the request ended. Scaled to the
configured ceiling that is 500 MB per request; three concurrent agent batches
(the machine has 16.8 GB total and showed **1.7 GB free** during the audit) exhaust
the box. There is no `express-rate-limit` on the route
(`backend/src/middleware/rateLimiter.js` covers only admin login, subject login/verify
and the public join lookup/accept — 6 limiters, none on data or upload paths).

The recording and video routes correctly use `diskStorage`
(`recording.routes.js:53-57`, `video.routes.js:49-52`) with a comment saying
memoryStorage "took the API down". The photo route — the one that runs 5000×/day —
did not get the same treatment.

Sizing for requirement 2 (5000 images/day): at a typical 3 MB phone JPEG and 20 per
batch, each POST is 60 MB resident for its whole lifetime. 5000/day = 250 batches;
if 5 agents upload concurrently that is 300 MB steady-state on top of Prisma, sharp
and the JSON heap, with no back-pressure mechanism anywhere.

---

## 6. [P1] No magic-byte validation anywhere; the client's `Content-Type` is the only
##      check. Decompression bombs are accepted and then permanently jam the pipeline.

Every `fileFilter` tests `file.mimetype`, which is copied verbatim from the
`Content-Type` header of the multipart part — i.e. from the client. `import.validators.js:66-76`
(`assertAcceptableFile`) has a MIME **allowlist**, but it also only inspects
`file.mimetype`. No route reads the first bytes of the buffer, and there is no
`file-type`/`sharp().metadata()` gate before the file is used.

**OBSERVED** — mimetype spoofing passes the filter and reaches sharp:

```
$ printf 'this is definitely not an image' > notimage.txt
$ curl -s -i -b c.agent.txt -X POST "…/sessions/$S/photos" \
    -F "photos=@notimage.txt;type=image/jpeg;filename=evil.jpg"
HTTP/1.1 500  {"error":"Input buffer contains unsupported image format"}
```

**OBSERVED** — an SVG with an inline `<script>` is accepted (it starts with `image/`):

```
$ cat xss.svg
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/><script>alert(document.domain)</script></svg>
$ curl -s -b c.agent.txt -X POST "…/sessions/$S/photos" -F "photos=@xss.svg;type=image/svg+xml"
{"added":1,"duplicates":0,"photos":[{"id":"1e678030-…","mimeType":"image/jpeg","sizeBytes":294,
  "width":64,"height":64, …}]}   HTTP 201
```

The stored XSS risk is *incidentally* closed: `session.service.js:249` rasterises
everything with `sharp(buf).rotate().jpeg({quality:92})` and the DB `mimeType` is
hard-coded `'image/jpeg'` (line 258), so the serve path can never echo `image/svg+xml`.
What is **not** closed is that arbitrary SVG is fed to librsvg inside libvips — the
XXE / `file://` / external-reference surface of that library is now reachable by any
collection agent. **INFERRED** (I did not get a file-read to succeed; I only proved
SVG input is accepted and rasterised).

**No `limitInputPixels` anywhere** — a repo-wide grep over `backend/src` for
`limitInputPixels|failOn|sequentialRead` returns **zero** hits, so sharp's default
268,402,689-pixel ceiling applies. That is 40× larger than any real camera.

**OBSERVED** — cost of a 256 MP bomb, measured locally with the project's own sharp
(0.35.3 / libvips 8.18.3) and then live:

```
100 MP (10000x10000) flat JPEG  = 586,207 bytes on the wire
   sharp(buf).rotate().jpeg({quality:92}).toBuffer()  ->   767 ms
256 MP (16000x16000) flat JPEG  = 1,500,269 bytes on the wire
   sharp(buf).rotate().jpeg({quality:92}).toBuffer()  ->  2393 ms
289 MP (17000x17000)            -> "Input image exceeds pixel limit"

# live, through the API:
$ curl -s -w 'HTTP %{http_code} upload=%{size_upload}B wall=%{time_total}s\n' \
    -b c.agent.txt -X POST "…/sessions/$S/photos" -F "photos=@bomb256mp.jpg;type=image/jpeg"
HTTP 201 upload=1500474B wall=4.342616s
  { … "sizeBytes":1500269,"width":16000,"height":16000 … }

$ … -F "photos=@bomb289mp.jpg;type=image/jpeg"
{"error":"Input image exceeds pixel limit","correlationId":"07e79544-…"}   HTTP 500
```

**Amplification:** 1.5 MB in → 4.34 s of server work. `files: 20` and no total-request
cap means one authenticated agent can post 20 of these (30 MB total, well inside every
limit) for roughly **87 seconds of blocking libvips work in a single HTTP request**,
repeated as fast as they like because there is no rate limit. At 8 cores, four such
requests saturate the box.

**Worse: the limits are asymmetric with the downstream worker, so the frame is
permanently un-processable.** The Python face worker *does* have a bomb guard:

```
$ curl -s -b c.agent.txt -X POST ".../subjects/$SUB/enrollments" -F "selfie=@bomb256mp.jpg;type=image/jpeg"
HTTP 400  {"error":"Unreadable image: Image size (256000000 pixels) exceeds limit of 178956970 pixels,
           could be decompression bomb DOS attack."}
```

178,956,970 px in the worker vs 268,402,689 px in the backend. Anything in that
90 MP window is **accepted at ingest and rejected at recognition**, forever.
And `recognition.service.js:104-113` has no per-photo try/catch:

```js
  const photos = await prisma.photo.findMany({ where: { sessionId } })   // unbounded
  …
  for (const photo of photos) {
    const buffer = await readFile(photo.storagePath)
    const meta = await sharp(buffer).metadata()
    const faces = await detectFaces(buffer, `${photo.id}.jpg`)            // throws on 400
```
and `detectFaces` (line 70-73) throws
`new Error('Face service returned 400: …')`. One oversized photo therefore fails
**the whole session's recognition job**, not just that frame — every other photo in
the session stays at `piiStatus: PENDING` and finalize can never run.
**INFERRED** for the job-abort path (read from code; I did not trigger a full
`processSession` on the live queue), **OBSERVED** for both pixel limits.

---

## 7. [P1] Batch photo upload is not atomic and the failure response says nothing
##      about what was already committed.

`session.routes.js:112-131`:

```js
    const results = []
    for (const file of req.files) {
      results.push(await sessionService.addPhoto(sessionId, file, meta, req.admin))
    }
    res.status(201).json({ added: …, duplicates: …, photos: … })
```

No transaction, no per-file try/catch. The first throw escapes to `next(err)` and the
already-committed rows plus their on-disk sealed blobs stay.

**OBSERVED** — probe A1, into an empty session:

```
$ curl -s -w '\nHTTP %{http_code}\n' -b c.agent.txt -X POST \
   "…/sessions/4e9ff5d3-e58f-450b-81d4-b6117d95ccad/photos" \
   -F "photos=@p1.jpg;type=image/jpeg" \
   -F "photos=@p2.jpg;type=image/jpeg" \
   -F "photos=@bad.jpg;type=image/jpeg"
{"error":"Input buffer contains unsupported image format","correlationId":"92375fa9-…"}
HTTP 500

$ node … p.photo.findMany({where:{sessionId:'4e9ff5d3-…'}})
[{"id":"e035e612-…","sha256":"85616be1…","sizeBytes":363},
 {"id":"04a8bd4a-…","sha256":"47c37242…","sizeBytes":363}]
```

Two of three files committed; the client received a bare 500 and cannot know which.
Requirement 7 ("failure, retry, duplicate upload must not break the workflow") is
only half met — the content-hash dedupe *does* make the blind retry safe (see §18),
but the client is given no `partial`/`errors` array to reason with, and the UI
(`admin-portal/src/lib/api.js:182 uploadPhotos`) surfaces one error string for the
whole batch. Same shape at `import.routes.js:69-77`.

---

## 8. [P1] `GET /api/v1/dsar/:requestId/purge-jobs/:purgeJobId` never validates or uses
##      `:requestId` — any purge job is readable under any (or a garbage) request id.

`backend/src/modules/dsar/dsar.routes.js:385-395`:

```js
dsarRoutes.get(
  '/:requestId/purge-jobs/:purgeJobId',
  requireRole('dataAdmin', 'dpo', 'super_admin'),
  async (req, res, next) => {
    try {
      res.json(await getPurgeJob(uuid.parse(req.params.purgeJobId)))   // requestId ignored
```

and `purge.service.js:644-651`:

```js
export async function getPurgeJob(purgeJobId) {
  const job = await prisma.purgeJob.findUnique({
    where: { id: purgeJobId },
    include: { locations: { orderBy: { locationCode: 'asc' } } },
  })
  if (!job) throw new ApiError(404, 'Purge job not found')
```

No `where: { dsarRequestId }`. Every sibling route on this router scopes by request id;
this one does not.

**OBSERVED** — a syntactically impossible request id sails past validation and the
handler answers about the purge job instead of 400-ing on the path:

```
$ curl -s -w '\nHTTP %{http_code}\n' -b c.dataadmin.txt \
   'http://localhost:4000/api/v1/dsar/I-AM-NOT-A-UUID/purge-jobs/00000000-0000-4000-8000-000000000000'
{"error":"Purge job not found","correlationId":"359ad920-…"}
HTTP 404
```

Compare the correct behaviour on a sibling route:

```
$ curl -s -b c.dpo.txt 'http://localhost:4000/api/v1/dsar/zzz'
{"error":"Validation failed","details":[{"validation":"uuid",…}], …}   HTTP 400
```

A purge job's `locations` breakdown names every storage location a named principal's
data was destroyed from. `purgeJob` is empty in the live DB (`p.purgeJob.findMany()`
returned `[]`), so I could not demonstrate a cross-request read with real data —
the missing scoping is **OBSERVED in code and confirmed by the 404-vs-400 behaviour**,
the actual cross-tenant read is **INFERRED**.

---

## 9. [P1] Unbounded list endpoints — no `limit` parameter and no `take`.

A scripted scan of every `.findMany(` call site under `backend/src`:

```
findMany call sites: 129    WITHOUT a `take:` in the option object: 116
```

(That heuristic has false positives — I spot-checked and confirmed
`subject.service.js:55` (`take: limit + 1`) and `audit.service.js:53` (`take: limit`)
are correctly cursor-paged.) The genuinely unbounded, client-reachable ones I verified
by reading:

| Endpoint | Service | Live measurement |
|---|---|---|
| `GET /api/v1/projects` | `project.service.js:60` no take, no limit param | 200, 1307 B, 0.29 s |
| `GET /api/v1/sessions` | `session.service.js:92` no take, `listQuerySchema` has no `limit` | 200, 15527 B, **35 items**, 0.26 s |
| `GET /api/v1/sessions/:id` | `session.service.js:125` `photos: {orderBy}` — **every photo**, plus every recording, every audio segment, every document, every span | 200, **14762 B for 22 photos**, 1.32 s |
| `GET /api/v1/sessions/:id/photos` | `listSessionPhotosForOversight` | 200, 3753 B, 0.34 s |
| `GET /api/v1/sessions/:id/clusters` | `session.service.js:510` | 200, 8393 B, 0.69 s |
| `GET /api/v1/sessions/:id/people` | `session.service.js:719-725` | 200, 534 B, 0.76 s |
| `GET /api/v1/sessions/:id/people/:sid/photos` | `session.service.js:818` all photos + all faces | not measured (needs tagged data) |
| `GET /api/v1/projects/:id/sessions` | `project.service.js:419` | 200, 9796 B, 0.75 s |
| `GET /api/v1/projects/:id/handoffs` | `project.service.js:468` | — |
| `GET /api/v1/handoffs` | `handoff.service.js:6`, `listQuerySchema` has only `status` | 200, 3129 B |
| `GET /api/v1/consent-templates` | `consentTemplate.service.js:56` | 200, 5064 B |
| `GET /api/v1/consent/projects` | `consent.service.js:16` | — |
| `GET /api/v1/me/participations` | `me.routes.js:47` inline `findMany`, no take | — |
| `GET /api/v1/me/photos` | `me.service.js:15` all `photoSubject` links for the subject | — |
| `GET /api/v1/me/dsar` | `dsar.service.js:234` subject branch, no take | — |
| `GET /api/v1/dsar/:id/media` | `dsar.service.js:734` | 200, **24680 B for 79 items** = 312 B/item |
| `GET /api/v1/subjects/:id/enrollments` | `enrollment.service.js:134` | 200, 455 B (28 enrollments) |
| `GET /api/v1/sessions/:id/recordings` / `/videos` / `/documents` | `recording.service.js:662`, `video.service.js:567`, `document.service.js:91` | — |
| `GET /auth/admin/users` | `auth-admin.service.js:192` | — |

Extrapolation for requirement 2 (5000 images/day):

* `GET /api/v1/sessions/:id` — 22 photos ⇒ 14,762 B ⇒ **671 B/photo**. A session
  holding one day's 5000 frames returns a **3.3 MB** JSON body with no paging,
  built by serialising 5000 Prisma rows, on every open of the tagging screen.
* `GET /api/v1/dsar/:id/media` — 312 B/item today. A subject appearing in 5% of a
  year's frames (≈91,000 items) is a **28 MB** unpaged response, and it is on the
  DSAR path a regulator uses.
* `GET /api/v1/sessions` — 443 B/session at 35 sessions; a year of collection is
  thousands of sessions in one array with no `limit` accepted at all
  (`listQuerySchema` at `session.routes.js:43-46` has only `status` and `type`).

The endpoints that *are* bounded are bounded correctly and reject overshoot — that
part is fine:

```
/api/v1/dsar?limit=1000000        -> 400 "Number must be less than or equal to 200"
/api/v1/audit?limit=1000000       -> 400
/api/v1/subjects?limit=1000000    -> 400 "…less than or equal to 100"
/api/v1/access-events?limit=1000000 -> 400
/api/v1/dsar/evidence?limit=501   -> 400   (500 -> 200)
/api/v1/handoffs/lineage?limit=501-> 400   (500 -> 200)
/api/v1/projects/:id/subjects?limit=51 -> 400
/api/v1/audit?limit=abc           -> 400 "Expected number, received nan"
/api/v1/subjects?cursor=notauuid  -> 400 "Invalid uuid"
/api/v1/dsar?cursor=%%%not-base64%%% -> 400 "Malformed cursor"
/api/v1/dashboard/compliance-report?from=notadate -> 400 "Invalid date"
```

but note the ceilings are still generous for a single page:
`dsar/evidence` 500, `handoffs/lineage` 500, `dsar/:id/items/actions` **1000**
(`dsar.routes.js:90`), and `/api/v1/audit?limit=200` already costs 75,275 B / 0.44 s.

---

## 10. [P1] Five mutually incompatible error envelopes, two of them HTML.

| Trigger | Status | `Content-Type` | Body |
|---|---|---|---|
| zod failure | 400 | `application/json` | `{"error":"Validation failed","details":[…],"correlationId":"…"}` |
| `ApiError` | 4xx/5xx | `application/json` | `{"error":"…","correlationId":"…"}` |
| Prisma `P2002` | 409 | `application/json` | `{"error":"…","details":<prisma meta>,"correlationId":"…"}` |
| **hand-rolled 400 in `document.routes.js:66`** | 400 | `application/json` | `{"error":"Text content is required"}` — **no correlationId** |
| **body-parser 413** | 413 | `application/json` | `{"error":"request entity too large"}` — **no correlationId, no `x-correlation-id` header** |
| **unknown route / wrong method** | 404 | **`text/html`** | `<!DOCTYPE html>…` |
| **rate limit** | 429 | **`text/html`** | `Too many requests, please try again later.` |

**OBSERVED**:

```
$ curl -s -i -b c.dpo.txt 'http://localhost:4000/api/v1/does-not-exist'
HTTP/1.1 404 Not Found
Content-Security-Policy: default-src 'none'
X-Content-Type-Options: nosniff
Content-Type: text/html; charset=utf-8
<!DOCTYPE html>

$ curl -s -i -b c.dpo.txt -X PUT 'http://localhost:4000/api/v1/dsar'
HTTP/1.1 404 Not Found      (no 405, no Allow header)
Content-Type: text/html; charset=utf-8

$ for i in $(seq 1 62); do curl -s -o /dev/null "http://localhost:4000/api/v1/join/AAAAAAAAAAAAAAAAAAAAAAAA"; done
$ curl -s -i "http://localhost:4000/api/v1/join/AAAAAAAAAAAAAAAAAAAAAAAA"
Content-Type: text/html; charset=utf-8
Too many requests, please try again later.

$ curl -s -i -b c.agent.txt -X POST "…/sessions/$T/documents" -H 'Content-Type: application/json' -d '{}'
{"error":"Text content is required"}          # no correlationId

$ curl -s -i -b c.dataowner.txt -X POST http://localhost:4000/api/v1/projects \
    -H 'Content-Type: application/json' --data-binary @150kb.json
HTTP/1.1 413 Payload Too Large
{"error":"request entity too large"}          # no correlationId, no x-correlation-id header
```

`app.js` has **no 404 handler and no 405 handler**; `errorHandler` is the last
middleware but Express's `finalhandler` runs first for unmatched paths. The 413 misses
its correlation id because `app.use(express.json())` (`app.js:45`) is mounted **before**
`app.use(requestLogger)` (`app.js:47`), so `req.correlationId` is not set yet when
body-parser throws.

Can the portals render each shape? `admin-portal/src/lib/api.js:49-57` and
`user-portal/src/lib/api.js:10-18` both do
`const body = await res.json().catch(() => null)` then
`new Error(body?.error ?? 'Request failed with status ' + res.status)`. So HTML bodies
degrade to a status-code string (the operator sees "Request failed with status 404" for
a mistyped URL, and "Request failed with status 429" instead of "you are being rate
limited"), and every JSON `error` string is rendered verbatim — including the internal
messages from §2. Neither client ever renders `details`, so zod field errors are
invisible.

The public `/api/v1/join/:token` lookup is the **only unauthenticated route the data
principal hits before consenting**, and it is the one whose rate-limit response is
non-JSON.

---

## 11. [P2] `z.coerce.boolean()` on query strings — `false` means `true`.
##       `includeDeleted=false` returns deleted items.

`Boolean("false") === true`. Two query params use it:

```
backend/src/modules/dsar/dsar.routes.js:27   overdue: z.coerce.boolean().optional(),
backend/src/modules/dsar/dsar.routes.js:58   includeDeleted: z.coerce.boolean().default(false),
```

**OBSERVED** — `GET /api/v1/dsar/5a13e5a1-…/items?limit=200`, dataAdmin:

```
  q=''                       -> items=66  totals={"all":66,"matching":66,"deleted":25,…}
  q='&includeDeleted=false'  -> items=91  totals={"all":66,"matching":91,"deleted":25,…}
  q='&includeDeleted=0'      -> items=91
  q='&includeDeleted=true'   -> items=91

  GET /api/v1/dsar?limit=200
  q=''                -> items=3
  q='&overdue=false'  -> items=0
  q='&overdue=true'   -> items=0
  q='&overdue=0'      -> items=0
```

Asking a DSAR item grid to **exclude** deleted items returns 25 deleted ones — on the
surface whose whole purpose is telling a regulator what is and is not still held.
`totals.all` (66) and `totals.matching` (91) disagree in the same payload, so the
"this is everything, asserted from the database" claim in the comment at
`dsar.routes.js:313-316` is false in exactly this case.

Today's portals dodge it by never sending `false`
(`admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx:204`
`includeDeleted: filters.includeDeleted ? 'true' : undefined`, and
`DsarQueue.jsx:68` `if (overdueOnly) params.overdue = 'true'`), so the UI is currently
correct by accident. Any script, integration, curl user or future client that sends the
documented `false` gets the inverse.

---

## 12. [P2] `createDocumentSchema` is dead code — the text-document upload body is
##       entirely unvalidated.

`backend/src/modules/documents/document.routes.js:18-21` defines:

```js
const createDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Untitled Document'),
  textContent: z.string().min(1),
})
```

A repo-wide grep for `createDocumentSchema` returns **exactly one hit — the definition**.
The handler at line 54-78 instead does:

```js
    let name = req.body.name || 'Untitled Document'
    let textContent = req.body.textContent || ''
    if (req.file) {
      name = req.file.originalname || name
      textContent = req.file.buffer.toString('utf-8')
    }
    if (!textContent || !textContent.trim()) {
      return res.status(400).json({ error: 'Text content is required' })
    }
```

so `name` has no type check, no length cap and no sanitisation, and comes straight from
a client-supplied filename on the multipart path. `textContent` is `.toString('utf-8')`
on arbitrary bytes (the multer instance has no `fileFilter`, §4).

**OBSERVED**:

```
$ curl -s -w '\nHTTP %{http_code}\n' -b c.agent.txt -X POST "…/sessions/$T/documents" \
    -F 'file=@probe_doc.txt;filename=../../../../etc/passwd<img src=x onerror=alert(1)>.txt;type=text/plain'
{"id":"6c9c92c0-9070-4b48-994b-7a90e51b275b",
 "name":"passwd<img src=x onerror=alert(1)>.txt",
 "storagePath":"sessions/05a12fe6-…/text/6c9c92c0-….txt", …}
HTTP 201
```

Filesystem traversal is *not* reachable — `document.service.js:68` builds the path from
the document's own uuid, and the photo/enrollment/recording/video routes likewise use
sha256 or `randomUUID()` (`recording.routes.js:56`, `video.routes.js:51`,
`session.service.js:245`, `enrollment.service.js:86`). But the HTML payload is now
persisted in `text_documents.name` unbounded and un-escaped at the API layer. React
escapes it on render, so this is not exploitable stored XSS **today**; it is an
unvalidated persistence sink that the module's own author wrote a schema for and then
never wired up.

*(This probe created one row, `6c9c92c0-9070-4b48-994b-7a90e51b275b`. There is no
DELETE route for text documents, so I could not remove it.)*

Related: `document.routes.js:167` calls `documentService.readRedactedDocument(sessionId,
documentId)` with no `req.admin`, unlike its `/raw` sibling on line 149 — flagged for
the authz auditor, not mine.

---

## 13. [P2] `express.json()` default 100 kb is applied globally and breaks two real
##       write paths; the resulting 413 has no correlation id.

`app.js:45` — `app.use(express.json())`, no `limit`. Nothing anywhere raises it.

**OBSERVED** — a realistic diarised-recording save:

```
$ node -e "… 800 segments … "        body bytes 123273
$ curl -s -i -b c.agent.txt -X PUT \
    "…/sessions/09aa9054-…/recordings/79f4232e-…/segments" \
    -H 'Content-Type: application/json' --data-binary @segs.json
HTTP/1.1 413 Payload Too Large
{"error":"request entity too large"}
```

An `AudioSegment` row serialises to ~252 bytes (measured from a live row), so the limit
is hit at **~396 segments**. Live data has ≤22 segments per recording because only short
test clips exist; a 30-minute session at conversational turn-taking (2-4 s) produces
450-900. `PUT .../segments` (`recording.routes.js:188`) is the agent's manual-correction
save — losing it means the redaction decisions cannot be persisted.

Same exposure on `PUT .../documents/:id/spans` (`document.routes.js:104`): a `TextSpan`
row is ~266 bytes, so ~375 spans, and `analyzeDocument` on a long transcript can exceed
that.

Also inconsistent within one endpoint: `POST /:sessionId/documents` accepts **10 MB**
of text through the multipart branch (`document.routes.js:13`) and **100 kb** through
the JSON branch.

Near-misses to watch: `packageSchema` allows `itemIds` up to 2000 uuids
(`dsar.routes.js:101`) ≈ 78 kB — inside the limit, but only just;
`itemActionSchema.itemIds` max 1000 ≈ 39 kB.

The 413 carries no `correlationId` and no `x-correlation-id` response header because
`express.json` is mounted before `requestLogger` (`app.js:45` vs `app.js:47`).

---

## 14. [P2] No security headers at all — no helmet, no `X-Content-Type-Options`,
##       no CSP, no `Content-Disposition` on media, `X-Powered-By` advertised.

A grep over `backend/src` and `backend/package.json` for
`helmet|nosniff|X-Content-Type|Content-Security-Policy|hsts` returns **zero** hits.

**OBSERVED** — the full response header set on a media read:

```
$ curl -s -D - -o /dev/null -b c.agent.txt "…/sessions/$S/photos/$PID/file"
HTTP/1.1 200 OK
X-Powered-By: Express
Vary: Origin
Access-Control-Allow-Credentials: true
x-correlation-id: 1f2932a3-…
Cache-Control: private, no-store
Content-Type: image/jpeg
Content-Length: 1500269
ETag: W/"16e46d-…"
```

Missing: `X-Content-Type-Options: nosniff`, `Content-Disposition`,
`Content-Security-Policy`, `Referrer-Policy`, `Strict-Transport-Security`,
`Cross-Origin-Resource-Policy`. Present and unwanted: `X-Powered-By`.

Ironically the *only* responses that carry `nosniff` and a CSP are Express's own HTML
404 pages (§10) — the ones that contain no data.

Can an uploaded file be served back as `text/html`? Not today:

* photos — `mimeType` hard-coded `'image/jpeg'` at `session.service.js:258`;
* enrollments — always re-encoded JPEG, `enrollment.service.js:79-83`;
* documents — `mimeType` hard-coded `'text/plain'`, `document.service.js:64`;
* recordings — **`mimeType: file.mimetype`**, i.e. the client's declared
  `Content-Type` (`recording.service.js:176`), reflected back into the response by
  `sendAudioWithRange` (`recording.routes.js:241`). The `fileFilter` constrains it to
  `audio/*`, so the subtype (not the type) is attacker-chosen. With no `nosniff`, an
  `audio/…` response body is not a practical HTML-sniffing vector in modern browsers,
  but reflecting a client string into a response `Content-Type` at all is wrong.
  **OBSERVED in code**, exploit **INFERRED** and judged not currently reachable.

`extensionFor()` (`recording.service.js:52-54`) maps the mimetype through an allowlist
with a `'bin'` fallback, so the on-disk extension is not attacker-controlled.

---

## 15. [P2] Response bodies leak the internal object-store layout on every photo row.

**OBSERVED**:

```
$ curl -s -b c.agent.txt 'http://localhost:4000/api/v1/sessions/338c7d6e-…' | …
photos in payload: 22
first photo keys: id,sessionId,storagePath,cameraSource,sha256,mimeType,sizeBytes,
                  width,height,takenAt,createdAt,redactedPath,piiStatus,encKeyId
storagePath: sessions/338c7d6e-…/photos/e0edfed2312d62482d00dee2c47dab97f80217a78e12186ccc4e15c4387bbd33.jpg
```

`session.service.js:125` includes the raw `photo` rows with no `select`. The client is
handed `storagePath`, `redactedPath`, `sha256` and `encKeyId` — the sealed-blob layout,
the content hash and the encryption key identifier. `sizeBytes`/`sha256` also make it
trivial for one operator to confirm that a specific file they hold is (or is not) in the
system. Contrast `project.service.js:422-435` and `me.service.js:19`, which both use an
explicit `select` and deliberately withhold storage paths — the session read did not get
the same treatment.

---

## 16. [P2] Every param-level zod error reports `path: []` — the client cannot tell
##       which field failed, and both portals show a bare "Validation failed".

The pattern `uuid.parse(req.params.sessionId)` parses a **scalar**, so `err.issues[].path`
is empty:

```
$ curl -s -b c.dataowner.txt 'http://localhost:4000/api/v1/projects/not-a-uuid'
{"error":"Validation failed","details":[{"validation":"uuid","code":"invalid_string",
  "message":"Invalid uuid","path":[]}],"correlationId":"03394a11-…"}   HTTP 400
```

On a route with three uuid params
(`GET /:sessionId/people/:subjectId/photos/:photoId/redacted`) the response says
"Invalid uuid" with no indication of which. `admin-portal/src/lib/api.js:52` renders
`body.error` — literally the string `Validation failed` — and stores `details` on the
error object without ever displaying it. Requirement 4 ("real error states") is not met
for any validation failure.

Object-schema parses do report the path correctly
(`{"path":["limit"]}`, `{"path":["cursor"]}`, `{"path":["from"]}`), so the fix is to
parse `req.params` as an object rather than the scalars.

---

## 17. [P2] No rate limiting on any data or upload route.

`backend/src/middleware/rateLimiter.js` defines exactly six limiters, all on auth or
the public join flow:

```
line 27  subjectLoginIpLimiter      20 / 15 min
line 28  subjectLoginEmailLimiter    5 / 15 min
line 34  subjectVerifyIpLimiter     30 / 15 min
line 35  subjectVerifyEmailLimiter  10 / 15 min
line 44  joinLookupIpLimiter        60 / 15 min
line 45  joinAcceptIpLimiter        20 / 15 min
line 49  adminLoginIpLimiter        30 / 15 min
```

Nothing on `POST /sessions/:id/photos`, `POST /imports/:id/items`,
`POST /subjects/:id/enrollments`, `POST /sessions/:id/recordings`, the media reads, or
any list endpoint. Combined with §5 (500 MB/request) and §6 (4.3 s of libvips per 1.5 MB)
there is no mechanism that limits a single authenticated agent's resource consumption.

Positives found while checking: `POST /projects/:id/assignments` is idempotent
(returns the existing row rather than a P2002 — see §18), `POST /dsar/:id/items/actions`
is idempotent via `createMany({ skipDuplicates })` at `itemAction.service.js:222-236`
with a `MAX_BATCH` cap, and destructive item actions require a ≥10-character reason
(`itemAction.service.js:205-207`).

---

## 18. Idempotency — what actually happens on a duplicate POST (mostly good)

| POST | Behaviour | Evidence |
|---|---|---|
| `/sessions/:id/photos` (same bytes) | **Idempotent.** sha256 dedupe per session at `session.service.js:235-242`, computed *before* sharp so a duplicate bomb costs nothing. | **OBSERVED**: second POST of `bomb256mp.jpg` → `{"added":0,"duplicates":1,"photos":[{"id":"e0b19a43-…"}]}` (same id) |
| `/imports/:id/items` | Same dedupe (`import.service.js`), response reports `ingested`/`duplicates` | INFERRED from code |
| `/sessions/:id/recordings` | Idempotent, sha256 per session, `recording.service.js:163-169`, `duplicate` flag + 200 vs 201 | INFERRED |
| `/subjects/:id/enrollments` | Idempotent, sha256 per subject, `enrollment.service.js:71-75`, 200 vs 201 | INFERRED |
| `/dsar/:id/items/actions` | Idempotent via unique constraint + `skipDuplicates` | INFERRED (`itemAction.service.js:222-236`) |
| `/projects/:id/assignments` | Idempotent, **but returns 201 for a row that already existed** | **OBSERVED**: re-assigning the already-assigned agent returned `201` with `assignedAt:"2026-07-29T12:48:54.906Z"` |
| `POST /sessions` | **Not idempotent** and no `Idempotency-Key` support. A double-tap creates a second session. | **OBSERVED indirectly**: the live DB holds **19 ACTIVE IMAGE sessions with 0 photos** out of 36 total sessions — abandoned shells with no cleanup path |
| `/sessions/:id/documents` | **Not idempotent** — no sha256 dedupe in `document.service.js:50-85`, unlike every other media type. Re-posting the same file creates a second `TextDocument`. | INFERRED from code |
| `POST /consent/projects/:id/grant`, `POST /me/dsar` | not exercised (need a subject cookie) | — |

No route on the API accepts an `Idempotency-Key` header.

---

## 19. [P3] Unbounded arrays and strings in otherwise-good schemas.

Only the 100 kb JSON body limit stops these:

```
session.routes.js:58   clusterIdsSchema  z.array(uuid).min(1)              — no .max()   (~2500 ids fit in 100 kb)
session.routes.js:59   faceIdsSchema     z.array(uuid).min(1)              — no .max()
recording.routes.js:182 updateSegmentsSchema.segments  z.array(...)        — no .max()
document.routes.js:35  updateSpansSchema.spans         z.array(...)        — no .max()
project.routes.js:28   createSchema.dataTypes  z.array(z.string().min(1))  — no .max(), elements unbounded
consentTemplate.routes.js:17  bodyByLocale  z.record(z.string(), z.string())
                                  — keys not constrained to SUPPORTED_LOCALES, values unbounded
recording.routes.js:170-178  speakerId / reason / piiType  z.string()      — no .max()
document.routes.js:29-31     reason / piiType / textSnippet z.string()     — no .max()
audit.routes.js:36     accessQuerySchema.objectId  z.string()              — no .max(), no format
me.routes.js:182       package token  z.string().min(20)                   — no .max()
auth-admin.validation.js:7,18,26  password / newPassword  z.string()       — no .max()
```

**OBSERVED** for `objectId` (5000 characters accepted straight into a Prisma `where`):

```
$ curl -s -o /dev/null -w 'HTTP %{http_code} t=%{time_total}\n' -b c.dpo.txt \
    --get --data-urlencode "objectId@5000chars.txt" 'http://localhost:4000/api/v1/access-events'
HTTP 200 t=0.198844
```

Passwords go to `bcrypt` (`auth-admin.service.js:1,42,118,168`), which truncates at
72 bytes, so the missing `.max()` there is not a hashing DoS — it is only a missing bound.

---

## 20. [P3] `POST /api/v1/dsar/:requestId/execute` reads its body without a schema.

`dsar.routes.js:220-227`:

```js
    const inline = req.body?.inline !== false
```

`{"inline":"false"}` (a JSON *string*) is `!== false`, so it means `inline: true`.
This is the endpoint that runs a DSAR erasure. Every other body on this router has a
zod schema; this one does not. **INFERRED** — I did not execute a DSAR against live
data.

Similarly `join.routes.js:56` takes `locale` with no schema:
`typeof req.query.locale === 'string' ? req.query.locale : undefined`, passed to
`renderNotice(templateId, locale)`. **OBSERVED** that a 500-character locale reaches
the service (the 404 comes from the token, not from locale validation):

```
$ curl -s "http://localhost:4000/api/v1/join/AAAAAAAAAAAAAAAAAAAAAAAA?locale=xxxx…500…"
{"error":"This join link is not valid. Ask the agent for a new QR code.", …}   HTTP 404
```

Contrast `consentTemplate.routes.js:31`, which parses the same parameter properly
(`localeSchema.parse(req.query.locale ?? 'en')`).

---

## 21. [P3] Numeric fields have no cross-field or domain validation.

```
recording.routes.js:173-174   startSec: z.number().nonnegative()
                              endSec:   z.number().positive()
```
No `.max()`, no refinement that `endSec > startSec`, no check against the recording's
duration. A segment with `startSec: 500, endSec: 1` or `endSec: 1e300` is accepted by
the schema and written by `saveSegments`.

```
document.routes.js:26-27      startChar: z.number().int().min(0)
                              endChar:   z.number().int().min(0)
```
No refinement that `endChar > startChar`, none that either is inside the document's
`charCount`. Redaction slices by these offsets.

**INFERRED** — I did not write bad segments/spans into live rows.

---

## 22. [P3] No boot guard on `CORS_ORIGINS`.

`app.js:42-44`:

```js
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map(s=>s.trim()).filter(Boolean)
  app.use(cors({ origin: corsOrigins, credentials: true }))
```

An unset or empty `CORS_ORIGINS` yields `origin: []`, which matches nothing, so no
`Access-Control-Allow-Origin` header is emitted and **every** browser call from both
portals fails at the CORS layer — with no server-side error and no log line.
`server.js:7-10` guards `AUTH_PROVIDER` in production but not this. **INFERRED**
(dev `.env` has all four origins set; I did not restart with it unset).

---

## Exhaustive validation-coverage table

Routes whose handler performs **no** zod parse of anything it uses:

| Route | What is unvalidated |
|---|---|
| `POST /api/v1/sessions/:sessionId/documents` | the entire body (`name`, `textContent`) — §12 |
| `POST /api/v1/dsar/:requestId/execute` | `body.inline` — §20 |
| `GET /api/v1/dsar/:requestId/purge-jobs/:purgeJobId` | `:requestId` — never parsed, never used — §8 |
| `GET /api/v1/join/:token` | `?locale` — §20 |

Routes whose body is ignored entirely (harmless, but no `.strict()` anywhere so unknown
keys are silently accepted everywhere): `POST /projects/:id/{submit,approve,close}`,
`POST /dsar/:id/discovery`, `POST /handoffs/:id/ingest`,
`POST /consent/projects/:id/{grant,revoke}`, `POST /sessions/:id/{end,finalize}`,
`POST|DELETE /sessions/:id/invite`, `POST /consent-templates/:id/publish`,
`POST /me/dsar/:id/package-token`, `POST /sessions/:id/recordings/:rid/{analyze,redact}`,
`POST /sessions/:id/documents/:did/{analyze,redact}`,
`POST /auth/{admin,subject}/{refresh,logout}`.

Unknown query keys are silently dropped rather than rejected (zod default strip), so a
typo'd filter returns unfiltered data:

```
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' -b c.dpo.txt 'http://localhost:4000/api/v1/audit?limitt=99999&bogus=1'
HTTP 200
```

Everything else parses params, query and body correctly. Param uuid validation is
present and returns a clean 400 on all routes except the one in §8:

```
GET /api/v1/projects/not-a-uuid  -> 400
GET /api/v1/subjects/12345       -> 400
GET /api/v1/dsar/zzz             -> 400
```

---

## Complete probe log (25 live probes)

| # | Probe | Result |
|---|---|---|
| P1-P3 | malformed uuid on `projects/:id`, `subjects/:id`, `dsar/:id` | 400 each, `path: []` |
| P4 | `PATCH /subjects/<uuid>/status` | 500 `Cannot read properties of undefined (reading 'id')` |
| P5 | `POST /subjects` (agent) | 500 same |
| U-REG | `POST /subjects` unauthenticated | 401 |
| P6-P11 | pagination: `dsar?limit=1000000`, `audit?limit=…`, `dsar?cursor=garbage`, `projects`, `sessions` | 400/400/400 "Malformed cursor"; projects+sessions unbounded 200 |
| U1 | photos, `text/plain` part | 500 |
| U2 | photos, bytes spoofed as `image/jpeg` | 500 libvips message |
| U3 | photos, SVG with `<script>` | 201, rasterised to 64×64 JPEG |
| U6 | photos, 26 MB file | 500 "File too large" |
| U7 | photos, 21 files | 500 "Too many files" |
| U8 | photos, 256 MP bomb (1.5 MB) | **201, wall 4.34 s** |
| U9 | photos, 289 MP | 500 "Input image exceeds pixel limit" |
| U10 | photos, exact duplicate | 200-path, `duplicates:1`, same id |
| A1 | photos, `[good,good,bad]` | 500, **2 rows committed** |
| batch | 20 × 10 MB | 500 after 10.7 s, **+200 MB RSS**, not released |
| H1 | media response headers | no nosniff, no CSP, `X-Powered-By` |
| B1 | 150 kB JSON body | 413, no correlationId |
| D1 | `POST /documents` empty body | 400 `{"error":…}` no correlationId |
| D2 | `POST /documents` HTML-in-filename | 201, stored verbatim |
| D3 | `PUT /segments` 800 segments (123 kB) | 413 |
| E1/E2 | unknown route / wrong method | 404 **text/html**, no 405 |
| E3-E6 | non-image on enrollment / voice / video / import | 500 / 415 / 503 / 500 |
| F1 | garbage bytes to the face worker | 400 **with a Python heap address** |
| F3 | 256 MP bomb to the face worker | 400 — worker limit 178.9 MP vs backend 268.4 MP |
| G1 | `photos/AUDIT-PROBE-NOT-A-UUID-…/file` | 400, **AccessEvent row written first** |
| Q4/Q5 | `includeDeleted=false`, `overdue=false` | inverted |
| R1 | 62× public join lookup | 429 **text/html plain text** |
| V1 | `dsar/I-AM-NOT-A-UUID/purge-jobs/<uuid>` | 404, not 400 |
| V2 | `access-events?objectId=<5000 chars>` | 200 |
| L1/L2/L3 | FK-violation and duplicate-insert probes | 404 / 404 / 201 — all pre-guarded, no Prisma text leaked |
| N1-N8 | limit ceilings on subjects / projects-subjects / evidence / lineage / compliance-report | all reject overshoot with 400 |
| S1/S2 | `GET /sessions/<22 photos>` | 14,762 B, 1.32 s, leaks `storagePath`/`sha256`/`encKeyId` |

---

## State I changed (audit hygiene)

* Created and then **deleted** 4 probe photos (2 in `ae66b3b8-…`, 2 in `4e9ff5d3-…`)
  via `DELETE /sessions/:s/photos/:p` — all four returned 204.
* Created **1 `TextDocument`** (`6c9c92c0-9070-4b48-994b-7a90e51b275b`, name
  `passwd<img src=x onerror=alert(1)>.txt`, in session `05a12fe6-…`). There is no
  delete route for text documents; it remains.
* Created **1 `AccessEvent`** (`2d61e5bc-5894-424b-91fa-c19fddc3b912`, objectId
  `AUDIT-PROBE-NOT-A-UUID-1787252477`) — the artefact of §3. The ledger is append-only
  by design; I did not remove it.
* Consumed the public join-lookup rate-limit bucket for `::1` (60/15 min) at ~19:00 UTC.
* No file under the repository was created, edited or deleted. No service restarted.

---

## What I could not check

* **Subject-authenticated routes.** I had no subject session (OTP delivery is
  dev-console only and I chose not to mint a token). So `GET /api/v1/me/photos`,
  `GET /api/v1/me/participations`, `POST /api/v1/me/dsar`,
  `GET /api/v1/me/dsar/:id/package`, `POST /api/v1/consent/projects/:id/{grant,revoke}`
  and `POST /api/v1/join/:token/accept` were read from code but never exercised. The
  unbounded-list and idempotency conclusions for those are INFERRED.
* **Prisma error-text leakage.** I could not find a reachable path that lets a raw
  Prisma error escape — every insert I probed (`participants`, `assignments`) is
  pre-guarded and returns a clean 404. The P2002 `details: err.meta` leak at
  `errorHandler.js:26` is therefore INFERRED, not demonstrated.
* **The purge-job cross-request read.** `purgeJob` is empty in the live database, so I
  proved the missing `:requestId` validation and the missing scoping in code and via the
  404-instead-of-400 behaviour, but could not read another request's job.
* **`processSession` aborting on a bomb.** I proved both pixel limits and the absence of
  a per-photo try/catch by reading `recognition.service.js:104-135`, but I did not push
  a session through the live BullMQ recognition queue.
* **SVG XXE / `file://` in librsvg.** I proved SVG input is accepted and rasterised; I
  did not construct a working local-file-read or SSRF payload.
* **Video routes.** `VIDEO_CAPTURE_ENABLED` is unset, so `POST /sessions/:id/videos`
  503s before multer runs. Its multer config was read, not exercised.
* **Text worker.** `text-worker` (:8004) is down, so
  `POST /documents/:id/analyze` and `/redact` were not exercised.
* **CORS with an empty `CORS_ORIGINS`.** Would require a restart, which the brief
  forbids.
* **Concurrency.** I ran one 200 MB upload, not N concurrent ones — the 500 MB/request
  and OOM projections are linear extrapolations from a single measured request, not an
  observed failure.
* **`npm test`** was not run (19 minutes, out of scope per the brief). I did not check
  whether any existing test covers the `req.user` bug; grep suggests not, since the RBAC
  matrix test asserts only status classes and a 500 is neither 401 nor 403.
