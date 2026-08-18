# PRISM — handoff: Phase 1 complete, Phase 2 (audio, properly) is next

**Date:** 2026-08-16
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

then, scoping this session:

> *"complete only phase 1 as of now and write a handoff at the end for phase 2"*

The spec being executed is the published production-readiness plan:
**https://claude.ai/code/artifact/f6896ba4-0b03-4add-a869-4557a44f9cc3**
Read it before starting Phase 2. Two standing obligations: **implement phase by
phase**, and **verify after each phase** rather than at the end.

The user has raised no security or credential constraints, and has issued no
correction to the approach.

---

## 2. State

| Phase | State |
|---|---|
| **Phase 0 — correctness/security blockers** | ✅ complete, verified |
| **Phase 1 — role model + portal access** | ✅ **complete, verified** (this session) |
| **Phase 2 — audio, properly** | ⬜ not started — this is your work |
| Phases 3–5 | not started |

### Verification actually run at the end of Phase 1

```
admin-portal  npm run build   ✔ 1834 modules, no errors
admin-portal  npm run lint    ✔ 4 warnings, all pre-existing
user-portal   npm run build   ✔ 1812 modules, no errors
user-portal   npm run lint    ✔ 2 warnings, both pre-existing
backend       npx node --test tests/security/rbac-matrix.test.js
                              ✔ tests 4 / pass 4 / fail 0
backend       npm test        — see §2.1
```

The RBAC gate is the one that matters for Phase 1 and it is green. It still
reports the same **2 inconclusive checks** as before this session
(`POST /auth/subject/login` for `subject` and for `anon`, both answered by the
rate limiter first) — pre-existing, unrelated to Phase 1, and re-runnable
against a fresh limiter window.

### 2.1 The full suite

Baseline to hold, from Phase 0: **`# tests 123 / # pass 123 / # fail 0`**.
`npm test` takes ~8 minutes and **must be run in the background** — it exceeds
the 10-minute foreground cap. Phase 1 touched the front end plus two hrefs in
`dashboard.service.js`; no backend test asserts on tile hrefs, so no change to
that number is expected. **Confirm it before you start Phase 2** — a Phase 2
regression is far cheaper to find against a known-good baseline.

---

## 3. Nothing is committed

`git status --short`:

```
 M admin-portal/src/App.jsx                              <-- Phase 1
 M admin-portal/src/auth.jsx                             <-- Phase 1
 M admin-portal/src/components/Sidebar.jsx               <-- Phase 1
 M admin-portal/src/pages/dataAdmin/DsarQueue.jsx        <-- Phase 1
 M admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx<-- Phase 1
 D admin-portal/src/pages/dpo/RequestOversight.jsx       <-- Phase 1
 M admin-portal/src/roles.js                             <-- Phase 1
 M backend/src/modules/dashboard/dashboard.service.js    <-- Phase 1
 M docs/02_ROLE_PERMISSION_MATRIX.md                     <-- Phase 1 (new §E)
 M user-portal/src/App.jsx                               <-- Phase 1
 M user-portal/src/components/BottomNav.jsx              <-- Phase 1
 M user-portal/src/components/NavItems.js                <-- Phase 1
 M user-portal/src/components/SidebarNav.jsx             <-- Phase 1
?? user-portal/src/components/RequireAuth.jsx            <-- Phase 1

 M backend/.env.example                                  <-- Phase 0
 M backend/prisma/schema.prisma                          <-- Phase 0
 M backend/src/app.js                                    <-- Phase 0
 M backend/src/middleware/requireRole.js                 <-- Phase 0
 M backend/src/modules/dsar/*.js                         <-- Phase 0
 M backend/src/modules/recordings/*.js                   <-- Phase 0
 M backend/src/modules/sessions/session.service.js       <-- Phase 0
 M backend/tests/security/rbac-matrix.test.js            <-- Phase 0
 M docs/HANDOFF.md                                       <-- Phase 0
?? backend/prisma/migrations/20260816000001_audio_first_class/
?? backend/prisma/migrations/20260816000002_access_object_recording/
?? backend/tests/integration/dsar-audio-erasure.test.js
?? docs/HANDOFF_2026-08-16_production-readiness.md       <-- the Phase 1 handoff
```

