-- Audio becomes a first-class, erasable data class.
--
-- The tables shipped in 20260801112831 were a working prototype: PascalCase
-- names (every other table in this schema is snake_case and @@map'd), free-text
-- status/action columns where the rest of the schema uses enums, no integrity
-- columns, no encKeyId, and — the one that matters — no foreign key from a
-- segment to the subject it names.
--
-- That last omission is why a recording was invisible to a DSAR erasure: with no
-- FK and no entry in DataItemType, nothing in discovery.service.js could reach
-- it, so an erasure completed and signed a certificate while the voice data
-- survived. This migration makes the audio tables shaped like `photos` /
-- `photo_subjects`, which is what the discovery walk already knows how to read.
--
-- Renames rather than drop/create: there is live analysis data in these tables
-- and renaming carries the grants prism_app already holds.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "RecordingStatus" AS ENUM ('PENDING_ANALYSIS', 'ANALYZED', 'REDACTED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AudioSegmentAction" AS ENUM ('KEEP', 'REDACT_VOICE', 'REDACT_PII');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AUDIO joins PHOTO in the item-index vocabulary. ADD VALUE cannot run inside a
-- transaction block on PG < 12; IF NOT EXISTS makes a re-run safe.
ALTER TYPE "DataItemType" ADD VALUE IF NOT EXISTS 'AUDIO';

-- ---------------------------------------------------------------------------
-- 2. recordings
-- ---------------------------------------------------------------------------
ALTER TABLE "Recording" RENAME TO "recordings";
ALTER TABLE "recordings" RENAME CONSTRAINT "Recording_pkey" TO "recordings_pkey";
ALTER TABLE "recordings" RENAME CONSTRAINT "Recording_sessionId_fkey" TO "recordings_session_id_fkey";

ALTER TABLE "recordings" RENAME COLUMN "sessionId"    TO "session_id";
ALTER TABLE "recordings" RENAME COLUMN "storagePath"  TO "storage_path";
ALTER TABLE "recordings" RENAME COLUMN "redactedPath" TO "redacted_path";
ALTER TABLE "recordings" RENAME COLUMN "createdAt"    TO "created_at";

-- Anything that is not one of the four known states is DEFERRED, not ANALYZED.
-- Fail-closed on an unrecognised value: guessing "clean" here would publish an
-- unredacted recording.
UPDATE "recordings"
   SET "status" = 'DEFERRED'
 WHERE "status" IS NULL
    OR "status" NOT IN ('PENDING_ANALYSIS', 'ANALYZED', 'REDACTED', 'DEFERRED');

ALTER TABLE "recordings"
  ALTER COLUMN "status" TYPE "RecordingStatus" USING "status"::"RecordingStatus",
  ALTER COLUMN "status" SET DEFAULT 'PENDING_ANALYSIS';

ALTER TABLE "recordings"
  ADD COLUMN IF NOT EXISTS "mime_type"    TEXT NOT NULL DEFAULT 'audio/wav',
  ADD COLUMN IF NOT EXISTS "sha256"       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "size_bytes"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "duration_sec" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "enc_key_id"   TEXT;

CREATE INDEX IF NOT EXISTS "recordings_session_id_idx" ON "recordings" ("session_id");
CREATE INDEX IF NOT EXISTS "recordings_status_idx"     ON "recordings" ("status");

-- ---------------------------------------------------------------------------
-- 3. audio_segments
-- ---------------------------------------------------------------------------
ALTER TABLE "AudioSegment" RENAME TO "audio_segments";
ALTER TABLE "audio_segments" RENAME CONSTRAINT "AudioSegment_pkey" TO "audio_segments_pkey";
ALTER TABLE "audio_segments" RENAME CONSTRAINT "AudioSegment_recordingId_fkey" TO "audio_segments_recording_id_fkey";

ALTER TABLE "audio_segments" RENAME COLUMN "recordingId" TO "recording_id";
ALTER TABLE "audio_segments" RENAME COLUMN "speakerId"   TO "speaker_id";
ALTER TABLE "audio_segments" RENAME COLUMN "subjectId"   TO "subject_id";
ALTER TABLE "audio_segments" RENAME COLUMN "startSec"    TO "start_sec";
ALTER TABLE "audio_segments" RENAME COLUMN "endSec"      TO "end_sec";
ALTER TABLE "audio_segments" RENAME COLUMN "matchScore"  TO "match_score";

UPDATE "audio_segments"
   SET "action" = 'REDACT_VOICE'
 WHERE "action" IS NULL
    OR "action" NOT IN ('KEEP', 'REDACT_VOICE', 'REDACT_PII');

ALTER TABLE "audio_segments"
  ALTER COLUMN "action" TYPE "AudioSegmentAction" USING "action"::"AudioSegmentAction";

ALTER TABLE "audio_segments"
  ADD COLUMN IF NOT EXISTS "consent_id" UUID;

-- The prototype had no FK, so a segment could name a subject that does not
-- exist. Clear those before adding the constraint rather than failing the
-- migration on prototype rows.
UPDATE "audio_segments" s
   SET "subject_id" = NULL
 WHERE s."subject_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "data_subjects" d WHERE d."master_user_id" = s."subject_id"
   );

ALTER TABLE "audio_segments"
  ADD CONSTRAINT "audio_segments_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audio_segments"
  ADD CONSTRAINT "audio_segments_consent_id_fkey"
  FOREIGN KEY ("consent_id") REFERENCES "project_consent_matrix"("consentId")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "audio_segments_recording_id_idx" ON "audio_segments" ("recording_id");
-- The DSAR discovery probe: every recording this person is audible in.
CREATE INDEX IF NOT EXISTS "audio_segments_subject_id_idx"   ON "audio_segments" ("subject_id");
CREATE INDEX IF NOT EXISTS "audio_segments_consent_id_idx"   ON "audio_segments" ("consent_id");
