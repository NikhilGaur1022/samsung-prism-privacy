-- Repairs schema drift left by a `prisma db push` run from an INTROSPECTED
-- schema. Introspection reproduces a database's shape, not its model's
-- intent: a column whose NOT NULL and DEFAULT were declared in schema.prisma
-- comes back as a bare nullable column, and pushing that back drops the
-- constraint. Four things were lost this way and each is restored below.
--
-- Written defensively (backfill before SET NOT NULL, guards on catalog
-- lookups) because it runs against a database that already diverged once.

-- 1. recordings.{sha256,mime_type,size_bytes}
--
-- These are the integrity columns a deletion certificate attests to: a
-- recording that cannot be hashed before destruction cannot be certified as
-- destroyed. Their loss also broke reads outright — Prisma types them
-- non-nullable, so `recording.findMany()` threw on every row holding a NULL,
-- which took DSAR discovery down with it.
--
-- The backfill uses the model defaults. An empty sha256 is the same "not yet
-- hashed" state a freshly inserted row carries, so this asserts nothing false
-- about bytes nobody has read.
UPDATE "recordings" SET "sha256"     = ''           WHERE "sha256"     IS NULL;
UPDATE "recordings" SET "mime_type"  = 'audio/wav'  WHERE "mime_type"  IS NULL;
UPDATE "recordings" SET "size_bytes" = 0            WHERE "size_bytes" IS NULL;

ALTER TABLE "recordings"
  ALTER COLUMN "sha256"     SET DEFAULT '',
  ALTER COLUMN "sha256"     SET NOT NULL,
  ALTER COLUMN "mime_type"  SET DEFAULT 'audio/wav',
  ALTER COLUMN "mime_type"  SET NOT NULL,
  ALTER COLUMN "size_bytes" SET DEFAULT 0,
  ALTER COLUMN "size_bytes" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "recordings_status_idx" ON "recordings"("status");

-- 2. face_clusters.video_track_count
ALTER TABLE "face_clusters" ALTER COLUMN "video_track_count" SET NOT NULL;

-- 3. audio_segments.subject_id -> data_subjects.master_user_id
--
-- The most consequential of the four. AudioSegment.subjectId is the erasure
-- key for a voice attribution, and the FK is what makes a subject cascade
-- reach it. Without the constraint an erasure could delete the subject and
-- leave the attributions behind — orphaned rows saying a person was audible,
-- keyed to an id that no longer resolves.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audio_segments_subject_id_fkey'
  ) THEN
    DELETE FROM "audio_segments" s
     WHERE s."subject_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "data_subjects" d WHERE d."master_user_id" = s."subject_id"
       );
    ALTER TABLE "audio_segments"
      ADD CONSTRAINT "audio_segments_subject_id_fkey"
      FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. DataItemType: drop the stray 'TEXT' value.
--
-- It arrived with the push and has no counterpart in schema.prisma, which is
-- deliberate. A DataItemType value is a claim that the class is erasable, and
-- text documents have no purge handler yet (discovery emits L18/L19, purge
-- dispatches on neither). Leaving the label in the database would let a later
-- change start writing TEXT items that no erasure would ever reach — the
-- precise failure the AUDIO and VIDEO comments in schema.prisma exist to
-- prevent. Remove it now; re-add it in the change that ships its purge path.
--
-- Guarded on the value existing AND on nothing using it, so this is a no-op on
-- a database built from migrations rather than from the push.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'DataItemType' AND e.enumlabel = 'TEXT'
  ) AND NOT EXISTS (SELECT 1 FROM "subject_data_items" WHERE "type"::text = 'TEXT')
    AND NOT EXISTS (SELECT 1 FROM "import_batches"     WHERE "type"::text = 'TEXT')
  THEN
    CREATE TYPE "DataItemType_new" AS ENUM ('PHOTO', 'AUDIO', 'VIDEO');
    ALTER TABLE "import_batches"     ALTER COLUMN "type" DROP DEFAULT;
    ALTER TABLE "subject_data_items" ALTER COLUMN "type" TYPE "DataItemType_new" USING ("type"::text::"DataItemType_new");
    ALTER TABLE "import_batches"     ALTER COLUMN "type" TYPE "DataItemType_new" USING ("type"::text::"DataItemType_new");
    ALTER TYPE "DataItemType" RENAME TO "DataItemType_old";
    ALTER TYPE "DataItemType_new" RENAME TO "DataItemType";
    DROP TYPE "DataItemType_old";
    ALTER TABLE "import_batches" ALTER COLUMN "type" SET DEFAULT 'PHOTO';
  END IF;
END $$;
