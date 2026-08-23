import {
  FolderCheck, FileText, Gauge, ClipboardList, FolderKanban, FilePlus,
  Activity, Database, FileBarChart, ListChecks, PlayCircle, UserCheck, ShieldCheck,
  Camera, Inbox, SearchCode, Share2, Lock, FileClock, Upload,
} from 'lucide-react'

// One table, one direction. Until this file was inverted each role carried its
// own `nav` array and App.jsx generated `allow={[role.key]}` from it — one role
// per route by construction. That is why super_admin, which has no nav array of
// its own, could reach nothing: not a missing permission but a missing key. And
// it is why a page two roles legitimately share (the DSAR queue, the evidence
// vault) had to be listed twice and could still only be entered by one of them.
//
// So the page is the row and the roles are the column. `roles` on each page is
// the FRONT-END gate; the server's gate is docs/02_ROLE_PERMISSION_MATRIX.md §B,
// mirrored in backend/tests/security/rbac-matrix.test.js. This table must be a
// subset of that one — a page is listed for a role only if every endpoint that
// page calls on mount admits that role, otherwise the role lands on a screen
// that 403s in front of them. Where a page calls a narrower endpoint from a
// button rather than on mount, the page hides that button itself (see
// DsarQueue's identity search, DsarRequestDetail's item actions).

const WORKSPACE_SUBTITLE =
  'Role-specific workspace based on the platform flow and assigned responsibilities.'

const ACCESS_NOTE =
  'This portal shows only the projects, records, actions, and reports required for this administrator role. Other administrative functions remain hidden.'

const SUPER_ADMIN_ACCESS_NOTE =
  'Platform administration. This account can reach every workspace in the portal, so every read of subject data from here is recorded as an access event against your name.'

export const GROUPS = {
  governance: 'Governance',
  projects: 'Projects',
  collection: 'Collection',
  requests: 'Requests & data',
  oversight: 'Oversight',
}

// Ordered. A role's sidebar is this list filtered, so the order here is the
// order every role sees, and the groups keep super_admin's twenty-one entries
// readable instead of a wall of links.
export const PAGES = [
  // --- Governance ------------------------------------------------------------
  {
    path: '/project-approvals',
    label: 'Project Approvals',
    icon: FolderCheck,
    group: 'governance',
    // POST /projects/:id/approve|reject
    roles: ['dpo', 'super_admin'],
  },
  {
    path: '/consent-templates',
    label: 'Consent Templates',
    icon: FileText,
    group: 'governance',
    // POST /consent-templates, POST /consent-templates/:id/publish
    roles: ['dpo', 'super_admin'],
  },

  // --- Projects --------------------------------------------------------------
  {
    path: '/my-projects',
    label: 'My Projects',
    icon: FolderKanban,
    group: 'projects',
    // POST /projects/:id/submit, POST|DELETE /projects/:id/assignments
    roles: ['dataOwner', 'super_admin'],
  },
  {
    path: '/create-project',
    label: 'Create Project',
    icon: FilePlus,
    group: 'projects',
    // POST /projects — and GET /consent-templates, which excludes dataAdmin.
    roles: ['dataOwner', 'super_admin'],
  },
  {
    path: '/data-requirements',
    label: 'Data Requirements',
    icon: ClipboardList,
    group: 'projects',
    // PATCH /projects/:id
    roles: ['dataOwner', 'super_admin'],
  },
  {
    path: '/collection-progress',
    label: 'Collection Progress',
    icon: Activity,
    group: 'projects',
    // GET /dashboard/summary — open to every role, but this is the data team's
    // view of its own projects; the other roles have their own dashboards.
    roles: ['dataOwner', 'super_admin'],
  },
  {
    path: '/processed-data',
    label: 'Processed Data',
    icon: Database,
    group: 'projects',
    // GET /projects/:id/sessions
    roles: ['dataOwner', 'super_admin'],
  },
  {
    path: '/project-reports',
    label: 'Project Reports',
    icon: FileBarChart,
    group: 'projects',
    // GET /projects/:id/report
    roles: ['dpo', 'dataOwner', 'super_admin'],
  },

  // --- Collection ------------------------------------------------------------
  {
    path: '/assignments',
    label: 'Assignments',
    icon: ListChecks,
    group: 'collection',
    roles: ['collectionAgent', 'super_admin'],
  },
  {
    path: '/new-session',
    label: 'New Session',
    icon: PlayCircle,
    group: 'collection',
    // POST /sessions
    roles: ['collectionAgent', 'super_admin'],
  },
  {
    path: '/sessions',
    label: 'Sessions',
    icon: Camera,
    group: 'collection',
    // GET /sessions
    roles: ['collectionAgent', 'super_admin'],
  },
  {
    path: '/subject-verification',
    label: 'Subject Verification',
    icon: UserCheck,
    group: 'collection',
    // POST|GET /subjects and /subjects/:id/enrollments
    roles: ['collectionAgent', 'super_admin'],
  },
  {
    path: '/consent-check',
    label: 'Consent Check',
    icon: ShieldCheck,
    group: 'collection',
    // GET /projects/:id/subjects — names, so matrix §D keeps dpo/dataOwner out.
    roles: ['collectionAgent', 'super_admin'],
  },

  // --- Requests & data -------------------------------------------------------
  {
    path: '/dsar-queue',
    label: 'DSAR Requests',
    icon: Inbox,
    group: 'requests',
    // GET /dsar. The queue is shared: the handler works it, the dpo supervises
    // it, the data owner answers for their own project. What differs is what
    // the page shows once inside — the identity search and the import shortcut
    // are dataAdmin/super_admin only and the page withholds them itself.
    roles: ['dpo', 'dataOwner', 'dataAdmin', 'super_admin'],
  },
  {
    path: '/import',
    label: 'Import Data',
    icon: Upload,
    group: 'requests',
    // POST /imports
    roles: ['dataAdmin', 'super_admin'],
  },
  {
    path: '/discovery-workspace',
    label: 'Discovery Workspace',
    icon: SearchCode,
    group: 'requests',
    // GET|POST /handoffs
    roles: ['dataAdmin', 'super_admin'],
  },
  {
    path: '/data-lineage',
    label: 'Data Lineage',
    icon: Share2,
    group: 'requests',
    // GET /handoffs/lineage
    roles: ['dataAdmin', 'super_admin'],
  },
  {
    path: '/collection-sessions',
    label: 'Collection Sessions',
    icon: Camera,
    group: 'requests',
    // GET /projects/:id/sessions — the handler's window into where a principal's
    // media actually is. dataOwner reaches the same endpoint via Processed Data.
    roles: ['dataAdmin', 'super_admin'],
  },
  {
    path: '/purge-export',
    label: 'Purge / Export',
    icon: FileText,
    group: 'requests',
    // POST /dsar/:id/execute
    roles: ['dataAdmin', 'super_admin'],
  },
  {
    path: '/evidence-vault',
    label: 'Evidence Vault',
    icon: Lock,
    group: 'requests',
    // POST /dsar/:id/evidence — admits dataOwner, so they can file the proof for
    // their own system. A dpo reads evidence from the request workspace instead.
    roles: ['dataOwner', 'dataAdmin', 'super_admin'],
  },

  // --- Oversight -------------------------------------------------------------
  {
    path: '/sla-monitoring',
    label: 'SLA Monitoring',
    icon: Gauge,
    group: 'oversight',
    // GET /dsar/sla — excludes dataOwner.
    roles: ['dpo', 'dataAdmin', 'super_admin'],
  },
  {
    path: '/compliance-reports',
    label: 'Compliance Reports',
    icon: ClipboardList,
    group: 'oversight',
    // GET /audit/verify — excludes dataOwner, even though the compliance report
    // itself admits them; the page verifies the chain on mount.
    roles: ['dpo', 'dataAdmin', 'super_admin'],
  },
  {
    path: '/audit-logs',
    label: 'Audit Logs',
    icon: FileClock,
    group: 'oversight',
    // GET /audit
    roles: ['dpo', 'dataOwner', 'dataAdmin', 'super_admin'],
  },
  {
    path: '/queue-health',
    label: 'Queue Health',
    icon: Activity,
    group: 'oversight',
    // GET /ops/queue-health, POST /ops/requeue (dataAdmin/super_admin only —
    // the page hides the sweep button for the DPO).
    //
    // The DPO is admitted deliberately. "Is redaction actually running" is an
    // accountability question, and before this page the answer was unobtainable
    // by anyone: a session sat PROCESSING for two days and the product's own
    // counters reported zero outstanding work throughout.
    roles: ['dataAdmin', 'dpo', 'super_admin'],
  },
]

