# PRISM — handoff: Phase 2 complete, Phase 3 (delete dead code) is next

**Date:** 2026-08-17
**Branch:** `main` (working tree dirty — nothing committed, see §3)
**Written for a session with zero memory of the one that produced it.**

> **A Read-tool hook truncates `PLAN.md` and `docs/*.md` to line 1 and claims the
> file is already summarised. It is not.** Read them with
> `Get-Content FILE` (PowerShell) or `sed -n '1,240p' FILE` (Bash) instead.
> This file included.

---

## 1. What the user asked for

> *"please start implimenting this plan phase wise and make sure to check
> everthing works or not after each implimentation and please make make the
> system end to end proper because my life depends on this"*

The spec being executed is the published production-readiness plan:
**https://claude.ai/code/artifact/f6896ba4-0b03-4add-a869-4557a44f9cc3**
Read it before starting Phase 3. Two standing obligations: **implement phase by
phase**, and **verify after each phase** rather than at the end.

The user's only outstanding request to *you* is the one this session could not
satisfy: **`HF_TOKEN`** (§7). Ask for it again at the start of your session —
without it Phase 2's pipeline is code-complete but unexercised end to end.

---

## 2. State

| Phase | State |
|---|---|
| **Phase 0 — correctness/security blockers** | ✅ complete, verified |
| **Phase 1 — role model + portal access** | ✅ complete, verified |
| **Phase 2 — audio, properly** | ✅ **complete** (this session) — code-complete and verified as far as a missing `HF_TOKEN` allows, see §5 |
| **Phase 3 — delete dead code** | ⬜ not started — this is your work |
| Phases 4–5 | not started |

### Verification actually run at the end of Phase 2

```
admin-portal  npm run lint    ✔ 3 warnings, all pre-existing
admin-portal  npm run build   ✔ no errors
user-portal   npm run lint    ✔ 3 warnings (the new VoiceEnrollment.jsx one is the
                                same react-refresh pattern FaceEnrollment.jsx and
                                SelfieCapture.jsx already trip)
user-portal   npm run build   ✔ no errors
backend       npx node --test tests/security/rbac-matrix.test.js
                              ✔ tests 4 / pass 4 / fail 0, all 8 new voice routes
                                classified
docker ps                     ✔ 5/5 up (jre-pg, prism-redis, prism-qdrant,
                                prism-face-worker, prism-image-pii-worker)
                                — checked BEFORE the suite, see §2.1
backend       npm test        ✔ tests 123 / pass 123 / fail 0 / duration 19m18s
```

There is **no audio-worker container** in that list, and there was not meant to
be — see §7.

### 2.1 The full suite

Baseline to hold, from Phase 0 and unchanged through Phases 1 and 2:
**`# tests 123 / # pass 123 / # fail 0`**. Phase 2 held it — re-run at the end of
this session with every voice change in the tree, containers confirmed up first.

`npm test` **must be run in the background** — it exceeds the 10-minute
foreground cap. Earlier handoffs quote ~8 minutes; this session's run took
**19m18s** on a tree with the voice work in it, so budget for the longer figure
and do not read a slow run as a hang. **Confirm the baseline before you start Phase 3.**
Phase 3 deletes whole directories; you want a known-good number from *before*
the deletion, or you will not be able to tell a bad `rm` from a pre-existing
flake.

Two things to check before trusting any suite number:

- **`docker ps` first.** With the containers stopped the suite reports
  **`# pass 90 / # fail 33`** — a third of the tests down at once, which reads
  exactly like a broken change. Bring them back with
  `docker start prism-redis prism-qdrant prism-face-worker prism-image-pii-worker`.
- The RBAC matrix reports **2 inconclusive checks** (`POST /auth/subject/login`
  for `subject` and for `anon`) because the rate limiter answers first. This is
  pre-existing and re-runnable against a fresh limiter window.

---

## 3. Nothing is committed

`git status --short` — Phase 2's contribution marked:

