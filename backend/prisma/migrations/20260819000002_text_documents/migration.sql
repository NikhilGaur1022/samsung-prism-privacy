-- Text collection sessions (L18/L19), the audio-first-class migration's
-- counterpart for documents, plus the two columns the audio timeline needs to
-- explain itself.
--
-- Written idempotently throughout, and guarded on EXISTENCE rather than by
-- catching duplicate_object. These objects were first created on a shared dev
-- database by `prisma db push` from a branch that carried no migration for them,
-- so this file has to run against a database that already has some of it and
-- against a fresh one, and produce the same schema either way.
--
-- The distinction matters: PostgreSQL checks CREATE privilege on the schema
-- BEFORE it notices the object already exists, so an exception handler never
-- fires — the statement fails 42501 for the locked-down prism_app role that
-- 20260728000001 created. Checking the catalog first means the statement is
-- never attempted, so this migration is a clean no-op for a role that cannot do
-- DDL against a database where the DDL has already been done.

-- CreateEnum
DO $$
DECLARE
  t text;
  ddl text;
BEGIN
  FOR t, ddl IN
    SELECT * FROM (VALUES
      ('SessionType',        $ddl$CREATE TYPE "SessionType" AS ENUM ('IMAGE', 'AUDIO', 'TEXT')$ddl$),
      ('TextDocumentStatus', $ddl$CREATE TYPE "TextDocumentStatus" AS ENUM ('PENDING_ANALYSIS', 'TAGGED', 'REDACTED', 'DEFERRED')$ddl$),
      ('TextSpanAction',     $ddl$CREATE TYPE "TextSpanAction" AS ENUM ('KEEP_NON_PII', 'REDACT_ALL', 'REDACT_PII', 'MANUAL_REDACT', 'MANUAL_UNREDACT')$ddl$)
    ) AS v(t, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = t) THEN
      EXECUTE ddl;
    END IF;
  END LOOP;
END $$;

-- AlterEnum
-- One value at a time: on PostgreSQL 11 and earlier several ALTER TYPE ...
-- ADD VALUE cannot share a transaction.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['REDACTED_VIDEO', 'TEXT_DOCUMENT', 'REDACTED_TEXT_DOCUMENT'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AccessObjectType' AND e.enumlabel = v
    ) THEN
      EXECUTE format('ALTER TYPE "AccessObjectType" ADD VALUE %L', v);
    END IF;
  END LOOP;
END $$;

-- AlterTable
-- IMAGE by default, so every session that predates the split keeps behaving
-- exactly as it did.
ALTER TABLE "sessions"       ADD COLUMN IF NOT EXISTS "type"     "SessionType" NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "audio_segments" ADD COLUMN IF NOT EXISTS "reason"   TEXT;
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
CREATE INDEX IF NOT EXISTS "text_spans_document_id_idx"    ON "text_spans" ("document_id");
-- The DSAR discovery probe: every document this person is named in.
CREATE INDEX IF NOT EXISTS "text_spans_subject_id_idx"     ON "text_spans" ("subject_id");
CREATE INDEX IF NOT EXISTS "text_spans_consent_id_idx"     ON "text_spans" ("consent_id");

-- AddForeignKey
-- text_spans_subject_id_fkey in particular is one the db-push schema never had:
-- without it an erased subject leaves span rows pointing at a master_user_id
-- that no longer exists, and the DSAR discovery probe on text_spans.subject_id
-- silently under-reports.
DO $$
DECLARE
  c text;
  ddl text;
BEGIN
  FOR c, ddl IN
    SELECT * FROM (VALUES
      ('text_documents_session_id_fkey', $ddl$ALTER TABLE "text_documents" ADD CONSTRAINT "text_documents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE$ddl$),
      ('text_spans_document_id_fkey',    $ddl$ALTER TABLE "text_spans" ADD CONSTRAINT "text_spans_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "text_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE$ddl$),
      ('text_spans_subject_id_fkey',     $ddl$ALTER TABLE "text_spans" ADD CONSTRAINT "text_spans_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE$ddl$),
      ('text_spans_consent_id_fkey',     $ddl$ALTER TABLE "text_spans" ADD CONSTRAINT "text_spans_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "project_consent_matrix"("consentId") ON DELETE SET NULL ON UPDATE CASCADE$ddl$)
    ) AS v(c, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c) THEN
      EXECUTE ddl;
    END IF;
  END LOOP;
END $$;

-- prism_app grants
-- 20260728000001 ran ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM
-- prism_app, so a table created after it inherits NOTHING. Without this the app
-- connects fine and then fails permission-denied on the first document upload —
-- at runtime, not at deploy time. Guarded on the role existing so this still
-- applies on a plain Postgres where prism_app was never provisioned, and on the
-- current role being able to grant, so it is a no-op when prism_app is itself
-- the role running the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app')
     AND pg_has_role(current_user, 'prism_app', 'MEMBER') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "text_documents" TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "text_spans" TO prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "text_documents" FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "text_spans" FROM prism_app';
  END IF;
END $$;
