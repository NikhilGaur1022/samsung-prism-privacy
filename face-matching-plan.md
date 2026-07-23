# Face Enrollment → Auto-Match → People View — Executable Implementation Plan

> **How to use this file in a fresh chat:**
> `Read face-matching-plan.md and implement all 6 phases end to end. Do not run tests — I will test.`
> Everything needed is in this document: exact file paths, exact code shapes, env vars,
> infrastructure setup, migration commands and a startup sequence. No re-exploration required.

**Goal.** Capture a face at registration → auto-match every uploaded session photo against the
enrolled roster → present Google-Photos-style people cards → agent confirms/corrects what the
model was unsure about → finalize → hand the consent-mapped batch downstream.

---

## 0. Repo map (verified — do not re-explore)

```
samsung project/
├── backend/                     Node 20 ESM, Express, Prisma, BullMQ. Port 4000.
│   ├── prisma/schema.prisma     Subject, Project, ProjectConsent, Session, SessionParticipant,
│   │                            Photo, FaceDetection, FaceCluster, PhotoSubject, RecognitionJob
│   ├── src/config/              prisma.js · qdrant.js (3 lines) · redis.js
│   ├── src/lib/                 storage.js · faceQueue.js · consent.js · auditLog.js · logger.js
│   ├── src/middleware/          requireAdminAuth · requireSubjectAuth · requireRole · errorHandler
│   ├── src/modules/             subjects · projects · sessions · consent · auth-admin · auth-subject
│   ├── src/workers/recognition.worker.js   detect → crop → cluster → (MATCH GOES HERE)
│   └── src/server.js            route mounting + /health/deep
├── face-worker/                 FastAPI + insightface buffalo_l. Port 8001. main.py = 51 lines.
├── ai-core/prism-visual-pipeline/   ★ REFERENCE IMPLEMENTATION — harvest, don't rerun
│   └── app/services/            qdrant_session.py · face_encoder.py · face_matcher.py · image_redactor.py
├── admin-portal/                React + Vite + Tailwind. Port 5181.
│   └── src/pages/collectionAgent/  Assignments · NewSession · Sessions · SessionDetail
│                                   SubjectVerification · ConsentCheck · Tagging · ReviewPhotos
└── user-portal/                 React + Vite. Port 5173. Register · Verify · ConsentHub · Projects
```

### Existing code that is already correct — reuse, do not rewrite

| Location | What it already does |
|---|---|
| `face-worker/main.py` `POST /detect` | image → `[{bbox:[x1,y1,x2,y2], det_score, embedding[512]}]`, L2-normalised |
| `recognition.worker.js` | reads photo → `/detect` → `FaceDetection` rows → 256×256 crop via sharp → greedy centroid clustering (`CLUSTER_THRESHOLD=0.4`) → `FaceCluster` rows → job progress → audit → drops embeddings |
| `session.service.js` | `createSession` `addParticipant` (consent-gated) `addPhoto` (sha256 dedup) `endSession` (enqueue) `getClusters` (roster + clusters) `tagCluster` (roster-enforced) `getPhotosForReview` `finalizeSession` (consent re-check → `PhotoSubject` → ARCHIVED) |
| `session.routes.js` | multer 25 MB/20 files, `requireAdminAuth` + `requireRole('collectionAgent','super_admin')`, zod validation, media served through ownership checks |
| `lib/consent.js` | `consentVerdict()` / `isEligible()` / `signConsent()` — the single consent authority |
| `lib/storage.js` | `writeFile` `readFile` `deleteFile` `resolvePath`, rooted at `STORAGE_ROOT` |
| `lib/auditLog.js` | `writeAuditLog({entityType, entityId, action, actorId, payload})` |
| `admin-portal/src/lib/api.js` | `request()` with 60 s GET cache + prefix busting, `mediaUrl.photo/.faceCrop`, all session calls |
| `Tagging.jsx` / `ReviewPhotos.jsx` | cluster cards with roster dropdown; bbox overlay review page |
| Prisma `FaceCluster.suggestedSubjectId` | **declared but never written** — this is the auto-match output slot, already wired into `getClusters` response |

### Reference implementation to harvest (`ai-core/prism-visual-pipeline/app/services/`)

- **`qdrant_session.py`** — per-session collection lifecycle: `create_session` (512-d, COSINE),
  `add_enrollment(session_id, consent_id, embedding, payload)`, `search_face` → `(consent_id, score, payload)`,
  `list_enrollments`, `delete_session`. Collections named `session_{session_id}`.
  → **Port to Node** as `backend/src/lib/faceGallery.js` (the `@qdrant/js-client-rest` dep already exists).
- **`face_encoder.py`** `extract_single` — largest face, returns `(embedding, det_score)`, raises on zero faces.
  → **Port to Python** as the `/embed` endpoint in `face-worker/main.py`.
- **`image_redactor.py`** — Gaussian blur (`kernel 99`, `sigma 30`) over bbox list.
  → **Port to Python** as the `/redact` endpoint in `face-worker/main.py` (Phase 5).
- **`face_matcher.py`** — the threshold decision logic. Reimplement inline in the Node worker.
- Discard: `app/api/*`, `staging.py`, `demo.html`, `upload_pipeline.py` — the Node backend owns
  routing, authz, consent and persistence.

### The one real gap

**No face is captured anywhere at registration.** `user-portal/src/pages/Register.jsx` and
`admin-portal/src/pages/collectionAgent/SubjectVerification.jsx` have no selfie step, and there is
no enrollment table. The matching gallery is empty, so nothing downstream can work.