// Role metadata only. Navigation is derived — see navForRole.
export const ROLES = {
  dpo: {
    key: 'dpo',
    label: 'DPO / Legal Team',
    description: 'Approvals, consent governance, SLA and compliance',
    dashboardTitle: 'Governance Approval Inbox',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
  },
  dataOwner: {
    key: 'dataOwner',
    label: 'Data Team / Data Owner',
    description: 'Projects, requirements, collection progress and processed data',
    dashboardTitle: 'My Data Projects',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
  },
  collectionAgent: {
    key: 'collectionAgent',
    label: 'Data Collection Agent',
    description: 'Assigned sessions, subject verification, consent check and upload',
    dashboardTitle: 'Collection Assignments',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
  },
  dataAdmin: {
    key: 'dataAdmin',
    label: 'Data Team Admin',
    description: 'Request discovery, lineage, purge or export, evidence and audit',
    dashboardTitle: 'Request Operations Workspace',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
  },
  super_admin: {
    key: 'super_admin',
    label: 'Platform Administrator',
    description: 'Every workspace, platform health, break-glass and breach oversight',
    dashboardTitle: 'Platform Administration',
    subtitle: 'Full-platform workspace. Every other role’s screens are reachable from here.',
    accessNote: SUPER_ADMIN_ACCESS_NOTE,
  },
}

export const ROLE_ORDER = ['dpo', 'dataOwner', 'collectionAgent', 'dataAdmin', 'super_admin']

/** The sidebar entries for a role, in PAGES order. Unknown role → []. */
export function navForRole(roleKey) {
  if (!roleKey) return []
  return PAGES.filter((p) => p.roles.includes(roleKey))
}

/**
 * navForRole, split into ordered { key, label, items } sections. Sections with
 * no entries for this role disappear rather than rendering an empty heading.
 */
export function navSectionsForRole(roleKey) {
  const nav = navForRole(roleKey)
  return Object.entries(GROUPS)
    .map(([key, label]) => ({ key, label, items: nav.filter((p) => p.group === key) }))
    .filter((section) => section.items.length > 0)
}

/** The roles allowed on a path, for App.jsx's route generation. */
export function rolesForPath(path) {
  return PAGES.find((p) => p.path === path)?.roles ?? []
}

/** Where a role lands after sign-in when it has no explicit destination. */
export function landingPathForRole(roleKey) {
  return navForRole(roleKey)[0]?.path ?? '/dashboard'
}
