# Responsive design — code-level remediation map

Domain: responsive design across both portals. This deepens the lead's rendered-DOM measurements
(`00-LEAD-browser-pass.md`, `shots/report.json`, `shots2/report.json`) with the exact source lines
that produce them, and closes with a concrete, ordered remediation plan.

All evidence below is OBSERVED from `Read`/`Grep`/`Bash` against the live source tree at
`C:\Users\gaur3\Desktop\Projects\samsung project` unless marked INFERRED.

---

## 1. THE HEADLINE FINDING — why `/dsar/:requestId` is exactly 1316px, not "some overflow"

The lead measured `document.documentElement.scrollWidth` = **1316px** at a 390px viewport for
`/dsar/:requestId` and attributed it to "a fixed sidebar next to `main.flex-1 px-10 py-8`". That is
correct but incomplete — it explains *that* there is overflow, not why the number is *exactly*
1316. Tracing the box model closes the loop:

```
admin-portal/src/components/Sidebar.jsx:16
  <aside className="flex h-screen w-64 shrink-0 ...">        → 256px, never shrinks (shrink-0)

admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx:424-427
  <div className="flex min-h-svh bg-canvas">
    <Sidebar />
    <main className="flex-1 px-10 py-8">                     → px-10 = 40px each side = 80px

admin-portal/src/components/ItemGrid.jsx:68-69
  <div className="overflow-x-auto rounded-card bg-surface shadow-card">
    <table className="w-full min-w-[980px] text-left">       → table forces 980px minimum
```

`256 + 80 + 980 = 1316` — an exact match to the lead's measurement, byte for byte.

**Why the `overflow-x-auto` wrapper on the table does nothing here:** `main` is a flex item
(`flex-1` inside `div.flex`). Per the CSS Flexbox spec, an unconstrained flex item's *automatic*
`min-width` is not `0`, it is the min-content size of its subtree — **unless the item itself sets
`overflow` to something other than `visible`, or its `min-width` is pinned to `0`.** `main` does
neither. So the 980px hard floor set on the `<table>` (four DOM levels below `main`) propagates
straight up through every plain `<div>` in between and becomes `main`'s own automatic minimum
width. The flex row can't shrink `main` below that, so the whole `div.flex` — the entire page —
grows to 1316px and the browser puts the scrollbar on `<html>` instead of inside the
`overflow-x-auto` div where the author clearly intended it to live.

**This is not unique to the DSAR page.** Every route that mounts `main.flex-1 px-10 py-8` (34
pages, see §2) has the same missing `min-w-0`, and five components already ship an
`overflow-x-auto` wrapper that this defect silently defeats:

```
grep -rl "overflow-x-auto" admin-portal/src --include=*.jsx
  admin-portal/src/components/ItemGrid.jsx
  admin-portal/src/components/AudioTimeline.jsx
  admin-portal/src/pages/collectionAgent/TextSessionDetail.jsx
  admin-portal/src/pages/dataAdmin/DataLineage.jsx
  admin-portal/src/pages/dataAdmin/DiscoveryWorkspace.jsx
```

The developers on this codebase already know the `min-w-0` idiom — it is used **28 times** across
`admin-portal/src` for local truncation fixes (e.g. `ListPanel.jsx:15`, `ProcessedData.jsx:103`,
both `min-w-0 flex-1 …` on a row that must not push a sibling badge off-screen). It was simply never
applied at the one place — the shell's `main` element — where it would have contained the
overflow from the *table* level, not the row level.

**The fix that has the highest leverage-to-risk ratio in this entire audit:** add `min-w-0` to
`main` in the shell wrapper. On its own this converts the worst offenders (`/dsar/:requestId`
+926px, `/discovery-workspace` +599px, `/evidence-vault` +594px, `/data-lineage` +505px,
`/audit-logs` +478px — five of the top six) from *document-level horizontal scroll of the whole
page* into *correctly contained horizontal scroll inside the table*, which is what the
`overflow-x-auto` authors were already trying to build. It is a one-token change, it cannot regress
desktop (at 1440px there was already 0 overflow, meaning `main` was already wide enough that the
automatic-minimum floor was never binding), and `detect_changes`-style review of it is trivial: it
touches layout sizing only, no logic.

**It does not fix mobile usability on its own.** Even with the table correctly scrolling inside its
own box, the sidebar still eats 256 of 390px (66%) before any content renders, and `px-10` (80px)
eats another 20%, leaving ~54px for content on the *narrowest* routes and not much more once the
table stops force-widening everything else. The off-canvas drawer described in §3 is still required
to make the admin portal usable on a phone. But `min-w-0` should land first and separately — it is
close to zero-risk and it is the reason five different "we already built an overflow wrapper"
components are not doing their job today.

---