---

## 1. Architectural decisions (already made — implement, don't re-litigate)

**D1 — Store the enrollment selfie, never a persisted embedding.**
`schema.prisma:343` states embeddings are never persisted. Keep that invariant. At session start,
re-encode the roster's stored selfies into an **ephemeral** Qdrant collection `session_{sessionId}`;
delete the collection at finalize. Vectors live for minutes.
*Why:* no permanent biometric template; DSAR erase = delete one row + its files, no vector-store
reconciliation; and `qdrant_session.py` was written for exactly this ephemeral shape.
*Cost:* one re-encode per roster member per session — 10–50 people × ~50 ms CPU. Negligible.

**D2 — Up to 3 selfies per subject**, each stored as its own Qdrant point carrying the same
`masterUserId` payload. Multi-reference matching is the single largest accuracy win available and
costs nothing structurally.

**D3 — Match at cluster level, not face level.** The worker already groups a session's faces into
per-person clusters and maintains a running centroid. One decision per cluster = one decision per
people-card, and a centroid is a far better probe than one possibly-blurry profile face.

**D4 — Three threshold bands** (all env-tunable, no deploy needed):

```
score = cosine(cluster centroid, best gallery point)     # Qdrant COSINE, embeddings L2-normalised

score >= 0.55  → tagStatus=TAGGED,  taggedSubjectId set, autoTagged=true   "Auto-tagged"
0.38 <= score < 0.55 → tagStatus=PENDING, suggestedSubjectId set           "Is this Asha?"
score <  0.38  → tagStatus=PENDING, no suggestion                          "Unidentified"
```

Bias is deliberately conservative: a missed match costs the agent one click; a wrong auto-tag puts
a person's face into a stranger's consent bucket. `finalizeSession` re-checks consent regardless,
so an auto-tag can never bypass the consent gate.

**D5 — Gallery is roster-scoped only.** Never the whole subject DB. Both an accuracy win
(10–50 candidates instead of 10,000) and the existing roster rule enforced in `tagCluster`.

**D6 — Enrollment requires `biometricMatch` consent.** Hard 409 otherwise. Revoking consent or a
DSAR erase deletes the enrollment row and its image files.

---

## 2. Data lineage (maps to `context/dataflow diagram dsar.jpg`, steps 4–9)

```
[Data Subject Portal]  register → grant project consent (HMAC-signed)
      │  biometricMatch = true   ← gates everything below
      ▼
  SELFIE CAPTURE (1–3 shots, webcam or file)   quality gate: exactly 1 face, det_score >= 0.70
      ▼
  subject_face_enrollments row  +  storage/enrollments/{masterUserId}/{uuid}.jpg
      │  (image only — no vector persisted)
      │  consent revoke / DSAR erase ──► row soft-deleted, files removed, audit written
      ▼
[Collection Agent Portal]  create session → add roster (consent re-read from DB at add time)
      ▼
  END SESSION: build ephemeral Qdrant collection session_{sessionId}
      │  each roster selfie → POST /embed → upsert point {masterUserId, consentId, fullName}
      ▼
  RecognitionJob → BullMQ → recognition.worker
      │  POST /detect per photo → face_detections (bbox, det_score, crop 256×256)
      │  greedy cluster → face_clusters
      │  centroid → gallery search → taggedSubjectId | suggestedSubjectId | ∅   (+ matchScore)
      │  embeddings dropped from process memory
      ▼
[People View]  cards: Auto-tagged · Confirm these · Unidentified
      │  agent confirms / corrects / merges / splits / marks NOT_A_FACE
      ▼
  FINALIZE
      │  consent re-verified per subject (a revoke wins retroactively)
      │  photo_subjects(photoId, subjectId, consentId)   ← THE lineage link
      │  UNKNOWN / untagged bystander faces blurred → redacted derivative written
      │  session ARCHIVED · Qdrant collection DELETED · handoff record emitted
      ▼
[Consent Mapping Engine → PII/Redaction Engine → Data Team Admin Portal]   (steps 7–9)
      ▼
[Central Secure DB + Immutable Audit Log]
```

DSAR erasure walks `photo_subjects.consentId` exactly like `media_assets` — no new erasure path is
needed for session photos, only for enrollments.

---

## 3. Prerequisites — infrastructure (do this FIRST)

### 3.1 Qdrant (currently DOWN — Phase 2 hard-fails without it)

`backend/src/config/qdrant.js` already builds a client from `QDRANT_URL`, and `/health/deep`
already probes it. Only the server itself is missing.

**Preferred — Docker:**
```powershell
docker run -d --name prism-qdrant -p 6333:6333 -p 6334:6334 `
  -v "$env:USERPROFILE\qdrant_storage:/qdrant/storage" qdrant/qdrant:latest
```

**No Docker — portable binary:** download `qdrant-x86_64-pc-windows-msvc.zip` from
`https://github.com/qdrant/qdrant/releases`, extract next to the existing portable Redis on the
Desktop, run `qdrant.exe`. Defaults to `:6333`.

**Verify:** `curl http://localhost:6333/healthz` → `healthz check passed`, then
`curl http://localhost:4000/health/deep` → `{"postgres":true,"qdrant":true}`.

If neither is possible, the fallback is an in-process brute-force gallery — see §9.

### 3.2 Environment variables