```
 M ai-core/audio-worker/.env.example                        <-- Phase 2
 M ai-core/audio-worker/README.md                           <-- Phase 2
 M ai-core/audio-worker/config.py                           <-- Phase 2
 M ai-core/audio-worker/main.py                             <-- Phase 2
 M ai-core/audio-worker/schemas.py                          <-- Phase 2
 M ai-core/audio-worker/speaker_id.py                       <-- Phase 2
 M backend/.env.example                                     <-- Phase 2 (voice block)
 M backend/prisma/schema.prisma                             <-- Phase 2 (+ Phase 0)
 M backend/src/lib/cleanup.js                               <-- Phase 2
 M backend/src/modules/dsar/dsar.routes.js                  <-- Phase 2
 M backend/src/modules/dsar/itemSearch.service.js           <-- Phase 2
 M backend/src/modules/enrollment/enrollment.routes.js      <-- Phase 2
 M backend/src/modules/enrollment/enrollment.service.js     <-- Phase 2
 M backend/src/modules/handoff/handoff.service.js           <-- Phase 2 (§5.3)
 M backend/src/modules/recordings/recording.service.js      <-- Phase 2 (+ Phase 0)
 M backend/src/workers/retention.worker.js                  <-- Phase 2 (§5.3)
 M backend/tests/security/rbac-matrix.test.js               <-- Phase 2 (+ Phase 0)
 M docs/02_ROLE_PERMISSION_MATRIX.md                        <-- Phase 2 (+ Phase 1)
 M admin-portal/src/components/ItemGrid.jsx                 <-- Phase 2 (§5.4)
 M admin-portal/src/components/RecordingsPanel.jsx          <-- Phase 2
 M admin-portal/src/lib/api.js                              <-- Phase 2
 M admin-portal/src/pages/collectionAgent/SessionDetail.jsx <-- Phase 2
 M admin-portal/src/pages/collectionAgent/SubjectVerification.jsx <-- Phase 2
 M user-portal/src/components/FaceEnrollment.jsx            <-- Phase 2
 M user-portal/src/lib/api.js                               <-- Phase 2
 M user-portal/src/pages/ConsentHub.jsx                     <-- Phase 2
?? admin-portal/src/components/VoiceCapture.jsx             <-- Phase 2
?? backend/src/lib/audioFeature.js                          <-- Phase 2
?? backend/src/lib/voiceGallery.js                          <-- Phase 2
?? backend/src/modules/enrollment/voiceEnrollment.service.js<-- Phase 2
?? backend/prisma/migrations/20260817000001_subject_voice_enrollment/ <-- Phase 2
?? user-portal/src/components/VoiceCapture.jsx              <-- Phase 2
?? user-portal/src/components/VoiceEnrollment.jsx           <-- Phase 2
?? docs/HANDOFF_2026-08-16_phase2-audio.md                  <-- the Phase 2 handoff

  ... plus everything from Phases 0 and 1, listed in
      docs/HANDOFF_2026-08-16_phase2-audio.md §3
```

**All three migrations are already applied to the dev database.** Do not re-run
them and do not `migrate reset`:

```
20260816000001_audio_first_class          <-- Phase 0
20260816000002_access_object_recording    <-- Phase 0
20260817000001_subject_voice_enrollment   <-- Phase 2
```

Recent commits: `aa170ec` (merge origin/dev) ← `5573084` (audio worker built) ←
`9a09a78` (DSAR system, PLAN phases 3-9).

---

## 4. What Phase 2 actually changed

### 4.1 §5.1 — `SubjectVoiceEnrollment` + a Qdrant collection

Before this phase **there was no persisted voice enrollment anywhere.** Reference
clips were attached as multipart `voice_snippets` at analyze time and re-embedded
by the worker on every call. Speaker identity therefore depended on whoever
attached the right WAVs to that one request, nothing was reusable across
sessions, and — the part that mattered most — there was **no row to erase**: a
voice print held with no erasure path.

- **`backend/prisma/migrations/20260817000001_subject_voice_enrollment/`** creates
  `subject_voice_enrollments`, shaped as `subject_face_enrollments` is, because a
  voice print is DPDP §2 sensitive personal data on the same footing as a face
  embedding. The clip and its vector are both persisted, the vector is sealed
  under the **per-subject DEK** so `destroySubjectKey()` crypto-shreds it, and
  delete is **soft** so the tombstone survives for the audit chain while the
  biometric does not.
  Read the migration's header comment before touching the table — in particular
  the **`prism_app` grant block**. Migration `20260728000001` ran
  `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM prism_app`, so any
  table created after it inherits **nothing**; without the grant block the app
  connects fine and then fails permission-denied on the first enrollment, at
  runtime rather than at deploy time. `subject_face_enrollments` only escapes
  needing one because it predates that revoke. **Every new table from here on
  needs this block.**