## 2. There is no shared admin-portal shell — the sidebar+main pattern is copy-pasted 34 times

This matters directly for remediation cost. `Sidebar.jsx` is one component, but **nothing wraps
"Sidebar + main" into a layout component that pages consume.** Every one of the 34 page files that
renders a sidebar reimplements the shell inline:

```
grep -n "<Sidebar />" admin-portal/src/pages -r --include=*.jsx | wc -l
34
```

Representative instances, all textually near-identical:

```
admin-portal/src/pages/Dashboard.jsx:78-81
  <div className="flex min-h-svh bg-canvas">
    <Sidebar />
    <main className="flex-1 px-10 py-8">

admin-portal/src/pages/dataAdmin/EvidenceVault.jsx:227-230        — identical
admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx:424-427    — identical
admin-portal/src/pages/collectionAgent/Sessions.jsx:52-55         — identical
```

...but not all identical — three files have already drifted:

```
admin-portal/src/pages/collectionAgent/TextSessionDetail.jsx:317   <main className="flex-1 px-10 py-8 max-w-7xl">
admin-portal/src/pages/collectionAgent/AudioSessionDetail.jsx:295  <main className="flex-1 px-8 py-8 max-w-7xl">
admin-portal/src/pages/collectionAgent/AudioSessionDetail.jsx:273  <main className="flex-1 flex items-center justify-center">   (loading state)
admin-portal/src/pages/collectionAgent/TextSessionDetail.jsx:298   <main className="flex-1 flex items-center justify-center p-10">  (loading state)
```

**Consequence for the remediation plan:** there is no single file where "collapse the sidebar to a
drawer below `lg:`" can be made once. Two options, stated explicitly so the plan can price them:

- **Option A (correct, larger effort):** introduce `admin-portal/src/components/AppShell.jsx`
  (mirroring `user-portal/src/components/AppLayout.jsx`, see §4) that owns the responsive sidebar
  and renders `<Outlet/>` or `children`; convert the 34 pages to mount it once via a layout route in
  the router, the way `user-portal/src/App.jsx:35-55` already nests routes under one `AppLayout`
  element instead of each page importing its own chrome. This also deletes 34 copies of an
  8-line shell and the 3-way drift documented above.
- **Option B (mechanical, smaller effort, more risk of missing one):** find/replace the shell block
  in all 34 files (33, since one already differs on purpose) plus fix `Sidebar.jsx` itself to
  become responsive. Faster to land, guarantees nothing is missed only if every call site is
  actually touched — a `grep -c "<Sidebar />"` before/after is the way to prove full coverage.

Given the admin-portal has no router-level layout nesting at all today (confirmed: `App.jsx`
mounts each page as a leaf route with its own chrome — INFERRED from the fact that Sidebar is
imported per-page rather than composed via a layout route, consistent with the grep above), Option
A also means introducing that nesting for the first time. That raises the effort of the "right" fix
but is the only way to stop future pages from re-copying the broken pattern; see §7 for the ordered
plan.

---

## 3. `PageHeader` — the tablet-tier (820px) root cause, confirmed at the source

```
admin-portal/src/components/PageHeader.jsx:1-11
export default function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-medium text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
```

This matches the lead's overflow trace token-for-token (`div.flex items-start justify-between
gap-4` / `div.shrink-0`). Two independent defects compound here:

1. No `flex-wrap` — when `title` + `action` together exceed the header's width (which happens once
   `main`'s content width drops to ~700px at the 820px tablet tier, since 820 − 256 (sidebar) − 80
   (`px-10`) = 484px, and `action` clusters like the two-button group in
   `DsarRequestDetail.jsx:450-457` (two `StatusPill`s) or `DsarRequestDetail.jsx:481-505` (two
   buttons with icons and 13-word disabled-state text nearby) do not fit inline), the row cannot
   drop to two lines — it can only overflow the container to the right.
2. `shrink-0` on the action cluster removes the one degree of freedom that *could* have absorbed
   the overflow (letting the buttons shrink/wrap their own labels) — it explicitly opts the action
   cluster out of flexbox's default shrink behaviour.

**Fix, one file:** `flex-wrap items-start justify-between gap-3` on the outer div (drop
`items-start` to `items-center` once wrapped, or keep `items-start` — either reads fine once
wrapping is allowed), and drop `shrink-0` from the action wrapper or replace it with
`shrink-0 sm:shrink-0` scoped only above the point actions must stay inline. Every page that passes
an `action` prop inherits the fix for free — this is the one component in the whole audit where a
single-file change measurably clears most of tablet-tier overflow, exactly as the lead noted.

---

## 4. The two portals are built on opposite responsive philosophies — proven by breakpoint census

```
grep -c '\bsm:' / '\bmd:' / '\blg:'  (Grep tool, per-portal, *.jsx)

                sm:              md:              lg:
