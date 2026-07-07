export const PROJECT_APPROVALS = [
  {
    id: 'proj-xr-2026',
    name: 'XR Research 2026',
    owner: 'Aditi Rao — Data Team',
    risk: 'high',
    submitted: '2026-06-30',
    status: 'pending',
  },
  {
    id: 'proj-camera-quality',
    name: 'Camera Quality Study',
    owner: 'Marcus Lee — Data Team',
    risk: 'medium',
    submitted: '2026-07-01',
    status: 'pending',
  },
  {
    id: 'proj-mobile-capture',
    name: 'Mobile Capture Program',
    owner: 'Priya Singh — Data Team',
    risk: 'medium',
    submitted: '2026-07-02',
    status: 'pending',
  },
  {
    id: 'proj-voice-assist',
    name: 'Voice Assistant Accuracy',
    owner: 'Daniel Cho — Data Team',
    risk: 'low',
    submitted: '2026-07-03',
    status: 'pending',
  },
  {
    id: 'proj-wearable-health',
    name: 'Wearable Health Signals',
    owner: 'Aditi Rao — Data Team',
    risk: 'high',
    submitted: '2026-07-04',
    status: 'pending',
  },
  {
    id: 'proj-retail-vision',
    name: 'Retail Vision Pilot',
    owner: 'Marcus Lee — Data Team',
    risk: 'low',
    submitted: '2026-07-05',
    status: 'pending',
  },
]

export const CONSENT_TEMPLATES = [
  {
    id: 'tmpl-xr-standard',
    name: 'XR Session — Standard Consent',
    locale: 'en-IN',
    version: 'v3',
    updated: '2026-05-12',
    linkedProjects: 4,
  },
  {
    id: 'tmpl-camera-photo',
    name: 'DSLR Photo Capture — Consent',
    locale: 'en-IN',
    version: 'v2',
    updated: '2026-04-20',
    linkedProjects: 2,
  },
  {
    id: 'tmpl-mobile-media',
    name: 'Mobile Media Upload — Consent',
    locale: 'en-IN, hi-IN',
    version: 'v1',
    updated: '2026-03-08',
    linkedProjects: 3,
  },
  {
    id: 'tmpl-voice-sample',
    name: 'Voice Sample Collection — Consent',
    locale: 'en-IN',
    version: 'v4',
    updated: '2026-06-01',
    linkedProjects: 1,
  },
]

export const REQUEST_OVERSIGHT = [
  {
    id: 'req-10001',
    subject: 'Request 10001',
    type: 'Erasure',
    locations: 9,
    slaDue: '2026-07-10',
    status: 'review',
  },
  {
    id: 'req-10000',
    subject: 'Request 10000',
    type: 'Access',
    locations: 4,
    slaDue: '2026-07-08',
    status: 'in_progress',
  },
  {
    id: 'req-09999',
    subject: 'Request 09999',
    type: 'Correction',
    locations: 2,
    slaDue: '2026-07-07',
    status: 'in_progress',
  },
  {
    id: 'req-09998',
    subject: 'Request 09998',
    type: 'Erasure',
    locations: 6,
    slaDue: '2026-07-06',
    status: 'overdue',
  },
]

export const SLA_METRICS = {
  compliance: 96.8,
  breachedThisMonth: 1,
  avgResolutionDays: 4.2,
  byType: [
    { label: 'Access requests', value: 98.5 },
    { label: 'Erasure requests', value: 94.1 },
    { label: 'Correction requests', value: 97.9 },
  ],
}

export const COMPLIANCE_REPORTS = [
  {
    id: 'rpt-2026-06',
    title: 'Monthly DPDP Compliance Summary — June 2026',
    generated: '2026-07-01',
    type: 'Monthly Summary',
  },
  {
    id: 'rpt-2026-q2',
    title: 'Quarterly Consent Audit — Q2 2026',
    generated: '2026-07-02',
    type: 'Quarterly Audit',
  },
  {
    id: 'rpt-2026-dsar-h1',
    title: 'DSAR Fulfillment Report — H1 2026',
    generated: '2026-07-03',
    type: 'DSAR Report',
  },
]