Append to `backend/.env` (existing keys: `DATABASE_URL`, `DIRECT_URL`, `QDRANT_URL`,
`STORAGE_ROOT`, `NODE_ENV`, `PORT`, `CORS_ORIGINS`, `REDIS_URL`, `RESEND_*`, `JWT_*`,
`APP_BASE_URL`, `ADMIN_APP_BASE_URL`, `AUDIT_HMAC_SECRET`, `FACE_SERVICE_URL`,
`FACE_CLUSTER_THRESHOLD`):

```ini
QDRANT_URL=http://localhost:6333          # confirm this is set, not blank
FACE_MATCH_THRESHOLD=0.38                 # below this → Unidentified
FACE_AUTO_TAG_THRESHOLD=0.55              # at/above this → auto-tag
FACE_ENROLL_MIN_DET_SCORE=0.70            # selfie quality gate
FACE_MAX_ENROLLMENTS_PER_SUBJECT=3
FACE_BLUR_KERNEL=99
FACE_BLUR_SIGMA=30
```

### 3.3 Full startup sequence (5 services)

```powershell
# 1. Redis (portable, on Desktop)
& "$env:USERPROFILE\Desktop\redis-portable\redis-server.exe"
# 2. Qdrant (see 3.1)
# 3. face-worker — MUST be started from its own directory
cd "face-worker"; .\.venv\Scripts\python.exe -m uvicorn main:app --port 8001
# 4. backend API + worker (separate terminals)
cd backend; npm run dev
cd backend; npm run worker
# 5. portals
cd admin-portal; npm run dev     # 5181
cd user-portal;  npm run dev     # 5173
```

Known env quirks: Redis is portable on the Desktop and its version is below BullMQ's stated
minimum — it warns but works. `face-worker` must run from its own directory or insightface model
resolution fails. No new npm or pip dependencies are required by this plan
(`@qdrant/js-client-rest`, `sharp`, `multer`, `insightface`, `opencv` via insightface, `numpy`,
`pillow` are all already installed).

---

## 4. Phase 1 — Enrollment capture (the blocking gap)

### 1.1 `backend/prisma/schema.prisma`

Add after the `Subject` model:

```prisma
enum EnrollmentSource {
  SELF          // captured by the subject in user-portal
  AGENT         // captured by a collection agent in admin-portal
}

// The enrollment SELFIE is persisted; its embedding is NOT. Vectors are derived
// on demand into an ephemeral per-session Qdrant collection and destroyed with it.
// This keeps the no-persisted-biometric-template invariant stated on FaceDetection.
model SubjectFaceEnrollment {
  id         String           @id @default(uuid()) @db.Uuid
  subjectId  String           @map("subject_id") @db.Uuid
  imagePath  String                                    // relative to STORAGE_ROOT
  sha256     String
  detScore   Float
  width      Int?
  height     Int?
  source     EnrollmentSource
  capturedBy String?          @db.Uuid                 // AdminUser.id when source=AGENT
  createdAt  DateTime         @default(now())
  deletedAt  DateTime?                                 // soft delete; file removed immediately

  subject Subject @relation(fields: [subjectId], references: [masterUserId], onDelete: Cascade)

  @@unique([subjectId, sha256])
  @@index([subjectId, deletedAt])
  @@map("subject_face_enrollments")
}
```

Add the back-relation to `Subject` (next to `taggedFaces`):
```prisma
  faceEnrollments SubjectFaceEnrollment[]
```

Then:
```powershell
cd backend
npx prisma migrate dev --name add_subject_face_enrollments
npx prisma generate
```

### 1.2 `face-worker/main.py` — add `POST /embed`

Port `extract_single` from `ai-core/prism-visual-pipeline/app/services/face_encoder.py`.
Keep the existing `/detect` untouched; reuse the module-level `face_app` singleton.

```python
@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    """Single-face embedding for enrollment selfies.

    Returns the LARGEST face when several are present (a bystander in frame must
    not silently become the enrolled identity — the caller sees face_count and
    can reject). 400 when no face is found at all.
    """
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unreadable image: {exc}") from exc

    bgr = np.array(image)[:, :, ::-1]
    faces = face_app.get(bgr)
    if not faces:
        raise HTTPException(status_code=400, detail="No face detected in the image")

    faces.sort(key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)
    face = faces[0]
    return {
        "embedding": [float(v) for v in face.normed_embedding],
        "det_score": float(face.det_score),
        "bbox": [float(v) for v in face.bbox],
        "face_count": len(faces),
    }
```

### 1.3 `backend/src/modules/enrollment/` — new module (3 files)

**`enrollment.service.js`**

```js
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { prisma } from '../../config/prisma.js'
import { ApiError } from '../../middleware/errorHandler.js'
import { writeAuditLog } from '../../lib/auditLog.js'
import { writeFile, deleteFile } from '../../lib/storage.js'

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL ?? 'http://localhost:8001'
const MIN_DET_SCORE = Number(process.env.FACE_ENROLL_MIN_DET_SCORE ?? 0.7)
const MAX_PER_SUBJECT = Number(process.env.FACE_MAX_ENROLLMENTS_PER_SUBJECT ?? 3)
```

Exports:

- **`embedImage(buffer, filename)`** — POSTs multipart to `${FACE_SERVICE_URL}/embed` using the
  same `FormData` + `Blob` pattern as `detectFaces` in `recognition.worker.js`.
  Throws `ApiError(503, 'Face service unavailable')` on connection failure and
  `ApiError(400, <detail>)` on a 400 from the worker.

