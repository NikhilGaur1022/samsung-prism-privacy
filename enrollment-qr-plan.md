# Enrollment-at-Registration + QR Session Join — Implementation Plan

> Execute in a fresh chat. Everything needed is here. Repo facts below were verified by
> reading the files on 2026-07-23 — trust them, do not re-explore from scratch.
> Companion doc `face-matching-plan.md` describes the ALREADY-BUILT half; this doc is the gap.

---

## 0. What already works (do NOT rebuild)

Verified by reading the code. The detect → cluster → match → people-view → tag → redact →
handoff pipeline is **complete and wired**.

| Capability | Location |
|---|---|
| `/detect` `/embed` `/redact` | `face-worker/main.py` (insightface `buffalo_l`, 512-d, L2-normalised) |
| Enrollment CRUD, agent + self | `backend/src/modules/enrollment/` (routes, service, validation) |
| Per-session Qdrant gallery | `backend/src/lib/faceGallery.js` — collection `session_{id}`, 512-d cosine |
| Gallery build at endSession | `session.service.js` `buildSessionGallery()` (~L235-300) |
| Detect/cluster/match worker | `backend/src/workers/recognition.worker.js` — 3 bands: auto-tag / suggest / unidentified |
| Google-Photos people view | `getPeople()` `session.service.js:557`, `getPersonPhotos():656`, `People.jsx`, route `/sessions/:id/people` |
| Manual tagging | `tagCluster():395`, `acceptSuggestions():432`, `mergeClusters():465`, `splitFaces():508`, `Tagging.jsx` |
| Redaction of untagged faces | `finalizeSession():687` → `redactBystanders():810` → `/redact` → `photo.redactedPath` |
| Handoff to next portal | `backend/src/modules/handoff/` |
| `notEnrolled[]` warning banner | **already wired** — `SessionDetail.jsx:98,166,216` |
| Dev OTP display | `lib/otp.js devOtp()`, forwarded via router state to `Verify.jsx` |

**Consequence: the only real gaps are (A) enrollment never happens, and (B) there is no QR join.**

---

## 1. Decisions already made — implement exactly these

1. **Embeddings are persisted permanently**, encrypted at rest, and deleted whenever the
   enrollment is deleted. This REVERSES the current documented design (see the comment at
   `schema.prisma:79-80` and in `enrollment.service.js` — both must be updated, not left lying).
2. **Multi-pose capture at registration**, 5 poses, mandatory step in the signup flow.
   NOT a literal 180° sweep — `buffalo_l` degrades past ~±45° yaw, so extra angles are wasted
   storage. Poses: front, ¾-left, ¾-right, slight-up, slight-down.
3. **QR takes the subject to a consent screen; the subject taps to agree.** The scan itself is
   NOT consent. `signConsent()` produces the audit signature that is your legal evidence — if it
   is minted by a scan rather than a human act, the record proves nothing and every photo
   downstream inherits the defect. One extra tap. This is non-negotiable in this plan.
4. Accepting the QR consent **also creates the SessionParticipant row** — the subject does
   nothing else. Agent never has to add them manually.
5. Manual add stays exactly as-is as the second option.

---

## 2. Hard constraints discovered in the code — violating these will break things

- **`createEnrollment()` refuses unless `subject.status === 'ACTIVE'` AND
  `subject.biometricMatch === true`** (`enrollment.service.js` L36-46). `Subject.biometricMatch`
  defaults to `false` (`schema.prisma:62`) and **nothing in the codebase ever sets it to true.**
  This is the single reason enrollment is currently impossible for a fresh user. A new endpoint
  must set it. Order is forced: register → OTP verify (status→ACTIVE) → biometric consent
  → capture. Do not reorder.
- `schema.prisma:57-62` warns `generalTerms`/`piiProcessing`/`biometricMatch` are "intake-time UX
  defaults ONLY" and must never gate media intake. Setting `biometricMatch` for enrollment is
  consistent with the existing service check, but do **not** start reading it in session/photo code.
- `agentEnrollmentRoutes` guards are **per-route, not router-level**, deliberately — it shares the
  `/api/v1/subjects` mount with `subjectRoutes`, and a router-level `.use()` would 401 public
  subject registration. Preserve this pattern in anything mounted there.
- Self-facing enrollment takes `subjectId` from `req.subject.masterUserId`, **never from the URL**.
  Same rule for every new subject-scoped endpoint.
