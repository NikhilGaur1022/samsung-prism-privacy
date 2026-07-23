-- CreateEnum
CREATE TYPE "EnrollmentPose" AS ENUM ('FRONT', 'LEFT', 'RIGHT', 'UP', 'DOWN');

-- AlterTable
-- All nullable: existing rows keep working and are re-derived from the selfie on
-- first use, then written back opportunistically.
ALTER TABLE "subject_face_enrollments"
  ADD COLUMN "pose" "EnrollmentPose",
  ADD COLUMN "embedding" BYTEA,
  ADD COLUMN "embeddingDim" INTEGER;
