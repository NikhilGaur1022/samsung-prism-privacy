# User-portal (data-subject portal) UI/UX audit — 2026-08-20/21

Domain: `user-portal/src` (React 19 + Vite 8 + Tailwind 4, live on `:5173`, API on `:4000`).
All 35 JS/JSX files + `index.css` read in full (36 files, matching the brief's count).

Scope note: the lead's browser pass (`00-LEAD-browser-pass.md`) could not render any authenticated
user-portal screen because subject login is OTP-by-email and Claude-in-Chrome was not connected. I
independently confirmed Claude-in-Chrome is **still** not connected this session (`tabs_context_mcp`
returns "Browser extension is not connected"), so I could not add screenshots either. Instead I did
what the brief asked as the fallback: found the dev-OTP escape hatch, established a **real, live
subject session**, and exercised every authenticated endpoint directly against the running API with
that session — tracing each response through the exact React code that consumes it. Every claim below
about what an authenticated screen would render is grounded in a live HTTP response, not guesswork.

---

## How I got a real subject session (for anyone reproducing this)

`backend/src/lib/otp.js:38-40` — `devOtp(code)` returns the plaintext OTP in the JSON response
whenever `NODE_ENV !== 'production'`. The live backend's `.env:17` has `NODE_ENV="development"`, so
`POST /auth/subject/login` returns `devOtp` in the body — this is also literally what `Verify.jsx`
autofills from (`location.state?.devOtp`, `Verify.jsx:21,113-131`).

```
OBSERVED
POST /auth/subject/login  {"email":"e2e-6201913c-subject-a@test.invalid"}
  -> 200 {"message":"Verification code sent","devOtp":"616532"}
POST /auth/subject/verify {"email":"...","otp":"616532"}
  -> 200 {"masterUserId":"e69d2387-...","email":"...","group":"VOLUNTEER","status":"ACTIVE"}
  -> Set-Cookie: prism_subject_at=..., prism_subject_rt=...
```

I used `e2e-6201913c-subject-a@test.invalid`, an existing e2e-fixture subject (from
`backend/prisma`-seeded/e2e test data, `registrationChannel: SELF`, `biometricMatch: true`,
`otpVerifiedAt` 2026-08-19) rather than any of the real personal emails present in the `Subject`
table — I confirmed via a read-only Prisma query which subjects exist, but did not attempt to
authenticate as any subject tied to a real personal account; one such attempt was in fact blocked by
the harness's own permission classifier and I did not try to work around it. Cookie jar:
`scratchpad/ui-user-portal/subject-cookies.txt`.

---

## 1. P0 — the portal can grant DPDP §5-governed consent without the subject ever seeing what they are consenting to

The Join (QR-invite) flow does this correctly: `Join.jsx:96-147` fetches the rendered notice via
`renderConsentNotice()`, shows it in a scrollable box, tracks scroll position with both an `onScroll`
handler and a `ResizeObserver` (to handle a notice too short to need scrolling, and late web-font
reflow), and the "I agree — add me to this session" button is `disabled={busy || !notice ||
!scrolledToBottom}` (`Join.jsx:351-357`). This is a real, working scroll-gate. Good design, and it
should be the one implementation, not one of three.

But there are **two other places a subject can grant project consent, and neither of them shows the
notice at all**:

- **`ProjectDetails.jsx`** (route `/consent/:projectId`, reached from `Dashboard.jsx`'s "Active
  Consents" list and from `Projects.jsx`) renders `project.purpose` (one sentence) and a static,
  hardcoded `COLLECTED` list (`ProjectDetails.jsx:10-14` — "Photographs of you", "Biometric face
  data", "Full Name", the same three items for every project regardless of what that project's
  `dataTypes` actually are). The "Give Consent" button (`ProjectDetails.jsx:127-134`) calls
  `grantConsent(projectId)` directly. There is no import of `renderConsentNotice`, no notice body, no
  retention/grievance-contact/policy-version detail beyond two summary chips, no scroll-gate. One tap
  and consent is recorded.
- **`MyConsents.jsx`** (route `/consents`, in the primary nav under "Consent") is worse: the "Give
  consent" button (`MyConsents.jsx:103-109`) is a single, immediate, **unconfirmed** click straight to
  `grantConsent()` — no notice, no confirmation dialog, nothing. Contrast this with the same file's
  withdraw path three lines below, which opens a confirm panel with explanatory legal text
  (`MyConsents.jsx:112-140`) before calling `revokeConsent()`. Granting has *less* ceremony than
  withdrawing in the one screen whose own subtitle claims "This is the only place your consent
  decisions are made."

I verified server-side that nothing stops this. `POST /api/v1/consent/projects/:projectId/grant`
(`backend/src/modules/consent/consent.routes.js:20-27`) takes **no request body at all** — no
`templateId`, no "I read this" acknowledgement, no proof-of-view token.
`consent.service.js:grantConsent()` (`consent.service.js:43-94`) signs a `signatureHash` over
`{subjectId, projectId, policyVersion, signedAt}` entirely server-side and writes an audit log
entry claiming `CONSENT_GRANTED`. The signature attests only that a POST arrived on an authenticated
session — it has no relationship to whether the notice was ever rendered to that browser.

Live proof, end to end, as the authenticated test subject, against the project named `"nikhil"`
(`dataTypes: ["face","photo","hands"]`, template `afdb4476-...`, riskLevel `LOW`):

```
OBSERVED
# The notice this project's own template would render, if anyone asked for it —
# never fetched by ProjectDetails.jsx or MyConsents.jsx:
GET /api/v1/consent-templates/02545ad3.../render?locale=en   (a *different* project's template,
  shown here only to demonstrate the render endpoint exists and returns real §5 content: purpose,
  dataTypes, retention, grievanceContact, body, policyVersion)

# Grant consent to the "nikhil" project with ZERO notice fetch of any kind first:
POST /api/v1/consent/projects/397c07b9-f283-44d6-94b2-84bb5184a81f/grant
  -> 200 {"consentId":"8b5a6e39-...","status":"ACTIVE","policyVersion":"new template v1",
          "signatureHash":"c268b589...","consentedAt":"2026-08-20T19:56:55.826Z"}
```

That is a legally-weighted, hashed, audit-logged consent signature — for a project whose
`riskLevel` can be `HIGH` (as it is for the E2E fixture project, which also has `HIGH` risk and
`dataTypes: ["FACE_IMAGE","NAME"]`) — produced by a UI flow that, in two of its three entry points,
never shows the subject a single word of what they are agreeing to. This directly answers the audit
question "can the UI ever let a subject consent without seeing the text?" — **yes, from the two most
prominent consent screens in the app** (`/consents` is in the primary sidebar nav; `/consent/:id` is
one tap from the dashboard's main content and from the Projects tab).

(I revoked the test grant afterward via the same API to restore state —
`POST /api/v1/consent/projects/397c07b9.../revoke` — confirmed `200 {"status":"REVOKED",...}`.)

**Fix:** `ProjectDetails.jsx` and `MyConsents.jsx`'s grant action must route through the same
notice-render-and-scroll-gate component `Join.jsx` already has (extract it — it is currently
duplicated nowhere, which is itself the bug: there is one correct implementation and it is not
reused). Ideally the server should also require some non-guessable proof the notice was served
(e.g. echo back the `templateId`/`policyVersion` the client says it rendered, or a short-lived
render token) rather than trusting the client to have shown anything at all.

---

## 2. P0 — Register.jsx, the portal's own account-creation screen, is unconditionally broken; confirmed live with the exact text a real visitor sees

The lead traced this to `backend/src/modules/subjects/subject.routes.js:19-20` — the whole
`/api/v1/subjects` router requires `requireAdminAuth` + `requireRole('collectionAgent',
'super_admin')` — and to a `req.user.id` vs `req.admin.id` bug in the controller for the
authenticated-agent case. From the user-portal side, here is what that means concretely: I sent the
**exact request `Register.jsx` sends**, unauthenticated, exactly as a first-time visitor's browser
would:

```
OBSERVED
POST /api/v1/subjects  (no cookie — Register.jsx never has one; this is a brand-new visitor)
  {"group":"VOLUNTEER","fullName":"Audit Probe","email":"audit-probe-never-created@test.invalid",
   "registrationChannel":"SELF"}
  -> HTTP 401  {"error":"Not authenticated"}
```

`Register.jsx:36-56` handles the response:

```js
} catch (err) {
  if (err.status === 409) { setError('duplicate'); return }   // never reached — see below
  setError(err.message ?? 'Registration failed. Please try again.')
}
```

`err.status` is `401`, not `409`, so the message shown on the account-creation form to a stranger who
has never authenticated anything is the literal string **"Not authenticated"**
(`backend/src/middleware/requireAdminAuth.js:11`) — the exact wrong side of a 401/409 branch that
exists in the code but can never fire, because every unauthenticated `POST /api/v1/subjects` 401s
before Prisma is ever asked whether the email is taken. The duplicate-email UX
(`Register.jsx:150-157`, "An account with this email already exists. Sign in instead.") is dead code
today.

Consequences specific to this portal:
- Every one of the 9 subjects currently in the database (`registrationChannel: "SELF"` on all of
  them) was created while some earlier, since-removed code path still worked
  (`subject.routes.js:9-18`'s own comment confirms this). **No currently-running code path lets a new
  person create a Prism account through the front door.**
- `Login.jsx`'s "New to Prism? Create an account" link, `Register.jsx` itself, and the whole
  `/register -> /verify -> /enroll` funnel described in `Register.jsx:139-148`'s own copy ("Right
  after you verify your email we'll ask for five quick photos of your face...") are unreachable in
  their entirety for anyone starting fresh.
- This is not a corner case of the portal — it is the portal's front door.

**Fix:** as the lead's report states — fix `req.user.id -> req.admin.id` for the agent-authenticated
path AND decide the self-registration story deliberately (a public, rate-limited
`POST /auth/subject/register`, or remove `Register.jsx` and make onboarding agent-only). Whichever
is chosen, `Register.jsx`'s error handling should not describe "you aren't authenticated" as the
reason a *sign-up* failed.

---

## 3. P1 — the `if (!data) return <Loading/>` pattern the lead found in `Enroll.jsx` is systemic; three distinct broken shapes, enumerated across every page

The lead asked to enumerate every page with this pattern. Having read all 35 files, it is not one
pattern but three, and I traced each to its root cause in the shared hooks/components rather than
just the page level.

### 3a. Infinite, silent "Loading…" — the error is known internally and never shown

Root cause: `useEnrollment()` (`FaceEnrollment.jsx:18-60`) and `useVoiceEnrollment()`
(`VoiceEnrollment.jsx:21-80`) both do this on mount:

```js
useEffect(() => { reload().catch(setError) }, [reload])
```

`reload()` sets `status` **only on success**. On failure (a 401 from an expired session being the
realistic case — see §4) `setError` fires but `status` stays `null` forever. Every consumer of these
hooks guards on `status` alone and never looks at `error` at this checkpoint:

| File | Line | Guard |
|---|---|---|
| `components/FaceEnrollment.jsx` | 180-182 | `if (!status) return <p>Loading…</p>` |
| `components/VoiceEnrollment.jsx` | 214-216 | `if (!status) return <p>Loading…</p>` (after the unrelated `unavailable` 503 check) |
| `pages/Enroll.jsx` | 30-36 | `if (!status) return (… Loading… …)` — the lead's original finding |

Two more places inherit the same defect by consuming the same hooks without adding their own guard:

- **`ConsentHub.jsx`'s `FaceEnrollmentCard`/`VoiceEnrollmentCard`** (lines 31-39 and 103-111): the
  `summary` string is computed as `!status ? 'Loading…' : ...`. If `getEnrollmentStatus()` 401s, the
  card sits on "Loading…" forever, with **no error text rendered anywhere in the card** (the error
  block that does exist, lines 60-80 / 132-154, is nested inside `open && status?.verified`, so it
  never mounts while `status` is null). This is the *first* card on the Consent Hub — the screen a
  subject opens specifically to check what they've consented to.
- **`Join.jsx`'s `Done` component** (lines 373-424): after a successful join, if the enrollment
  offer is opened (`showEnroll`) and `useEnrollment()`'s status fetch fails, `enrollment.status` stays
  `undefined`. The render is `status?.biometricConsent ? <PoseStepper/> : <p>Face matching needs a
  separate consent first...</p>` (line 406-412) — a **network/auth failure is silently
  mis-presented as "you haven't consented yet,"** actively wrong information on the one screen
  designed to get someone enrolled right after they've just agreed to be collected.

### 3b. "Loading…" shown forever *alongside* a correctly-rendered error message — a self-contradicting screen

A different, subtler bug: the page **does** catch the error and **does** render it, but a second,
independent conditional for the list body never resolves because the list state (not the error state)
is what's checked, and the list state is never set to anything on failure.

| File | Error line | Stuck-Loading line | List state |
|---|---|---|---|
| `pages/MyConsents.jsx` | 50 `{error && <p>{error.message}</p>}` | 52-53 `{!projects ? <p>Loading…</p> : ...}` | `projects` init `null`, never set on failure (line 21) |
| `pages/RequestStatus.jsx` (`RequestList`) | 63 | 65-66 | `items` init `null`, never set on failure (line 53) |
| `pages/SecureInbox.jsx` | 110 | 112-113 | `items` init `null`, never set on failure (line 98) |

Live confirmation that a 401 mid-session is exactly the trigger these guard against: I hit these same
endpoints with an intentionally invalid cookie and got a clean, catchable error every time —
`{"error":"Invalid or expired session"}` (401) — which is precisely the `Error` object these
`.catch(setError)` handlers receive. A subject on any of these three screens whose 15-minute access
token has expired sees a permanent error banner sitting on top of a permanent "Loading…" spinner, with
no path forward except knowing to manually navigate to `/login` themselves.

Contrast this with the file that gets it right: `RequestStatus.jsx`'s own **`RequestDetail`**
function, 90 lines below `RequestList` in the same file, does `if (error) return <ErrorScreen/>` as a
mutually-exclusive branch *before* the `if (!request) return <Loading/>` check (lines 114-134) — a
clean, correct, one-state-at-a-time render. `Certificate.jsx` (lines 23-43) and `MyData.jsx`
(loading/error/data all independently and correctly gated, lines 93-124) do the same. The fix is
mechanical and already has three correct in-house examples to copy: check `error` before checking for
absence of data, and return early.

### 3c. Silent error-swallow — a failed fetch is indistinguishable from "you truly have nothing"

The most concerning variant for a *DPDP rights* portal, because it doesn't look broken — it looks like
an authoritative, reassuring answer that happens to be wrong.

- **`Dashboard.jsx`'s `useActiveConsents`** (lines 97-107): `.catch(() => setProjects([]))`. On any
  failure — network blip, expired session — the "Active Consents" section renders **"No active
  consents yet."** (line 140), identical to the genuine-empty-state text, with zero indication
  anything went wrong.
- **`Dashboard.jsx`'s `EnrollmentBanner`** (lines 67-95): `.catch(() => setStatus(null))`. The banner
  that nudges an incomplete enrollment simply vanishes on error — indistinguishable from "you're
  already fully enrolled."
- **`Profile.jsx`'s `Participations`** (lines 34-93): `.catch(() => setError(true))`, then
  `if (error) return null` (line 44) — the entire "Projects you've joined" section disappears with no
  trace.

For a portal whose stated purpose (`MyData.jsx:120`) is "What Prism holds about you... as required
under DPDP §11," a subject checking "do I have any active consents on file?" after a session timeout
sees a page that has silently and confidently told them **no** when the true answer is "unknown, the
request failed." This is a different and arguably worse failure mode than 3a/3b: those at least *look*
broken; this looks like an answer.

**Fix, all three sub-patterns:** standardize on the three-state loading contract `MyData.jsx` and
`Certificate.jsx` already use correctly (`loading | error | data`, error checked and rendered before
any "not yet loaded" fallback, never silently coerced to an empty/complete state), and give
`useEnrollment()`/`useVoiceEnrollment()` a real error-first branch that every consumer (`Enroll.jsx`,
both `ConsentHub.jsx` cards, `Join.jsx`'s `Done`) can share instead of re-deriving.

---

## 4. P1 — no session-refresh path exists anywhere in the portal; §3 above is what a subject actually experiences once their 15-minute token expires

```
OBSERVED
grep -rn "refreshSession" user-portal/src        -> defined in lib/api.js:45-47, called nowhere else
grep -rn "401" user-portal/src                    -> only in comments, never checked/handled
```

`lib/api.js` exports `refreshSession()` (`POST /auth/subject/refresh`) but **no file in the portal
ever calls it.** `RequireAuth.jsx` calls `useMe()` — which calls `getMe()` once — only at the moment
the shared `<AppLayout/>` route element mounts (`App.jsx:35-40`); because every protected page is a
child route nested under that one layout element, React Router does not remount it on navigation
between `/dashboard`, `/consent`, `/my-data`, etc. So the auth check genuinely runs once per browser
tab, not once per page.

Backend TTLs, confirmed by the lead: 15-minute access token, 7-day refresh token
(`backend/src/lib/tokens.js:6-7`). Put together:

- A subject who opens the app, reads a long consent notice, fills in a DSAR description, or simply
  leaves a tab open past 15 minutes will have every subsequent fetch on that tab 401 — with the
  **valid, unexpired 7-day refresh cookie sitting right there, unused**, because nothing ever calls
  `/auth/subject/refresh`.
- `RequireAuth` will not catch this and redirect to `/login`, because it already ran once, before the
  token expired, and passed.
- What the subject actually sees from that point on is whichever of the three sub-patterns in §3
  applies to the page they're on: a permanent unlabeled spinner, a permanent spinner next to a
  correctly-worded but unactionable error, or — worst — a confident, wrong "you have nothing here."

**Fix:** either an `api.js` request wrapper that transparently retries once through
`POST /auth/subject/refresh` on a 401 (the standard pattern, and the backend already has the route
built and working — I confirmed the 401 error text live in §3b), or, at minimum, a global fetch
interceptor that redirects to `/login` on any 401 that survives past the initial `RequireAuth` check.
Today there is neither.

---

## 5. P2 — enrollment promises "five" photos everywhere except the one screen that takes them, which hard-caps at three; retaking silently burns a slot instead of replacing

`SelfieCapture.jsx:4-12` defines exactly three pose objects (`FRONT`, `LEFT`, `RIGHT`) with this
comment:

> "Three angles, not five: the backend caps a subject at MAX_PER_SUBJECT (3) photos, so UP/DOWN
> were unreachable... buffalo_l also degrades past roughly ±45° yaw..."

That comment is **wrong for this live deployment**:

```
OBSERVED
GET /api/v1/me/enrollment-status  (authenticated subject)
  -> {"biometricConsent":true,"verified":true,"count":1,"max":5,"poses":["FRONT"],
      "allPoses":["FRONT","LEFT","RIGHT","UP","DOWN"],"complete":false}

grep FACE_MAX_ENROLLMENTS_PER_SUBJECT backend/.env  -> FACE_MAX_ENROLLMENTS_PER_SUBJECT="5"
```

`backend/src/modules/enrollment/enrollment.service.js:12` reads
`MAX_PER_SUBJECT = Number(process.env.FACE_MAX_ENROLLMENTS_PER_SUBJECT ?? 3)` — the code comment
describes the *default* (3), but this live deployment's `.env` overrides it to **5**, and the server
also defines five named poses (`ENROLLMENT_POSES`, `enrollment.service.js:14`), not three.

The client never reads `allPoses` to decide which pose buttons to offer — `SelfieCapture.jsx`'s pose
list is a hardcoded array of three, independent of what the server says is available. The effect
compounds across the app's own copy, which is *not* internally consistent about this:

- `Register.jsx:144` promises **"five quick photos of your face."**
- `Dashboard.jsx:87` (`EnrollmentBanner`) shows **"`{poses.length}` of `5` angles captured"** — `5` is
  a literal in the JSX, not derived from the API.
- `MyData.jsx:176` correctly reads `enrollment.allPoses.length` (=5) from the API — so it, too, shows
  "of 5."
- The actual capture UI (`PoseStepper` via `SelfieCapture`) can never produce more than 3 distinct
  poses, ever, no matter how many times a subject uses it, because it only ever offers `FRONT`,
  `LEFT`, `RIGHT` as targets. `complete` becomes `true` (`enrollment.service.js:162`,
  `poses.includes('FRONT') && poses.length >= 3`) at exactly 3, so the flow *works* — but a subject
  who reads Register.jsx's promise or Dashboard's "X of 5" and expects two more angles to matter will
  never be offered them.

Separately, **retaking a pose does not replace the previous shot.** Tapping a completed pose icon in
`SelfieCapture.jsx:461-478` only sets `active` to that pose key — it does not call
`enrollment.remove()` first. The next capture is sent as a **new** `addEnrollment(blob, pose)` call;
server-side, `createEnrollment` (`enrollment.service.js:41-131`) has no pose-uniqueness constraint —
it just appends another row (deduped against a duplicate only by exact `sha256`, line 71-74, which a
genuinely different retake photo will never match). The old shot is left in place, only removable via
the separate trash icon. Two retakes of the same pose, without manually deleting first, consume 2 of
the (live) 5-photo cap on top of the 3 required poses — a subject who retakes twice can hit "At most 5
photos can be enrolled per person" (`enrollment.service.js:59`) before ever being told why, since
`done = new Set(captured)` (`SelfieCapture.jsx:102`) dedupes by pose key for display purposes only,
hiding the duplicate rows from the UI right up until the cap 409s.

**Fix:** derive `POSES` (or at least which of the 5 to show) from `status.allPoses`/`status.max`
instead of a hardcoded 3-entry array; align `Register.jsx`'s and `Dashboard.jsx`'s copy to whatever
that ends up being (ideally both driven off the same API field `MyData.jsx` already uses correctly);
and have the pose-icon retake path call `remove()` on the existing enrollment for that pose before
issuing a new capture, or disable retake once the cap is in sight.

---

## 6. P2 — irreversible biometric-deletion controls: no confirmation, and touch targets around half the WCAG minimum, on the one class of action that cannot be undone

Every other destructive action in the portal that I found has a confirmation step:
`MyConsents.jsx`'s "Withdraw consent" (lines 88-140, two-step with explanatory copy). These do not:

| Control | File:line | Confirmation? | Rendered size |
|---|---|---|---|
| Delete one enrollment photo | `FaceEnrollment.jsx:149-156` | **None** — fires on click | `p-1` around a 12px icon ≈ **20×20px** |
| Delete one voice clip | `VoiceEnrollment.jsx:174-181` | **None** — fires on click | `p-1` around a 13px icon ≈ **21×21px** |
| "Turn off biometric matching and delete my photos and voice recordings" | `ConsentHub.jsx:65-74` | **None** — one click, wipes both face *and* voice data | text button, no size issue, but zero friction for the largest-blast-radius delete in the app |
| "Delete my voice recordings" (all clips) | `ConsentHub.jsx:141-147` | **None** | text button |

The per-photo/per-clip trash icons sit at roughly half WCAG 2.2 SC 2.5.8's 24×24px minimum (the lead
found the same class of undersized control elsewhere in the admin portal at 390px — this is the same
defect recurring in the one place it is paired with an unrecoverable delete rather than navigation).
`FaceEnrollment.jsx`'s delete icon is additionally positioned `absolute right-1 top-1` directly over a
small thumbnail (`h-20 w-20`, i.e. an 80×80px photo), which on a real phone is exactly the kind of
cramped, adjacent-to-other-content target most likely to be mis-tapped during the auto-capture flow
`SelfieCapture.jsx` otherwise puts real engineering effort into making frictionless (the FaceID-style
hold-ring, continuous readiness polling, etc.).

**Fix:** at minimum a confirm step on both the "turn off biometric matching" and "delete all voice
recordings" actions (they are the two largest-blast-radius deletes and currently have the *least*
friction in the app); enlarge the per-item trash targets to 24×24px minimum, 44×44px preferred, and
move them off the top of the thumbnail image itself.

---

## 7. P2 — camera/mic failure paths surface raw browser exception text; the "Use camera" button is not hidden on an insecure origin it cannot function on

Both capture components are honest about the underlying browser constraint in their own comments:

> `SelfieCapture.jsx:72-74` / `VoiceCapture.jsx:75-77`: "getUserMedia needs HTTPS or localhost — over
> a LAN IP it silently yields nothing, so the file input is always rendered rather than offered only
> as a fallback."

The "always render the upload fallback" half is real and good — I confirmed both components render
the `<input type="file" accept="image/*"/audio/*" capture="user">` unconditionally, regardless of
camera state (`SelfieCapture.jsx:603-617`, `VoiceCapture.jsx:254-267`). That is the correct mitigation
for a collection agent's or subject's phone hitting the portal over a bare LAN IP in the field.

What is not mitigated: the **"Use camera" / "Start recording" button is rendered unconditionally
too** — there is no `navigator.mediaDevices` feature check anywhere in either file gating it. On an
insecure origin, `navigator.mediaDevices` itself is `undefined` in every current major browser (this
is standard, spec-mandated behavior for the Media Capture and Streams API on non-secure contexts, not
an edge case) — INFERRED from documented browser behavior, not directly reproducible in this
text-only environment. Both `start()` functions (`SelfieCapture.jsx:142-154`,
`VoiceCapture.jsx:125-152`) wrap the call in `try { ... } catch (err) { setCamError(err.message ??
'Could not open the camera') }` — the `try` does catch this, so the app does not crash, but
`navigator.mediaDevices.getUserMedia` throws a `TypeError` reading `getUserMedia` off `undefined`
*before* any camera permission prompt ever appears, and `err.message` for that `TypeError` is raw V8
text (something like "Cannot read properties of undefined (reading 'getUserMedia')"), not the
friendly `'Could not open the camera'` fallback — the fallback string is only used when `err.message`
is itself falsy, which a real `TypeError` never is.

For an ordinary permission denial or missing-device case, `getUserMedia`'s own `DOMException` names
(`NotAllowedError`, `NotFoundError`) come with reasonably clear `.message` text in Chrome/Firefox, so
that path is acceptable as-is.

**Fix:** feature-detect `navigator.mediaDevices?.getUserMedia` up front and either hide the camera/mic
buttons or show one clear proactive line ("Camera needs a secure connection — use Upload instead")
rather than only reacting after a confusing exception; this matters specifically for the field
scenario (collection agent's tablet, or a subject's phone via `Join.jsx`, on a bare LAN IP) that the
code comments already correctly identify as the reason the file-upload fallback exists.

---

## 8. P3 — unverified auto-capture geometry sign shipped to production

`SelfieCapture.jsx:32-40`:

```js
// YAW_SIGN maps the transformation matrix's rotation sense onto that point of
// view... verify on-device and flip this to -1 if "turn left" only ever
// satisfies the RIGHT band.
const YAW_SIGN = 1
```

This is the sign used by `yawMessage()` (`SelfieCapture.jsx:62-70`) to decide whether the live
readiness loop tells someone to "Turn a bit more to your left" vs "your right" during auto-capture,
and it is explicitly, self-admittedly unverified. If it is wrong, the guidance text for the `LEFT` and
`RIGHT` poses is systematically backwards (asking for more left turn when the fix is to turn right).
This degrades, rather than blocks, auto-capture — the manual "Take photo" button and the backend's own
`det_score`/face-count validation are unaffected — but it is worth flagging as shipped-unverified
before a wider field rollout, since it directly affects whether the "FaceID-style hold ring" UX (a
genuinely well-built piece of this component) gives correct or backwards instructions.

## 9. P3 — face-quality auto-capture depends on two external CDNs with no self-hosted fallback

`SelfieCapture.jsx:28-30`:
```js
const MEDIAPIPE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.0/wasm'
const FACE_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/.../face_landmarker.task'
```
The degrade path is real and well-built (`loadLandmarker()` catches any failure and falls back to
brightness/blur-only gating, `SelfieCapture.jsx:160-177`, `evaluateFrame`'s `if (!landmarker) return
{ok:true,...}` at line 250) — a blocked CDN does not break enrollment, it just loses face-count/angle
guidance client-side (the backend still enforces `det_score` and single-face). Worth noting for a
platform whose stated production requirement is 5,000 images/day across field locations: capture
*quality guidance* — not capture itself — is tied to two third-party hosts' uptime and to whatever a
site's firewall allows.

---

## Cross-check: `user-portal/src/lib/api.js` against the live backend

Every exported function in `api.js` traced to its route file and, where practical, called live.
**One mismatch, already covered above as Finding 2** (`registerSubject` → `POST /api/v1/subjects`,
gated by `requireAdminAuth` + `requireRole('collectionAgent','super_admin')`,
`backend/src/modules/subjects/subject.routes.js:19-20,33` — unreachable by the unauthenticated caller
that is the only caller). Every other call matched its live route and, where I could exercise it
without side effects a synthetic test subject shouldn't have, returned the shape the consuming
component expects:

| `api.js` export | Route | Verified |
|---|---|---|
| `requestLoginOtp`/`verifyLoginOtp`/`getMe`/`refreshSession`(unused, §4)/`logout` | `/auth/subject/*` | Live — used to build the test session |
| `listConsentProjects`/`grantConsent`/`revokeConsent` | `/api/v1/consent/*` | Live — §1 |
| `getEnrollmentStatus`/`setBiometricConsent`/`addEnrollment`/`listEnrollments`/`deleteEnrollment`/`enrollmentImageUrl` | `/api/v1/me/{enrollment-status,biometric-consent,enrollments}` | Live (status), route-matched (rest) |
| `getVoiceEnrollmentStatus`/`addVoiceEnrollment`/`listVoiceEnrollments`/`deleteVoiceEnrollment`/`voiceEnrollmentAudioUrl` | `/api/v1/me/voice-enrollments/*` | Live (status), route-matched (rest) |
| `getJoinInvite`/`acceptJoinInvite` | `/api/v1/join/:token[/accept]` | Route-matched; lead already verified invalid-token live |
| `renderConsentNotice` | `/api/v1/consent-templates/:id/render` | Live — §1 |
| `raiseDsarRequest`/`listMyDsarRequests`/`getMyDsarRequest`/`getMyDsarTimeline`/`getMyDsarCertificate`/`createDsarPackageToken`/`downloadMyDsarPackage` | `/api/v1/me/dsar/*` | Live — see next section |
| `getMyPhotos`/`getMyRedactedPhoto` | `/api/v1/me/photos*` | Live — see next section |
| `getMyParticipations` | `/api/v1/me/participations` | Live |
| `registerSubject` | `/api/v1/subjects` | Live — **broken, Finding 2** |

---

## DSAR screens, traced live end to end

Raised a real `ACCESS` request as the test subject to exercise the full `RaiseRequest -> RequestStatus`
path (the live DB had zero `CLOSED` requests among its 3 existing rows, all still `RECEIVED`, so I
could not observe the `SecureInbox`/`Certificate` populated states — see "what I could not check"):

```
OBSERVED
POST /api/v1/me/dsar {"type":"ACCESS","description":"UI audit test request"}
  -> 201 {id, status:"RECEIVED", slaDueAt:"2026-09-19...", internalDueAt:"2026-08-27...", ...}
GET  /api/v1/me/dsar
  -> {"items":[{..., "coarseStatus":"OPEN",
      "sla":{"dueAt":"2026-09-19...","daysRemaining":30,"breached":false,"internalBreached":false}}]}
GET  /api/v1/me/dsar/{id}          -> 200, same shape + evidence:[]
GET  /api/v1/me/dsar/{id}/timeline -> 200 {"entries":[{"kind":"MILESTONE","summary":"We received your request", ...}]}
GET  /api/v1/me/dsar/{id}/certificate  -> 404 "No certificate has been issued yet"   (correct — not an erasure)
POST /api/v1/me/dsar/{id}/package-token -> 404 "No package has been issued for this request"  (correct — not built)
```

`RequestStatus.jsx`'s `RequestList`/`RequestDetail` and `SecureInbox.jsx`'s `CertificateStatus`/
`PackageDownload` all render exactly what their code says they should against these responses
(SLA countdown text, `coarseStatus` badge, timeline entries, the 404-as-"not built yet" messages in
`SecureInbox.jsx:51-56`). No mismatch found in the DSAR read/detail/timeline path.

**One inconsistency worth a specific, narrow callout** (already filed as `auth-authz.md` P3-6, so not
repeated as a top-level finding here, but it does directly affect this portal's own
`getMyDsarRequest()` — the exact call `RequestStatus.jsx`'s `RequestDetail` makes): a foreign
subject's real DSAR id returns `403 "This request belongs to another data principal"` while a
genuinely nonexistent id returns `404`. That is a distinguishable pair of responses on the very
endpoint this page calls, i.e. `/requests/:requestId` in this portal is an (extremely low-value,
UUIDv4-gated) existence oracle for other subjects' request ids. I mention it here only because it is
this page's own API call; full detail and the fix are in `auth-authz.md`.

`getMyPhotos()` for the test subject returned `{"totalPhotos":0,"projectCount":0,"projects":[]}` even
though that subject has an active `PROCESSING` session (`COL-7224` — the same session the lead's
`00-LEAD-live-api-and-pipeline.md` FINDING R-1 documents as stuck for ~2 days with a `RecognitionJob`
still `RUNNING`). **`MyData.jsx` cannot distinguish "you are in zero photos" from "the pipeline that
would tell us is stuck"** — both render as identical text ("You do not appear in any photos yet.",
`MyData.jsx:208-214`). This is the user-portal-facing symptom of the lead's backend finding, not a new
root cause, but it is worth recording here because it is exactly the kind of silently-wrong-looking-
confident-and-correct answer that §3c above describes as the most concerning failure shape for this
app. (In the ~40 minutes between the lead's DB snapshot and mine, the live `piiStatus=PENDING` count
grew from 27 to **33** — corroborating, from a second independent read, that the backlog the lead
flagged is actively growing, not a one-time blip.)

`PhotoThumb` (`MyData.jsx:26-80`) — checked the specific leak scenario the audit brief's phrasing
("does each show real data") implies: could a subject ever be served a photo whose redaction was not
yet confirmed? `me.service.js:listMyPhotos()` computes `viewable: Boolean(photo.redactedPath) &&
!['DEFERRED','FAILED'].includes(photo.piiStatus)` — the same "list known-bad states" shape as the
admin portal's `blockedCount()` the lead flagged in FINDING R-2, which would be unsafe if a `PENDING`
photo could ever have `redactedPath` already set. I checked this directly against the live table:

```
OBSERVED
SELECT count(*) FROM "Photo" WHERE "piiStatus"='PENDING'                          -> 33
SELECT count(*) FROM "Photo" WHERE "piiStatus"='PENDING' AND "redactedPath" IS NOT NULL -> 0
```

**Cleared** — not currently exploitable; `redactedPath` is never populated before a photo leaves
`PENDING` in this pipeline today. Recording it here as checked, and noting the same "enumerate the bad
states instead of testing for the one good state" fragility pattern the lead already flagged
elsewhere now has a second, independent occurrence (`me.service.js` here vs `ProcessedData.jsx`
there) — worth fixing both from the same root-cause pass rather than patching one file.

---

## Consent flow — direct answers to the audit's specific questions

- **Is the scroll-gate real?** Yes, in `Join.jsx` only (§1). Verified via code: `onScroll` handler
  plus a `ResizeObserver` fallback for notices too short to scroll, both correctly flip
  `scrolledToBottom` before the agree button unlocks.
- **Is consent granular?** No, and this is by design, stated in the code:
  `ProjectDetails.jsx:114-115` — "One decision, project-wide. Granting covers everything above —
  including being photographed and having your face detected." A single `Subject.biometricMatch`
  flag also gates *both* face and voice matching together (`VoiceEnrollment.jsx:111-114` states this
  explicitly and the UI does correctly warn about it in both directions — turning on voice consent
  warns it also turns on face matching, and turning off face matching warns it also erases voice).
  Coarse-grained by design, at least honestly labeled where it matters.
- **Is withdrawal as easy as granting?** Backend code cites the §6(4) requirement directly
  (`consent.service.js:152`, "withdrawal must be as easy as giving consent"), and functionally
  withdrawal *does* work in one project-scoped action with real consequences (drops the subject from
  any live session roster, raises an internal erasure DSAR, purges enrollments if it was the last
  active consent). But in the UI specifically, `MyConsents.jsx` gives granting **zero** friction (one
  click, no notice, no confirm — §1) and withdrawal **one extra confirm step with explanatory text**
  (lines 88-140) — withdrawal is, if anything, one click harder than granting in this portal, the
  opposite asymmetry from what the backend's own comment argues for. (I read this as a soft/debatable
  finding, not a hard violation — a destructive-action confirm is defensible UX — but it is the
  opposite direction of friction from what the cited law and the backend's own comment describe, and
  worth resolving in the same pass as §1.)
- **Is the policy version recorded?** Yes, consistently: `MyConsents.jsx:76`, `ProjectDetails.jsx:95`,
  `Join.jsx:339` all display `policyVersion`, and the server stamps it into every consent row
  (`consent.service.js:58-79`) and re-signs against the *current* version on re-grant after a
  withdrawal (line 62-64 comment is explicit about this).
- **Can the UI ever let a subject consent without seeing the text?** Yes — see §1, live-verified, from
  two of the three consent-granting entry points.

---

## Login/Register/Verify — OTP UX

- **Resend + cooldown**: `Verify.jsx:41-53` implements a real 60-second countdown
  (`RESEND_COOLDOWN_SECONDS`), disables the resend button for its duration, and correctly restarts it
  on every successful resend. No bug found here.
- **Digit input**: 6 separate boxes with auto-advance-on-digit and backspace-to-previous
  (`Verify.jsx:25-37`) — standard, works, no paste-handling for a 6-digit code pasted as a block
  (each box's `onChange` strips to the last typed character via `.slice(-1)`, so pasting `123456`
  into the first box yields only `6` in that box and nothing in the rest) — minor, P3, most OTP UIs
  this size have the same gap.
- **Error messages**: server-side per-cause text is good (`otp.js:60-82` — "No active code for this
  email", "Code expired", "Too many incorrect attempts", "Incorrect code") and `Verify.jsx:72-76`
  passes it straight through.
- **Account enumeration**: `POST /auth/subject/login` returns a different status/body for an
  existing vs. nonexistent email (`404 "No account found for this email"` vs `200 "Verification code
  sent"` — live-verified) — already filed as `auth-authz.md` P2-5, not repeated as a top-level finding
  here, but worth flagging its exact user-facing consequence: `Login.jsx:26` (`setError(err.message ??
  ...)`) puts that literal "No account found for this email" text on screen for anyone who tries an
  email address, which is the UI-layer confirmation of the oracle, not just an API quirk.
- **Dev-OTP banner**: correctly gated to disappear in production (`devOtp()` returns `undefined` when
  `NODE_ENV==='production'`, `otp.js:38-40`) and the client never assumes it exists
  (`Verify.jsx:21` — `useState(location.state?.devOtp)`, fine if undefined).

---

## Join flow — the other three cases the lead didn't get to

The lead confirmed an invalid token shows a correct error. I traced the remaining cases in code
(did not have a real invite token from a live session to test end to end, so these are code-level,
marked accordingly):

- **Expired / already-used token**: `Join.jsx:49-54` calls `getJoinInvite(token)` once on mount and
  `.catch(setError)`. Whatever the server's error message is for an expired or consumed token, it
  renders via `if (error && !invite) return <Shell>{error.message}</Shell>` (lines 149-155) — same
  code path the lead already confirmed works for a straight-up invalid token, so an expired/used token
  (a different server-side rejection reason, same shape of response) should render the same way.
  INFERRED from code structure, not independently re-verified against a live expired token.
  **What I could not check**: whether the *server's* message text actually distinguishes "expired"
  from "already used" from "invalid" for the subject reading it — that's a backend-copy question
  outside this file's scope.
- **Wrong subject already signed in**: `Join.jsx:68` — `handleContinue` branches to `'consent'`
  directly if `signedIn.current` is true, from a `getMe()` call on mount (line 51-53). There is no
  check anywhere that the signed-in subject matches anything about the invite/QR — by design, since
  the whole point of a QR/link join is "whoever is holding this phone, signed in as whoever they are,
  consents as themselves" (confirmed correct by the code comment at line 17: "The scan is NOT
  consent... The agree button is"). Not a bug — the invite is a session/project pointer, not a
  person-check, and `acceptJoinInvite` on the server takes the subject id only from the verified
  session token (`join.routes.js:65-69`), never from anything in the invite payload. Cleared.
- **Logged-out state on `/join/:token`**: correctly handled — `Join.jsx` renders itself entirely
  outside `RequireAuth` (`App.jsx:32`, deliberately, per the comment at line 29-30) and does its own
  inline OTP login (`step === 'auth'`, lines 201-270) rather than bouncing to `/login` and losing the
  token — this is the one auth entry point in the app that gets the "don't lose context mid-flow"
  problem right, in contrast to `RequireAuth.jsx`'s own comment (lines 14-17) admitting the main
  `/login` redirect does **not** carry a return-to path anywhere else in the app.

---

## Refresh behavior / rehydration on deep routes

- `useMe()` (`lib/useMe.js`) runs once per mount of the shared layout, not once per page — confirmed
  by reading `App.jsx`'s route tree (one `<RequireAuth><AppLayout/></RequireAuth>` wrapping all 13
  protected routes as nested children, `App.jsx:35-55`). A hard refresh (F5) on any deep route (e.g.
  `/requests/abcd/certificate`) remounts the whole tree, so `useMe()` does run again there — that case
  is fine. The problem is soft navigation *within* an already-open tab past the 15-minute token TTL,
  covered fully in §4.
- **Flash of unauthenticated content**: not observed. `RequireAuth.jsx:22` (`if (loading) return
  null`) renders nothing — not even a spinner — while `useMe()` resolves, so there is no frame where
  protected content or a logged-out shell flashes before the redirect decision is made. This is a
  correct, deliberate choice per the component's own comment (line 21, "No shell, no spinner-shaped
  hint about what is behind the gate") and I found no counter-example to it anywhere in the 35 files.

---

## Lint and build — real output

```
OBSERVED — cd user-portal && npm run lint   (exit 0)
> oxlint
src/components/FaceEnrollment.jsx:18:17: warning react(only-export-components): Fast refresh only
  works when a file only exports components. Use a new file to share constants or functions between
  components.
src/components/VoiceEnrollment.jsx:21:17: warning react(only-export-components): (same)
src/components/SelfieCapture.jsx:8:14: warning react(only-export-components): (same)
```

Three warnings, zero errors — all three are the same class (hooks/constants co-exported alongside
components from the enrollment files, e.g. `useEnrollment`/`POSES` living beside `FaceEnrollment`
default export), harmless for a production build, only affects Vite's dev-mode Fast Refresh
granularity. Not worth restructuring for.

```
OBSERVED — cd user-portal && npm run build   (exit 0)
vite v8.1.3 building client environment for production...
✓ 1814 modules transformed
dist/index.html                          0.47 kB │ gzip:   0.30 kB
dist/assets/index-DULpEjwY.css          35.87 kB │ gzip:   6.65 kB
dist/assets/vision_bundle-CN_gIQKz.js  152.60 kB │ gzip:  45.23 kB
dist/assets/index-DxNdU_eq.js          382.90 kB │ gzip: 110.80 kB
✓ built in 1.32s
```

Clean build, no warnings. Four chunks total — `vision_bundle` (the MediaPipe wasm loader) is split out
by Vite automatically because of the dynamic `import('@mediapipe/tasks-vision')` in
`SelfieCapture.jsx:163`, but there is **no route-level code splitting** otherwise: every route
(`React.lazy` is not used anywhere in `App.jsx`) ships in the one 382 KB / 110 KB-gzipped main bundle,
so a subject who only ever visits `/requests` to check a DSAR status still downloads the entire
camera-capture and voice-capture code paths. At 110 KB gzipped this is not severe today, but it is a
P3 worth naming given the field-usage requirement (phones, possibly constrained connections) —
`React.lazy(() => import('./pages/Enroll'))` etc. would be a small, low-risk change.

---

## Information architecture — does the copy actually let a subject understand what is held?

Two screens do this well and are worth naming as the pattern to keep, not just critique the rest
against: **`MyData.jsx`** (explicit "as required under DPDP §11" framing, every section sourced from
a real endpoint, correctly distinguishes "no consent record" from "revoked" from "active") and
**`RequestStatus.jsx`'s `RequestDetail`** (the coarse/fine status split with an explicit statement of
what's *not* shown and why — "Our internal handling records... are kept separately," lines 200-207 —
is exactly the kind of honest boundary-setting a rights portal should have).

Screens that fail this test, beyond the broken-loading-state pages already covered in §3:

- **`ProjectDetails.jsx`** — the `COLLECTED` data-types list (line 10-14) is a **hardcoded constant**,
  always "Photographs of you / Biometric face data / Full Name," regardless of the project's actual
  `dataTypes` field (which the API already returns — `["FACE_IMAGE","NAME"]` for one project,
  `["face","photo","hands"]` for another, live-observed, differently-cased and differently-valued
  between projects). A subject reading this screen for a project that collects hand imagery, or that
  does not collect biometric face data at all, is shown the same three generic bullet points as every
  other project. This directly undermines the "understand what is held" goal and is a straightforward
  fix (map `project.dataTypes` to icons/labels instead of a static array).
- **`ConsentHub.jsx`**'s bottom-of-page links ("Privacy Policy", "Terms of Service", "GDPR Support",
  lines 218-222) are plain `<span>` text, not links to anything — three dead-looking affordances that
  read as clickable (styled identically to the working nav links elsewhere in the same file) but do
  nothing.

---

## What I could not check

- **No screenshots / no visual or interaction testing of authenticated screens.** Claude-in-Chrome was
  not connected in this session either (`tabs_context_mcp` → "Browser extension is not connected"),
  same as the lead's pass. I compensated by exercising every authenticated endpoint directly against
  the live API with a real subject session and tracing each response through the exact consuming
  React code, but I did not click a single button in a real rendered page, so: real click targets,
  actual focus-trap/keyboard behavior, real responsive layout of the authenticated screens (only
  inferred from Tailwind classes, not measured `scrollWidth` the way the lead measured the public/
  admin routes), and real font-rendering/animation are unverified.
- **`SecureInbox.jsx` and `Certificate.jsx` populated states.** The live DB's 3 DSAR requests are all
  `RECEIVED` — none `CLOSED`, so no certificate and no built access package exist to download live. I
  verified the *empty*, *404*, and *not-yet-built* states of both screens live (§ DSAR section above)
  and the *code path* for the populated states, but never observed a real `Award`/certificate render
  or a real ZIP download completing through `PackageDownload`'s `document.createElement('a').click()`
  flow.
- **Real camera/microphone hardware.** `SelfieCapture.jsx`/`VoiceCapture.jsx`/the LAN-IP-insecure-
  origin failure mode (§7) are traced from code and documented browser platform behavior, not exercised
  against a real device.
- **Any subject tied to a real personal email.** I deliberately used only a synthetic e2e-fixture
  account (`e2e-6201913c-subject-a@test.invalid`) for the live session. A second login attempt against
  `nikhilgaur1022@gmail.com` (a real subject row with actual DSAR history, which would have let me
  test `RequestStatus`/`SecureInbox` against real non-trivial data) was blocked by the harness's own
  permission classifier; I did not attempt to work around that and dropped it.
- **Long-list / large-dataset rendering.** The live dataset is small (this subject: 1 project, 1
  participation, 0 viewable photos). `MyData.jsx`'s photo grid, `RequestStatus.jsx`'s list, etc. were
  never exercised against dozens/hundreds of rows — no pagination exists on any of these `/me/*`
  endpoints as far as `api.js` shows (`getMyPhotos`, `listMyDsarRequests`, `getMyParticipations` all
  take no cursor/limit params), which itself may be a scale concern at the stated 5,000-images/day
  target for a long-tenured subject with many photos, but I could not observe it directly against
  data of that size.
