-- Project export.
--
-- The requirement had two unbuilt halves and this is the first: there was no
-- project-wide export route and no button anywhere in the system. All 156 route
-- definitions were enumerated to confirm it — the project surface ended at
-- GET /:projectId/report, which returns 765 bytes of JSON counts.
--
-- A row rather than a synchronous response, because at the measured 241.3 KB
-- average image and 5,000 images/day, a project archive passes 4 GiB in three
-- and a half days of collection.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProjectExportStatus') THEN
    CREATE TYPE "ProjectExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "project_exports" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"             UUID NOT NULL,
  "requested_by_admin_id"  UUID NOT NULL,
  "status"                 "ProjectExportStatus" NOT NULL DEFAULT 'QUEUED',
  "scope"                  TEXT NOT NULL DEFAULT 'REDACTED_DERIVATIVES',
  "photos_total"           INTEGER NOT NULL DEFAULT 0,
  "photos_written"         INTEGER NOT NULL DEFAULT 0,
  "photos_excluded"        INTEGER NOT NULL DEFAULT 0,
  "subject_count"          INTEGER NOT NULL DEFAULT 0,
  "size_bytes"             BIGINT,
  "storage_path"           TEXT,
  "content_hash"           TEXT,
  "error"                  TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at"             TIMESTAMP(3),
  "finished_at"            TIMESTAMP(3),
  "expires_at"             TIMESTAMP(3),
  "download_count"         INTEGER NOT NULL DEFAULT 0,
  "last_downloaded_at"     TIMESTAMP(3)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_exports_project_id_fkey'
  ) THEN
    ALTER TABLE "project_exports"
      ADD CONSTRAINT "project_exports_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_exports_requested_by_admin_id_fkey'
  ) THEN
    -- RESTRICT, not CASCADE: the export record is the audit trail for personal
    -- data leaving the platform, and deleting the admin who took it out must not
    -- delete the evidence that it was taken out.
    ALTER TABLE "project_exports"
      ADD CONSTRAINT "project_exports_requested_by_admin_id_fkey"
      FOREIGN KEY ("requested_by_admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "project_exports_project_id_created_at_idx"
  ON "project_exports" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "project_exports_status_idx"
  ON "project_exports" ("status");