admin-portal    14  (6 files)    4  (2 files)     14  (7 files)
user-portal      2  (2 files)   41 (22 files)      1  (1 file)
```

Both portals total roughly 60–80 JSX files. Admin-portal touches a breakpoint prefix in **13 of
~80** files; user-portal touches one in **~23 of ~50** files, and overwhelmingly favours `md:`
(41 hits, one breakpoint, used as the single mobile/desktop pivot) over `sm:`/`lg:`.

**This is not a style preference — it maps directly onto whether each portal has a responsive
shell:**

```
user-portal/src/components/AppLayout.jsx:1-19
  <div className="min-h-svh bg-canvas md:flex">
    <SidebarNav />                                        (hidden md:flex …)
    <div className="flex-1 md:min-w-0">                    ← min-w-0 IS present here
      <main className="mx-auto w-full max-w-md pb-24 md:max-w-none md:pb-10">
        <div className="md:mx-auto md:max-w-5xl md:px-4">
          <Outlet />
        </div>
      </main>
    </div>
    <BottomNav />                                          (… md:hidden)
  </div>

user-portal/src/components/SidebarNav.jsx:7
  <aside className="hidden md:flex md:w-64 md:flex-col md:shrink-0 md:border-r … md:h-screen md:sticky md:top-0">

user-portal/src/components/BottomNav.jsx:6
  <nav className="fixed bottom-0 inset-x-0 z-20 … pb-[env(safe-area-inset-bottom)] md:hidden">
```

This is a genuinely mobile-first shell: the sidebar is `display:none` until `md:` (768px), a fixed
bottom tab bar takes over below that breakpoint, content is capped at `max-w-md` (28rem/448px) on
mobile so text measure stays readable, and **`AppLayout.jsx:9` already has the exact `min-w-0` that
§1 shows is missing from the admin shell.** The user-portal engineer who wrote this component
independently discovered and applied the fix the admin portal needs.

`admin-portal/src/components/Sidebar.jsx` contains **zero** breakpoint prefixes anywhere in its 69
lines — it is one unconditional `<aside className="flex h-screen w-64 shrink-0 …">` with no
`hidden`/`md:flex` toggle, no drawer state, no `z-` layer for an overlay, no close affordance. There
is no code path in the admin portal, at any viewport, that removes the sidebar from the layout
flow.

**Direct consequence for the remediation plan:** the fix for admin-portal is not a novel design —
it is porting `user-portal/src/components/{AppLayout,SidebarNav,BottomNav}.jsx`'s *structural*
pattern (hidden-until-md sidebar + conditional bottom/drawer nav + `min-w-0` on the flex spine) into
admin-portal, while keeping admin-portal's own visual language (see §5 — the two portals do not
share a design system, so this is a structural port, not a reskin). Concretely:

- Admin's `Sidebar.jsx` becomes: `hidden` below `lg:` (admin has more/denser nav items via
  `navSectionsForRole`, including a 23-entry super_admin case per Sidebar.jsx:10-12 comment — `lg:`
  1024px is the safer pivot than `md:` 768px given that density), replaced below `lg:` by a header
  bar with a hamburger that opens the same `<nav>` content in an off-canvas panel (`fixed inset-0
  z-50` + slide-in, or reuse `ConfirmDialog.jsx`'s `role="dialog" aria-modal` + focus-trap +
  Escape-to-close pattern at `ConfirmDialog.jsx:38-45` — that focus/Escape logic is already written
  once in this codebase and should be extracted, not re-invented, for the drawer).
- The `main` wrapper gains `min-w-0` (§1) and a responsive padding scale (`px-4 md:px-6 lg:px-10`
  instead of the flat `px-10` that survives unchanged to 390px today).

---

## 5. The two design systems are genuinely different — the port is structural, not visual

```
admin-portal/src/index.css:4-35                         user-portal/src/index.css:4-32
  font: Inter                                              font: Manrope
  --color-sidebar: #172033 (dark navy, admin only)         (no sidebar token — nav is a light aside)
  --radius-card: 14px                                      --radius-card: 28px
  (no --radius-chip)                                       --radius-chip: 18px
  --color-brand: #0058BC                                   --color-brand: #0058BC   (same blue)
