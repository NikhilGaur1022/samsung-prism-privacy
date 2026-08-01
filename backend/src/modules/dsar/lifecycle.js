// The coarse Open / In Progress / Closed view, in one place.
//
// The spec asks for three states. The system has seven, and they are not
// negotiable: the deletion certificate, the SLA board, the transition table and
// every existing test are written against `DsarStatus`. Collapsing them would
// mean rewriting the parts of this system that carry legal weight in order to
// simplify a label.
//
// So the three states are a PROJECTION, defined here and nowhere else. Both
// portals import from this module; a second copy of the mapping in a React file
// is how the dashboard and the API start disagreeing about whether a request is
// finished.

export const COARSE = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  CLOSED: 'CLOSED',
}

export const STATUSES_BY_COARSE = {
  [COARSE.OPEN]: ['RECEIVED', 'TRIAGE'],
  [COARSE.IN_PROGRESS]: ['DISCOVERY', 'EXECUTING', 'REVIEW'],
  [COARSE.CLOSED]: ['CLOSED', 'REJECTED'],
}

const COARSE_BY_STATUS = Object.fromEntries(
  Object.entries(STATUSES_BY_COARSE).flatMap(([coarse, statuses]) =>
    statuses.map((status) => [status, coarse]),
  ),
)

/**
 * @param {string} status a DsarStatus value
 * @returns {'OPEN'|'IN_PROGRESS'|'CLOSED'} never undefined — an unmapped status
 *   is a bug, and reporting it as OPEN keeps it visible in the queue instead of
 *   dropping the request out of every tab.
 */
export function coarseStatus(status) {
  return COARSE_BY_STATUS[status] ?? COARSE.OPEN
}

/** Expands a coarse tab back into the statuses it filters on. */
export function statusesFor(coarse) {
  return STATUSES_BY_COARSE[coarse] ?? null
}

export const COARSE_LABELS = {
  [COARSE.OPEN]: 'Open',
  [COARSE.IN_PROGRESS]: 'In Progress',
  [COARSE.CLOSED]: 'Closed',
}
