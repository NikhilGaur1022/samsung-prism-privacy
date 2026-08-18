-- AccessObjectType gains the two audio values.
--
-- GET /sessions/:id/recordings/:rid/redacted shipped with
-- logAccess('REDACTED_RECORDING', ...) against an enum that had no such value,
-- so every read threw at the AccessEvent insert. Because logAccess runs BEFORE
-- the blob is decrypted (invariant 6) the read failed closed rather than serving
-- unlogged audio — the right outcome for the wrong reason, and it would have
-- read as "audio playback is broken" rather than as a missing enum value.

ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'RECORDING';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'REDACTED_RECORDING';