- **`backend/src/lib/voiceGallery.js` (new)** is the audio counterpart of
  `faceGallery.js`. Two deliberate differences, both commented in the file:
  - **`DIM = 192`**, not 512. SpeechBrain ECAPA-TDNN emits a 192-float speaker
    embedding at 16 kHz. Copying the face dimension fails at Qdrant with a
    vector-size error.
  - **Keyed by recording, not by session** (`voice_<recordingId>`). The face
    gallery is per-session because it is built once at `endSession` and consumed
    by one job; audio analysis is a per-recording call that can run concurrently
    for several recordings in the same session, and a shared collection name
    would mean one run tearing down the gallery another run is still searching. A
    per-run collection also cannot go stale — an enrollment captured after the
    session started is in the next recording's gallery automatically.
- **`backend/src/lib/audioFeature.js` (new)** holds the `AUDIO_CAPTURE_ENABLED`
  kill switch (`audioCaptureEnabled()` / `requireAudioEnabled`), moved out of
  `recording.routes.js` because **voice enrollment is gated by it too** and
  enrollment has no business importing a route module to read a flag. Both gates
  must move together: enrollment that stayed open with capture off would collect
  voice prints for a pipeline that cannot use them, which is collection without a
  purpose. The switch is exactly the string `"on"` — `"true"`, `"1"` and `"ON"`
  are all off, because a kill switch that accepts near-misses is one typo away
  from being on in an environment nobody meant to enable. It is read **per
  request**, never captured at module load, or the flag would freeze at import
  time and be untestable.
- **`backend/src/modules/enrollment/voiceEnrollment.service.js` (new)** — capture,
  embed via the worker's new `/embed`, seal, persist, soft-delete.
  `VOICE_MAX_ENROLLMENTS_PER_SUBJECT` (3) and `VOICE_ENROLL_MIN_SECONDS` (3).
- **Eight new routes**, all classified in `rbac-matrix.test.js` and documented in
  `docs/02_ROLE_PERMISSION_MATRIX.md` in the same change — *an unclassified route
  is a test failure*:

  | Route | Allowed |
  |---|---|
  | `POST /api/v1/subjects/:subjectId/voice-enrollments` | `collectionAgent`, `super_admin` |
  | `GET /api/v1/subjects/:subjectId/voice-enrollments` | `collectionAgent`, `super_admin` |
  | `DELETE /api/v1/subjects/:subjectId/voice-enrollments/:id` | `collectionAgent`, `super_admin` |
  | `POST /api/v1/me/voice-enrollments` | `subject` |
  | `GET /api/v1/me/voice-enrollments` | `subject` |
  | `GET /api/v1/me/voice-enrollments/status` | `subject` |
  | `GET /api/v1/me/voice-enrollments/:id/audio` | `subject` |
  | `DELETE /api/v1/me/voice-enrollments/:id` | `subject` |

  Note there is **exactly one playback route and it is the subject's own**. An
  agent gets duration, source and date, and a delete button — no `<audio>`
  element anywhere in the admin portal. That is a decision, not an oversight, and
  it is held identically in the route file, the RBAC test, the matrix doc and the
  UI. Do not "fix" it by adding an agent playback endpoint.

### 4.2 §5.2 — gallery-based speaker identification

The worker's `/analyze` **no longer takes `voice_snippets` or `snippet_muids`,
and no longer returns `speaker_matches` / `matched_muid`.** It returns
`speaker_embeddings` — one 192-float vector per diarised speaker, with
`embedding: null` and `reason: TURN_TOO_SHORT | EMBEDDING_FAILED` when it cannot
produce one. Identity is now decided in the backend against a Qdrant gallery
built from persisted enrollments, for the same reason face matching is: the
worker holds no state, sees no consent, and must not be a second place where
"is this person X" gets decided.

A new **`POST /api/v1/embed`** on the worker returns one embedding for one
enrollment clip. `400` means unreadable audio or no usable speech — the subject
should re-record. `502` means the model failed — an operational fault the subject
cannot fix. The two are kept distinct so the backend can say which happened.
`duration_sec` is read from the file header, so the backend enforces its minimum
enrollment length against what actually arrived rather than a client-supplied
form field.

`resolveSpeakerConsent()` was **not** regressed — it still resolves every matched
speaker against real `ProjectConsent` in one pair of queries.