```

Same brand blue, different everything else — different typeface, a dark-navy sidebar vs. a
light-surface one, half the corner radius. Neither `index.css` defines `--breakpoint-*` custom
tokens (confirmed: no `tailwind.config.*` exists in either portal — `find admin-portal user-portal
-maxdepth 1 -iname "tailwind.config*"` → no results — both are pure Tailwind v4 CSS-first config),
so both run on Tailwind's stock breakpoints (sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536).
**Neither `index.css` sets a global `overflow-x: hidden` safety net on `html`/`body`/`#root`** — the
only rule on `#root` in both files is `min-height: 100svh` (`admin-portal/src/index.css:46-48`,
`user-portal/src/index.css:43-45`). That is a second reason the admin-portal overflow reads as an
actual page-level horizontal scrollbar rather than silently-clipped content: nothing anywhere stops
it. Adding `overflow-x: clip` (or `hidden`) to `body` in `admin-portal/src/index.css` is a cheap,
independent belt-and-suspenders line that will not fix any of the underlying `min-w-0`/wrap issues
but will stop a *future* regression of the same shape from reaching production as a visible
horizontal scrollbar — it converts a "the whole page scrolls sideways" bug into a "something is
clipped, go find it" bug, which is strictly better and costs one CSS line. It is not a substitute
for §1–§3.

---

## 6. Fixed-width / no-responsive-variant inventory

### `min-w-[Npx]` / forced pixel minimums

| Location | What | Effect |
|---|---|---|
| `admin-portal/src/components/ItemGrid.jsx:69` | `<table className="w-full min-w-[980px] …">` | Root cause of §1; only 5 tables in admin-portal even attempt `overflow-x-auto`, and this is the one whose forced floor is documented to exactly reproduce the worst measured overflow. |
| `admin-portal/src/pages/dataAdmin/DsarRequestDetail.jsx:826` | `<input className="min-w-64 flex-1 …">` inside a `flex-wrap items-end gap-2` evidence-filing form (`:810`) | Lower risk — the parent already wraps, so this one just forces the input to its own line early; not a page-overflow contributor. |

### `<table>` with no horizontal-scroll strategy at all (worse than ItemGrid — no wrapper attempted)

```
admin-portal/src/pages/dataAdmin/PurgeExport.jsx:157-158, 295-296
  <div className="mt-2 max-h-64 overflow-y-auto">
    <table className="min-w-full text-left text-xs">
```

Five columns (Session, Project, Taken, Subjects on frame, a "Break-glass" action button —
`PurgeExport.jsx:161-165`) at `text-xs`, wrapped only in `overflow-y-auto` (a vertical scroll cap
for a long list) with **no `overflow-x-auto` at all**. `min-w-full` (100% of parent, not a pixel
floor) means this table doesn't reproduce the exact §1 arithmetic, but it has strictly less mobile
protection than `ItemGrid` — there is no scroll escape hatch in either axis-x direction if the five
columns don't fit. This table renders inside a break-glass/media-preview panel gated behind
interaction (`showMedia` state, confirmed at `PurgeExport.jsx:202`), which is why the lead's
first-paint automated pass did not surface it — it would only appear after a click the harness never
made. **Not yet measured live; flagged from code, needs a manual-QA pass to get real pixel
numbers.**

### `grid-cols-N` with no responsive variant (fixed column count survives to 390px)

```
admin-portal/src/pages/Dashboard.jsx:89,96                    grid grid-cols-3 gap-4      (StatCard tiles, incl. skeleton at :89)
admin-portal/src/pages/dpo/SlaMonitoring.jsx:29,36             grid grid-cols-3 gap-4
admin-portal/src/pages/dpo/ComplianceReports.jsx:196,226,252   grid grid-cols-3 gap-4
admin-portal/src/pages/dpo/ComplianceReports.jsx:219           grid grid-cols-2 gap-4
admin-portal/src/pages/collectionAgent/NewSession.jsx:98       grid grid-cols-3 gap-3
admin-portal/src/pages/collectionAgent/SubjectVerification.jsx:334   grid grid-cols-2 gap-4  (a form)
admin-portal/src/pages/dataOwner/ProjectReports.jsx:138,145    grid grid-cols-2 gap-4
admin-portal/src/components/AudioTimeline.jsx:723              grid grid-cols-2 gap-3
```

Every one of these is a **`StatCard`-style tile row or a form field grid living directly under
`main`'s fixed padding** — three equal columns of a value+label tile (`StatCard.jsx:1-8`, `p-5`,
`text-2xl` value) squeezed into whatever width `main` has left after the sidebar. Once §1/§3 are
fixed and `main` gets real content width on mobile (~330–350px after a responsive padding scale),
three tiles at `gap-4` (16px × 2 gaps = 32px) leaves ~100px per tile — workable for a short number
but tight for anything with a longer label. **Recommendation: `grid-cols-1 sm:grid-cols-3` (or
`grid-cols-3` only from `sm:`/`md:` up) for every stat-tile grid in this list**, which the codebase
already knows how to write correctly elsewhere:

```
admin-portal/src/pages/collectionAgent/People.jsx:141   grid gap-4 sm:grid-cols-2 lg:grid-cols-3
admin-portal/src/pages/collectionAgent/Tagging.jsx:358,396,420,443   grid gap-4 sm:grid-cols-2 lg:grid-cols-4
```

Worth naming explicitly: these `sm:`/`lg:` grids are the *only* places in admin-portal that behave
responsively today, and they are all photo/people **card galleries nested inside `main`**, not the
shell. Their authors clearly know the pattern — it was applied locally to galleries and never
applied to the shell that contains them, and because the shell never yields width on mobile, these
already-correct grids never get to prove themselves; they've been collapsing to their `lg:`
(desktop-only, ≥1024px) column count this whole time only because `main` never got narrow *enough*
to hit their unstyled 1-column default — they'd behave properly the moment the shell does.

### `absolute` / fixed positioning

```
admin-portal/src/components/TimelineList.jsx:54   <span className="absolute -left-[9px] top-5 grid size-[18px] …">   — timeline dot, positioned relative to `ol.relative`, scales fine, not a page-width contributor.
admin-portal/src/components/ConfirmDialog.jsx:52   <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6">   — modal overlay, has px-6 gutter, card is `w-full max-w-md`; this one is already correctly responsive (see §8).
user-portal/src/components/BottomNav.jsx:6   <nav className="fixed bottom-0 inset-x-0 …">   — intentional, correct (mobile tab bar).
```

No other `fixed`/`absolute` layout elements found via `grep -rn "\babsolute\b\|\bfixed\b"` scoped to
these component/page directories that behave as page-width contributors; the two `fixed` uses above
are both intentional UI (a modal, a tab bar) and both already handle their own width correctly.

---

## 7. Touch targets — the shared root cause, traced to source

The lead measured (`00-LEAD-browser-pass.md`, OBSERVED-6): `Show password` 18×18, `Forgot?` 44×16,
`Back to sign in` 84×15, `Sign in` link 39×15, `Edit` 46×28, `Submit for approval` 138×28, `Start
session` 120×28, `Agents`/`Enrollment` 84–106×28.

### The 28px-tall buttons — one Tailwind recipe, 94 occurrences, no shared component

```
grep -rc "py-1.5" admin-portal/src --include=*.jsx   →  94 occurrences total
find admin-portal/src -iname "Button*"               →  no results — there is no Button component
```

There is **no shared `Button`/`IconButton` primitive anywhere in `admin-portal/src`.** Every button
is a bespoke inline `<button className="…">`, and the dominant recipe for a small action button is
`px-3 py-1.5 text-xs font-semibold …` — `py-1.5` (6px top + 6px bottom = 12px) plus a `text-xs`
line-box (~16px) yields the measured 28px. Confirmed at the exact controls the lead measured:

```
admin-portal/src/pages/collectionAgent/Assignments.jsx:56       "Start session" button    → px-3 py-1.5 text-xs
admin-portal/src/pages/dataOwner/DataRequirements.jsx:195       "Submit for approval"      → (same recipe, grep-confirmed)
admin-portal/src/pages/dataOwner/MyProjects.jsx:224              "Submit for approval"      → (same recipe, grep-confirmed)
```

("Agents"/"Enrollment" at 84–106×28 were not traced to an exact literal string — no `>Agents<` or
`'Agents'` match in `admin-portal/src` — they are almost certainly the same `px-3 py-1.5 text-xs`
recipe applied to a different tab/pill control the harness's text-collapsing artifact (see the
lead's note on the "letter s" bug) may have relabeled; the recipe-level finding and fix apply
regardless of which exact file it is.)

**Because there is no shared component, there is no single file where "make buttons 44px" can be
applied once.** The fix is necessarily either (a) a global CSS layer rule targeting the recipe
class combination, which Tailwind's utility-class model makes awkward and fragile, or (b)
introducing `admin-portal/src/components/Button.jsx` now and doing a mechanical pass across the ~94
call sites to adopt it — which is the same shape of problem as §2 (no shared shell) and should be
batched with it: **build the primitives (`Button`, `IconButton`, `Link`-as-button) once, then do one
pass that both fixes touch targets and removes ~94 near-duplicate class strings.** The minimum
viable version: keep the visual size (`text-xs`, `px-3`) for desktop density but add
`min-h-11` (44px) with `inline-flex items-center` so the *hit area* grows via padding/line-height
without changing the printed button chrome — WCAG 2.2 SC 2.5.8 cares about the target size, not the
visible glyph size, so this can be done without a visual redesign.

### The icon-only and bare-text controls — smaller in number, each needs an explicit fix

```
admin-portal/src/pages/Login.jsx:96-103
  <button
    type="button"
    onClick={() => setShowPassword((v) => !v)}
    className="shrink-0 text-ink-faint"
    aria-label={showPassword ? 'Hide password' : 'Show password'}
  >
    {showPassword ? <EyeOff size={18} … /> : <Eye size={18} … />}
  </button>
```