- **`createEnrollment({ subjectId, file, source, capturedBy })`**
  1. Load subject; 404 if missing; 409 if `subject.status !== 'ACTIVE'`.
  2. **Consent gate:** 409 `'Biometric matching consent not given'` unless
     `subject.biometricMatch === true`. *(Note: `Subject.biometricMatch` is documented as an
     intake-time UX default. It is the only biometric-specific flag that exists today, so use it
     here and leave a TODO pointing at `project_consent_matrix` from backend-plan.md Phase 2.)*
  3. Count live enrollments (`deletedAt: null`); 409 if `>= MAX_PER_SUBJECT`.
  4. `embedImage(file.buffer)`; reject 400 if `det_score < MIN_DET_SCORE`
     (`'Face not clear enough — retake in better light, facing the camera'`)
     or if `face_count > 1` (`'More than one face in the photo — retake alone'`).
  5. `sha256 = createHash('sha256').update(file.buffer).digest('hex')`; if a live row already has
     that sha for this subject, return `{ duplicate: true, enrollment: existing }`.
  6. Normalise before storing:
     `sharp(buffer).rotate().resize(1024,1024,{fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer()`,
     read `metadata()` for width/height.
  7. `writeFile(`enrollments/${subjectId}/${randomUUID()}.jpg`, normalised)`.
  8. Create the row. **Discard the embedding — never persist it.**
  9. `writeAuditLog({ entityType:'Subject', entityId:subjectId, action:'ENROLLMENT_CAPTURED', actorId:capturedBy, payload:{ enrollmentId, source, detScore } })`.

- **`listEnrollments(subjectId)`** — live rows, no image bytes: `{ id, detScore, source, createdAt }`.

- **`deleteEnrollment(enrollmentId, actorId)`** — set `deletedAt`, `deleteFile(imagePath)`,
  audit `ENROLLMENT_DELETED`. Idempotent.

- **`deleteAllEnrollments(subjectId, actorId, reason)`** — used by consent-revoke and DSAR erase.
  Soft-deletes every live row, removes every file, audits `ENROLLMENT_PURGED` with `{ reason, count }`.

- **`readEnrollmentImage(enrollmentId)`** — `{ path, mimeType: 'image/jpeg' }` for the media route.

**`enrollment.routes.js`** — two routers exported separately, because the two callers authenticate
differently:

```
// agentEnrollmentRoutes: requireAdminAuth + requireRole('collectionAgent','super_admin')
POST   /api/v1/subjects/:subjectId/enrollments      multer single('selfie'), memoryStorage,
                                                    limits { fileSize: 10*1024*1024, files: 1 },
                                                    fileFilter image/* only  → source:'AGENT',
                                                    capturedBy: req.admin.id
GET    /api/v1/subjects/:subjectId/enrollments
GET    /api/v1/subjects/:subjectId/enrollments/:id/image    // sendFile via resolvePath, private cache
DELETE /api/v1/subjects/:subjectId/enrollments/:id

// selfEnrollmentRoutes: requireSubjectAuth
// subjectId is ALWAYS req.subject.masterUserId — never read it from the path, or one subject
// could enroll their face against another subject's identity.
POST   /api/v1/me/enrollments
GET    /api/v1/me/enrollments
DELETE /api/v1/me/enrollments/:id
```

Validate every id with `z.string().uuid()`, mirroring `session.routes.js`.

**`enrollment.validation.js`** — the zod schemas above.

### 1.4 `backend/src/server.js` — mount

```js
import { agentEnrollmentRoutes, selfEnrollmentRoutes } from './modules/enrollment/enrollment.routes.js'
...
app.use('/api/v1/subjects', agentEnrollmentRoutes)   // BEFORE subjectRoutes — that router applies
                                                     // requireAuth (a dev stub) and owns a bare /:id
app.use('/api/v1/me', selfEnrollmentRoutes)
```

### 1.5 Consent-revoke and DSAR hooks

`backend/src/modules/consent/consent.service.js` → `revokeConsent`: after the existing revoke
writes, check whether the subject still holds any `ACTIVE` `ProjectConsent`. If none remain, call
`deleteAllEnrollments(subjectId, subjectId, 'ALL_CONSENT_REVOKED')`. If some remain, keep the
enrollment — it is still lawfully held for the other project.

`backend/src/modules/subjects/subject.service.js` → `updateStatus`: when a subject moves to a
terminated/erased status, call `deleteAllEnrollments(masterUserId, actorId, 'SUBJECT_STATUS_CHANGE')`.

### 1.6 Frontend — selfie capture

**`admin-portal/src/components/SelfieCapture.jsx`** and an identical copy at
**`user-portal/src/components/SelfieCapture.jsx`** (the two portals share no component library):

- `navigator.mediaDevices.getUserMedia({ video: { facingMode:'user', width:1280, height:720 } })`
  into `<video autoPlay playsInline muted>`; capture to an offscreen `<canvas>`;
  `canvas.toBlob(blob => onCapture(blob), 'image/jpeg', 0.92)`.
- Always render an `<input type="file" accept="image/*" capture="user">` fallback — getUserMedia
  requires HTTPS or localhost and will be blank on a LAN IP.
- Stop tracks in the `useEffect` cleanup (`stream.getTracks().forEach(t => t.stop())`) or the
  camera light stays on after navigation.
