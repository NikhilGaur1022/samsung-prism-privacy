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
  Inbox,
  SearchCode,
  Share2,
  Lock,
  FileClock,
  Upload,
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
      { label: 'Sessions', icon: Camera, path: '/sessions' },
      { label: 'Subject Verification', icon: UserCheck, path: '/subject-verification' },
      { label: 'Consent Check', icon: ShieldCheck, path: '/consent-check' },
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
      { label: 'DSAR Dashboard', icon: Inbox, path: '/dsar-queue' },
      { label: 'Import Data', icon: Upload, path: '/import' },
      { label: 'Collection Sessions', icon: Camera, path: '/collection-sessions' },
      { label: 'Discovery Workspace', icon: SearchCode, path: '/discovery-workspace' },
      { label: 'Data Lineage', icon: Share2, path: '/data-lineage' },
      { label: 'Purge / Export', icon: FileText, path: '/purge-export' },
      { label: 'Evidence Vault', icon: Lock, path: '/evidence-vault' },
      { label: 'Audit Logs', icon: FileClock, path: '/audit-logs' },
    ],
  },
}

export const ROLE_ORDER = ['dpo', 'dataOwner', 'collectionAgent', 'dataAdmin']
