import { createHmac } from 'node:crypto'

const HMAC_SECRET = process.env.AUDIT_HMAC_SECRET ?? 'dev-only-secret-change-in-prod'

// Binds the consent record to who signed it, for what, and under which policy
// version — so a later policy change can't be passed off as covered by an older
// signature. Consent is project-wide and all-or-nothing (no per-tier toggles).
export function signConsent({ subjectId, projectId, policyVersion, signedAt }) {
  const canonical = [subjectId, projectId, policyVersion, signedAt.toISOString()].join('|')
  return createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex')
}

export const CONSENT_VERDICT = {
  ELIGIBLE: 'ELIGIBLE',
  NO_CONSENT: 'NO_CONSENT',
  REVOKED: 'REVOKED',
  SUBJECT_INACTIVE: 'SUBJECT_INACTIVE',
}

// Single place the "can this person be captured on this project?" question is
// answered. Called on roster-add, again on end-session, and again on finalize —
// a revoke mid-session must retroactively drop the person and their photos.
export function consentVerdict(subject, consent) {
  if (subject.status !== 'ACTIVE') return CONSENT_VERDICT.SUBJECT_INACTIVE
  if (!consent) return CONSENT_VERDICT.NO_CONSENT
  if (consent.status !== 'ACTIVE') return CONSENT_VERDICT.REVOKED
  return CONSENT_VERDICT.ELIGIBLE
}

export function isEligible(verdict) {
  return verdict === CONSENT_VERDICT.ELIGIBLE
}
