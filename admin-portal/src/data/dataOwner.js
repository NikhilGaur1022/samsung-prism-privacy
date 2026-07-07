export const MY_PROJECTS = [
  {
    id: 'proj-xr-2026',
    name: 'XR Research 2026',
    status: 'active',
    progress: 72,
    dataType: 'XR Sessions',
  },
  {
    id: 'proj-camera-quality',
    name: 'Camera Quality Study',
    status: 'active',
    progress: 91,
    dataType: 'DSLR Photos',
  },
  {
    id: 'proj-mobile-capture',
    name: 'Mobile Capture Program',
    status: 'processing',
    progress: 100,
    dataType: 'iPhone Media',
  },
  {
    id: 'proj-voice-assist',
    name: 'Voice Assistant Accuracy',
    status: 'pending_approval',
    progress: 0,
    dataType: 'Voice Samples',
  },
]

export const DATA_REQUIREMENTS = [
  {
    id: 'req-xr-fov',
    project: 'XR Research 2026',
    requirement: 'Minimum 90° field-of-view capture per session',
    status: 'met',
  },
  {
    id: 'req-xr-consent',
    project: 'XR Research 2026',
    requirement: 'Signed consent before every session start',
    status: 'met',
  },
  {
    id: 'req-camera-lighting',
    project: 'Camera Quality Study',
    requirement: 'Indoor and outdoor lighting conditions represented',
    status: 'at_risk',
  },
  {
    id: 'req-mobile-locale',
    project: 'Mobile Capture Program',
    requirement: 'Coverage across 5 regional locales',
    status: 'met',
  },
]

export const COLLECTION_PROGRESS = [
  { id: 'cp-xr', project: 'XR Research 2026', collected: 720, target: 1000 },
  { id: 'cp-camera', project: 'Camera Quality Study', collected: 910, target: 1000 },
  { id: 'cp-mobile', project: 'Mobile Capture Program', collected: 480, target: 480 },
]

export const PROCESSED_DATA = [
  {
    id: 'proc-xr',
    project: 'XR Research 2026',
    assets: '31.2K',
    lastProcessed: '2026-07-05',
    status: 'ready',
  },
  {
    id: 'proc-camera',
    project: 'Camera Quality Study',
    assets: '18.6K',
    lastProcessed: '2026-07-04',
    status: 'ready',
  },
  {
    id: 'proc-mobile',
    project: 'Mobile Capture Program',
    assets: '34.4K',
    lastProcessed: '2026-07-06',
    status: 'processing',
  },
]

export const PROJECT_REPORTS = [
  {
    id: 'rpt-xr-collection',
    title: 'XR Research 2026 — Collection Summary',
    generated: '2026-07-05',
  },
  {
    id: 'rpt-camera-quality',
    title: 'Camera Quality Study — QA Report',
    generated: '2026-07-04',
  },
  {
    id: 'rpt-mobile-progress',
    title: 'Mobile Capture Program — Progress Report',
    generated: '2026-07-06',
  },
]
