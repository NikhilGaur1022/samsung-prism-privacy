-- Text collection sessions (L18/L19), the audio-first-class migration's
-- counterpart for documents, plus the two columns the audio timeline needs to
-- explain itself.
--
-- Written idempotently throughout. These objects were first created on a shared
-- dev database by `prisma db push` from a branch that had no migration for them,
-- so this file has to be able to run against a database that already has some of
-- it and against a fresh one, and produce the same schema either way.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SessionType" AS ENUM ('IMAGE', 'AUDIO', 'TEXT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TextDocumentStatus" AS ENUM ('PENDING_ANALYSIS', 'TAGGED', 'REDACTED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TextSpanAction" AS ENUM ('KEEP_NON_PII', 'REDACT_ALL', 'REDACT_PII', 'MANUAL_REDACT', 'MANUAL_UNREDACT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterEnum
-- One value per statement: on PostgreSQL 11 and earlier several ALTER TYPE ...
-- ADD VALUE cannot share a transaction.
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'REDACTED_VIDEO';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'TEXT_DOCUMENT';
ALTER TYPE "AccessObjectType" ADD VALUE IF NOT EXISTS 'REDACTED_TEXT_DOCUMENT';

-- AlterTable
-- IMAGE by default, so every session that predates the split keeps behaving
-- exactly as it did.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "type" "SessionType" NOT NULL DEFAULT 'IMAGE';

-- AlterTable
ALTER TABLE "audio_segments" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "audio_segments" ADD COLUMN IF NOT EXISTS "pii_type" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "text_documents" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Untitled Document',
    "storage_path" TEXT NOT NULL,
    "redacted_path" TEXT,
    "status" "TextDocumentStatus" NOT NULL DEFAULT 'PENDING_ANALYSIS',
    "mime_type" TEXT DEFAULT 'text/plain',
    "sha256" TEXT,
    "char_count" INTEGER DEFAULT 0,
    "enc_key_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "text_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "text_spans" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "subject_id" UUID,
    "consent_id" UUID,
    "start_char" INTEGER NOT NULL,
    "end_char" INTEGER NOT NULL,
    "action" "TextSpanAction" NOT NULL DEFAULT 'KEEP_NON_PII',
    "reason" TEXT,
    "pii_type" TEXT,
    "text_snippet" TEXT,

    CONSTRAINT "text_spans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "text_documents_session_id_idx" ON "text_documents" ("session_id");
CREATE INDEX IF NOT EXISTS "text_spans_document_id_idx"   ON "text_spans" ("document_id");
-- The DSAR discovery probe: every document this person is named in.
CREATE INDEX IF NOT EXISTS "text_spans_subject_id_idx"    ON "text_spans" ("subject_id");
CREATE INDEX IF NOT EXISTS "text_spans_consent_id_idx"    ON "text_spans" ("consent_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "text_documents"
    ADD CONSTRAINT "text_documents_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "text_spans"
    ADD CONSTRAINT "text_spans_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "text_documents"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The subject FK the db-push schema never had: without it an erased subject
-- leaves span rows pointing at a master_user_id that no longer exists, and the
-- DSAR discovery probe on text_spans.subject_id silently under-reports.
DO $$ BEGIN
  ALTER TABLE "text_spans"
    ADD CONSTRAINT "text_spans_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "text_spans"
    ADD CONSTRAINT "text_spans_consent_id_fkey"
    FOREIGN KEY ("consent_id") REFERENCES "project_consent_matrix"("consentId")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
