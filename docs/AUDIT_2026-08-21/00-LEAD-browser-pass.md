# Lead note — live headless-browser UI pass (2026-08-21)

The Claude-in-Chrome extension was not connected, so the lead drove **headless Chrome 151 over the
DevTools Protocol** instead (`scratchpad/cdp.mjs`, Node 22 global `WebSocket`, no npm install).
Real login via `POST /auth/admin/login`, the returned `prism_admin_at` cookie injected with
`Network.setCookie`, then every route rendered at three viewports with layout metrics read out of
the live DOM.

- Harness: `scratchpad/cdp.mjs`
- Raw data: `scratchpad/shots/report.json` (117 route x viewport records), `scratchpad/shots2/report.json`
- Screenshots: `scratchpad/shots/*.png`, `scratchpad/shots2/*.png`
- Viewports: desktop 1440x900, tablet 820x1180, mobile 390x844 (`Emulation.setDeviceMetricsOverride`, mobile:true)
- Coverage: 5 admin public routes, 7 dataOwner, 10 collectionAgent, 9 dataAdmin, 4 dpo, plus
  user-portal public routes. 39 route x role combinations, each at 3 viewports.

> **Artifact warning for anyone reading the captured `text` fields:** the harness's own
> whitespace-collapsing regex lost a backslash in transport, so runs of the letter **s** were
> collapsed to a space in the extracted text ("Session" reads as "Se ion"). **That is a defect in
> the measuring instrument, not in the application** — the screenshots render correctly. Do not
> report it as a UI bug. The structural metrics (scrollWidth, overflow, rootEmpty, console errors)
> are unaffected.

---

## OBSERVED-1 (P0, responsive) — the admin portal is unusable on a phone

**25 of 39 authenticated admin route x role combinations overflow horizontally at 390px.**
Desktop: 0/39 overflow. Tablet: 6/39. Mobile: 25/39.

Measured `document.documentElement.scrollWidth` against a 390px viewport:

| Route | scrollWidth @390 | overflow |
|---|---|---|
| `/dsar/:requestId` | **1316px** | +926px |
| `/discovery-workspace` | 989px | +599px |
| `/evidence-vault` | 984px | +594px |
| `/data-lineage` | 895px | +505px |
| `/audit-logs` | 868px | +478px |
| `/sessions` | 822px | +432px |
| `/subject-verification` | 796px | +406px |
| `/consent-templates` | 793px | +403px |
| `/my-projects` | 765px | +375px |
| `/dsar-queue` | 751px | +361px |
| `/compliance-reports` | 738px | +348px |
| `/assignments` | 733px | +343px |
| `/project-approvals` | 631px | +241px |
| `/dashboard` | 543px | +153px |
| 11 more between +42px and +132px | | |

**Root cause, confirmed from the overflow-element trace:** the shell is a two-column flex with a
**fixed ~256px sidebar that is never collapsed, hidden or turned into a drawer at any breakpoint**,
beside `main.flex-1 px-10 py-8`. The `px-10` (40px per side) survives to mobile as well. There is
no hamburger anywhere in the admin portal.

Screenshot evidence, same page, same data:
- `shots/admin-dataadmin_dsar_..._desktop.png` — clean, modern, correct.
- `shots/admin-dataadmin_dsar_..._mobile.png` — **the sidebar occupies 256 of 390px (66% of the
  screen)**, the item table is clipped mid-word at the right edge, and the page is 3.4x the
  viewport width.

This is not a polish item. On a phone the admin portal presents a nav rail and a sliver. Collection
agents work from phones in the field, and `/sessions`, `/subject-verification` and `/consent-check`
are exactly the screens that must work there — all three overflow.

**Fix:** one shared responsive shell — sidebar becomes an off-canvas drawer below `lg:` with a
header hamburger; `main` padding scales (`px-4 md:px-6 lg:px-10`); every table gets a card fallback
or an `overflow-x-auto` wrapper. Because it is one shared layout plus per-table work, it belongs
early in the execution order.

## OBSERVED-2 (P1, responsive) — 6 routes already break at tablet (820px)

`/sessions` (+16px), `/discovery-workspace` (+184px), `/data-lineage` (+90px),
`/evidence-vault` (+179px), `/audit-logs` (+62px), `/dsar/:requestId` (+511px).