**The unmatched-speaker contract is preserved:** below threshold the search
returns `subjectId: null` and the caller mutes. An unidentified speaker is an
unconsented bystander, never "probably the closest one".

### 4.3 §5.3 — audio in retention, purge and handoff-blocking

Both holes named in the Phase 2 handoff are closed, plus a third this session
found:

- **`retention.worker.js` → `sweepRecordingOriginals()`** now shreds L14
  recording originals on the same clock as L2 photo originals, and — copying the
  photo rule — **only when a confirmed muted copy exists to replace it**
  (`isRecordingRedactedAvailable`'s condition: `REDACTED` with a `redactedPath`).
  A recording past TTL with no muted copy is **retained and counted**, and the
  sweep logs `blockedByMissingRedaction` so the backlog is visible rather than
  silently destroying the only copy of audio that can still be re-muted for
  remaining speakers.
- **`handoff.service.js`** blocked on photos only; a `Recording` with
  `status = DEFERRED` or `redactedPath = null` did **not** block a handoff, so an
  unmasked voice could leave the platform in a dataset. It now counts unmuted
  recordings and raises the audio counterpart of `REDACTION_INCOMPLETE`.
- **The third hole, found this session:** `sweepRevokedEnrollments()` swept face
  enrollments only. A subject with no active consent anywhere kept their **voice
  print** indefinitely. It now shreds the clip, nulls `embedding` /
  `embeddingDim` and tombstones the row, and returns
  `{ shredded, voiceShredded }`.

Purge and discovery (L14/L15/SEGMENT, ordered SEGMENT → L15 → L14) were already
correct from Phase 0 and were **verified, not redesigned**.

### 4.4 §5.4 — audio rows in the DSAR item grid

`ItemGrid.jsx` gained the type column and two corrections that only surfaced once
voice enrollments started producing rows:

- **`originLabel(item)`.** `ORIGIN_LABELS.ENROLLMENT` was hard-coded to
  "Enrollment selfie", but a voice enrollment emits `type: 'AUDIO'`,
  `origin: 'ENROLLMENT'`. An operator reviewing an erasure would have been told
  the thing they were about to destroy was a photo when it was the subject's
  recorded voice.
- **Enrollment rows are excluded from the missing-derivative flag.** Both
  enrollment item builders set `redactedAvailable: false` permanently and
  correctly — there is no muted copy of a voice print, and there should not be —
  so the grid was flagging a gap that does not exist.

The counting rule to keep in mind if you touch this: **one index row per
(subject, recording), not per segment**, and `sharedSubjectCount` for audio is
the count of **distinct identified subjects across the whole recording**, which
is what makes the DELETE → REDACT downgrade correct for a multi-speaker file.

### 4.5 Front end

- **admin-portal:** `VoiceCapture.jsx` (new) and a `VoiceEnrollmentSection` in
  `SubjectVerification.jsx`. The panel is now "Enrollment — {name}" rather than
  "Face enrollment"; the list button reads "Enrollment".
- **user-portal:** `VoiceCapture.jsx` and `VoiceEnrollment.jsx` (new), a
  `VoiceEnrollmentCard` on the Consent Hub. **No new route on either portal** —
  voice lives inside the existing enrollment surfaces, so §E of the matrix needed
  a paragraph but no new row.
- **Both `VoiceCapture` components convert to 16 kHz mono PCM WAV in the
  browser** (`decodeAudioData` → `OfflineAudioContext(1, n, 16000)` → 16-bit
  PCM). `torchaudio.load`'s support for MediaRecorder's webm/opus (Chrome) and
  mp4/aac (Safari) is backend-dependent, and this is also exactly what
  ECAPA-TDNN wants — it cuts a five-second clip to under 200 KB. Do not "simplify"
  this by uploading the raw MediaRecorder blob.
- **503 is rendered as "not offered here", never as an error**, on every voice
  surface. Rendering the kill switch as a fault would train agents to ignore the
  banner in the one environment where it does mean something broke.
- **`RecordingsPanel.jsx` was the one surface that missed this** and it was
  fixed after the suite run above. It predates Phase 2, so with
  `AUDIO_CAPTURE_ENABLED` unset it showed a red danger banner **and span its
  loader forever** — `recordings` stayed `null`, so the spinner had nothing to
  resolve to — on the collection agent's session page, the most-demoed screen in
  the product. It now treats 503 as "switched off for this deployment —
  sessions here are photo-only" and stops loading. Front-end only; no test
  covers it, so the 123/123 result above is unaffected.
- **Neither panel echoes the server's 503 text any more.** That message reads
  "Set `AUDIO_CAPTURE_ENABLED=on` once the audio worker is provisioned" — an
  instruction for whoever runs the deployment. A collection agent reading it
  mid-session can only conclude something is broken and that they are expected
  to fix it. The status is still kept in state for the console; only the
  operator-facing wording is withheld from the agent.
- **One biometric consent flag.** `Subject.biometricMatch` governs **both** face
  and voice: agreeing on the voice card enables face matching too, and withdrawing
  anywhere erases both. Both consent gates say so in plain words, and both
  Consent Hub cards remount on a shared `bioKey` so neither can keep displaying
  data the server has already erased.

---

## 5. What Phase 2 could NOT verify, and it matters

Everything above is code-complete, lints, builds and passes the suite. **None of
the ML path has been exercised against a running audio worker**, because there
isn't one (§7). Specifically unverified end to end:

- diarisation on real session audio,
- `/embed` against a real enrollment clip (including the 400-vs-502 split),
- a Qdrant voice gallery search returning a real match,
- audio redaction output.

The tests that cover this path exercise the **fail-closed** branch —
`AudioUnavailableError` → `DEFERRED` — which is the correct behaviour with the
worker down and is why the suite is unaffected by its absence. Do not read a
green suite as "the audio pipeline works".

### 5.1 `VOICE_MATCH_THRESHOLD` is not calibrated — treat this as a live risk

`VOICE_MATCH_THRESHOLD` defaults to **0.10** (a cosine **similarity**, higher is
a closer match — Qdrant's `Cosine` distance returns a similarity, and
`searchVoiceGallery` rejects anything *below* the threshold). The value was
carried over unchanged from the worker's old `SIMILARITY_THRESHOLD`; **nobody
measured it.**

0.10 sits well below published ECAPA operating points, and it errs in the
direction that costs the most: a **bystander** who happens to score above it is
accepted as an enrolled subject, and their voice survives the redaction. The
warning is written into `recording.service.js` above the constant and into
`backend/.env.example`, but a comment is not a fix. **Measure it against real
session audio and raise it before this pipeline is trusted with anything.** This
is arguably the largest single piece of unfinished business in Phase 2 and it is
blocked on the same missing token.

The knob lives in exactly one place now. `SIMILARITY_THRESHOLD` was **removed**
from `ai-core/audio-worker/config.py` and `.env.example` rather than left unused
— a knob that still reads from the environment but no longer changes who gets
identified is worse than no knob, because someone tunes it, sees no effect, and
concludes the matching is broken.

---

## 6. Traps — every one of these cost real time

1. **Migrations fail with 42501 unless you override `DIRECT_URL`.**
   `prisma migrate deploy` fails `P3018 / permission denied for schema public`
   because `DIRECT_URL` points at `prism_app`, which **deliberately cannot run
   DDL**. Set `$env:DIRECT_URL` to the `ADMIN_DATABASE_URL` value **for the
   duration of the migrate command only**. If a migration half-applied, recover
   with `prisma migrate resolve --rolled-back <name>` first. This is the required
   procedure for every future migration in this repo.

2. **A new table needs its own `prism_app` grant block** (§4.1). Missing it fails
   at runtime on first use, not at deploy time.

3. **Router mount order is load-bearing in `backend/src/app.js`.**
   `sessionRoutes.use(requireRole('collectionAgent','super_admin'))` is
   *router-level* middleware that runs on every request **reaching** that router.
   Any router admitting other roles must be mounted **before** it. That is why
   `recordingRoutes` sits ahead of `sessionRoutes` — moving it back re-breaks
   dataOwner/dataAdmin on all three audio GETs with a 403.

4. **Prefer the Grep tool over Bash pipelines here.** Bash `grep` hit the 120 s
   tool timeout on this repo. `Grep` with `multiline: true` works. A Bash heredoc
   invoking `python` was intercepted by the environment.

5. **Run the full suite in the background.** Foreground `npm test` exceeds the
   10-minute cap. `rbac-matrix.test.js` alone takes ~67 s and is safe in the
   foreground.

6. **`context/docx_media/word/media/image1..8.png` once showed as deleted in
   `git status` with no edit having touched them.** Restore with
   `git checkout -- context/docx_media`. Cause unknown; **do not commit the
   deletion.** This one is worth re-reading before Phase 3, whose whole job is
   deleting files — you will be running `git status` against a tree full of
   intentional deletions and an accidental one would blend right in.

7. **Docker containers stop between sessions and the symptom looks like a code
   regression.** See §2.1.

---

## 7. Blockers and things that are wrong in the plan

### STILL BLOCKED — the audio worker (:8003) cannot start

`ai-core/audio-worker/` has a `.env.example` but **still no `.env`**, and compose
requires one. `HF_TOKEN` is mandatory because `pyannote/speaker-diarization-3.1`
is a gated model. **Only the user can supply that token — do not fabricate one.**
This was raised with the user during Phase 2 and is still outstanding.

To unblock: accept the licence at
`https://huggingface.co/pyannote/speaker-diarization-3.1`, generate a read token
at `https://huggingface.co/settings/tokens`, and put it in
`ai-core/audio-worker/.env`.

Consequences while it is missing, so you can scope around it: `AUDIO_CAPTURE_ENABLED`
stays off, every voice route answers **503**, both portals render voice as "not
offered here", recordings go `DEFERRED`, and §5's list stays unverified. The
suite is unaffected — it tests exactly that fail-closed branch.

### A published-plan item that is WRONG — do not implement it

**Plan item 0.4, "Route audio blobs under the per-subject DEK", is incorrect and
was deliberately not implemented.** A recording is a **multi-speaker object**; a
per-subject key would mean one speaker's erasure destroys every other speaker's
data in the same file. The correct model, which is what is in the tree: blobs
stay under `sessions/<sid>/audio/` (session/path DEK), and erasure works through
explicit purge locations (**L14/L15/SEGMENT**). Already reported to the user.

**The rule is about the object, not the modality**, and Phase 2 applied it in the
other direction: a voice **enrollment** is single-subject, so its embedding *is*
sealed under the per-subject DEK, exactly as the face enrollment is.

### Smaller open gaps

- The onboarding `Enroll.jsx` page is **deliberately face-only**. Voice is
  managed from the Consent Hub. Sign-in is already a three-screen OTP walk and
  adding a microphone step to it would cost more completed enrollments than the
  voice prints are worth at this stage. Revisit only if the user asks.
- The super_admin dashboard's Admin accounts / Data principals / Open breaches
  tiles still have no destination screen.
- The RBAC matrix's 2 inconclusive checks (§2.1).
- *(fixed before this handoff shipped)* `admin-portal/src/lib/api.js` carried a
  comment saying the voice-enrollment routes "404 unless AUDIO_CAPTURE_ENABLED is
  on". They answer **503**; the code was always right, only the comment was
  wrong. Corrected — noted here so a diff reader knows why that line moved.

---

## 8. Phase 3 — delete dead code

The plan's scope: `ai-core/audio-services`, `ai-core/prism-visual-pipeline`,
`ai-core/text-services`, plus the vestigial video and text pipelines.

What this session checked so you do not have to re-check it:

- **All three directories exist** under `ai-core/`. The live workers are
  `ai-core/audio-worker` (singular), `ai-core/image-pii-worker`, and
  **`face-worker/` at the repo root, not under `ai-core/`.** Do not delete those
  three.
- **Nothing imports the dead directories.** A repo-wide search for
  `audio-services|prism-visual-pipeline|text-services` outside `node_modules`
  returns only: their own `pyproject.toml`/`uv.lock`; two of the dated handoffs
  and `face-matching-plan.md`; and **two provenance comments in
  `ai-core/image-pii-worker/`** (`pii_recognizers.py:2` and `main.py:40`) that
  cite `ai-core/text-services/app.py` as where the recognisers and the Presidio
  score threshold came from. Those are comments, not imports — but they become
  dangling references the moment you delete the directory, so rewrite them in the
  same change.
- **Check `docker-compose` / `compose.yaml` under `backend/` for service entries**
  pointing at the deleted directories before you delete; a stale build context
  breaks `docker compose up` for everyone including the live workers.

Verification for Phase 3 should be: the full suite at the §2.1 baseline, both
portals lint+build, `docker compose config` parses, and the live workers still
start.

## 9. Phases 4–5, unstarted

- **Phase 4 — UI:** design tokens, consistent loading/empty/error states, a
  mobile user portal, accessibility, a consent-copy review.
- **Phase 5 — release:** a frontend test harness, CI, a load test at 5 000 items,
  closing DPIA R11/R12, repo hygiene, a manual pass over both portals, the
  production checklist.

---

## 10. Domain refresher (skip if you already know PRISM)

Samsung worklet: a **DPDP 2023 (India)** consent-management + DSAR platform.

- **Stack:** Node/Express/Prisma/PostgreSQL (Supabase), Redis + BullMQ, Qdrant,
  two React/Vite portals (**admin :5180**, **user :5173**), FastAPI Python
  workers (face **:8001**, image-PII **:8002**, audio **:8003**).
- **Roles:** `super_admin`, `dpo`, `dataOwner`, `collectionAgent`, `dataAdmin`
  (the `AdminRole` enum) plus **`Subject`** — the data principal, authenticated
  separately via a subject session cookie.
- **DPDP §11–§13:** access / correction / portability / erasure / grievance.
- **Envelope encryption:** `MEDIA_KEK` → per-session (path-scoped), per-subject,
  per-project and per-export DEKs; crypto-shred via `destroySubjectKey()`.
- **Location codes:** L2 original, L3 face crop, L4 enrollment selfie, L5
  embedding, L6 redacted, L7 per-person cache, L8 vault, L9 export, L10 DSAR
  package, L11 backup, L12/L13 import original/redacted, **L14/L15 recording
  original/redacted, L16 voice clip, L17 voice embedding**.
- **Fail-closed posture:** `PiiUnavailableError` / `AudioUnavailableError` →
  `DEFERRED`, **never** treated as clean. *"Worker down"* and *"worker found
  nothing"* must never collapse into the same outcome.
- **`SubjectDataItem` is a rebuildable projection, never an authority.** It is
  tombstoned, not deleted.
- **Shared-object downgrade:** `sharedSubjectCount > 1` downgrades DELETE →
  REDACT server-side, never client-side.
- **Embedding dimensions differ by modality:** face (buffalo_l) is **512**, voice
  (ECAPA-TDNN) is **192**.

Key env (`backend/.env.example`): `DATABASE_URL`/`DIRECT_URL` connect as
`prism_app`; `ADMIN_DATABASE_URL` is the owner role used **only** by
`prisma migrate deploy` and `scripts/sql/*` — the server never uses it.
`AUDIO_CAPTURE_ENABLED` is a kill switch: exactly `"on"` mounts the recording
and voice-enrollment routes, anything else returns **503**. Voice knobs:
`VOICE_MATCH_THRESHOLD` (§5.1), `VOICE_MAX_ENROLLMENTS_PER_SUBJECT`,
`VOICE_ENROLL_MIN_SECONDS`. Required secrets: `FACE_EMBEDDING_KEY`, `MEDIA_KEK`
(+ `_VERSION`, `_PREVIOUS`, `MEDIA_REQUIRE_SEALED`), `AUDIT_HMAC_SECRET`,
`JWT_SUBJECT_SECRET`, `JWT_ADMIN_SECRET`, `DSAR_SIGNING_SEED`.

---

## 11. Read these before starting

| File | Why |
|---|---|
| the plan artifact (§1) | the spec you are executing |
| `docs/HANDOFF_2026-08-16_phase2-audio.md` | the Phase 2 handoff this one supersedes; its §5 is the spec Phase 2 was built against |
| `docs/02_ROLE_PERMISSION_MATRIX.md` | §B is the server authority; **§D** is the identity rule; **§E** is the front-end page table |
| `backend/tests/security/rbac-matrix.test.js` | the executable form of §B — an unclassified route is a failure |
| `backend/src/lib/voiceGallery.js` | the 192-dim, per-recording Qdrant gallery |
| `backend/src/lib/audioFeature.js` | the shared `AUDIO_CAPTURE_ENABLED` gate |
| `backend/src/modules/enrollment/voiceEnrollment.service.js` | capture → embed → seal → persist |
| `backend/src/modules/recordings/recording.service.js` | analyze/redact, `resolveSpeakerConsent`, the muting default, `VOICE_MATCH_THRESHOLD` |
| `ai-core/audio-worker/README.md` | the current `/analyze` + `/embed` contract and where the threshold lives |
| `docs/HANDOFF.md` + the dated handoffs it lists | the pre-existing platform; **none are to be deleted** |
| `PLAN.md` | the earlier, completed 9-phase DSAR plan — historical, not the current spec |
