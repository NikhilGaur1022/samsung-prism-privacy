-- The principal's own confirmation, recorded before anything is destroyed.
--
-- Until now an erasure ran the moment a data admin pressed Execute. That is
-- defensible for a §6(4) withdrawal, where the principal's act of withdrawing IS
-- the instruction — but not for a §12(3) erasure request, where the principal
-- asked for something irreversible and had never been shown what it covers.
--
-- The flow this column gates: the principal reviews a package of every frame they
-- appear in for that project, with every OTHER face redacted and their own left
-- visible, and only then presses Erase. Approval by a DPO is necessary and is no
-- longer sufficient.
--
-- Backfilled for requests already past the point of no return. A request that has
-- executed, closed or been rejected cannot be retro-confirmed by anyone, and
-- leaving it NULL would strand it: not executable, not closable.
ALTER TABLE "dsar_requests"
  ADD COLUMN IF NOT EXISTS "subject_confirmed_at" TIMESTAMP(3);

UPDATE "dsar_requests"
   SET "subject_confirmed_at" = COALESCE("closed_at", "updatedAt")
 WHERE "subject_confirmed_at" IS NULL
   AND ("status" IN ('EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED')
        -- A withdrawal is self-confirming: lib/revocation.js raises it because
        -- the principal withdrew consent, which is the instruction itself. Making
        -- them confirm a second time would deadlock every automatic withdrawal.
        OR "type" = 'WITHDRAWAL_ERASURE');