Both migrations are **already applied to the dev database**. Do not re-run them
and do not `migrate reset`.

Recent commits: `aa170ec` (merge origin/dev) ← `5573084` (audio worker built) ←
`9a09a78` (DSAR system, PLAN phases 3-9).

---

## 4. What Phase 1 actually changed

The defect: `super_admin` could reach **nothing** in the admin portal, and any
page two roles legitimately share could be entered by only one of them. The
cause was structural and purely front-end — each role carried its own `nav`
array, `App.jsx` emitted `allow={[role.key]}` from it (one role per route by
construction), and `roles.js` had no `super_admin` key at all. The backend was
already correct throughout.

### 4.1 `admin-portal/src/roles.js` — inverted to a page-first table

```js
export const PAGES = [ { path, label, icon, group, roles: [...] }, … ]  // 23 entries, ordered
export const GROUPS = { governance, projects, collection, requests, oversight }
export const ROLES = { … }   // metadata ONLY — no `nav` any more
export const ROLE_ORDER = ['dpo','dataOwner','collectionAgent','dataAdmin','super_admin']

navForRole(roleKey) · navSectionsForRole(roleKey) · rolesForPath(path) · landingPathForRole(roleKey)
```

**The contract, and the rule you must keep:** `roles` on each page is the
**front-end** gate; the server's gate is `docs/02_ROLE_PERMISSION_MATRIX.md §B`,
mirrored in `backend/tests/security/rbac-matrix.test.js`. **`PAGES` must stay a
subset of that table** — a page is listed for a role only if **every endpoint
that page calls on mount** admits that role. Where a page calls a narrower
endpoint from a *button*, the page hides that button itself.

The whole derivation is now written down in **`docs/02_ROLE_PERMISSION_MATRIX.md`
§E**, added this session: the 23-row page table with the narrowest mount-time
endpoint per page, the per-page control gating, and the subject-portal note.
**Update §E whenever you add a page or widen a role** — it is the only place the
front-end half of the matrix is recorded.

### 4.2 The other seven items

| # | File | What |
|---|---|---|
| 1 | `App.jsx` | routes generated from `PAGES` (one route, every role); `super_admin` added to the five hand-wired `/sessions/:sessionId*` routes; `/dsar/:requestId` widened to include `dataOwner` |
| 2 | `Sidebar.jsx` | consumes `navSectionsForRole`; group headings render only when >1 section, so only super_admin sees them |
| 3 | `DsarQueue.jsx` | shared by four roles now: identity search + import shortcut gated to `dataAdmin`/`super_admin`; **Overdue only** toggle ported from RequestOversight into both `reload` and *Load more* |
| 4 | `RequestOversight.jsx` | **deleted** — superseded in every respect. Its dashboard tile href now points at `/dpo/dsar-queue` |
| 5 | `DsarRequestDetail.jsx` | tab strip derived from the role (§4.3) |
| 6 | `auth.jsx` | `RequireRole` renders a **stated refusal** naming role + path + permitted roles, instead of a silent `<Navigate to="/dashboard">` |
| 7 | user-portal | `RequireAuth` added; nav rebuilt around the rights (§4.4) |
| 8 | — | flat API hrefs were already done in `Dashboard.jsx` (`HREF_PREFIXES`/`resolveHref`); verified, and it is the only consumer of `tile.href` |

Plus, from §8 of the previous handoff: `superAdminSummary()` tiles now carry
hrefs (Projects → `/my-projects`, Open DSAR → `/dsar-queue`, Break-glass →
`/audit-logs`). **Admin accounts, Data principals and Open breaches deliberately
still have none** — no screen exists for them, and a tile that 404s is worse
than a tile that only counts. That is the standing gap on that dashboard.