Zero padding, zero explicit size — the rendered hit area is exactly the 18px icon's own box,
matching the lead's 18×18 measurement precisely. **Fix:** `className="flex h-11 w-11 shrink-0
items-center justify-center text-ink-faint"` (or `-mr-2` to compensate the added visual padding
against the input's right edge) — 44×44 hit area, same 18px glyph.

```
admin-portal/src/pages/Login.jsx:83-85          <Link to="/forgot-password" className="text-xs font-semibold text-brand">Forgot?</Link>
admin-portal/src/pages/ForgotPassword.jsx:81-82  <Link to="/login" className="font-semibold text-brand">Back to sign in</Link>
admin-portal/src/pages/ResetPassword.jsx:98-99   <Link to="/login" className="font-semibold text-brand">Back to sign in</Link>
```

Same shape of bug as the eye icon: a bare inline `<Link>` with no padding, so the tap target is the
text glyph's own line box (~15–16px tall). These three (plus `AcceptInvite.jsx`'s "Already active?
Sign in", not yet independently re-read but structurally identical per the lead's 39×15
measurement) are the auth-flow escape hatches — exactly the links someone fat-fingering a phone
keyboard needs to hit reliably. **Fix:** wrap in `inline-flex min-h-11 items-center` (or simpler:
add `py-2.5` to the existing className, which is enough to clear 24px and get close to 44px given
the ~16px text line-height already present).

### admin-portal `ConfirmDialog` and `ItemGrid`/`BulkActionBar` checkboxes — not flagged by the lead, worth a note

```
admin-portal/src/components/ItemGrid.jsx:74-79, 109-119   <input type="checkbox" … className="size-4 accent-brand …">
```

`size-4` = 16×16px native checkboxes with no padding wrapper — below the 24px minimum. Not in the
lead's measured list (checkboxes render inside `ItemGrid`, which only appears past a role/tab gate
the automated first-paint pass didn't drill into), but the same class of defect as the touch targets
above and should be swept in the same pass — either size the input itself up via `accent-brand`-
compatible sizing (`size-5`/`size-6`) or wrap in a `p-2` hit-area label, which also fixes the
"tapping exactly on a 16px square on a moving list" precision problem this UI's bulk-delete
workflow cannot afford to get wrong.

---

## 8. What is already correct in the admin portal — preserve these while rebuilding the shell

- `admin-portal/src/components/ConfirmDialog.jsx:52-57` — `fixed inset-0 … px-6` overlay with a
  `w-full max-w-md` card. This is the one modal-shaped component in the codebase that already does
  the right thing at narrow widths: it never exceeds the viewport, it has a real gutter (`px-6`),
  and it has working Escape-to-close + focus-on-open (`:31-45`) and a focus trap start point
  (`cancelRef`, `:29,34`). **Reuse this exact overlay/focus pattern for the sidebar drawer in §4**
  rather than writing a second implementation.
- `admin-portal/src/components/ItemGrid.jsx:68` and 4 sibling components already reach for
  `overflow-x-auto` — the intent was right, only the missing `min-w-0` upstream defeats it (§1).
  Do not rewrite these into cards; once `min-w-0` lands they become correctly-scrolling tables with
  zero further change.
- The two-tier refusal-copy pattern (role refusal vs. ownership refusal — lead's OBSERVED-7) has
  nothing to do with layout but sits on the same pages being reworked here; the shell rebuild in §4
  must not collapse `AccessRefused` into a differently-styled generic state as a side effect of
  changing `main`'s wrapper markup.

---

## 9. Camera/capture components — aspect ratio and orientation

```
user-portal/src/components/SelfieCapture.jsx:492    <video … className="aspect-video w-full scale-x-[-1] object-cover">
user-portal/src/components/SelfieCapture.jsx:499    <img … className="${on ? 'absolute inset-0 h-full w-full' : 'aspect-video w-full'} … object-contain">
admin-portal/src/components/SelfieCapture.jsx:79    <video … className="aspect-video w-full object-cover">
admin-portal/src/components/SelfieCapture.jsx:72,80  preview <img>/<video> also aspect-video
```

Both portals' selfie-capture preview is hard-pinned to `aspect-video` (16:9, landscape) for a
**front-facing face-enrollment shot** — the one capture scenario in this whole system that is
naturally portrait (a face fills more of a tall frame than a wide one). At a typical mobile content
width of ~340px (inside the `max-w-md` card, minus `p-4`/`px-5` gutters), a 16:9 box is only
`340 × 9/16 ≈ 191px` tall. The 3-pose auto-capture flow in `user-portal/src/components/
SelfieCapture.jsx` draws a Face-ID-style readiness ring sized at `RING_R = 46` (SVG units against a
100×100 viewBox, so ~46% of the shorter box dimension — `:439-440,506`) inside that 191px-tall
strip — workable but visibly cramped compared to what a `aspect-[3/4]` or `aspect-square` box would
give the same UI. **Not a breakage — camera opens, frames still register, `object-cover`/
`object-contain` both handle the crop without distortion — but it fights the framing task the
component exists to do.** Recommend `aspect-[3/4]` (portrait) for both `SelfieCapture` components;
this is a pure Tailwind class swap with no logic change, low risk, and the ring geometry (relative
`%`-based `RING_R`) already adapts automatically to a taller box.

**Orientation change:** neither component listens for `orientationchange`/`resize`, but none of
them need to — `getUserMedia`'s constraints (`width: 1280, height: 720`, `SelfieCapture.jsx:146` /
admin `:26`) are *ideal* hints, not hard constraints (no `exact`/`min`/`max`), and the preview box's
aspect ratio is pure CSS (`aspect-video`), which the browser recalculates on every layout pass with
no JS involvement. **No orientation-lock defect found** — this is a genuine non-finding, called out
because the brief asked and it would be easy to assume otherwise from the lack of an explicit
listener.

