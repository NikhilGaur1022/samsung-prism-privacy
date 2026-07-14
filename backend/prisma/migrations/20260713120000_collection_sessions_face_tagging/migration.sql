-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('ACTIVE', 'REVOKED', 'PURGED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'PROCESSING', 'TAGGING', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "CameraSource" AS ENUM ('IPHONE_LIVE', 'IPHONE_UPLOAD', 'DSLR', 'XR');

-- CreateEnum
CREATE TYPE "FaceTagStatus" AS ENUM ('PENDING', 'TAGGED', 'UNKNOWN', 'SKIPPED', 'NOT_A_FACE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL DEFAULT 'v1',
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "ownerAdminId" UUID,
    "retention" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_assignments" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_consent_matrix" (
    "consentId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'ACTIVE',
    "policyVersion" TEXT NOT NULL,
    "signatureHash" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "project_consent_matrix_pkey" PRIMARY KEY ("consentId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participants" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "storagePath" TEXT NOT NULL,
    "cameraSource" "CameraSource" NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "takenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_detections" (
    "id" UUID NOT NULL,
    "photoId" UUID NOT NULL,
    "clusterId" UUID,
    "bbox" JSONB NOT NULL,
    "detScore" DOUBLE PRECISION,
    "cropPath" TEXT,
    "taggedSubjectId" UUID,
    "tagStatus" "FaceTagStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_detections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_clusters" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "repFaceId" UUID,
    "faceCount" INTEGER NOT NULL DEFAULT 0,
    "suggestedSubjectId" UUID,
    "tagStatus" "FaceTagStatus" NOT NULL DEFAULT 'PENDING',
    "taggedSubjectId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_subjects" (
    "id" UUID NOT NULL,
    "photoId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recognition_jobs" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "photosTotal" INTEGER NOT NULL DEFAULT 0,
    "photosDone" INTEGER NOT NULL DEFAULT 0,
    "facesFound" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recognition_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_assignments_adminId_idx" ON "project_assignments"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "project_assignments_projectId_adminId_key" ON "project_assignments"("projectId", "adminId");

-- CreateIndex
CREATE INDEX "project_consent_matrix_projectId_status_idx" ON "project_consent_matrix"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_consent_matrix_subjectId_projectId_key" ON "project_consent_matrix"("subjectId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_code_key" ON "sessions"("code");

-- CreateIndex
CREATE INDEX "sessions_agentId_status_idx" ON "sessions"("agentId", "status");

-- CreateIndex
CREATE INDEX "sessions_projectId_idx" ON "sessions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "session_participants_sessionId_subjectId_key" ON "session_participants"("sessionId", "subjectId");

-- CreateIndex
CREATE INDEX "photos_sessionId_idx" ON "photos"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "photos_sessionId_sha256_key" ON "photos"("sessionId", "sha256");

-- CreateIndex
CREATE INDEX "face_detections_photoId_idx" ON "face_detections"("photoId");

-- CreateIndex
CREATE INDEX "face_detections_clusterId_idx" ON "face_detections"("clusterId");

-- CreateIndex
CREATE INDEX "face_clusters_sessionId_tagStatus_idx" ON "face_clusters"("sessionId", "tagStatus");

-- CreateIndex
CREATE INDEX "photo_subjects_consentId_idx" ON "photo_subjects"("consentId");

-- CreateIndex
CREATE UNIQUE INDEX "photo_subjects_photoId_subjectId_key" ON "photo_subjects"("photoId", "subjectId");

-- CreateIndex
CREATE INDEX "recognition_jobs_sessionId_idx" ON "recognition_jobs"("sessionId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_ownerAdminId_fkey" FOREIGN KEY ("ownerAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_consent_matrix" ADD CONSTRAINT "project_consent_matrix_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_consent_matrix" ADD CONSTRAINT "project_consent_matrix_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "project_consent_matrix"("consentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_detections" ADD CONSTRAINT "face_detections_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_detections" ADD CONSTRAINT "face_detections_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "face_clusters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_detections" ADD CONSTRAINT "face_detections_taggedSubjectId_fkey" FOREIGN KEY ("taggedSubjectId") REFERENCES "data_subjects"("master_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_clusters" ADD CONSTRAINT "face_clusters_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "face_clusters" ADD CONSTRAINT "face_clusters_suggestedSubjectId_fkey" FOREIGN KEY ("suggestedSubjectId") REFERENCES "data_subjects"("master_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_subjects" ADD CONSTRAINT "photo_subjects_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_subjects" ADD CONSTRAINT "photo_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "data_subjects"("master_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_subjects" ADD CONSTRAINT "photo_subjects_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "project_consent_matrix"("consentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recognition_jobs" ADD CONSTRAINT "recognition_jobs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