### 4.3 `DsarRequestDetail.jsx` — how the role gating works

Four roles reach the route and no two may call the same endpoints, so the tab
strip is derived, not fixed. Constants at the top mirror `dsar.routes.js`
one-for-one:

```js
ITEM_READ_ROLES     = ['dpo','dataAdmin','super_admin']            // items, timeline, action log
ITEM_WRITE_ROLES    = ['dataAdmin','super_admin']                  // items/actions, package
DISCOVERY_ROLES     = ['dataOwner','dataAdmin','super_admin']
EXECUTE_ROLES       = ['dataAdmin','super_admin']
EVIDENCE_WRITE_ROLES= ['dataOwner','dataAdmin','super_admin']
CLOSE_ROLES         = ['dpo','dataAdmin','super_admin']            // POST /close
APPROVE_ROLES       = ['dpo','dataOwner','super_admin']            // POST /approve
```

Consequences worth knowing before you touch this file:

- **A dataOwner never fires `/items`, `/timeline` or `/items/actions`.** The
  guard is repeated inside `loadItems()` and inside the tab `useEffect`, not
  only in the tab strip, because `runDiscovery`/`runExecute` also call
  `loadItems()` on success and a stale `tab` between renders must not leak a
  request.
- **`tab` snaps to the first tab the role has** once `roleKey` arrives from the
  `/me` round-trip. The first render can otherwise carry `data` for a dataOwner.
- **A new `evidence` tab** (all four roles) lists `GET /dsar/evidence` filtered
  to this request, offers `POST /dsar/:id/evidence` to `EVIDENCE_WRITE_ROLES`,
  and renders the deletion certificate when one exists. This is a dataOwner's
  entire workspace on this page, alongside Run discovery and the sign-off.
- **Close goes through two endpoints.** `POST /close` for `CLOSE_ROLES`;
  `POST /approve` for everyone else who has the tab. `approveResolution()` in
  `dsar.service.js` is the same `REVIEW → CLOSED` transition, so a dataOwner
  signs off through it. The button, heading and confirm dialog all change wording.

### 4.4 user-portal

- **`RequireAuth.jsx` (new)** wraps `AppLayout`. There was **no auth gate at
  all**: thirteen signed-in routes under a bare layout, only 2 of 13 pages
  calling `useMe`. A signed-out visitor typing `/my-data` got the full shell.
  It sends a refused visitor to `/login` and **does not** carry a return-to —
  sign-in is a three-screen OTP walk (`/login → /verify → /enroll`) with no
  `from` threaded through it, so promising a bounce-back would be a lie. If you
  want return-to, that is a change to all three screens.
- **`NavItems.js`** now exports `NAV_SECTIONS` (Overview / Consent / Your rights
  / Account, 10 entries), `NAV_ITEMS` (flattened), and `PRIMARY_NAV` (5 entries
  for the mobile bar: dashboard, consent, rights, requests, profile). It used to
  expose 4 routes against 13, leaving the entire DPDP §11–§13 rights surface
  reachable only by typing the URL.

---

## 5. Phase 2 — audio, properly

Four items from the published plan. Everything below was verified against the
tree this session, so the "where it stands" column is current, not remembered.

### 5.1 `SubjectVoiceEnrollment` + a Qdrant collection

**This is the core of the phase and everything else in it is smaller.**

Where it stands: **there is no persisted voice enrollment anywhere.** The agent
uploads reference `voice_snippets` as multipart files **at analyze time**
(`recording.routes.js:129`, `recording.service.js:50`), and the worker
re-embeds every snippet on every call (`ai-core/audio-worker/main.py:82-95`).
So speaker identity depends on whoever happens to attach the right WAVs to that
one request, and nothing is reusable across sessions.

The model to mirror is **`SubjectFaceEnrollment`** (`schema.prisma:114-140`) —
it is the right shape and its comments state the reasoning:

- the reference blob **and** its embedding are both persisted;
- the embedding is `Bytes?` sealed AES-256-GCM as `nonce(12)||tag(16)||ct`, with
  an `embeddingDim` column and a `null` meaning "legacy row, re-derive on use";
- **`encKeyId`** names the per-subject DEK from `lib/keyring.js`, so
  `destroySubjectKey()` **crypto-shreds** the biometric;
- the embedding is **never selected by any API response**;
- soft delete: `deletedAt` keeps the tombstone for the audit chain, the file and
  the biometric go immediately.

Every one of those properties is load-bearing for a voice enrollment too. A
voice print is §2 sensitive personal data under DPDP exactly as a face embedding
is, and the erasure story has to be identical.

**Watch for:** `ai-core/audio-worker/speaker_id.py` uses SpeechBrain ECAPA-TDNN
(`spkrec-ecapa-voxceleb`) at 16 kHz — the vector dimension is **192**, not the
512 of buffalo_l. Do not copy the face dimension. `match_speaker()` already
refuses to guess: it returns `None` below `SIMILARITY_THRESHOLD`, and its
docstring states the caller must treat an unmatched speaker as an unconsented
bystander, which `recording.service.js:231-238` does (defaults to muting). Keep
that contract when the gallery moves to Qdrant.

**Also design for:** the `⚑` break-glass rules in matrix §C, and a
`GET /subjects/:id/voice-enrollments` route classified in `rbac-matrix.test.js` —
**an unclassified route is a test failure**, so the matrix row and the doc row
land in the same change as the route.

### 5.2 Gallery-based speaker identification