**Safe-area insets:** only `user-portal/src/components/BottomNav.jsx:6`
(`pb-[env(safe-area-inset-bottom)]`) references `env(safe-area-inset-*)` anywhere in either portal
— confirmed via `grep -rn "safe-area" admin-portal/src user-portal/src --include=*.jsx`, one hit.
Both `SelfieCapture` components are card-embedded, not full-bleed, so they don't sit directly under
a notch/home-indicator today; if a future full-screen capture mode is added, it will need the same
`env()` treatment BottomNav already has, but nothing currently needs it and isn't getting it.

---

## 10. Modals/drawers and keyboard-open behaviour

- `ConfirmDialog.jsx` (§8) is the only modal component in admin-portal and is already
  narrow-viewport safe.
- **No drawer component exists in admin-portal at all** — there is nothing to audit for
  keyboard-open behaviour because there is no off-canvas panel yet; §4's drawer is new construction,
  not a fix to an existing one.
- **No `<input>`/`<textarea>` in either portal sets `inputmode`, and no page listens for
  `visualViewport` resize to keep a focused field above an open on-screen keyboard.** Given
  `AppLayout.jsx`'s mobile content is `max-w-md` with normal document flow (no `fixed`
  bottom-sheet-style forms found in either portal via `grep -rn "fixed.*bottom" --include=*.jsx`
  beyond `BottomNav.jsx` itself), the standard mobile-browser behaviour (scroll the focused input
  into view, resize the visual viewport) should apply without extra code — **this is a genuine gap
  in coverage (untested, not unbroken)**, not a proven defect; it belongs in the manual-QA list in
  §11, not in the findings table, because there is no code-level evidence either way and the lead's
  pass explicitly did not do interaction testing.

---

## 11. What I could not check

- **No live rendering was performed in this pass.** Everything above is static analysis of the
  source tree layered onto the lead's already-captured `report.json` measurements. The `min-w-0`
  root-cause claim in §1 is arithmetically exact against the lead's number (256+80+980=1316) and is
  standard, well-documented CSS Flexbox behaviour, but it was not independently re-verified by
  re-running the headless-browser harness with the fix applied (that would require editing
  application code, which this audit-only pass is not permitted to do).
- `PurgeExport.jsx`'s break-glass media table (§6) was found by reading code, not by driving the UI
  to the `showMedia` state — its real overflow pixel count at 390px is unmeasured.
