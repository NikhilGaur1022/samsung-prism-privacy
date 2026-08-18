# PRISM — handoff: production-readiness plan, Phase 0 done / Phase 1 in flight

**Date:** 2026-08-16
**Branch:** `main` (working tree dirty — nothing committed yet, see §3)
**Written for a session with zero memory of the one that produced it.**

> **A Read-tool hook truncates `PLAN.md` and `docs/*.md` to line 1 and claims the
> file is already summarised. It is not.** Read them with
> `Get-Content FILE` (PowerShell) or `sed -n '1,240p' FILE` (Bash) instead.
> This file included.

---

## 1. What the user asked for, in their words

Four sequential requests. The first three are closed; the fourth is what you are
executing.

1. *"pull and merge the branch that was pushed by raisa and then merge and push it
   to the main"* — done (`aa170ec`).
2. *"please analyse this codebase … the project is not working as intended and we
   are not able to input audio and video files as well … all the admin portals,
   there are some things that some admin portals are not supposed to have and some
   are there which the admins are supposed to have … map out the entire data flow
   from the user and then the data collection agent and then to who and then
   finally where does it go and how does the entire dsar happens and what and all
   features work and which do not … now i want to push this to the production and
   in terms of ui and everything this is very bad"* — done (analysis delivered).
3. *"okay for now make a plan for to make this profuction read and fix all of the
   things and please be precise and make a detailed plan"* — done. **The plan is
   published at https://claude.ai/code/artifact/f6896ba4-0b03-4add-a869-4557a44f9cc3
   — read it before touching anything.** It is the spec for the work below.
4. **ACTIVE:** *"please start implimenting this plan phase wise and make sure to
   check everthing works or not after each implimentation and please make make the
   system end to end proper because y life depends on this"*

Two standing obligations from (4): **implement phase by phase**, and **verify
after each phase** rather than at the end. The user has given no corrections to
the approach since (4) was issued, and has stated no security or credential
constraints at any point.

---

## 2. Where the work actually stands

| Phase | State |
|---|---|
| **Phase 0 — correctness/security blockers** | ✅ complete, verified green |
| **Phase 1 — role model + portal access** | 🔨 **1 of 8 items landed; build is currently broken (intentionally, mid-edit)** |
| Phases 2–5 | not started |

### Phase 0 — done and proven

Background test run finished `exit_code 0`. TAP tail:

```
1..123
# tests 123   # pass 123   # fail 0
# cancelled 0 # skipped 0  # todo 0
# duration_ms 473951.4553
```

Baseline before this work was **117** (per `docs/HANDOFF.md`); the +6 delta is
exactly the new `backend/tests/integration/dsar-audio-erasure.test.js`. **No
regressions.** That 123/123 is the number any later change must hold.

Closed in Phase 0: audio invisible to DSAR erasure (P0-01); any agent could reach
any session's audio (P0-02); the RBAC gate was red (P0-03); audio upload OOM
(P1-09); an audio N+1 query; a hardcoded `.wav`; missing sha256/encKeyId/dedupe on
recordings; missing `AccessObjectType` enum values; a router mount-order bug; and
audio missing from the §11 access package.

### Phase 1 — exactly one file has been rewritten

**`admin-portal/src/roles.js` (317 lines) is fully rewritten and is the only
Phase 1 edit that exists.** Everything else in Phase 1 is untouched.

That rewrite **deliberately breaks the admin portal build**, and you must finish
the sequence in §5 before it compiles. See §4 for why.

---

## 3. Working-tree state — nothing is committed

`git status --short` on `main`:

```
 M admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx
 M admin-portal/src/roles.js                      <-- the one Phase 1 edit
 M backend/.env.example
 M backend/prisma/schema.prisma
 M backend/src/app.js
 M backend/src/middleware/requireRole.js
 M backend/src/modules/dsar/discovery.service.js
 M backend/src/modules/dsar/export.service.js
 M backend/src/modules/dsar/itemAction.service.js
 M backend/src/modules/dsar/itemIndex.service.js
 M backend/src/modules/dsar/purge.service.js
 M backend/src/modules/recordings/recording.routes.js
 M backend/src/modules/recordings/recording.service.js
 M backend/src/modules/sessions/session.service.js
 M backend/tests/security/rbac-matrix.test.js
 M docs/02_ROLE_PERMISSION_MATRIX.md
?? backend/prisma/migrations/20260816000001_audio_first_class/
?? backend/prisma/migrations/20260816000002_access_object_recording/
?? backend/tests/integration/dsar-audio-erasure.test.js
```

Everything except `roles.js` and `DsarRequestDetail.jsx` is **Phase 0** work that
is already verified. The two migrations are **already applied to the dev
database** — do not re-run them, and do not `migrate reset`.

Recent commits: `aa170ec` (merge origin/dev) ← `5573084` (audio worker built) ←
`9a09a78` (DSAR system, PLAN phases 3-9).

---

## 4. The Phase 1 design decision you are mid-way through

### The defect

`super_admin` could reach **nothing** in the admin portal. The cause was purely
front-end, and it was structural, not a missing permission:

- old `roles.js` gave each role its own `nav` array; `roles.js` had **no
  `super_admin` key at all**, so it had zero nav entries;
- `App.jsx` generated routes from `Object.values(ROLES).flatMap(role => role.nav…)`
  and wrapped each in `<RequireRole allow={[role.key]}>` — **one role key per
  route, by construction**.

So a page two roles legitimately share (the DSAR queue, the evidence vault, audit
logs, project reports) had to be listed twice and could still only be entered by
one of them. The backend was already correct throughout: `dashboardRoutes.use(
requireRole(…, 'super_admin'))`, `superAdminSummary()` exists and returns six
tiles, and every row of the RBAC matrix already admits `super_admin`.

### The fix that has landed

`roles.js` is inverted to a **page-first table**: the page is the row, roles are
the column.

```js
export const PAGES = [ { path, label, icon, group, roles: [...] }, … ]  // 23 entries, ordered
export const GROUPS = { governance, projects, collection, requests, oversight }
export const ROLES = { … }        // metadata ONLY — no `nav` any more
export const ROLE_ORDER = ['dpo','dataOwner','collectionAgent','dataAdmin','super_admin']

navForRole(roleKey)          // PAGES filtered, in PAGES order
navSectionsForRole(roleKey)  // grouped into { key, label, items }, empty groups dropped
rolesForPath(path)           // for App.jsx route generation
landingPathForRole(roleKey)  // post-sign-in destination
```

