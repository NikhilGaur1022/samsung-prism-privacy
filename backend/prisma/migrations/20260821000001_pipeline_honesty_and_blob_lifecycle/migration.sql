-- Phase 2 (pipeline honesty) and Phase 3 (erasure completeness) schema.
--
-- Three additions, each closing a finding that has a reproduction against the
-- running system:
--
--   1. SessionStatus.REDACTING — finalizeSession committed `ARCHIVED` and created
--      the handoff row inside a transaction, then called redactBystanders()
--      AFTER the commit. A failure there left a session archived, handed off,
--      and holding unredacted originals. Observed: COL-2225, ARCHIVED, ended
--      2026-08-18, sixteen photos still PENDING.
--
--   2. orphan_blobs — 1,123 of 1,353 files under the media root were referenced
--      by no row (265 MB, including 383 cropped faces and 135 enrolment
--      selfies). Discovery and purge both enumerate blobs by walking rows, so
--      every one of them was invisible to erasure while a signed deletion
--      certificate said otherwise.
--
--   3. stalled_jobs — there was no reaper, no surfaced stalled-job timeout, and
--      no screen showing either. COL-7224 sat PROCESSING for two days.
--
-- Every statement is guarded on existence. This database has already diverged
-- once from a `db push` against an introspected schema (see
-- 20260820000001_repair_push_drift), so a migration that assumes a clean slate
-- is a migration that fails halfway.

-- 1. -----------------------------------------------------------------------
-- ADD VALUE cannot run inside a transaction block on Postgres < 12, and Prisma
-- wraps migrations in one. IF NOT EXISTS makes the statement idempotent, which
-- is what allows the re-run after a partial apply.
ALTER TYPE "SessionStatus" ADD VALUE IF NOT EXISTS 'REDACTING' BEFORE 'ARCHIVED';

-- 2. -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrphanBlobState') THEN
    CREATE TYPE "OrphanBlobState" AS ENUM ('PENDING_DELETE', 'QUARANTINED', 'DELETED', 'RETAINED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "orphan_blobs" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storage_path"        TEXT NOT NULL,
  "size_bytes"          BIGINT,
  "reason"              TEXT NOT NULL,
  "state"               "OrphanBlobState" NOT NULL DEFAULT 'PENDING_DELETE',
  "quarantine_path"     TEXT,
  "first_seen_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "quarantined_at"      TIMESTAMP(3),
  "resolved_at"         TIMESTAMP(3),
  "decided_by_admin_id" UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS "orphan_blobs_storage_path_key" ON "orphan_blobs" ("storage_path");
CREATE INDEX IF NOT EXISTS "orphan_blobs_state_first_seen_at_idx" ON "orphan_blobs" ("state", "first_seen_at");

-- 3. -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StalledJobState') THEN
    CREATE TYPE "StalledJobState" AS ENUM ('DETECTED', 'REQUEUED', 'FAILED_PERMANENTLY', 'RESOLVED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "stalled_jobs" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "queue_name"     TEXT NOT NULL,
  "job_id"         TEXT NOT NULL,
  "subject_ref"    TEXT,
  "state"          "StalledJobState" NOT NULL DEFAULT 'DETECTED',
  "stalled_for_ms" BIGINT,
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "last_error"     TEXT,
  "detected_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at"    TIMESTAMP(3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "stalled_jobs_queue_name_job_id_key" ON "stalled_jobs" ("queue_name", "job_id");
CREATE INDEX IF NOT EXISTS "stalled_jobs_state_detected_at_idx" ON "stalled_jobs" ("state", "detected_at");

-- The append-only ledger tables are RLS-forced; these two are operational and
-- deliberately are not. They record what the system did to ITS OWN storage, not
-- what a principal did to personal data, and an operator has to be able to mark
-- an orphan RETAINED.
