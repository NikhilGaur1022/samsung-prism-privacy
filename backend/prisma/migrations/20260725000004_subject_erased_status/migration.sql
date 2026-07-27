-- WAVE 3 — terminal status for an erased data principal.
--
-- A DSAR erasure anonymises the Subject row rather than deleting it: the row
-- anchors the ProjectConsent records that prove the original collection was
-- lawful, and the DSAR request itself. Reusing INACTIVE for this would make an
-- erased principal indistinguishable from a dormant one, and something would
-- eventually try to reactivate them.
ALTER TYPE "SubjectStatus" ADD VALUE 'ERASED';