- `SubjectFaceEnrollment` has `@@unique([subjectId, sha256])`, and `createEnrollment` returns
  `{duplicate:true}` on a repeat rather than erroring. Multi-pose capture must not resubmit an
  identical frame.
- `MAX_PER_SUBJECT` = `FACE_MAX_ENROLLMENTS_PER_SUBJECT` env, default **3**. Five poses needs 5.
- `deleteAllEnrollments()` is already called from `consent.service.js:131` (all-consent revoke)
  and `subject.service.js:106` (status change). Persisted embeddings MUST be cleared by that same
  path — it is the existing purge chokepoint, use it, do not add a parallel one.
- `getUserMedia` requires HTTPS or localhost. Over a LAN IP it silently yields nothing — this is
  why `SelfieCapture.jsx` always renders a file input. **Keep that fallback in the multi-pose
  version**, or phones on LAN cannot enroll at all.
- `admin-portal` and `user-portal` each have their own `SelfieCapture.jsx` — currently identical
  143-line twins. They diverge in this plan (user gets guided poses). Do not try to share them.
- `request()` in both `lib/api.js` forces JSON content-type; multipart calls bypass it (see
  `addEnrollment`). Follow that precedent.
- Admin `request()` has a **60s GET cache with prefix busting** (`api.js:33 clearApiCache`).
  Any new polling endpoint must bypass or bust it or the live roster will freeze.

---

## 3. Phases

Phases 1-2 and Phase 3 are independent — either order. Phase 4 last.

---

### Phase 1 — Persist embeddings (encrypted)

**Schema** (`backend/prisma/schema.prisma`)
```prisma
model SubjectFaceEnrollment {
  // ...existing fields...
  embedding    Bytes?   // AES-256-GCM(512 float32 LE) — nonce||tag||ciphertext
  embeddingDim Int?     // 512; null = legacy row needing backfill
  pose         EnrollmentPose?
}

enum EnrollmentPose { FRONT, LEFT, RIGHT, UP, DOWN }
```
Update the stale comment at `schema.prisma:79-80` — it currently asserts embeddings are never
persisted.

**New file** `backend/src/lib/embeddingCrypto.js`
- `encryptEmbedding(number[]) -> Buffer`, `decryptEmbedding(Buffer) -> number[]`
- AES-256-GCM, key from `FACE_EMBEDDING_KEY` (32 bytes, base64). Random 12-byte nonce per record.
- Throw loudly at import time if the env var is missing or wrong length. Never log the key or
  the plaintext vector.

**`enrollment.service.js`**
- In `createEnrollment`, store `encryptEmbedding(result.embedding)`, `embeddingDim: 512`, and the
  `pose` passed by the caller. Replace the "deliberately NOT stored" comment with the new rationale.
- In `listEnrollments`, add `pose` to the `select`. **Never select `embedding`** — the select is
  already explicit, keep it that way so the vector cannot leak through an API.
- `deleteEnrollment` / `deleteAllEnrollments`: on soft-delete also `embedding: null,
  embeddingDim: null`. The tombstone row stays for the audit chain; the biometric does not.

**`session.service.js` `buildSessionGallery()`**
- Use the stored embedding when present; fall back to `readFile` + `embedImage` when
  `embedding == null` (legacy rows), and opportunistically write the result back.
- Keep the existing per-enrollment try/catch: one bad enrollment must not fail the build.

**Migration**: `npx prisma migrate dev --name persist_face_embeddings` in `backend/`.
Nullable columns only — no backfill needed, the fallback path covers old rows.

**Env**: add `FACE_EMBEDDING_KEY` and `FACE_MAX_ENROLLMENTS_PER_SUBJECT=5` to `backend/.env` and
`backend/.env.example`. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

---

### Phase 2 — Guided multi-pose enrollment inside registration

**Backend**

1. `PATCH /api/v1/me/biometric-consent` (subject auth) — body `{accepted: boolean}` →
   sets `Subject.biometricMatch`. Audit `BIOMETRIC_CONSENT_SET`. When set to `false`, call
   `deleteAllEnrollments(subjectId, subjectId, 'BIOMETRIC_CONSENT_WITHDRAWN')`.
   Put it in the `subjects` module or a small `me` router — NOT in `enrollment.routes.js`.
2. `POST /api/v1/me/enrollments` — accept optional `pose` form field, validate against the enum,
   pass through to `createEnrollment`.
3. `GET /api/v1/me/enrollment-status` → `{ biometricConsent, count, max, poses: string[],
   complete: boolean }`. `complete` = at least 3 distinct poses including `FRONT`.
   Drives the registration gate and the ConsentHub card.

