-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "SubjectGroup" AS ENUM ('SAMSUNG_EMPLOYEE', 'EX_SAMSUNG_EMPLOYEE', 'SEED_LAB_EMPLOYEE', 'EX_SEED_LAB_EMPLOYEE', 'VOLUNTEER');

-- CreateEnum
CREATE TYPE "SubjectStatus" AS ENUM ('PENDING', 'ACTIVE', 'INACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegistrationChannel" AS ENUM ('SELF', 'AGENT');

-- CreateTable
CREATE TABLE "data_subjects" (
    "master_user_id" UUID NOT NULL,
    "group" "SubjectGroup" NOT NULL,
    "status" "SubjectStatus" NOT NULL DEFAULT 'PENDING',
    "fullName" TEXT NOT NULL,
    "email" CITEXT,
    "phone" TEXT,
    "employeeRef" TEXT,
    "registrationChannel" "RegistrationChannel" NOT NULL,
    "registeredByUserId" UUID,
    "otpVerifiedAt" TIMESTAMP(3),
    "generalTerms" BOOLEAN NOT NULL DEFAULT false,
    "piiProcessing" BOOLEAN NOT NULL DEFAULT false,
    "biometricMatch" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_subjects_pkey" PRIMARY KEY ("master_user_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" UUID,
    "payloadHash" TEXT NOT NULL,
    "prevHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_subjects_email_key" ON "data_subjects"("email");

-- CreateIndex
CREATE UNIQUE INDEX "data_subjects_employeeRef_key" ON "data_subjects"("employeeRef");

-- CreateIndex
CREATE INDEX "data_subjects_group_status_idx" ON "data_subjects"("group", "status");

-- CreateIndex
CREATE INDEX "data_subjects_employeeRef_idx" ON "data_subjects"("employeeRef");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_createdAt_idx" ON "audit_log"("entityType", "entityId", "createdAt");