- The exact source of the "Agents"/"Enrollment" 84–106×28 controls (lead's OBSERVED-6) was not
  located by literal string search; the recipe-level fix in §7 applies regardless, but the precise
  file:line is unconfirmed.
- Real-device testing, Safari/Firefox rendering differences, actual touch interaction (vs. computed
  box size), and on-screen-keyboard behaviour were not exercised — same limitation the lead's pass
  already recorded, carried forward here because this pass is source-only.
- No authenticated user-portal screens beyond the public/`AppLayout` structural read — `Dashboard`,
  `MyData`, `ConsentHub`, etc. were read only insofar as they `import TopBar`/mount inside
  `AppLayout`; their internal content layout (card grids, forms) was not individually audited for
  fixed widths the way admin-portal's pages were, because the lead's browser pass had no OTP to
  reach them and this pass prioritized explaining the admin-portal numbers that already exist.
  Per §4/§6 evidence, user-portal's shell is sound; its per-page content is unaudited, not verified
  clean.
- `admin-portal/src/pages/AcceptInvite.jsx` was not independently re-read line-by-line (only
  grepped) — its "Sign in" link touch-target is inferred to be the same bare-`<Link>` pattern as
  `ForgotPassword.jsx`/`ResetPassword.jsx` by the lead's matching 39×15 measurement, not confirmed
  by direct code read.

---

## 12. Remediation plan

### Layout primitives to introduce
1. `admin-portal/src/components/AppShell.jsx` — responsive sidebar (hidden below `lg:`, off-canvas
   drawer using `ConfirmDialog`'s overlay/focus/Escape pattern) + `main` with `min-w-0` and
   `px-4 md:px-6 lg:px-10`. Consumed via a router-level layout route, matching
   `user-portal/src/App.jsx:35-55`'s nesting — not imported per-page.
2. `admin-portal/src/components/Button.jsx` (+ optional `IconButton.jsx`) — codifies the `px-3
   py-1.5 text-xs` visual recipe with a `min-h-11`/`min-w-11` hit area baked in, plus a `danger`/
   `brand`/`neutral` tone prop mirroring the tone unions already hand-rolled at every call site
   (`ConfirmDialog.jsx:98`, `BulkActionBar.jsx:61-63`, etc.).
3. A shared responsive `Table`/`DataList` primitive: `overflow-x-auto` wrapper (kept) +
   consistent `min-w-0` contract with its flex/grid ancestor documented in the component's own
   comment so the §1 mistake cannot recur silently in a sixth table. Card-fallback below `sm:` is
   optional (the horizontal-scroll pattern, once actually working via `min-w-0`, is an acceptable
   mobile pattern for dense operational tables like these — recommend keeping scroll-table over
   building N bespoke card layouts, given no shared card-list primitive exists yet either).

### Breakpoint system to standardise on
Keep Tailwind v4 stock breakpoints (no config file exists in either portal — do not introduce
custom `--breakpoint-*` tokens, it would be pure churn). Standardise the *convention*, which today
differs by accident rather than design: user-portal already treats **`md:` (768px) as the single
mobile/desktop shell pivot** and uses `sm:`/`lg:` only for in-page grid density. Admin-portal should
adopt **`lg:` (1024px) as its shell pivot** (not `md:`) because its sidebar carries more items
(23 for `super_admin`, `Sidebar.jsx:10-12`) and its tables are denser than user-portal's card
layouts — `lg:` gives the drawer breakpoint more room before the two-column shell has to reappear.
`sm:`/`md:` remain available for in-page grids exactly as `People.jsx`/`Tagging.jsx` already use
them correctly today.

### Page-by-page order of work

| Order | Change | Files touched | Effort | Why this order |
|---|---|---|---|---|
| 1 | `min-w-0` on `main` in all 34 shell instances (or on `AppShell` if built first) | 34 pages or 1 new file | S (mechanical) / already-covered by #4 if done together | Fixes 5 of the 6 worst overflow routes immediately, zero visual risk, provably matches lead's measured numbers |
| 2 | `PageHeader.jsx` — `flex-wrap`, drop `shrink-0` on action cluster | 1 file | S | Clears most of the 6 tablet-tier (820px) overflows per lead's own trace |
| 3 | Build `AppShell.jsx` (drawer sidebar) + router layout-route migration | 1 new file + `App.jsx` + 34 pages de-duplicated | L | The only real fix for "66% of a 390px screen is sidebar"; do after #1/#2 land as quick wins so the big refactor isn't blocking those |
| 4 | Build `Button.jsx`, sweep the 94 `py-1.5` call sites + the 4 bare-link/icon touch targets in §7 | ~40-60 files | M | Independent of #3, can run in parallel; fixes WCAG 2.2 SC 2.5.8 across the board |
| 5 | `grid-cols-3`/`grid-cols-2` → responsive variants (§6 list, 8 files) | 8 files | S | Cosmetic once #3 gives `main` real mobile width; low priority until then |
| 6 | `PurgeExport.jsx` table `overflow-x-auto` (§6) | 1 file | S | Currently unmeasured but code-confirmed gap; cheap, do opportunistically |
| 7 | `SelfieCapture.jsx` (both portals) `aspect-video` → `aspect-[3/4]` | 2 files | S | Pure polish, zero logic risk |
| 8 | `body { overflow-x: clip }` in `admin-portal/src/index.css` | 1 file | S | Belt-and-suspenders regression guard, do any time after #1-#3 |
| 9 | Manual QA pass: real devices, on-screen-keyboard behaviour, `PurgeExport` break-glass table at 390px, OTP-gated user-portal authenticated screens | n/a | — | Everything in §11 |

Effort key: S = under a day, M = a few days, L = the multi-day shell refactor plus regression pass
across all 34 admin-portal routes.
