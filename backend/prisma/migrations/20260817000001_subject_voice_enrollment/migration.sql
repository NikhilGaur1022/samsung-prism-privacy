-- SubjectVoiceEnrollment: a persisted, crypto-shreddable voice print.
--
-- Until now there was no persisted voice enrollment at all. Reference clips were
-- attached as multipart `voice_snippets` at analyze time and re-embedded by the
-- worker on every call, so speaker identity depended on whoever attached the
-- right WAVs to that one request, nothing was reusable across sessions, and
-- there was no row to erase — a voice print held with no erasure path.
--
-- Shaped as subject_face_enrollments is, because a voice print is §2 sensitive
-- personal data on the same footing as a face embedding: the clip and its vector
-- are both persisted, the vector is sealed under the per-subject DEK so
-- destroySubjectKey() crypto-shreds it, and delete is soft so the tombstone
-- survives for the audit chain while the biometric does not.
--
-- embedding_dim is 192 (SpeechBrain ECAPA-TDNN spkrec-ecapa-voxceleb), not the
-- 512 of buffalo_l. Nullable, meaning "legacy row, re-derive from the clip".

CREATE TABLE "subject_voice_enrollments" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "audio_path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'audio/wav',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "duration_sec" DOUBLE PRECISION,
    "source" "EnrollmentSource" NOT NULL,
    "capturedBy" UUID,
    "embedding" BYTEA,
    "embedding_dim" INTEGER,
    "enc_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "subject_voice_enrollments_pkey" PRIMARY KEY ("id")
);

-- Content de-duplication per subject: a retried upload must not create a second
-- row pointing at identical bytes, the same rule Recording and Photo follow.
CREATE UNIQUE INDEX "subject_voice_enrollments_subject_id_sha256_key"
    ON "subject_voice_enrollments"("subject_id", "sha256");

-- The gallery build's access pattern: every live enrollment for a subject.
CREATE INDEX "subject_voice_enrollments_subject_id_deleted_at_idx"
    ON "subject_voice_enrollments"("subject_id", "deleted_at");

ALTER TABLE "subject_voice_enrollments"
    ADD CONSTRAINT "subject_voice_enrollments_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- prism_app grants
-- ---------------------------------------------------------------------------
-- 20260728000001 ran ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM
-- prism_app, so a table created after it inherits NOTHING. Without this block
-- the app connects successfully and then fails permission-denied on the first
-- enrollment — at runtime, not at deploy time, which is the expensive way to
-- find out. subject_face_enrollments only avoids needing its own block because
-- it predates that revoke.
--
-- Guarded on the role existing so the migration still applies on a plain
-- Postgres where prism_app was never provisioned, matching every other grant
-- block in this directory. TRUNCATE is revoked: nothing in the app has any
-- business emptying a biometric table wholesale.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_voice_enrollments" TO prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "subject_voice_enrollments" FROM prism_app';
  END IF;
END $$;
