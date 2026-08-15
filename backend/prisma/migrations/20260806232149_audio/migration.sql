-- CreateEnum
CREATE TYPE "DataItemOrigin" AS ENUM ('COLLECTION_SESSION', 'IMPORT', 'ENROLLMENT');

-- CreateEnum
CREATE TYPE "DataItemType" AS ENUM ('PHOTO');

-- CreateEnum
CREATE TYPE "DsarItemActionKind" AS ENUM ('REDACT', 'DELETE', 'EXPORT');

-- CreateEnum
CREATE TYPE "DsarItemActionStatus" AS ENUM ('REQUESTED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('OPEN', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurgeJobScope" AS ENUM ('FULL', 'PARTIAL');

-- AlterEnum
ALTER TYPE "AccessAction" ADD VALUE 'SEARCH';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccessObjectType" ADD VALUE 'SUBJECT_DATA_ITEM';
ALTER TYPE "AccessObjectType" ADD VALUE 'REDACTED_RECORDING';

-- AlterTable
ALTER TABLE "photo_subjects" ALTER COLUMN "consentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "photos" ALTER COLUMN "sessionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "purge_jobs" ADD COLUMN     "meta" JSONB,
ADD COLUMN     "scope" "PurgeJobScope" NOT NULL DEFAULT 'FULL';

-- CreateTable
CREATE TABLE "dsar_item_actions" (
    "id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "kind" "DsarItemActionKind" NOT NULL,
    "status" "DsarItemActionStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_admin_id" UUID,
    "batch_id" UUID,
    "reason" TEXT,
    "error" TEXT,
    "hash_before" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "dsar_item_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "type" "DataItemType" NOT NULL DEFAULT 'PHOTO',
    "project_id" UUID,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_admin_id" UUID,
    "items_total" INTEGER NOT NULL DEFAULT 0,
    "items_done" INTEGER NOT NULL DEFAULT 0,
    "items_failed" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_data_items" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "type" "DataItemType" NOT NULL,
    "origin" "DataItemOrigin" NOT NULL,
    "source_table" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "project_id" UUID,
    "session_id" UUID,
    "storage_path" TEXT,
    "content_hash" TEXT,
    "captured_at" TIMESTAMP(3),
    "shared_subject_count" INTEGER NOT NULL DEFAULT 1,
    "redacted_available" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,

    CONSTRAINT "subject_data_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dsar_item_actions_batch_id_idx" ON "dsar_item_actions"("batch_id");

-- CreateIndex
CREATE INDEX "dsar_item_actions_dsar_request_id_status_idx" ON "dsar_item_actions"("dsar_request_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_item_actions_dsar_request_id_item_id_kind_key" ON "dsar_item_actions"("dsar_request_id", "item_id", "kind");

-- CreateIndex
CREATE INDEX "import_batches_status_idx" ON "import_batches"("status");

-- CreateIndex
CREATE INDEX "import_batches_subject_id_created_at_idx" ON "import_batches"("subject_id", "created_at");

-- CreateIndex
CREATE INDEX "subject_data_items_subject_id_deleted_at_captured_at_id_idx" ON "subject_data_items"("subject_id", "deleted_at", "captured_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "subject_data_items_subject_id_deleted_at_idx" ON "subject_data_items"("subject_id", "deleted_at");

-- CreateIndex
CREATE INDEX "subject_data_items_subject_id_type_captured_at_idx" ON "subject_data_items"("subject_id", "type", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "subject_data_items_subject_id_type_source_table_source_id_key" ON "subject_data_items"("subject_id", "type", "source_table", "source_id");

-- CreateIndex
CREATE INDEX "dsar_requests_sla_due_at_id_idx" ON "dsar_requests"("sla_due_at", "id");

-- CreateIndex
CREATE INDEX "photos_sha256_idx" ON "photos"("sha256");

-- CreateIndex
CREATE INDEX "purge_jobs_dsar_request_id_scope_status_idx" ON "purge_jobs"("dsar_request_id", "scope", "status");

-- AddForeignKey
ALTER TABLE "dsar_item_actions" ADD CONSTRAINT "dsar_item_actions_dsar_request_id_fkey" FOREIGN KEY ("dsar_request_id") REFERENCES "dsar_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_item_actions" ADD CONSTRAINT "dsar_item_actions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "subject_data_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_data_items" ADD CONSTRAINT "subject_data_items_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;
