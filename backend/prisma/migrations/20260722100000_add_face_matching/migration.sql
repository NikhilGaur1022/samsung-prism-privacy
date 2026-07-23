-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('SELF', 'AGENT');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('PENDING_INGEST', 'INGESTED', 'REJECTED');

-- CreateTable
CREATE TABLE "subject_face_enrollments" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "imagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "detScore" DOUBLE PRECISION NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "source" "EnrollmentSource" NOT NULL,
    "capturedBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "subject_face_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_face_enrollments_subject_id_deletedAt_idx" ON "subject_face_enrollments"("subject_id", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "subject_face_enrollments_subject_id_sha256_key" ON "subject_face_enrollments"("subject_id", "sha256");

-- AddForeignKey
ALTER TABLE "subject_face_enrollments" ADD CONSTRAINT "subject_face_enrollments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "face_clusters" ADD COLUMN "match_score" DOUBLE PRECISION,
                             ADD COLUMN "auto_tagged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "photos" ADD COLUMN "redacted_path" TEXT;

-- CreateTable
CREATE TABLE "session_handoffs" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'PENDING_INGEST',
    "photoCount" INTEGER NOT NULL,
    "subjectCount" INTEGER NOT NULL,
    "linkCount" INTEGER NOT NULL,
    "emittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedAt" TIMESTAMP(3),

    CONSTRAINT "session_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_handoffs_sessionId_key" ON "session_handoffs"("sessionId");

-- CreateIndex
CREATE INDEX "session_handoffs_status_idx" ON "session_handoffs"("status");

-- AddForeignKey
ALTER TABLE "session_handoffs" ADD CONSTRAINT "session_handoffs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enrollment images are biometric data; keep the same RLS posture as data_subjects.
ALTER TABLE "subject_face_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_handoffs" ENABLE ROW LEVEL SECURITY;
