-- CreateTable
CREATE TABLE "session_invites" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "session_invites_token_key" ON "session_invites"("token");

-- CreateIndex
CREATE INDEX "session_invites_session_id_idx" ON "session_invites"("session_id");

-- AddForeignKey
ALTER TABLE "session_invites" ADD CONSTRAINT "session_invites_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