**Frontend — `user-portal`**

- Rewrite `user-portal/src/components/SelfieCapture.jsx` into a guided stepper:
  - Props `{ poses, captured, onCapture, busy, error }`.
  - One pose at a time, with an on-screen instruction ("Turn slightly to your left") and a
    thumbnail strip of what is done.
  - Retake per pose. Keep the `<input type="file" capture="user">` fallback per pose.
  - Stop the camera stream on unmount — the existing `useEffect(() => stop, [stop])` does this,
    preserve it.
- New page `user-portal/src/pages/Enroll.jsx`, route `/enroll` (public route group, alongside
  `/verify` — the user has a subject session but has not finished onboarding).
  - Screen 1: plain-language biometric explainer + explicit checkbox → `PATCH /me/biometric-consent`.
  - Screen 2: the pose stepper.
  - Screen 3: done → `navigate('/dashboard')`.
  - Allow "Skip for now" → dashboard, but show a persistent banner afterwards. Hard-blocking a
    user out of their own account over a biometric step is the wrong trade.
- `Verify.jsx`: after successful OTP verification navigate to `/enroll`, not `/dashboard`.
- `Register.jsx:145`: the comment says enrollment lives in ConsentHub — update it to point at
  `/enroll`.
- `ConsentHub.jsx`: keep the existing card but drive it from `enrollment-status`; when
  `complete === false` render it **expanded** with a prompt, not collapsed behind "Add photo".
  This collapsed default is the actual reason nobody ever enrolled.
- `App.jsx`: register the `/enroll` route.
- `lib/api.js`: `setBiometricConsent`, `getEnrollmentStatus`, and `addEnrollment(blob, pose)`.

**Frontend — `admin-portal`**
- `SubjectVerification.jsx` `EnrollmentPanel` already exists and works. Add the pose label to each
  thumbnail and pass `pose` through `addEnrollment(subjectId, blob, pose)` in `lib/api.js`.
  Agent-side capture stays free-form (agent may only get one usable shot in the field).

---

### Phase 3 — QR session join

**Schema**
```prisma
model SessionInvite {
  id        String    @id @default(uuid()) @db.Uuid
  sessionId String    @map("session_id") @db.Uuid
  token     String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdBy String    @db.Uuid
  createdAt DateTime  @default(now())
  session   Session   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId])
}
```
Add `invites SessionInvite[]` to `model Session`. Migration name: `add_session_invites`.

Use a dedicated token (`crypto.randomBytes(32).toString('base64url')`), **not** `Session.code` —
the code is an operator-facing label shown in the UI; a bearer credential must be rotatable and
revocable independently.

**New module** `backend/src/modules/join/` (`join.routes.js`, `join.service.js`)

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /api/v1/sessions/:id/invite` | agent | create or rotate; session must be `ACTIVE`; returns `{token, url, expiresAt}` |
| `DELETE /api/v1/sessions/:id/invite` | agent | set `revokedAt` |
| `GET /api/v1/join/:token` | **public** | `{projectName, purpose, policyVersion, consentText, sessionLocation, agentName}` — **no subject data, no session id**. Rate-limit hard (`express-rate-limit` + `rate-limit-redis` are already deps). |
| `POST /api/v1/join/:token/accept` | subject | `grantConsent(subjectId, projectId)` then `addParticipant(...)` in one `prisma.$transaction`; returns `{sessionCode, projectName, enrollmentComplete}` |

`accept` rules:
- Reuse `consent.service.grantConsent` and `session.service.addParticipant` — do **not**
  reimplement consent signing or the consent gate. They are the single authority.
- Idempotent: already a participant → `200`, not `409`.
- Reject expired / revoked tokens and non-`ACTIVE` sessions with distinct, human-readable errors.
- Audit `SESSION_JOINED_VIA_QR` with `{sessionId, token id, subjectId}` — never the raw token.
- `addParticipant` currently takes `admin` and calls `loadSession(sessionId, admin)` for ownership.
  Add an internal variant (e.g. `addParticipantInternal(sessionId, subjectId, actorId)`) that skips
  the agent-ownership check but keeps the consent check. **Do not weaken the consent check.**

Mount in `server.js` next to the other routers. `/api/v1/join` must be mounted **before** any
auth-requiring catch-all.

**Frontend — `user-portal`**
- New page `pages/Join.jsx`, route `/join/:token`, works logged-out.
  Flow: project card → `[Continue]` → if no session, inline email + OTP (reuse the existing
  `requestLogin`/`verify` calls and the `devOtp` banner) → consent screen with full text and an
  explicit agree button → `POST accept` → if `enrollmentComplete === false`, offer the pose
  stepper inline → success screen showing the project name and "this now appears in your Consent Hub".
- `App.jsx`: add the route outside `AppLayout` (no sidebar for a phone walk-up).
- `Dashboard.jsx:28` currently has a dead "Scan QR to Join Project" label — wire it or remove it.

**Frontend — `admin-portal`**
- `SessionDetail.jsx` roster section (`L233`) becomes two tabs:
  - **Scan to join** — large QR via `qrcode.react`, the URL in text under it as a fallback,
    expiry countdown, `[Rotate]` / `[Revoke]`, and a live participant list polling
    `getSession(sessionId)` every 3s. **Must call `clearApiCache()` or bypass the 60s GET cache**,
    or new joiners will not appear.
  - **Add manually** — the existing search + add UI, unchanged.
- Stop polling on unmount and when the session leaves `ACTIVE`.
- `lib/api.js`: `createInvite`, `revokeInvite`.

**Deps**: `cd admin-portal && npm i qrcode.react`. Backend needs nothing new.

**Env**: `USER_PORTAL_URL` in `backend/.env` + `.env.example`. The QR must encode a
phone-reachable origin — `localhost` will not work from a phone. Use the LAN IP
(`http://192.168.x.x:5173`) or a tunnel. Note in the UI that camera capture needs HTTPS, so a
tunnel (ngrok/cloudflared) is the realistic path for on-device selfie capture during a demo.

