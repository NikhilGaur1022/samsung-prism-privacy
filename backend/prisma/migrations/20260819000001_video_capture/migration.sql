-- Video becomes a first-class, erasable data class.
--
-- Shaped like `recordings`/`audio_segments`, which are shaped like `photos`/
-- `photo_subjects`, because that is the shape discovery.service.js and
-- purge.service.js already know how to walk. The capture path and the erasure
-- path land in this one migration for the reason DataItemType documents: a class
-- that can be collected but not erased makes a signed deletion certificate a
-- false statement.
--
-- Video is deliberately NOT modelled as many `photos` rows. A 2-minute 30fps
-- clip would be ~3,600 of them, and the DSAR item grid would then tell a Data
-- Principal we hold three thousand photographs of them. That is false in exactly
-- the way this platform cannot afford.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "VideoStatus" AS ENUM ('PENDING_ANALYSIS', 'ANALYZED', 'REDACTED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- VIDEO joins PHOTO and AUDIO in the item-index vocabulary. Safe inside this
-- transaction because nothing below USES the new value — Postgres only forbids
-- reading a value added in the same transaction that adds it.
ALTER TYPE "DataItemType" ADD VALUE IF NOT EXISTS 'VIDEO';

-- ---------------------------------------------------------------------------
-- 2. video_assets  (L16 original / L17 redacted derivative)
-- ---------------------------------------------------------------------------
CREATE TABLE "video_assets" (
    "id" UUID NOT NULL,
    -- Nullable for the same reason photos.session_id is: an imported clip had no
    -- capture event, so there is no session, agent or project to hang one on.
    "session_id" UUID,
    "storage_path" TEXT NOT NULL,
    "redacted_path" TEXT,
    "mime_type" TEXT NOT NULL DEFAULT 'video/mp4',
    "sha256" TEXT NOT NULL DEFAULT '',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "duration_sec" DOUBLE PRECISION,
    "fps" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "frame_count" INTEGER DEFAULT 0,
    "status" "VideoStatus" NOT NULL DEFAULT 'PENDING_ANALYSIS',
    -- Separate from `status` for the same reason photos carries both a
    -- redacted_path and a pii_status: "faces handled" and "printed text handled"
    -- are different claims, and an outage in the PII detector must never be
    -- recorded as a clean clip.
    "pii_status" "PiiStatus" NOT NULL DEFAULT 'PENDING',
    "enc_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_assets_pkey" PRIMARY KEY ("id")
);

-- Content de-duplication within a session: a retried upload must not create a
-- second row over identical bytes, or the DSAR item grid double-counts what we
-- hold. Same rule photos and recordings follow.
CREATE UNIQUE INDEX "video_assets_session_id_sha256_key"
    ON "video_assets"("session_id", "sha256");
CREATE INDEX "video_assets_session_id_idx" ON "video_assets"("session_id");
CREATE INDEX "video_assets_status_idx"     ON "video_assets"("status");

ALTER TABLE "video_assets"
    ADD CONSTRAINT "video_assets_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. video_face_tracks  (temporal analogue of face_detections)
-- ---------------------------------------------------------------------------
-- No embedding column, deliberately, exactly as face_detections has none. The
-- worker returns one averaged vector per track, the recognition pass clusters
-- and matches with it in memory, and drops it. Only boxes, the crop and the
-- eventual subject link survive.
CREATE TABLE "video_face_tracks" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    -- Points at the SAME face_clusters row a photo face would, which is what
    -- makes one tagging card cover a person's stills and their video.
    "cluster_id" UUID,
    "track_id" TEXT NOT NULL,
    "start_frame" INTEGER NOT NULL,
    "end_frame" INTEGER NOT NULL,
    "start_sec" DOUBLE PRECISION NOT NULL,
    "end_sec" DOUBLE PRECISION NOT NULL,
    -- Keyframed [{frame,x1,y1,x2,y2}, ...] at the detection stride; the redactor
    -- interpolates between them and holds past the ends. A row per frame would
    -- be thousands of rows to describe a path that is smooth by construction.
    "boxes" JSONB NOT NULL,
    "det_score" DOUBLE PRECISION,
    -- 0 means no frame of this track could be embedded. The match step must read
    -- that as "not identifiable", which is NOT the same as "no match" — the
    -- latter is a confident rejection and this is an absence of evidence.
    "embedded_frames" INTEGER NOT NULL DEFAULT 0,
    "rep_frame" INTEGER,
    "crop_path" TEXT,
    "tagged_subject_id" UUID,
    "tag_status" "FaceTagStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_face_tracks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "video_face_tracks_video_id_idx"   ON "video_face_tracks"("video_id");
CREATE INDEX "video_face_tracks_cluster_id_idx" ON "video_face_tracks"("cluster_id");

ALTER TABLE "video_face_tracks"
    ADD CONSTRAINT "video_face_tracks_video_id_fkey"
    FOREIGN KEY ("video_id") REFERENCES "video_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_face_tracks"
    ADD CONSTRAINT "video_face_tracks_cluster_id_fkey"
    FOREIGN KEY ("cluster_id") REFERENCES "face_clusters"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "video_face_tracks"
    ADD CONSTRAINT "video_face_tracks_tagged_subject_id_fkey"
    FOREIGN KEY ("tagged_subject_id") REFERENCES "data_subjects"("master_user_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. video_pii_spans
-- ---------------------------------------------------------------------------
-- No subject_id and no consent_id, deliberately: printed PII is masked whoever
-- is holding it. Same rule the stills path applies (text masking is not gated on
-- biometric consent) and the audio path applies to REDACT_PII spans.
CREATE TABLE "video_pii_spans" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "start_frame" INTEGER NOT NULL,
    "end_frame" INTEGER NOT NULL,
    "start_sec" DOUBLE PRECISION NOT NULL,
    "end_sec" DOUBLE PRECISION NOT NULL,
    "boxes" JSONB NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',

    CONSTRAINT "video_pii_spans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "video_pii_spans_video_id_idx" ON "video_pii_spans"("video_id");

ALTER TABLE "video_pii_spans"
    ADD CONSTRAINT "video_pii_spans_video_id_fkey"
    FOREIGN KEY ("video_id") REFERENCES "video_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. video_subjects  (the erasure key)
-- ---------------------------------------------------------------------------
CREATE TABLE "video_subjects" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    -- Null ONLY on an import link with no live ProjectConsent at ingest,
    -- matching photo_subjects.consent_id. The capture path never writes null:
    -- finalizeSession refuses to create a link without a consent id.
    "consent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_subjects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "video_subjects_video_id_subject_id_key"
    ON "video_subjects"("video_id", "subject_id");
-- The DSAR discovery probe: every clip this person is visible in.
CREATE INDEX "video_subjects_subject_id_idx" ON "video_subjects"("subject_id");
CREATE INDEX "video_subjects_consent_id_idx" ON "video_subjects"("consent_id");

ALTER TABLE "video_subjects"
    ADD CONSTRAINT "video_subjects_video_id_fkey"
    FOREIGN KEY ("video_id") REFERENCES "video_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_subjects"
    ADD CONSTRAINT "video_subjects_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_subjects"
    ADD CONSTRAINT "video_subjects_consent_id_fkey"
    FOREIGN KEY ("consent_id") REFERENCES "project_consent_matrix"("consentId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. face_clusters gains the video half of the card
-- ---------------------------------------------------------------------------
-- `face_count` is left alone on purpose. The admin portal and the handoff counts
-- already read it, and redefining it to include tracks would have moved numbers
-- on screens this change never touched. Video is counted BESIDE it, not inside.
ALTER TABLE "face_clusters"
  ADD COLUMN IF NOT EXISTS "video_track_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rep_track_id" UUID;

-- ---------------------------------------------------------------------------
-- 7. prism_app grants
-- ---------------------------------------------------------------------------
-- 20260728000001 ran ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM
-- prism_app, so every table created after it inherits NOTHING. Without this the
-- app connects fine and then fails permission-denied on the first video upload —
-- at runtime rather than at deploy time, which is the expensive way to find out.
--
-- Guarded on the role existing so this still applies on a plain Postgres where
-- prism_app was never provisioned. TRUNCATE is revoked: nothing in the app has
-- any business emptying a media table wholesale.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "video_assets"      TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "video_face_tracks" TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "video_pii_spans"   TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "video_subjects"    TO prism_app';

    EXECUTE 'REVOKE TRUNCATE ON "video_assets"      FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "video_face_tracks" FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "video_pii_spans"   FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "video_subjects"    FROM prism_app';
  END IF;
END $$;
