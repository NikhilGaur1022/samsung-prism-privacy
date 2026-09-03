-- Three access-object types that the code was already logging against and the
-- enum did not have.
--
-- This is the third time this exact failure has landed here — the RECORDING and
-- REDACTED_VIDEO comments in schema.prisma both describe it. A route logs an
-- AccessEvent with an objectType the enum does not contain, the insert throws,
-- and because invariant 6 writes the log BEFORE decrypting the blob, every read
-- of that route fails closed. Nothing leaks, which is why it survives review;
-- the route is simply, silently, always broken.
--
-- What each one is, and why it is not folded into an existing value:
--
--   DETECTED_VIDEO         the detection overlay — boxes and track labels over
--                          UNMASKED frames. The opposite claim to
--                          REDACTED_VIDEO, so a DPO auditing "who saw an
--                          unblurred face" must be able to filter it apart.
--   ERASURE_REVIEW_PHOTO   one frame of the package a principal reviews before
--                          confirming an erasure, with every other face blurred.
--   ERASURE_REVIEW_PACKAGE the same set downloaded as a ZIP.
--
-- The last two are reads by the data principal about themselves. That is still a
-- read of personal data and still belongs in the ledger — the ledger answers
-- "who looked at this", and "they did" is a legitimate answer, not an exemption.
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'DETECTED_VIDEO';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'ERASURE_REVIEW_PHOTO';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'ERASURE_REVIEW_PACKAGE';