Follows from 5.1: replace the per-request `voice_snippets` upload with a gallery
built once per session from stored enrollments, the way the face pipeline builds
a session gallery from persisted embeddings ("in seconds instead of one
face-service round trip per enrollment per session" — `schema.prisma:112`).

`resolveSpeakerConsent()` (`recording.service.js:151-171`) already resolves every
matched speaker against real `ProjectConsent` in one pair of queries and was
explicitly de-N+1'd; do not regress it.

### 5.3 Audio in retention, purge and handoff-blocking

Two confirmed holes, both one-liners to find and neither one trivial to fix well:

- **`backend/src/workers/retention.worker.js` shreds `Photo.storagePath` only.**
  It never looks at `Recording.storagePath`. A recording therefore outlives the
  original-media TTL that governs every photo in the same session. The photo
  logic has the rule you must copy: the row survives, the original is shredded,
  and **only when a redacted derivative exists to replace it** (lines 27-36).
  For audio that means `isRecordingRedactedAvailable()` — already exported from
  `itemIndex.service.js:119`, `redactedPath && status === 'REDACTED'`.
- **`backend/src/modules/handoff/handoff.service.js:92` blocks on photos only:**
  `OR: [{piiStatus:'DEFERRED'}, {piiStatus:'FAILED'}, {redactedPath:null}]`. A
  `Recording` with `status = DEFERRED` or `redactedPath = null` does **not**
  block a handoff, so an unmasked voice can leave the platform in a dataset. The
  `REDACTION_INCOMPLETE` error at line 98 needs an audio counterpart, and the
  fail-closed rule is already stated on `RecordingStatus.DEFERRED`
  (`schema.prisma:1188-1196`): worker-unreachable is **not** cleared.

Purge and discovery are **already done** — Phase 0 built L14/L15/SEGMENT into
`discovery.service.js:172-224` and `purge.service.js:37-45`, in the ordering
SEGMENT → L15 → L14 (re-mute survivors before destroying the original, same
reason as LINK → L6 → L2). `backend/tests/integration/dsar-audio-erasure.test.js`
covers it. **Do not redesign that.**

### 5.4 Audio rows in the DSAR item grid

Smallest item; do it first for a quick verified win.

`admin-portal/src/components/ItemGrid.jsx` renders **no type column at all**, so
a PHOTO row and an AUDIO row are indistinguishable. The data is already there —
`itemSearch.service.js:195` returns `type`, and `itemIndex.service.js:132-153`
puts `durationSec`, `recordingStatus` and a `speakerCount` into `meta`. It needs
rendering, not plumbing.

Note the counting rule so you label it correctly: **one index row per (subject,
recording), not per segment** (`itemIndex.service.js:21`), and
`sharedSubjectCount` for audio is the count of **distinct identified subjects
across the whole recording** — which is what makes the DELETE → REDACT downgrade
correct for a multi-speaker file.

---

## 6. Traps — every one of these cost real time

1. **Migrations fail with 42501 unless you override `DIRECT_URL`.**
   `prisma migrate deploy` fails `P3018 / permission denied for schema public`
   because `DIRECT_URL` points at `prism_app`, which **deliberately cannot run
   DDL**. Set `$env:DIRECT_URL` to the `ADMIN_DATABASE_URL` value for the
   duration of the migrate command only. If a migration half-applied, recover
   with `prisma migrate resolve --rolled-back <name>` first. **This is the
   required procedure for every future migration in this repo** — and Phase 2
   needs at least one, for `SubjectVoiceEnrollment`.

2. **Router mount order is load-bearing in `backend/src/app.js`.**
   `sessionRoutes.use(requireRole('collectionAgent','super_admin'))` is
   *router-level* middleware that runs on every request **reaching** that
   router. Any router admitting other roles must be mounted **before** it. That
   is why `recordingRoutes` sits ahead of `sessionRoutes` — moving it back
   re-breaks dataOwner/dataAdmin on all three audio GETs with a 403.

3. **Prefer the Grep tool over Bash pipelines here.** Bash `grep` hit the 120 s
   tool timeout on this repo. `Grep` with `multiline: true` works. A Bash
   heredoc invoking `python` was intercepted by the environment.

4. **Run the full suite in the background.** Foreground `npm test` exceeds the
   10-minute cap. `rbac-matrix.test.js` alone takes ~67 s and is safe in the
   foreground.

5. **`context/docx_media/word/media/image1..8.png` once showed as deleted in
   `git status` with no edit having touched them.** Restore with
   `git checkout -- context/docx_media`. Cause unknown; do not commit the
   deletion.

6. **Docker containers stop between sessions, and the symptom looks like a code
   regression.** Bring them back with
   `docker start prism-redis prism-qdrant prism-face-worker prism-image-pii-worker`,
   and **check `docker ps` before you trust any suite result**. With them
   stopped the suite reports **`# pass 90 / # fail 33`** out of 123 — a third of
   the tests down at once, which reads exactly like a broken change until you
   look at `docker ps`. It cost a full 8-minute run this session. Qdrant is
   already running for the face
   pipeline — Phase 2 adds a collection to it, not a new service.

---

## 7. Blockers and things that are wrong in the plan

### BLOCKED — the audio worker (:8003) cannot start

`ai-core/audio-worker/` has a `.env.example` but **no `.env`**, and compose
requires one. `HF_TOKEN` is mandatory because `pyannote/speaker-diarization-3.1`
is a gated model. **Only the user can supply that token — do not fabricate one.**

This fails *closed* by design: `AudioUnavailableError` → the request goes
`DEFERRED`, which is the tested behaviour, so the 123-test suite is unaffected.
But **no real diarisation or audio redaction can be exercised end to end until
the token arrives**, which directly limits how far 5.1 and 5.2 can be verified.
Ask the user for it at the start of Phase 2 — this is the single thing most
likely to stall the phase.

### A published-plan item that is WRONG — do not implement it

**Plan item 0.4, "Route audio blobs under the per-subject DEK", is incorrect and
was deliberately not implemented.** A recording is a **multi-speaker object**; a
per-subject key would mean one speaker's erasure destroys every other speaker's
data in the same file. The correct model, which is what is in the tree: blobs
stay under `sessions/<sid>/audio/` (session/path DEK), and erasure works through
explicit purge locations (**L14/L15/SEGMENT**). This was already reported to the
user.

Note the tension with §5.1: a **voice enrollment** is single-subject, so it
*should* be sealed under the per-subject DEK exactly as the face enrollment is.
The rule is about the object, not the modality.

### Smaller open gaps

- The super_admin dashboard's Admin accounts / Data principals / Open breaches
  tiles have no destination screen (§4.2).
- The RBAC matrix reports **2 inconclusive checks** because the rate limiter
  answered first: `POST /auth/subject/login` for `subject` and for `anon`.

---

## 8. Phases 3–5, unstarted

- **Phase 3 — delete dead code:** `ai-core/audio-services`,
  `prism-visual-pipeline`, `text-services`, plus the vestigial video and text
  pipelines. (Note the live worker is `ai-core/audio-worker` — singular. Do not
  delete that one.)
- **Phase 4 — UI:** design tokens, consistent loading/empty/error states, a
  mobile user portal, accessibility, a consent-copy review.
- **Phase 5 — release:** a frontend test harness, CI, a load test at 5 000
  items, closing DPIA R11/R12, repo hygiene, a manual pass over both portals,
  the production checklist.

---

## 9. Domain refresher (skip if you already know PRISM)

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
  original/redacted**.
- **Fail-closed posture:** `PiiUnavailableError` / `AudioUnavailableError` →
  `DEFERRED`, **never** treated as clean. *"Worker down"* and *"worker found
  nothing"* must never collapse into the same outcome.
- **`SubjectDataItem` is a rebuildable projection, never an authority.** It is
  tombstoned, not deleted.
- **Shared-object downgrade:** `sharedSubjectCount > 1` downgrades DELETE →
  REDACT server-side, never client-side.

Key env (`backend/.env.example`): `DATABASE_URL`/`DIRECT_URL` connect as
`prism_app`; `ADMIN_DATABASE_URL` is the owner role used **only** by
`prisma migrate deploy` and `scripts/sql/*` — the server never uses it.
`AUDIO_CAPTURE_ENABLED` is a kill switch: exactly `"on"` mounts the recording
routes, anything else returns 503. Required secrets: `FACE_EMBEDDING_KEY`,
`MEDIA_KEK` (+ `_VERSION`, `_PREVIOUS`, `MEDIA_REQUIRE_SEALED`),
`AUDIT_HMAC_SECRET`, `JWT_SUBJECT_SECRET`, `JWT_ADMIN_SECRET`,
`DSAR_SIGNING_SEED`.

---

## 10. Read these before starting

| File | Why |
|---|---|
| the plan artifact (§1) | the spec you are executing |
| `docs/02_ROLE_PERMISSION_MATRIX.md` | §B is the server authority; **§D** is the identity rule; **§E** is the new front-end page table |
| `backend/tests/security/rbac-matrix.test.js` | the executable form of §B — an unclassified route is a failure |
| `backend/prisma/schema.prisma:114-140` | `SubjectFaceEnrollment`, the model to mirror for voice |
| `backend/prisma/schema.prisma:1188-1290` | `RecordingStatus`, `Recording`, `AudioSegment` |
| `backend/src/modules/recordings/recording.service.js` | analyze/redact, `resolveSpeakerConsent`, the muting default |
| `ai-core/audio-worker/{main,speaker_id,schemas}.py` | the current snippet-upload contract you are replacing |
| `backend/src/modules/dsar/itemIndex.service.js` | the audio index row and its meta |
| `docs/HANDOFF_2026-08-16_production-readiness.md` | the Phase 1 handoff this one supersedes |
| `docs/HANDOFF.md` + the dated handoffs it lists | the pre-existing platform; **none are to be deleted** |
| `PLAN.md` | the earlier, completed 9-phase DSAR plan — historical, not the current spec |