- Props `{ onCapture(blob), busy, error }`; retake button; live `n of 3 photos added` counter.

**`admin-portal/src/lib/api.js`** — add (multipart, so bypass `request()` exactly like
`uploadPhotos` already does):

```js
export async function addEnrollment(subjectId, blob) { /* POST /api/v1/subjects/:id/enrollments */ }
export function listEnrollments(subjectId) { ... }
export function deleteEnrollment(subjectId, id) { ... }
export const enrollmentImageUrl = (subjectId, id) =>
  `${BASE_URL}/api/v1/subjects/${subjectId}/enrollments/${id}/image`
```

`user-portal/src/lib/api.js` — the same three against `/api/v1/me/enrollments`.

**`SubjectVerification.jsx`** — after the existing OTP-verify step, add a "Face enrollment" panel
for the selected subject: thumbnails of existing enrollments, `SelfieCapture`, delete buttons.
Show a "Not enrolled — cannot be auto-matched" badge in the subject list when the count is 0.

**`user-portal/src/pages/Register.jsx`** — add a final, skippable step after consent:
"Add your photo so your pictures can be found automatically." Explain that skipping means an agent
tags manually. Only offer it once `biometricMatch` consent is recorded.

---

## 5. Phase 2 — Session gallery build

### 2.1 `backend/src/lib/faceGallery.js` — new (Node port of `qdrant_session.py`)

```js
import { randomUUID } from 'node:crypto'
import { qdrant } from '../config/qdrant.js'
import { logger } from './logger.js'

const DIM = 512
const collectionName = (sessionId) => `session_${sessionId}`
```

Exports:

- **`createGallery(sessionId)`** — `qdrant.createCollection(name, { vectors: { size: DIM, distance: 'Cosine' } })`.
  Swallow a 409 "already exists" so a rerun of `endSession` is idempotent.
- **`galleryExists(sessionId)`** — `getCollection` in a try/catch.
- **`addEnrollmentPoint(sessionId, { embedding, masterUserId, consentId, fullName, enrollmentId })`**
  — `qdrant.upsert(name, { wait: true, points: [{ id: randomUUID(), vector: embedding, payload: {...} }] })`.
- **`searchGallery(sessionId, embedding, limit = 1)`** — `qdrant.search(name, { vector: embedding, limit, with_payload: true })`
  → `[{ score, payload }]`. **No thresholding here** — the worker owns the bands so all three
  decisions are visible in one place.
- **`destroyGallery(sessionId)`** — `deleteCollection`; swallow 404. Never let it throw into a
  finalize transaction.

`@qdrant/js-client-rest` uses camelCase methods (`createCollection`, `getCollection`, `upsert`,
`search`, `deleteCollection`) with snake_case option keys (`with_payload`).

### 2.2 `session.service.js` → `endSession` — build the gallery before enqueuing

Insert after `dropRevokedParticipants(...)` and the `photosTotal === 0` guard, before the
`prisma.$transaction` that creates the `RecognitionJob`:

```js
const gallery = await buildSessionGallery(sessionId, admin.id)
```

New private function in the same file:

1. Load participants with `subject: { include: { faceEnrollments: { where: { deletedAt: null } } } }`.
2. `await createGallery(sessionId)`.
3. For each live enrollment: `readFile(imagePath)` → `embedImage(buffer)` (import from the
   enrollment service — one shared code path, no duplicated fetch logic) →
   `addEnrollmentPoint(sessionId, { embedding, masterUserId, consentId: participant.consentId, fullName })`.
4. Collect `enrolled[]` and `notEnrolled[]` (participants with zero live enrollments).
5. **Fail loudly** if Qdrant is unreachable:
   `throw new ApiError(503, 'Face gallery unavailable — is Qdrant running?')`.
   Silently skipping the match step is the worst possible failure mode here. A single enrollment
   that fails to embed is logged and skipped, not fatal.
6. Audit `GALLERY_BUILT` with `{ points, subjects: enrolled.length, notEnrolled }`.
7. Return `{ points, notEnrolled }` and surface it in the `endSession` response so
   `SessionDetail.jsx` can warn *"3 people have no enrolled photo and will need manual tagging."*

### 2.3 Teardown

- `finalizeSession` — `destroyGallery(sessionId)` **after** the `$transaction` commits, wrapped in
  try/catch, audit `GALLERY_DESTROYED`. A teardown failure must never roll back a finalize.
- `recognition.worker.js` `failed` handler — when the final attempt fails and the session flips to
  `FAILED`, also `destroyGallery`.
- **Orphan sweep** in `backend/src/lib/cleanup.js` (the file already exists): list collections
  matching `^session_`, drop any whose session is `ARCHIVED` / `FAILED` / missing.

---

## 6. Phase 3 — Match inside the recognition worker

### 3.1 `schema.prisma` — two columns so a tag's provenance is auditable

```prisma
model FaceCluster {
  ...
  matchScore Float?   @map("match_score")
  autoTagged Boolean  @default(false) @map("auto_tagged")
}
```
`npx prisma migrate dev --name add_cluster_match_metadata`

### 3.2 `backend/src/workers/recognition.worker.js`

Add at the top:
```js
import { searchGallery } from '../lib/faceGallery.js'

const MATCH_THRESHOLD    = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.38)
const AUTO_TAG_THRESHOLD = Number(process.env.FACE_AUTO_TAG_THRESHOLD ?? 0.55)
```