---

### Phase 4 — Redaction hardening

- `Tagging.jsx` / `People.jsx`: add an explicit destructive-styled **"Not a participant — redact"**
  action on a cluster card, writing `tagStatus: 'UNKNOWN'` through the existing `tagCluster`.
  Today a face is redacted by being *left* untagged, so "I decided to redact" and "I forgot" are
  indistinguishable in both the UI and the audit log.
- Show a pre-finalize summary: "N faces will be blurred" before `finalizeSession` runs.
- Decide and implement one of:
  (a) keep the original alongside `redactedPath` (current behaviour), or
  (b) have handoff serve **only** the redacted copy when one exists.
  `handoff.service.js:64,123` currently just exposes a `hasRedacted` boolean and does not enforce
  either. If the intent is that an unrecognised person's face is actually gone downstream, (b) is
  required — (a) leaves the unblurred original on disk and still served by
  `GET /sessions/:id/photos/:photoId/file`.

---

## 4. Verification (manual — do not write tests unless asked)

Prereqs, all six must be up: Postgres, Redis (`redis-server`), Qdrant :6333,
face-worker :8001, backend :4000, portals :5173 / :5181.

1. Register a new subject → OTP (dev banner) → lands on `/enroll` → consent → 5 poses → dashboard.
   DB: 5 `subject_face_enrollments` rows, `embedding` non-null, distinct `pose`.
2. `GET /api/v1/me/enrollments` response contains **no** `embedding` field.
3. Agent creates a session → **Scan to join** tab → open the URL on a phone → consent →
   subject appears in the agent's roster within ~3s, and the project shows in the subject's
   Consent Hub.
4. Upload photos → End session → `notEnrolled` is empty → job completes → People view shows
   auto-tagged cards plus an unidentified bucket.
5. Tag one unknown, mark another "redact" → finalize → redacted JPEG exists at
   `sessions/{id}/redacted/{photoId}.jpg` with the right face blurred.
6. Revoke all consent in the user portal → enrollment rows soft-deleted, `embedding` null,
   image files gone from disk.
7. Restart the backend with `FACE_EMBEDDING_KEY` removed → it must refuse to boot, not silently
   store plaintext.

---

## 5. Do not

- Do not remove or weaken the consent check in `addParticipant`.
- Do not treat a QR scan as consent.
- Do not persist embeddings unencrypted, return them from any endpoint, or log them.
- Do not read `Subject.biometricMatch` in session/photo/purge logic (`schema.prisma:57-59`).
- Do not make `agentEnrollmentRoutes`-style guards router-level on the `/api/v1/subjects` mount.
- Do not rebuild the worker, clustering, people view, tagging, redaction or handoff — they work.
- Do not delete `face-matching-plan.md`.
- Do not run tests or commit unless asked.
