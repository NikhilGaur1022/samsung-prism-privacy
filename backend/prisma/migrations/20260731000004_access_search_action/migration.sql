-- Phase 4 (item search & discovery API).
--
-- logAccess is fail-closed: recordAccess() throws 503 when the AccessEvent write
-- fails, and an enum value the database does not know is exactly such a failure.
-- Both new values therefore have to exist BEFORE the search endpoints ship, or
-- every item search 500s instead of degrading.
--
-- ALTER TYPE ... ADD VALUE is not transactional on PostgreSQL < 12 and cannot be
-- used in the same transaction that references the new value. Nothing here uses
-- either value, so a single migration is safe on 12+.

ALTER TYPE "AccessAction" ADD VALUE IF NOT EXISTS 'SEARCH';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'SUBJECT_DATA_ITEM';

-- Item search pages by (captured_at DESC NULLS LAST, id DESC) and filters by
-- origin/project. The Phase 1 indexes cover (subject_id, type, captured_at) and
-- (subject_id, deleted_at); this one covers the live-items keyset walk, which is
-- the hot path for a subject with thousands of items.
CREATE INDEX IF NOT EXISTS "subject_data_items_subject_id_deleted_at_captured_at_id_idx"
  ON "subject_data_items" ("subject_id", "deleted_at", "captured_at" DESC, "id" DESC);