`clusterFaces` already maintains an incrementally-updated, re-normalised `centroid` on every
cluster — **use it directly, no recomputation needed.**

Replace the cluster-creation loop in `processSession` with:

```js
for (const cluster of clusters) {
  const rep = cluster.members.reduce((a, b) => (a.detScore >= b.detScore ? a : b))

  // One gallery probe per person-group, not per face: the centroid is a cleaner
  // signal than any single frame, and it keeps the decision 1:1 with the card
  // the agent will see.
  let match = null
  try {
    const [top] = await searchGallery(sessionId, cluster.centroid, 1)
    if (top && top.score >= MATCH_THRESHOLD) match = top
  } catch (err) {
    logger.warn({ err, sessionId }, 'gallery search failed — cluster left for manual tagging')
  }

  const subjectId  = match?.payload?.masterUserId ?? null
  const autoTagged = Boolean(match && match.score >= AUTO_TAG_THRESHOLD)

  const created = await prisma.faceCluster.create({
    data: {
      sessionId,
      repFaceId: rep.id,
      faceCount: cluster.members.length,
      matchScore: match?.score ?? null,
      autoTagged,
      tagStatus:          autoTagged ? 'TAGGED'  : 'PENDING',
      taggedSubjectId:    autoTagged ? subjectId : null,
      suggestedSubjectId: subjectId,   // set in BOTH bands — an auto-tag the agent later
                                       // overrides should still show what was suggested
    },
  })

  await prisma.faceDetection.updateMany({
    where: { id: { in: cluster.members.map((m) => m.id) } },
    data: {
      clusterId: created.id,
      ...(autoTagged && { tagStatus: 'TAGGED', taggedSubjectId: subjectId }),
    },
  })
}
```

Extend the completion audit payload:
```js
payload: { photos: photos.length, clusters: clusters.length, autoTagged, suggested, unidentified }
```

Update the comment above `detected.length = 0`: embeddings are still dropped, but they are now
*searched* against an ephemeral gallery first. State that explicitly so the invariant does not
read as violated.

### 3.3 `session.service.js` → `getClusters`

The response already carries `suggestedSubjectId`. Add `matchScore` and `autoTagged` to the mapped
cluster object, and resolve `suggestedSubjectId` to a name using the roster it already loads —
the UI needs *"Is this Asha?"*, not a UUID.

---

## 7. Phase 4 — People view (the Google Photos surface)

### 4.1 Backend — `session.service.js` + `session.routes.js`

**`getPeople(sessionId, admin)`** → `GET /api/v1/sessions/:sessionId/people`

```js
{
  status: 'TAGGING',
  people: [{
    subjectId, fullName, email,
    coverFaceId,          // repFaceId of the largest cluster for this subject
    photoCount,           // DISTINCT photoId across all their clusters
    faceCount,
    clusterIds: [...],
    source: 'AUTO' | 'MANUAL' | 'MIXED',
    matchScore,           // best score across their clusters
  }],
  pending: [{             // needs a decision — drives the "Confirm these" section
    clusterId, repFaceId, faceCount, matchScore,
    suggestedSubjectId, suggestedName,   // null ⇒ Unidentified
  }],
  roster: [{ masterUserId, fullName, email, enrolled: bool }],
  counts: { autoTagged, suggested, unidentified, notAFace },
}
```

Implementation: one `faceCluster.findMany` with `faces: { select: { photoId: true } }`, grouped in
JS by `taggedSubjectId`. Session scale is tens of clusters — no need for a raw aggregate query.

**`getPersonPhotos(sessionId, subjectId, admin)`** → `GET /api/v1/sessions/:sessionId/people/:subjectId/photos`
Returns the distinct photos containing any face tagged to that subject, each with its face bboxes
so the UI can highlight. Reuse the shape `getPhotosForReview` already returns.

**`mergeClusters(sessionId, { clusterIds }, admin)`** → `POST /api/v1/sessions/:sessionId/clusters/merge`
The clusterer splits one person across two cards when lighting or pose differ. Repoint every
`FaceDetection` of the source clusters at the target (largest) cluster, sum `faceCount`, delete the
emptied clusters. `assertStatus(session, 'TAGGING')`. Audit `CLUSTERS_MERGED`.

**`splitFaces(sessionId, clusterId, { faceIds }, admin)`** → `POST /api/v1/sessions/:sessionId/clusters/:clusterId/split`
The inverse: the clusterer merged two people. Move `faceIds` into a **new** `FaceCluster` with
`tagStatus: 'PENDING'`, no suggestion, `repFaceId` = highest-detScore of the moved set; decrement
the source `faceCount`. Audit `CLUSTER_SPLIT`.

