// Front-end mirror of backend/src/lib/photoState.js.
//
// The backend's PiiStatus enum has five values and only two of them mean
// "redaction is finished with this frame". Counting the bad ones — which is what
// every screen here used to do — silently omits PENDING, the schema default and
// the state an un-run redaction leaves behind. Both admin screens therefore
// reported zero blocked frames on sessions that could not be handed off.
//
// Written as the inverse, so a new enum value shows up as blocked until someone
// deliberately declares it terminal.

export const TERMINAL_PII_STATUSES = ['CLEAN', 'MASKED']

/**
 * How many frames in a piiStatusCounts map are NOT finished.
 * @param {Record<string, number>|null|undefined} piiStatusCounts
 */
export function blockedFrameCount(piiStatusCounts) {
  if (!piiStatusCounts) return 0
  return Object.entries(piiStatusCounts)
    .filter(([status]) => !TERMINAL_PII_STATUSES.includes(status))
    .reduce((total, [, count]) => total + (count ?? 0), 0)
}
