# Frontend Pages & Polish — Implementation Plan

Scope: admin-portal (build 21 missing role pages + wire routing) and both portals'
polish pass (responsive, states, a11y). No backend/DB work — everything here runs on
a mock data layer, swappable later for the real API without page rewrites.

## 0. Current state (from codebase survey)

- **admin-portal routing is a dead end.** `App.jsx` only has `/login` and `/dashboard`.
  `Sidebar.jsx` renders nav items as plain `<button>`s with **no `onClick`/route wiring** —
  clicking anything except Dashboard does nothing.
- **Auth is all-or-nothing.** `auth.jsx`'s `RequireRole` checks "is a role logged in",
  not "is this role allowed on this route." Every one of the 21 pages needs to be
  reachable only by its own role.
- **No shared list/table/empty-state components exist yet.** Dashboard's "Current Work
  Queue" list markup is inlined in `Dashboard.jsx` — every new page would otherwise
  reinvent it slightly differently.
- **user-portal is already functionally complete** (Dashboard, Login, Verify,
  ConsentHub, ProjectDetails, DataRights, Projects, Profile) — its work here is polish
  only, not new pages.
- **No mock data files exist** — Dashboard's numbers live inline in `roles.js`.
- Tailwind v4 tokens are defined per-app in `index.css` via `@theme` (no
  `tailwind.config.js`) — reuse `rounded-card`, `shadow-card`, `bg-surface`, `text-ink`,
  `text-ink-muted`, `text-ink-faint`, `bg-canvas`, `text-brand`, `border-border` etc.
  throughout; don't invent new tokens without a reason.

## 1. Design approach

- **One route per nav item, flat paths, slug-based.** Add a `path` field to every nav
  entry in `roles.js` (e.g. `{ label: 'Consent Templates', icon: FileText, path: '/consent-templates' }`).
  Sidebar renders `NavLink` against `path`, active state comes from router (`isActive`)
  instead of the current string-matched `activeLabel` prop.
- **Per-route role gating.** Extend `auth.jsx` with a `RequireRole(roleKey)` variant (or
  a route→role map) so a `dataOwner` can't hit a `dataAdmin` URL by typing it in.
  Redirect to `/dashboard` (not `/login`) on mismatch — they're authenticated, just
  wrong role.
- **Shared component kit before pages, not during.** Three components will be reused
  by most of the 21 pages — build them once:
  - `PageHeader` (title + subtitle + optional action button) — Dashboard already has
    this pattern inline; extract it.
  - `ListPanel` / `DataTable` — generalizes Dashboard's "Current Work Queue" card into
    a reusable list-with-rows component (title, rows, empty state, optional row click).
  - `StatusPill` — port/adapt `user-portal/src/components/Badge.jsx` into admin-portal
    for approval/risk/status labels (High Risk, Pending, Approved, etc.) instead of
    plain text.
  - `EmptyState` — one small component (icon + message) used whenever a list has zero
    items, instead of each page inventing its own.
- **Mock data layer, not hardcoded JSX.** `src/data/*.js` per domain (`projects.js`,
  `requests.js`, `consentTemplates.js`, `auditLog.js`, `assignments.js`, ...), plus a
  tiny `src/lib/mockApi.js` with a `fetchMock(data, delay=300)` helper that returns a
  Promise. Pages call this instead of importing arrays directly, so swapping in real
  fetch calls later touches one file per page, not the JSX.
- **Prioritize by compliance value.** Build DPO and Data-Admin pages first (approvals,
  SLA, DSAR, purge, audit log — the actual compliance surface this app exists for),
  then Data-Owner and Collection-Agent (operational/day-to-day forms).

## 2. Phases

### Phase 1 — Routing & auth foundation (admin-portal)
- Add `path` to every nav entry in `roles.js`.
- Add route-role guard to `auth.jsx`.
- Rewrite `Sidebar.jsx` to use `NavLink`, drop the `activeLabel` prop plumbing.
- Add all 21 routes to `App.jsx`, each initially pointing at a placeholder page (so
  nothing 404s while pages are built incrementally).
- **DoD:** every sidebar item navigates somewhere real; wrong-role direct URL access
  redirects instead of rendering.

### Phase 2 — Shared component kit
- Build `PageHeader`, `ListPanel`, `StatusPill`, `EmptyState` in `src/components/`.
- Refactor `Dashboard.jsx` to consume them (proves they work, keeps one code path).
- **DoD:** Dashboard renders identically to before, now via shared components.

### Phase 3 — Mock data layer
- `src/data/*.js` + `src/lib/mockApi.js`.
- Seed realistic data consistent with what Dashboard already implies (project names
  like "XR Research 2026", request IDs like "10001", etc.) so pages feel connected,
  not randomly generated.
- **DoD:** each domain dataset has enough rows to show list, empty, and pagination/
  scroll behavior in the UI.

Each role phase below (4-7) bundles its own polish (responsive, loading/empty/error
states, a11y) as part of that phase's definition of done, rather than deferring all
polish to one pass at the end — cheaper to catch issues while the page is fresh, and
avoids a scary 21-page review at the very end.

### Phase 4 — DPO pages (5) — effort: M
Project Approvals, Consent Templates, Request Oversight, SLA Monitoring, Compliance
Reports — list + detail patterns, approve/reject actions (UI only, mock state update).
**DoD:** all 5 reachable, populated from mock data, responsive down to tablet width,
loading/empty states via shared components, keyboard-navigable.

### Phase 5 — Data-Admin pages (6) — effort: L
DSAR Queue, Discovery Workspace, Data Lineage, Purge/Export, Evidence Vault, Audit
Logs — these are the most structurally novel (lineage graph, hash-chained audit log
display) so budget more time here. Same DoD checklist as Phase 4.

### Phase 6 — Data-Owner pages (6) — effort: M
My Projects, Create Project, Data Requirements, Collection Progress, Processed Data,
Project Reports. Same DoD checklist as Phase 4.

### Phase 7 — Collection-Agent pages (6) — effort: M
Assignments, New Session, Subject Verification, Consent Check, Capture & Upload,
Upload Queue — includes the only genuinely form-heavy, multi-step flows (session
creation, capture). Same DoD checklist as Phase 4, plus form validation states.

### Phase 8 — Cross-cutting consistency pass + user-portal polish — effort: S
- One pass across all 21 new pages checking visual/interaction consistency (spacing,
  empty-state wording, focus rings) now that they all exist side by side.
- Apply the same loading/empty/error/a11y checklist to user-portal's existing pages
  (Dashboard, ConsentHub, ProjectDetails, DataRights, Projects, Profile) — no new
  pages needed there, this is polish-only.

## 3. Open questions

1. **Approve/reject and other write actions in Phases 4-7 — mock-only (local state,
   resets on refresh) or should they persist to localStorage so demos survive a
   reload?** Recommend localStorage-backed mock store — cheap now, and the same
   interface will make the real-API swap later more mechanical.
2. **Data Lineage (Phase 5) — any existing sketch for what this looks like?** The
   `context/` folder has a "dpdp cmp and dsar portal data lineage graph.jpg" reference
   — worth confirming that's the intended visual before building a graph UI from
   scratch, since that's the single most novel page in scope.
