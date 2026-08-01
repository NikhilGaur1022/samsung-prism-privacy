// Labels for the coarse Open / In Progress / Closed view.
//
// Deliberately labels ONLY. The mapping from the seven-state `DsarStatus` to
// these three lives in `backend/src/modules/dsar/lifecycle.js` and every request
// the API returns already carries a `coarseStatus` field computed there. A copy
// of the mapping here is how the dashboard and the API start disagreeing about
// whether a request is finished — so this file must never grow one.

export const COARSE_TABS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'CLOSED', label: 'Closed' },
]

export const COARSE_LABELS = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  CLOSED: 'Closed',
}

export const COARSE_TONES = {
  OPEN: 'neutral',
  IN_PROGRESS: 'warning',
  CLOSED: 'success',
}

export const STATUS_TONE = {
  RECEIVED: 'neutral',
  TRIAGE: 'neutral',
  DISCOVERY: 'warning',
  EXECUTING: 'warning',
  REVIEW: 'brand',
  CLOSED: 'success',
  REJECTED: 'danger',
}
