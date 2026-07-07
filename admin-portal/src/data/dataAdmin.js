export const DSAR_QUEUE = [
  { id: 'req-10001', subject: 'Request 10001', type: 'Erasure', locations: 9, status: 'discovery' },
  { id: 'req-10000', subject: 'Request 10000', type: 'Access', locations: 4, status: 'ready' },
  { id: 'req-09999', subject: 'Request 09999', type: 'Correction', locations: 2, status: 'ready' },
  { id: 'req-09998', subject: 'Request 09998', type: 'Erasure', locations: 6, status: 'discovery' },
  { id: 'req-09997', subject: 'Request 09997', type: 'Access', locations: 3, status: 'closed' },
]

export const DISCOVERY_ITEMS = [
  {
    id: 'disc-10001-a',
    request: 'Request 10001',
    system: 'Media Storage — S3 (xr-sessions)',
    matchType: 'Subject ID match',
    records: 41,
  },
  {
    id: 'disc-10001-b',
    request: 'Request 10001',
    system: 'Postgres — consent_history',
    matchType: 'Email match',
    records: 6,
  },
  {
    id: 'disc-09998-a',
    request: 'Request 09998',
    system: 'Media Storage — S3 (dslr-photos)',
    matchType: 'Subject ID match',
    records: 18,
  },
]

export const LINEAGE_NODES = [
  { id: 'intake', label: 'Collection Agent Intake', kind: 'source' },
  { id: 'media', label: 'Media Storage (S3)', kind: 'store' },
  { id: 'postgres', label: 'Postgres — consent_history', kind: 'store' },
  { id: 'processed', label: 'Processed Data Warehouse', kind: 'derived' },
  { id: 'export', label: 'DSAR Export Bundle', kind: 'output' },
]

export const LINEAGE_EDGES = [
  ['intake', 'media'],
  ['intake', 'postgres'],
  ['media', 'processed'],
  ['postgres', 'processed'],
  ['processed', 'export'],
]

export const PURGE_JOBS = [
  {
    id: 'purge-10001',
    subject: 'Request 10001 — Erasure',
    scope: '9 locations',
    stage: 'soft_delete',
    scheduledHardDelete: '2026-07-21',
  },
  {
    id: 'purge-09998',
    subject: 'Request 09998 — Erasure',
    scope: '6 locations',
    stage: 'awaiting_confirmation',
    scheduledHardDelete: null,
  },
  {
    id: 'export-10000',
    subject: 'Request 10000 — Access Export',
    scope: '4 locations',
    stage: 'export_ready',
    scheduledHardDelete: null,
  },
]

export const EVIDENCE_ITEMS = [
  {
    id: 'ev-10001',
    title: 'Request 10001 — Deletion Confirmation Bundle',
    kind: 'Erasure evidence',
    sealed: '2026-07-05',
  },
  {
    id: 'ev-09999',
    title: 'Request 09999 — Correction Diff Log',
    kind: 'Correction evidence',
    sealed: '2026-07-04',
  },
  {
    id: 'ev-09997',
    title: 'Request 09997 — Access Export Manifest',
    kind: 'Access evidence',
    sealed: '2026-07-01',
  },
]

export const AUDIT_LOG = [
  {
    id: 'log-0001',
    actor: 'DPO — legal@prism.local',
    action: 'Approved project "Camera Quality Study"',
    time: '2026-07-05 14:22',
    hash: '8f3a1c…',
  },
  {
    id: 'log-0002',
    actor: 'Data Admin — ops@prism.local',
    action: 'Initiated purge for Request 10001',
    time: '2026-07-05 11:03',
    hash: 'e21bd4…',
  },
  {
    id: 'log-0003',
    actor: 'Collection Agent — field12@prism.local',
    action: 'Uploaded 24 assets to XR Research 2026',
    time: '2026-07-04 09:47',
    hash: 'a90f77…',
  },
  {
    id: 'log-0004',
    actor: 'System',
    action: 'Hard-deleted 6 assets past grace period (Request 09990)',
    time: '2026-07-03 02:00',
    hash: '1c4d90…',
  },
]
