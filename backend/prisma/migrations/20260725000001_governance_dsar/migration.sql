-- WAVE 0.2 — governance + DSAR schema.
--
-- Generated from the Prisma datamodel and kept byte-identical to what
-- `prisma migrate diff` emits, so `migrate deploy` on a fresh database and
-- `migrate dev` on an existing one agree. Hand-edit only alongside schema.prisma.
--
-- ALTER TYPE ... ADD VALUE runs inside the migration transaction: legal on
-- PostgreSQL 12+ as long as the new values are not *used* in the same
-- transaction, which they are not. On PG 11 or older this must be split.

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ConsentTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PiiStatus" AS ENUM ('PENDING', 'CLEAN', 'MASKED', 'DEFERRED', 'FAILED');

-- CreateEnum
CREATE TYPE "DsarType" AS ENUM ('ACCESS', 'CORRECT', 'ERASE', 'WITHDRAWAL_ERASURE', 'GRIEVANCE', 'NOMINATION');

-- CreateEnum
CREATE TYPE "DsarStatus" AS ENUM ('RECEIVED', 'TRIAGE', 'DISCOVERY', 'EXECUTING', 'REVIEW', 'CLOSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DsarChannel" AS ENUM ('PORTAL', 'EMAIL', 'PHONE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('DISCOVERY_RESULT', 'IDENTITY_PROOF', 'EXPORT_PACKAGE', 'PURGE_REPORT', 'CORRESPONDENCE', 'APPROVAL');

-- CreateEnum
CREATE TYPE "PurgeJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurgeLocationStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "AccessActorType" AS ENUM ('ADMIN', 'SUBJECT', 'SERVICE');

-- CreateEnum
CREATE TYPE "AccessObjectType" AS ENUM ('PHOTO', 'REDACTED_PHOTO', 'FACE_CROP', 'ENROLLMENT', 'EMBEDDING', 'SUBJECT_PII', 'EXPORT', 'DSAR_PACKAGE', 'VAULT_OBJECT', 'AUDIT_LOG');

-- CreateEnum
CREATE TYPE "AccessAction" AS ENUM ('VIEW', 'DOWNLOAD', 'DECRYPT', 'EXPORT', 'DENIED');

-- CreateEnum
CREATE TYPE "BreachSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('OPEN', 'CONTAINED', 'NOTIFIED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RetentionAction" AS ENUM ('HARD_DELETE', 'CRYPTO_SHRED', 'ANONYMISE', 'TOMBSTONE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProjectStatus" ADD VALUE 'SUBMITTED';
ALTER TYPE "ProjectStatus" ADD VALUE 'APPROVED';
ALTER TYPE "ProjectStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "data_subjects" ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "guardian_contact" TEXT,
ADD COLUMN     "nominee_contact" TEXT;

-- AlterTable
ALTER TABLE "subject_face_enrollments" ADD COLUMN     "enc_key_id" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "approved_by_admin_id" UUID,
ADD COLUMN     "consent_template_id" UUID,
ADD COLUMN     "data_types" JSONB,
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "risk_level" "RiskLevel",
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "photos" ADD COLUMN     "enc_key_id" TEXT,
ADD COLUMN     "pii_status" "PiiStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "consent_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ConsentTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "purpose" TEXT NOT NULL,
    "body_by_locale" JSONB NOT NULL,
    "data_types" JSONB,
    "retention" TEXT,
    "grievance_contact" TEXT,
    "supersedes_id" UUID,
    "created_by_admin_id" UUID,
    "published_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_requests" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "project_id" UUID,
    "type" "DsarType" NOT NULL,
    "status" "DsarStatus" NOT NULL DEFAULT 'RECEIVED',
    "channel" "DsarChannel" NOT NULL DEFAULT 'PORTAL',
    "description" TEXT,
    "auto_raised" BOOLEAN NOT NULL DEFAULT false,
    "assigned_admin_id" UUID,
    "dpo_admin_id" UUID,
    "sla_due_at" TIMESTAMP(3) NOT NULL,
    "internal_due_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "rejection_reason" TEXT,
    "closed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dsar_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_evidence" (
    "id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB,
    "storage_path" TEXT,
    "content_hash" TEXT NOT NULL,
    "created_by_admin_id" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsar_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purge_jobs" (
    "id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" "PurgeJobStatus" NOT NULL DEFAULT 'QUEUED',
    "locations_total" INTEGER NOT NULL DEFAULT 0,
    "locations_done" INTEGER NOT NULL DEFAULT 0,
    "key_destroyed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purge_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purge_job_locations" (
    "id" UUID NOT NULL,
    "purge_job_id" UUID NOT NULL,
    "location_code" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "storage_path" TEXT,
    "status" "PurgeLocationStatus" NOT NULL DEFAULT 'PENDING',
    "hash_before" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "completed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purge_job_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_certificates" (
    "id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "purge_job_id" UUID,
    "subject_pseudonym" TEXT NOT NULL,
    "locations_count" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signing_key_id" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'ed25519',
    "issued_by_admin_id" UUID,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_events" (
    "id" UUID NOT NULL,
    "actor_type" "AccessActorType" NOT NULL,
    "actor_id" UUID,
    "object_type" "AccessObjectType" NOT NULL,
    "object_id" TEXT NOT NULL,
    "action" "AccessAction" NOT NULL,
    "purpose" TEXT,
    "dsar_request_id" UUID,
    "project_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "break_glass" BOOLEAN NOT NULL DEFAULT false,
    "justification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_records" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "BreachSeverity" NOT NULL,
    "status" "BreachStatus" NOT NULL DEFAULT 'OPEN',
    "discovered_at" TIMESTAMP(3) NOT NULL,
    "contained_at" TIMESTAMP(3),
    "affected_subject_count" INTEGER NOT NULL DEFAULT 0,
    "affected_project_ids" JSONB,
    "dpb_notified_at" TIMESTAMP(3),
    "principals_notified_at" TIMESTAMP(3),
    "reported_by_admin_id" UUID,
    "remediation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breach_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "data_class" TEXT NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "action" "RetentionAction" NOT NULL DEFAULT 'HARD_DELETE',
    "clock_start" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin_id" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_keys" (
    "subject_id" UUID NOT NULL,
    "key_id" TEXT NOT NULL,
    "salt" BYTEA,
    "kek_version" INTEGER NOT NULL DEFAULT 1,
    "destroyed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_keys_pkey" PRIMARY KEY ("subject_id")
);

-- CreateIndex
CREATE INDEX "consent_templates_status_idx" ON "consent_templates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "consent_templates_name_version_key" ON "consent_templates"("name", "version");

-- CreateIndex
CREATE INDEX "dsar_requests_status_sla_due_at_idx" ON "dsar_requests"("status", "sla_due_at");

-- CreateIndex
CREATE INDEX "dsar_requests_subject_id_createdAt_idx" ON "dsar_requests"("subject_id", "createdAt");

-- CreateIndex
CREATE INDEX "dsar_requests_assigned_admin_id_status_idx" ON "dsar_requests"("assigned_admin_id", "status");

-- CreateIndex
CREATE INDEX "dsar_evidence_dsar_request_id_createdAt_idx" ON "dsar_evidence"("dsar_request_id", "createdAt");

-- CreateIndex
CREATE INDEX "purge_jobs_status_idx" ON "purge_jobs"("status");

-- CreateIndex
CREATE INDEX "purge_jobs_dsar_request_id_idx" ON "purge_jobs"("dsar_request_id");

-- CreateIndex
CREATE INDEX "purge_job_locations_purge_job_id_status_idx" ON "purge_job_locations"("purge_job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purge_job_locations_purge_job_id_location_code_object_type__key" ON "purge_job_locations"("purge_job_id", "location_code", "object_type", "object_id");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_certificates_dsar_request_id_key" ON "deletion_certificates"("dsar_request_id");

-- CreateIndex
CREATE INDEX "access_events_actor_id_createdAt_idx" ON "access_events"("actor_id", "createdAt");

-- CreateIndex
CREATE INDEX "access_events_object_type_object_id_idx" ON "access_events"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "access_events_dsar_request_id_idx" ON "access_events"("dsar_request_id");

-- CreateIndex
CREATE INDEX "access_events_createdAt_idx" ON "access_events"("createdAt");

-- CreateIndex
CREATE INDEX "breach_records_status_discovered_at_idx" ON "breach_records"("status", "discovered_at");

-- CreateIndex
CREATE INDEX "retention_policies_active_idx" ON "retention_policies"("active");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_project_id_data_class_key" ON "retention_policies"("project_id", "data_class");

-- CreateIndex
CREATE UNIQUE INDEX "subject_keys_key_id_key" ON "subject_keys"("key_id");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "projects_ownerAdminId_idx" ON "projects"("ownerAdminId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_consent_template_id_fkey" FOREIGN KEY ("consent_template_id") REFERENCES "consent_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_templates" ADD CONSTRAINT "consent_templates_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "consent_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_evidence" ADD CONSTRAINT "dsar_evidence_dsar_request_id_fkey" FOREIGN KEY ("dsar_request_id") REFERENCES "dsar_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_dsar_request_id_fkey" FOREIGN KEY ("dsar_request_id") REFERENCES "dsar_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_job_locations" ADD CONSTRAINT "purge_job_locations_purge_job_id_fkey" FOREIGN KEY ("purge_job_id") REFERENCES "purge_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_certificates" ADD CONSTRAINT "deletion_certificates_dsar_request_id_fkey" FOREIGN KEY ("dsar_request_id") REFERENCES "dsar_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_keys" ADD CONSTRAINT "subject_keys_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