The overflow trace names the same culprit chain on every one of them:

```
main.flex-1 px-10 py-8                      right=989
div.flex items-start justify-between gap-4  right=949
div.shrink-0                                right=949
```

A `PageHeader` row that is `flex justify-between` with a `shrink-0` action cluster and no
`flex-wrap`. Fixing `PageHeader` alone clears most of the tablet tier.

## OBSERVED-3 (P1, functional) — `/enroll` in the user portal is a permanent dead end

At all three viewports, with a **7-second** settle, `/enroll` renders exactly `"Loading…"`
(textLen=8) plus two `401 (Unauthorized)` console errors.

Root cause, confirmed in code: `user-portal/src/App.jsx:31` mounts `/enroll` **outside** the
`RequireAuth` wrapper (the protected block begins at line 35). `Enroll.jsx` calls `useEnrollment()`,
whose fetch 401s for an unauthenticated visitor; `status` stays `null`; and `Enroll.jsx:29-35`
returns the `"Loading…"` branch unconditionally whenever `!status`. There is **no error branch and
no redirect** — the screen hangs forever.

This sits on the path every newly-registered subject is sent down after `/verify` ("Right after you
verify your email we'll ask for five quick photos of your face" — observed on `/register`). Any
session hiccup strands them on a blank screen.

**Fix:** move `/enroll` inside `RequireAuth`, and give `useEnrollment()` a three-state return
(loading / error / data) with a real error branch in `Enroll.jsx`. Then audit every other page for
the same `if (!data) return <Loading/>` shape with no error arm — it is likely systemic.

## OBSERVED-4 (P2, UX) — neither portal has a 404; unknown routes silently impersonate a logout

`admin-portal/src/App.jsx:181` — `<Route path="*" element={<Navigate to="/login" replace />} />`.
Verified live: `/this-route-does-not-exist` renders the **login page**, byte-identical to `/login`
(textLen 240 for both). A signed-in admin who follows a stale or mistyped link is shown a sign-in
form, which reads as "you have been logged out", not "that page does not exist".
`user-portal/src/App.jsx:56` does the same, redirecting to `/dashboard`.

## OBSERVED-5 (P2, UX + perf) — skeletons that outlive the capture, and buttons live before their data

On `/dsar/:requestId` at desktop the capture (2.6s settle) shows `— items held in total` and an
unresolved grey skeleton bar. The same page at mobile, later in the run, shows `66 items held in
total` with a populated table. So the data does arrive — **the desktop capture caught a load slower
than 2.6 seconds, on a local machine, against a warm database, for 66 items.** That number is the
scalability warning: this is the DSAR item grid and the stated requirement is 5,000 images/day.

Separately, **`Package everything` and `Package marked items` render enabled while the item count is
still `—` and while the banner reads "Nothing has been searched yet. Run discovery…"**. An expensive
and legally significant action should not be clickable before the data it operates on exists.

## OBSERVED-6 (P2, accessibility) — touch targets below the minimum throughout

Measured live at 390px. Every one of these is an interactive control:

| Control | Rendered size |
|---|---|
| `Forgot?` | 44x**16** |
| `Show password` toggle | **18x18** |
| `Back to sign in` | 84x**15** |
| `Sign in` (text link) | 39x**15** |
| `Edit` | 46x**28** |
| `Submit for approval` | 138x**28** |
| `Start session` | 120x**28** |
| `Agents`, `Enrollment` | 84-106x**28** |

WCAG 2.2 SC 2.5.8 sets 24x24 as the minimum and 44x44 as the comfortable target. The
`Show password` control at 18x18 fails even the minimum.

## OBSERVED-7 — NOT A FINDING (investigated and cleared)

The first pass flagged that, as `agent@prism.local`, `/sessions/:id/photos` rendered 439 characters
with no 403, while the sibling routes (`/sessions/:id`, `/tagging`, `/people`, `/review`) showed
`"This session belongs to another agent"`. That looked like a possible fail-open on session media.

**It is not.** Reading the captured text, those 439 characters *are* a refusal — a different and
better one, from the `AccessRefused` component:

> "This page is not part of your role. You are signed in as Data Collection Agent, and
> /sessions/:id/photos is reserved for Data Team / Data Owner, Data Team Admin, Platform
> Administrator. Nothing was read and nothing was recorded against your name. If this is work you
> are meant to be doing, it is a role change your platform administrator makes — not something this
> screen can grant."

The server agrees. Probed live across all four roles on the same session:

```
GET /api/v1/sessions/faa3e6fd…/photos    agent 403 · dataowner 403 · dataadmin 200 · dpo 403
GET /api/v1/sessions/faa3e6fd…           agent 403 · dataowner 403 · dataadmin 403 · dpo 403
GET /api/v1/sessions/faa3e6fd…/clusters  agent 403 · dataowner 403 · dataadmin 403 · dpo 403
GET /api/v1/sessions/faa3e6fd…/people    agent 403 · dataowner 403 · dataadmin 403 · dpo 403
```

`dataAdmin` getting 200 on `/photos` alone matches the documented mount order in `app.js` —
`sessionMediaRoutes` is deliberately mounted ahead of `sessionRoutes` so it can admit dataOwner and
dataAdmin to redacted derivatives. Client gate and server gate agree. Cleared.

Two things worth carrying forward from this, both positive and worth *preserving* through the UI
rework: the refusal copy is genuinely good (it names the role, names the required roles, states that
nothing was read, and tells the user who can fix it), and there are **two distinct refusal
components** — a role refusal and an ownership refusal. Keep both; do not collapse them into one
generic "Access denied" during the redesign.

**Aside (not a defect):** the access token TTL is `15m` and the refresh token `7d`
(`backend/src/lib/tokens.js:6-7`). A 25-minute-old curl cookie jar 401s, which is correct behaviour
and is what produced the initial 401s during this pass.

## OBSERVED-8 (P1, security) — auth cookie flags

```
Set-Cookie: prism_admin_at=…; Path=/; HttpOnly; SameSite=Strict
Set-Cookie: prism_admin_rt=…; Path=/auth/admin/refresh; HttpOnly; SameSite=Strict
```

`HttpOnly` and `SameSite=Strict` are right. **`Secure` is absent** — the session cookie will travel
over plain HTTP wherever one exists. There is also **no `Domain` attribute**, so the cookie is
host-only: the moment the portal and the API sit on different hostnames the browser will not send it
at all, and `SameSite=Strict` additionally blocks it across registrable domains. Today both are
`localhost`, which conceals both problems.

The `Domain`/`SameSite` half is a deployment-topology decision and belongs to the deferred infra
phase. The missing `Secure` flag should be fixed now — it is a one-line, environment-conditional
change in the cookie helper.

## Corrected — a false positive the lead chased down

The first pass recorded `user-portal /login` as rendering **completely blank** (`#root` empty,
textLen 0) at desktop and tablet while working at mobile. A re-run with a 7-second settle
(`shots2/report.json`) renders all three correctly at 187 chars. It was **Vite's cold on-demand
compile on first hit of a new origin**, not an application bug. Not a finding.

It does make a real point for the plan, though: **the portals are being reviewed as Vite dev
servers.** Every timing number taken against `:5173` / `:5180` is dev-mode. Production numbers must
be re-measured against `npm run build` output served by a real static server.

## What this pass could not check

- **No authenticated user-portal screens.** Subject login is OTP-by-email and the lead had no live
  OTP, so every user-portal finding above comes from public routes only. `Dashboard`, `ConsentHub`,
  `MyConsents`, `MyData`, `DataRights`, `RaiseRequest`, `RequestStatus`, `SecureInbox`,
  `Certificate`, `Profile`, `Projects` and `ProjectDetails` are **unrendered and unverified**.
- **No interaction testing** — no clicks, form submissions, modal/focus-trap or keyboard checks.
  Everything above is first-paint only.
- No real-device testing, no Safari or Firefox, no touch, no orientation change.
- Camera and microphone flows (`SelfieCapture`, `VoiceCapture`, `FaceEnrollment`) cannot run headless.
- Long-list and large-dataset rendering was not exercised beyond the 66-item DSAR grid.

All of these belong in the plan as required manual QA, with the OTP path made testable first.