**`acceptSuggestions(sessionId, { clusterIds }, admin)`** → `POST /api/v1/sessions/:sessionId/clusters/accept-suggestions`
Bulk-confirm. For each cluster, apply its own `suggestedSubjectId` through the **same roster check
`tagCluster` already performs** — do not bypass it. Skip (don't fail) clusters with no suggestion.
Audit `SUGGESTIONS_ACCEPTED` with the count.

Wire all four into `session.routes.js` with zod-validated uuids, following the existing handler
shape exactly (`try { ... } catch (err) { next(err) }`).

### 4.2 `admin-portal/src/lib/api.js`

```js
export function getPeople(sessionId)
export function getPersonPhotos(sessionId, subjectId)
export function mergeClusters(sessionId, clusterIds)
export function splitFaces(sessionId, clusterId, faceIds)
export function acceptSuggestions(sessionId, clusterIds)
```

All go through the existing `request()` helper — mutations already bust the `/sessions/:id/*`
cache prefix automatically.

### 4.3 `admin-portal/src/pages/collectionAgent/People.jsx` — new

Circular face-card grid (`mediaUrl.faceCrop(sessionId, coverFaceId)`, `rounded-full`,
`aspect-square object-cover`), name under each card, `n photos` caption. Clicking a card opens a
photo grid for that person — either a modal or a `?person=<id>` query param on the same page.
Match the existing visual language: `rounded-card bg-surface p-4 shadow-card`, `text-ink-faint`,
`StatusPill`, `EmptyState`, `Sidebar` + `PageHeader` layout, `lucide-react` icons.

### 4.4 Rework `Tagging.jsx` into three sections

Keep `ClusterCard` and its roster-only `<select>` — that constraint is the whole point of
roster-scoping and must survive the rework.

1. **Confirm these** — clusters with a `suggestedSubjectId` and `tagStatus === 'PENDING'`.
   Card shows *"Is this Asha? (0.47)"* with **Yes** / **No, someone else** (falls back to the
   dropdown). Header button: **Accept all N suggestions** → `acceptSuggestions`.
2. **Unidentified** — `PENDING`, no suggestion. Current dropdown behaviour, unchanged.
3. **Auto-tagged** — collapsed `<details>` section, each card showing the name, the score and an
   **Change** control that reopens the dropdown. These are already `TAGGED`, so they do not block
   finalize — but they must remain visible and overridable, never hidden.

Selection mode (checkbox on each card) enables **Merge selected**; a face-level picker inside a
card enables **Split**.

The existing gate — `disabled={busy || pending > 0 || data.status !== 'TAGGING'}` — stays; now
`pending` counts only sections 1 and 2.

### 4.5 `App.jsx` + `roles.js`

```jsx
<Route path="/sessions/:sessionId/people" element={
  <RequireRole allow={['collectionAgent']}><People /></RequireRole>
} />
```
(Add alongside the existing `/sessions/:sessionId/tagging` and `/review` routes; it is a detail
route, so it does **not** go in `PAGE_COMPONENTS` or `ROLES.collectionAgent.nav`.)

Navigation chain: `SessionDetail` → *End session* → `Tagging` → *Review photos* → `ReviewPhotos`
→ *Finalize*. Insert **People** as a peer of Tagging, linked from both `Tagging.jsx` and
`SessionDetail.jsx` once the session status is `TAGGING`.

---

## 8. Phase 5 — Review, redaction and finalize hardening

### 5.1 `ReviewPhotos.jsx`

Already overlays bboxes from `getPhotosForReview`. Add:
- Border colour by `tagStatus`: green `TAGGED`, amber suggested-pending, grey `UNKNOWN`/`NOT_A_FACE`.
- The match score in the box label when present (extend `getPhotosForReview` to include
  `matchScore` and `autoTagged` from the parent cluster).
- A filter chip row: *All · Auto-tagged · Manually tagged · Untagged faces*.

### 5.2 Bystander redaction — `face-worker/main.py` `POST /redact`

Port `image_redactor.py`. Accepts the image plus a JSON list of bboxes, applies
`cv2.GaussianBlur` with `(FACE_BLUR_KERNEL, FACE_BLUR_KERNEL)` and `FACE_BLUR_SIGMA` to each
region, returns the JPEG bytes. (OpenCV is already available — insightface depends on it.)

In `finalizeSession`, before flipping to `ARCHIVED`: for every photo containing at least one face
whose final `tagStatus` is `UNKNOWN` (or `PENDING`-untagged, which cannot happen given the gate),
call `/redact` with those bboxes and write the result to
`sessions/{sessionId}/redacted/{photoId}.jpg`. Store the derivative path on `Photo`
(`redactedPath String?` — one more small migration) and serve it from a
`GET /sessions/:id/photos/:photoId/redacted` route.

**Never overwrite the original.** The unredacted file stays put; downstream decides which
derivative it is entitled to.

### 5.3 `finalizeSession`

Keep the existing consent re-check and `PhotoSubject` writes exactly as they are — that logic is
already correct and is the lineage anchor. Add, in order, after the transaction commits:
redaction pass → `destroyGallery` → handoff emit (Phase 6) → audit.

---

## 9. Phase 6 — Handoff to the Data Team Admin portal (DSAR steps 7–9)

Minimal, additive — the downstream pages (`dataAdmin/DiscoveryWorkspace.jsx`,
`dataAdmin/DataLineage.jsx`) are already scaffolded and currently render placeholders.

### 6.1 `schema.prisma`

```prisma
enum HandoffStatus { PENDING_INGEST  INGESTED  REJECTED }

// Emitted when a session is finalized. The batch the Consent Mapping Engine and
// the PII/Redaction Engine consume (steps 7–9 of the DSAR dataflow) — every photo
// in it already carries a consentId via photo_subjects.
model SessionHandoff {
  id           String        @id @default(uuid()) @db.Uuid
  sessionId    String        @unique @db.Uuid
  projectId    String        @db.Uuid
  status       HandoffStatus @default(PENDING_INGEST)
  photoCount   Int
  subjectCount Int
  linkCount    Int
  emittedAt    DateTime      @default(now())
  ingestedAt   DateTime?

  session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([status])
  @@map("session_handoffs")
}
```
Add `handoff SessionHandoff?` to `Session`.
`npx prisma migrate dev --name add_session_handoff`

### 6.2 Backend

- `finalizeSession` creates the `SessionHandoff` row inside the existing transaction and audits
  `SESSION_HANDED_OFF`.
- New `backend/src/modules/handoff/` with `requireAdminAuth` + `requireRole('dataAdmin','super_admin')`:
  - `GET  /api/v1/handoffs?status=PENDING_INGEST` — list with project and session code.
  - `GET  /api/v1/handoffs/:id` — the consent-mapped batch: every `PhotoSubject` joined to its
    subject and consent, i.e. exactly the view the Consent Mapping Engine expects.
  - `POST /api/v1/handoffs/:id/ingest` — mark `INGESTED`, audit `HANDOFF_INGESTED`.

Check the exact role key in `admin-portal/src/roles.js` before writing `requireRole` — use the
`key` field of the data-admin role verbatim.

### 6.3 Frontend

`dataAdmin/DiscoveryWorkspace.jsx` — replace the placeholder with the pending-handoff queue:
session code, project, photo/subject counts, emitted-at, and an **Ingest** action.
`dataAdmin/DataLineage.jsx` — render one lineage row per `photo_subjects` entry:
`photo → subject → consentId → project`. That chain is the DSAR erasure path, so showing it is
the compliance evidence.

DSAR erasure needs no new photo path: it walks `photo_subjects.consentId` exactly like
`media_assets`. The only new erasure target is `subject_face_enrollments`, handled in Phase 1.5.

---

## 10. Fallback if Qdrant cannot be run

The gallery is 10–50 vectors. If Qdrant is unavailable, implement `faceGallery.js` against an
in-process `Map<sessionId, Array<{vector, payload}>>` with brute-force cosine — `recognition.worker.js`
already has a `cosine()` implementation to reuse. Keep the exact same five exported function
signatures so the swap is one file.

Caveat: the backend API and the BullMQ worker are **separate processes**, so an in-memory gallery
built in `endSession` would not be visible to the worker. In that case build the gallery lazily
inside the worker instead (read roster enrollments → embed → hold in a local array for the
duration of `processSession`). This is a clean fallback, just slower on reruns.

---

## 11. Build order and per-phase acceptance

| # | Deliverable | Done when |
|---|---|---|
| 0 | Qdrant running, env vars added | `/health/deep` → `{"postgres":true,"qdrant":true}` |
| 1 | Enrollment table, `/embed`, enrollment module, selfie UI | An agent can add 1–3 selfies to a subject and see the thumbnails; a subject without `biometricMatch` consent gets a 409 |
| 2 | `faceGallery.js`, gallery build on `endSession`, teardown | `endSession` response reports `{ points, notEnrolled }`; a Qdrant collection `session_<id>` exists during processing and is gone after finalize |
| 3 | Match columns, worker match step | `face_clusters` rows carry `matchScore` / `autoTagged` / `suggestedSubjectId`; the audit payload reports the three-band split |
| 4 | People endpoints, `People.jsx`, three-section `Tagging.jsx` | Face cards render; accept-all works; merge and split work |
| 5 | Review colours, `/redact`, redacted derivatives | Finalize writes redacted copies and leaves originals untouched |
| 6 | `SessionHandoff`, handoff module, dataAdmin pages | A finalized session appears in the data-admin queue and can be ingested |

Migrations to run, in order:
```
add_subject_face_enrollments
add_cluster_match_metadata
add_photo_redacted_path      (Phase 5)
add_session_handoff          (Phase 6)
```

## 12. Invariants that must survive every edit

1. **No embedding is ever written to Postgres.** Vectors exist only in the ephemeral Qdrant
   collection and in worker process memory.
2. **The tag dropdown and every tagging endpoint stay roster-scoped.** `tagCluster`'s
   `sessionParticipant` check is the server-side enforcement — bulk-accept and merge must route
   through the same check, never around it.
3. **`finalizeSession` re-reads consent.** An auto-tag is not a consent decision. A revoke between
   tagging and finalize still wins retroactively.
4. **Originals are never overwritten** by redaction.
5. **Every state transition writes an `AuditLog` row** — new actions: `ENROLLMENT_CAPTURED`,
   `ENROLLMENT_DELETED`, `ENROLLMENT_PURGED`, `GALLERY_BUILT`, `GALLERY_DESTROYED`,
   `CLUSTERS_MERGED`, `CLUSTER_SPLIT`, `SUGGESTIONS_ACCEPTED`, `SESSION_HANDED_OFF`,
   `HANDOFF_INGESTED`.
6. **A missing gallery fails loudly**, never silently degrades to "no matches found".

## 13. Risks

| Risk | Mitigation |
|---|---|
| One selfie misses profile / low-light faces | Capture up to 3; each becomes its own gallery point |
| Auto-tag mislabels someone | Conservative 0.55 band; always overridable; consent re-checked at finalize |
| Qdrant down at `endSession` | Hard 503 with an actionable message — never silent |
| Clusterer splits one person across cards | Merge action; both cards usually carry the same suggestion anyway |
| Clusterer merges two people | Split action |
| Two InsightFace model loads (face-worker + visual-pipeline) | Only `face-worker` runs; the visual pipeline is a code donor, not a live service |
| Enrollment selfie is biometric data at rest | Consent-gated, deletable, purged on revoke, covered by the DSAR path |
| `getUserMedia` blank over LAN IP | File-input fallback always rendered |
