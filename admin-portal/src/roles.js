import {
  FolderCheck,
  FileText,
  ShieldAlert,
  Gauge,
  ClipboardList,
  FolderKanban,
  FilePlus,
  Activity,
  Database,
  FileBarChart,
  ListChecks,
  PlayCircle,
  UserCheck,
  ShieldCheck,
  Camera,
  UploadCloud,
  Inbox,
  SearchCode,
  Share2,
  Lock,
  FileClock,
} from 'lucide-react'

const WORKSPACE_SUBTITLE =
  'Role-specific workspace based on the platform flow and assigned responsibilities.'

const ACCESS_NOTE =
  'This portal shows only the projects, records, actions, and reports required for this administrator role. Other administrative functions remain hidden.'

export const ROLES = {
  dpo: {
    key: 'dpo',
    label: 'DPO / Legal Team',
    description: 'Approvals, consent governance, SLA and compliance',
    dashboardTitle: 'Governance Approval Inbox',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
    nav: [
      { label: 'Project Approvals', icon: FolderCheck, path: '/project-approvals' },
      { label: 'Consent Templates', icon: FileText, path: '/consent-templates' },
      { label: 'Request Oversight', icon: ShieldAlert, path: '/request-oversight' },
      { label: 'SLA Monitoring', icon: Gauge, path: '/sla-monitoring' },
      { label: 'Compliance Reports', icon: ClipboardList, path: '/compliance-reports' },
    ],
    stats: [
      { label: 'Pending Projects', value: '6' },
      { label: 'Requests Awaiting Approval', value: '4' },
      { label: 'SLA Compliance', value: '96.8%' },
    ],
    queue: [
      { title: 'XR Research 2026 — High Risk — Review' },
      { title: 'Camera Quality Study — Medium Risk — Approve' },
      { title: 'Request 10001 — Resolution Evidence — Review' },
    ],
  },
  dataOwner: {
    key: 'dataOwner',
    label: 'Data Team / Data Owner',
    description: 'Projects, requirements, collection progress and processed data',
    dashboardTitle: 'My Data Projects',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
    nav: [
      { label: 'My Projects', icon: FolderKanban, path: '/my-projects' },
      { label: 'Create Project', icon: FilePlus, path: '/create-project' },
      { label: 'Data Requirements', icon: ClipboardList, path: '/data-requirements' },
      { label: 'Collection Progress', icon: Activity, path: '/collection-progress' },
      { label: 'Processed Data', icon: Database, path: '/processed-data' },
      { label: 'Project Reports', icon: FileBarChart, path: '/project-reports' },
    ],
    stats: [
      { label: 'My Projects', value: '12' },
      { label: 'Awaiting Approval', value: '3' },
      { label: 'Processed Assets', value: '84.2K' },
    ],
    queue: [
      { title: 'XR Research 2026 — XR Sessions — 72% Collected' },
      { title: 'Camera Quality Study — DSLR Photos — 91% Collected' },
      { title: 'Mobile Capture Program — iPhone Media — Processing' },
    ],
  },
  collectionAgent: {
    key: 'collectionAgent',
    label: 'Data Collection Agent',
    description: 'Assigned sessions, subject verification, consent check and upload',
    dashboardTitle: 'Collection Assignments',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
    nav: [
      { label: 'Assignments', icon: ListChecks, path: '/assignments' },
      { label: 'New Session', icon: PlayCircle, path: '/new-session' },
      { label: 'Subject Verification', icon: UserCheck, path: '/subject-verification' },
      { label: 'Consent Check', icon: ShieldCheck, path: '/consent-check' },
      { label: 'Capture & Upload', icon: Camera, path: '/capture-upload' },
      { label: 'Upload Queue', icon: UploadCloud, path: '/upload-queue' },
    ],
    stats: [
      { label: 'Assigned Today', value: '14' },
      { label: 'Ready to Collect', value: '8' },
      { label: 'Uploading', value: '3' },
    ],
    queue: [
      { title: 'COL-2048 — XR Session — Ready' },
      { title: 'COL-2047 — DSLR Photos — Uploading' },
      { title: 'COL-2046 — iPhone Media — Consent Check' },
    ],
  },
  dataAdmin: {
    key: 'dataAdmin',
    label: 'Data Team Admin',
    description: 'Request discovery, lineage, purge or export, evidence and audit',
    dashboardTitle: 'Request Operations Workspace',
    subtitle: WORKSPACE_SUBTITLE,
    accessNote: ACCESS_NOTE,
    nav: [
      { label: 'DSAR Queue', icon: Inbox, path: '/dsar-queue' },
      { label: 'Discovery Workspace', icon: SearchCode, path: '/discovery-workspace' },
      { label: 'Data Lineage', icon: Share2, path: '/data-lineage' },
      { label: 'Purge / Export', icon: FileText, path: '/purge-export' },
      { label: 'Evidence Vault', icon: Lock, path: '/evidence-vault' },
      { label: 'Audit Logs', icon: FileClock, path: '/audit-logs' },
    ],
    stats: [
      { label: 'Open Requests', value: '18' },
      { label: 'In Discovery', value: '7' },
      { label: 'Actions Queued', value: '23' },
    ],
    queue: [
      { title: 'Request 10001 — Erasure — 9 Locations' },
      { title: 'Request 10000 — Access — 4 Locations' },
      { title: 'Request 09999 — Correction — 2 Locations' },
    ],
  },
}

export const ROLE_ORDER = ['dpo', 'dataOwner', 'collectionAgent', 'dataAdmin']