`ROLES.super_admin` now exists (label *Platform Administrator*, its own
`accessNote` noting every read is logged against the operator's name), so it
appears on all 23 pages.

**The contract written into the file's header comment, and the rule you must keep:**
`roles` on each page is the **front-end** gate; the server's gate is
`docs/02_ROLE_PERMISSION_MATRIX.md §B`, mirrored in
`backend/tests/security/rbac-matrix.test.js`. **`PAGES` must stay a subset of that
table** — a page is listed for a role only if **every endpoint that page calls on
mount** admits that role. Where a page calls a narrower endpoint from a *button*
rather than on mount, **the page hides that button itself**.

Two deliberate widenings vs. the published plan, both justified by the matrix:

- `/project-reports` gained `dpo` — `GET /projects/:id/report` admits dpo.
- `/audit-logs` gained `dataOwner` — `GET /api/v1/audit` admits dataOwner.

And one retirement: **`/request-oversight` is absent from `PAGES`.** `ShieldAlert`
was dropped from the icon imports accordingly.

### Matrix §D — the identity rule that shapes several of these decisions

**dpo and dataOwner never see subject identity.** That is why:

- `GET /api/v1/dsar/subjects/search` (names + emails) is dataAdmin/super_admin only;
- `GET /api/v1/projects/:id/subjects` is collectionAgent/super_admin only (hence
  `/consent-check` is agent-only);
- DSAR list rows send `subjectRef` (a pseudonym) to a dpo instead of `subjectId`.

`DsarQueue`'s row renderer already honours this correctly — it renders
`r.subjectRef ?? (r.subjectId ? …)`, so it cannot leak an identity the API
withheld nor manufacture a pseudonym the API did not issue. **Do not "improve" it.**

### The breakage this created

`ROLES[roleKey].nav` no longer exists. Two files still read it and are broken
right now:

- `admin-portal/src/App.jsx:133-148` — the route generator.
- `admin-portal/src/components/Sidebar.jsx:24` — `role?.nav.map(...)`.

This is expected and is the next work.

---

## 5. Do this next, in this order

### 5.1 `admin-portal/src/pages/dataAdmin/DsarQueue.jsx` (253 lines, read in full)

The page is now shared by dpo / dataOwner / dataAdmin / super_admin, so it must
withhold what only dataAdmin may call.

1. Import `useAuth` (it does not import it today) and derive
   `const canSearchIdentity = ['dataAdmin','super_admin'].includes(roleKey)`.
2. **Gate block 1 — lines 99–153:** the `<form onSubmit={runSearch}>` identity
   search, its helper `<p>` (*"Exact and prefix matches only — never fuzzy…"*),
   the `searchError` banner, and the `results` `ListPanel`. All are driven by
   `searchDsarSubjects`, which is dataAdmin/super_admin only. The `runSearch`
   handler and the `term`/`results`/`searchError` state go behind the same gate.
   Keep the existing comment explaining why it is submit-on-enter rather than
   search-as-you-type (*every returned principal costs an AccessEvent*).
3. **Gate block 2 — lines 243–249:** the `Import a person's existing data →`
   button that navigates to `/import`. Keep the `useNavigate` import; render the
   button conditionally.
4. **Port the one thing `RequestOversight` uniquely had:** an *"Overdue only"*
   checkbox in the `PageHeader` action, threading `overdue: 'true'` into the
   `listDsar` params in **both** `reload` (line 50) and the *Load more* handler
   (line 225).

   ```jsx
   const [overdueOnly, setOverdueOnly] = useState(false)
   // …in reload(): if (overdueOnly) params.overdue = 'true'   (+ add to deps)
   ```

   **A correction to the published plan:** the plan overstates this port.
   `DsarQueue` **already** renders the per-row SLA due-date line and the
   breach-tone `StatusPill`, in richer form than `RequestOversight` (it also shows
   assignment and the `Counters` found/redacted/deleted/exported). The `overdue`
   toggle is the *only* missing capability. Do not re-add SLA rendering.

### 5.2 `admin-portal/src/App.jsx`

Replace the generator at lines 133–148 with a single map over `PAGES`:

```jsx
{PAGES.map(({ path, label, roles }) => {
  const Page = PAGE_COMPONENTS[path]
  return <Route key={path} path={path}
    element={<RequireRole allow={roles}>{Page ? <Page /> : <Placeholder label={label} />}</RequireRole>} />
})}
```

Also: change the import from `ROLES` to `PAGES`; drop `'/request-oversight'` from
`PAGE_COMPONENTS` (line 45) and its import (line 13); and **add `super_admin` to
the five hand-wired `/sessions/:sessionId*` routes** (lines 85–124) — they are
still one-role-each and strand super_admin exactly the way the generator did.

### 5.3 Delete `admin-portal/src/pages/dpo/RequestOversight.jsx`

96 lines, fully superseded once 5.1 lands.

### 5.4 `admin-portal/src/components/Sidebar.jsx`

Consume `navSectionsForRole(roleKey)` instead of `role?.nav`. Render the group
heading **only when more than one section is present** — a single-section role
should not grow a redundant label. super_admin's 23 entries are what the groups
exist for.

### 5.5 `admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx` (~600 lines, already +187 in the tree)

**dataOwner cannot be given this page as written.** The default `data` tab
unconditionally calls `listDsarItems`, and `GET /dsar/:id/items`, `/timeline` and
`/items/actions` are **dpo/dataAdmin/super_admin only**. Make the page role-aware
so a dataOwner never fires those three, then widen the route:

```jsx
<Route path="/dsar/:requestId" element={<RequireRole allow={['dataAdmin','dpo','dataOwner','super_admin']}>…
```

dataOwner's actually-allowed DSAR routes are: `GET /dsar`, `GET /dsar/:id`,
`GET /dsar/signing-key`, `GET /dsar/evidence`, `POST /dsar/:id/discovery`,
`POST /dsar/:id/evidence`, `POST /dsar/:id/approve`, `GET /dsar/:id/certificate`.
Build the dataOwner view from those and nothing else.

Existing constants in the file: `ACTIONABLE_STATUSES`, `DISCOVERY_STATUSES`,
`EXECUTE_STATUSES`, `ITEM_WRITE_ROLES = ['dataAdmin','super_admin']`,
`CLOSEABLE_STATUSES`, `TABS = [data, timeline, actions, close]`.

### 5.6 `admin-portal/src/auth.jsx` — stated refusals

`RequireRole` currently does `return <Navigate to="/dashboard" replace />` on a
role mismatch (line 52). That silent bounce is indistinguishable from a broken
link and is Phase 1 item 7. Replace it with a rendered refusal that names the role
and the page.

### 5.7 user-portal — two items, both still untouched

- **`user-portal/src/App.jsx` has no auth gate anywhere.** Thirteen signed-in
  routes sit under a bare `<Route element={<AppLayout />}>`. It needs a
  `RequireAuth`. `user-portal/src/lib/useMe.js` is currently used by only 2 of the
  13 protected pages.
- **`user-portal/src/components/NavItems.js` exposes 4 of 13 routes** — only
  `/dashboard`, `/projects`, `/consent`, `/profile`. The entire DPDP rights
  surface (`/rights`, `/my-data`, `/consents`, `/requests`, `/requests/new`,
  `/inbox`, certificates) is **dead unless deep-linked**. Rebuild the nav around
  the rights.

### 5.8 Verify — item 8 is already done

Phase 1 item 8 ("flat API hrefs") is **already implemented** in
`admin-portal/src/pages/Dashboard.jsx` via `HREF_PREFIXES` / `resolveHref()`,
which strips `/dpo`, `/data-owner`, `/agent`, `/data-admin`. Verify and look for
other call sites rather than re-implementing it.

---

## 6. How to verify (the user explicitly asked for this after each phase)

```powershell
# admin portal must compile — it does NOT right now
cd "C:\Users\gaur3\Desktop\Projects\samsung project\admin-portal"; npm run build

# backend RBAC gate (fast, the one that matters for Phase 1)
cd "..\backend"; npx node --test tests/security/rbac-matrix.test.js

# full suite — run in BACKGROUND, it takes ~8 min and times out in the foreground
cd "..\backend"; npm test
```

**Baseline to hold: `# tests 123 / # pass 123 / # fail 0`.**

`rbac-matrix.test.js` (466 lines) is the bidirectional gate: it walks the live
Express router stack via `listRoutes(app)`, and **an unclassified route is a test
failure**. Its definition of "allowed" is narrow and deliberate — *the request was
not rejected for WHO you are*: a 404 for a made-up id, a 400 for an empty body, or
a 503 from a kill switch all count as **allowed**; only 401/403 counts as denied.
It sets `process.env.AUDIO_CAPTURE_ENABLED = 'on'` and forbids
`/embedding/i`, `/\/raw-embedding/i`, `/face-?template/i` from ever being exposed.

Rows the `PAGES` table leans on, for cross-checking:

| Route | Roles |
|---|---|
| `GET /api/v1/projects/:projectId/report` | dpo, dataOwner, dataAdmin, super_admin |
| `GET /api/v1/audit` | dpo, dataOwner, dataAdmin, super_admin, subject |
| `GET /api/v1/audit/verify` | dpo, dataAdmin, super_admin |
| `GET /api/v1/dsar` | dpo, dataOwner, dataAdmin, super_admin |
| `GET /api/v1/dsar/sla` | dpo, dataAdmin, super_admin |
| `GET /api/v1/dsar/subjects/search` | dataAdmin, super_admin |
| `POST /api/v1/dsar/:requestId/evidence` | dataOwner, dataAdmin, super_admin |
| `GET /api/v1/consent-templates` | dpo, dataOwner, collectionAgent, super_admin |
| `GET /api/v1/projects/:projectId/subjects` | collectionAgent, super_admin |
| `GET /api/v1/dashboard/summary` | all five |

---

## 7. Traps — every one of these cost real time

1. **Migrations fail with 42501 unless you override `DIRECT_URL`.**
   `prisma migrate deploy` fails `P3018 / permission denied for schema public`
   because `DIRECT_URL` points at `prism_app`, which **deliberately cannot run
   DDL**. Set `$env:DIRECT_URL` to the `ADMIN_DATABASE_URL` value for the duration
   of the migrate command only. If a migration half-applied, recover with
   `prisma migrate resolve --rolled-back <name>` first. **This is the required
   procedure for every future migration in this repo.**

2. **Router mount order is load-bearing in `backend/src/app.js`.**
   `sessionRoutes.use(requireRole('collectionAgent','super_admin'))` is
   *router-level* middleware that runs on every request **reaching** that router.
   Any router admitting other roles must be mounted **before** it. This is exactly
   why `recordingRoutes` sits ahead of `sessionRoutes` — moving it back re-breaks
   dataOwner/dataAdmin on all three audio GETs with a 403.

3. **Prefer the Grep tool over Bash pipelines here.** Bash `grep` hit the 120 s
   tool timeout on this repo, and a Bash heredoc invoking `python` was intercepted
   by the environment (it emitted only `Ctrl click to launch VS Code Native REPL`).
   `Grep` with `multiline: true` works.

4. **Run the full suite in the background.** Foreground `npm test` exceeds the
   10-minute cap.

5. **`context/docx_media/word/media/image1..8.png` once showed as deleted in
   `git status` with no edit having touched them.** Restored with
   `git checkout -- context/docx_media`. Cause unknown — if it recurs, restore the
   same way and do not commit the deletion.

6. **Docker containers stop between sessions.** Bring them back with
   `docker start prism-redis prism-qdrant prism-face-worker prism-image-pii-worker`.

---

## 8. Known blockers and open gaps

### BLOCKED — audio worker (:8003) cannot start

`ai-core/audio-worker/` has a `.env.example` but **no `.env`**, and compose
requires one. `HF_TOKEN` is mandatory because `pyannote/speaker-diarization-3.1`
is a gated model. **Only the user can supply that token — do not fabricate one.**

Downstream this fails *closed* by design: `AudioUnavailableError` → request goes
`DEFERRED`, which is the tested behaviour, so the 123-test suite is unaffected.
But **no real diarisation or audio redaction can be exercised end to end until the
token arrives.** Ask for it when the user next appears.

### A published-plan item that is WRONG — do not implement it

**Plan item 0.4, "Route audio blobs under the per-subject DEK", is incorrect and
was deliberately not implemented.** A recording is a **multi-speaker object**; a
per-subject key would mean one speaker's erasure destroys every other speaker's
data in the same file. The correct model, which is what is in the tree: blobs stay
under `sessions/<sid>/audio/` (session/path DEK), and erasure works through
explicit purge locations (**L14/L15/SEGMENT**). This correction was already
reported to the user.

### Smaller open gaps

- `superAdminSummary()` (`backend/src/modules/dashboard/dashboard.service.js`
  lines 225–304) returns six tiles — Admin accounts, Projects, Data principals,
  Open DSAR, Open breaches, Break-glass 30d — and **none carries an `href`**, so
  the super_admin dashboard is non-navigable. Give them hrefs.
- The RBAC matrix reported **2 inconclusive checks** because the rate limiter
  answered first: `POST /auth/subject/login` for `subject` and for `anon`. Re-run
  against a fresh limiter window to cover them.

---

## 9. Phases 2–5, unstarted (from the published plan)

- **Phase 2 — audio, properly:** `SubjectVoiceEnrollment` + a Qdrant collection;
  gallery-based speaker identification; audio in retention/purge/handoff-blocking;
  audio rows in the DSAR item grid.
- **Phase 3 — delete dead code:** `ai-core/audio-services`,
  `prism-visual-pipeline`, `text-services`, plus the vestigial video and text
  pipelines.
- **Phase 4 — UI:** design tokens, consistent loading/empty/error states, a mobile
  user portal, accessibility, and a consent-copy review.
- **Phase 5 — release:** a frontend test harness, CI, a load test at 5 000 items,
  closing DPIA R11/R12, repo hygiene, a manual pass over both portals, and the
  production checklist.

---

## 10. Domain refresher (skip if you already know PRISM)

Samsung worklet: a **DPDP 2023 (India)** consent-management + DSAR platform.

- **Stack:** Node/Express/Prisma/PostgreSQL (Supabase), Redis + BullMQ, Qdrant,
  two React/Vite portals (**admin :5180**, **user :5173**), FastAPI Python workers
  (face **:8001**, image-PII **:8002**, audio **:8003**).
- **Roles:** `super_admin`, `dpo`, `dataOwner`, `collectionAgent`, `dataAdmin`
  (the `AdminRole` enum) plus **`Subject`** — the data principal, authenticated
  separately via a subject session cookie.
- **DPDP §11–§13:** access / correction / portability / erasure / grievance.
- **Envelope encryption:** `MEDIA_KEK` → per-session (path-scoped), per-subject,
  per-project and per-export DEKs; crypto-shred via `destroySubjectKey()`.
- **Location codes:** L2 original, L3 face crop, L4 enrollment selfie, L5
  embedding, L6 redacted, L7 per-person cache, L8 vault, L9 export, L10 DSAR
  package, L11 backup, L12/L13 import original/redacted, **L14/L15 recording
  original/redacted** (added this session).
- **Fail-closed posture:** `PiiUnavailableError` / `AudioUnavailableError` →
  `DEFERRED`, **never** treated as clean. *"Worker down"* and *"worker found
  nothing"* must never collapse into the same outcome.
- **`SubjectDataItem` is a rebuildable projection, never an authority.** It is
  tombstoned, not deleted.
- **Shared-object downgrade:** `sharedSubjectCount > 1` downgrades DELETE →
  REDACT server-side.

Key env (`backend/.env.example`, 116 lines): `DATABASE_URL`/`DIRECT_URL` connect
as `prism_app`; `ADMIN_DATABASE_URL` is the owner role used **only** by
`prisma migrate deploy` and `scripts/sql/*` — the server never uses it.
`AUDIO_CAPTURE_ENABLED` is a kill switch: exactly `"on"` mounts the recording
routes, anything else returns 503. Required secrets: `FACE_EMBEDDING_KEY`,
`MEDIA_KEK` (+ `_VERSION`, `_PREVIOUS`, `MEDIA_REQUIRE_SEALED`),
`AUDIT_HMAC_SECRET`, `JWT_SUBJECT_SECRET`, `JWT_ADMIN_SECRET`, `DSAR_SIGNING_SEED`.

---

## 11. Files worth reading before you start

| File | Why |
|---|---|
| the plan artifact (§1) | the spec you are executing |
| `docs/02_ROLE_PERMISSION_MATRIX.md` | §B is the authority `PAGES` must subset; §D is the identity rule |
| `backend/tests/security/rbac-matrix.test.js` | the executable form of that matrix |
| `admin-portal/src/roles.js` | the new page-first table, with the reasoning in its header |
| `docs/HANDOFF.md` + the four dated handoffs it lists | the pre-existing platform; **none are to be deleted** |
| `PLAN.md` | the earlier, completed 9-phase DSAR plan — historical, not the current spec |
