export const ASSIGNMENTS = [
  {
    id: 'col-2048',
    code: 'COL-2048',
    project: 'XR Research 2026',
    dataType: 'XR Session',
    location: 'Bengaluru Studio B',
    status: 'ready',
  },
  {
    id: 'col-2047',
    code: 'COL-2047',
    project: 'Camera Quality Study',
    dataType: 'DSLR Photos',
    location: 'Mumbai Field Site',
    status: 'uploading',
  },
  {
    id: 'col-2046',
    code: 'COL-2046',
    project: 'Mobile Capture Program',
    dataType: 'iPhone Media',
    location: 'Remote — Subject Home',
    status: 'consent_check',
  },
  {
    id: 'col-2045',
    code: 'COL-2045',
    project: 'XR Research 2026',
    dataType: 'XR Session',
    location: 'Bengaluru Studio A',
    status: 'ready',
  },
]

export const SUBJECTS = [
  { id: 'subj-1001', name: 'A. Sharma', code: 'SUBJ-1001', verified: true },
  { id: 'subj-1002', name: 'R. Fernandes', code: 'SUBJ-1002', verified: true },
  { id: 'subj-1003', name: 'K. Iyer', code: 'SUBJ-1003', verified: false },
  { id: 'subj-1004', name: 'M. Chen', code: 'SUBJ-1004', verified: false },
]

export const CONSENT_CHECKS = [
  {
    id: 'cc-2046',
    session: 'COL-2046 — Mobile Capture Program',
    subject: 'M. Chen',
    templateVersion: 'Mobile Media Upload — Consent v1',
    signed: false,
  },
  {
    id: 'cc-2048',
    session: 'COL-2048 — XR Research 2026',
    subject: 'A. Sharma',
    templateVersion: 'XR Session — Standard Consent v3',
    signed: true,
  },
]

export const UPLOAD_QUEUE = [
  { id: 'up-2047-1', session: 'COL-2047', file: 'IMG_0231.RAW', sizeMb: 42, progress: 100 },
  { id: 'up-2047-2', session: 'COL-2047', file: 'IMG_0232.RAW', sizeMb: 41, progress: 63 },
  { id: 'up-2047-3', session: 'COL-2047', file: 'IMG_0233.RAW', sizeMb: 44, progress: 0 },
  { id: 'up-2046-1', session: 'COL-2046', file: 'session_clip.mov', sizeMb: 210, progress: 12 },
]
