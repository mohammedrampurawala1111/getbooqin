-- CreateTable
CREATE TABLE "ConnectionMember" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'read',
    "invitedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionInvite" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'write',
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invitedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectionInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionMember_connectionId_userId_key" ON "ConnectionMember"("connectionId", "userId");

-- CreateIndex
CREATE INDEX "ConnectionMember_userId_idx" ON "ConnectionMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionInvite_token_key" ON "ConnectionInvite"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionInvite_connectionId_email_key" ON "ConnectionInvite"("connectionId", "email");

-- CreateIndex
CREATE INDEX "ConnectionInvite_connectionId_status_idx" ON "ConnectionInvite"("connectionId", "status");

-- AddForeignKey
ALTER TABLE "ConnectionMember" ADD CONSTRAINT "ConnectionMember_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionMember" ADD CONSTRAINT "ConnectionMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionInvite" ADD CONSTRAINT "ConnectionInvite_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing Connection's current owner (Connection.userId)
-- gets an explicit ConnectionMember row with role 'owner', so "list team
-- members" can read this table alone instead of UNIONing against
-- Connection.userId. gen_random_uuid() requires the pgcrypto extension (or
-- Postgres 13+, which ships it built in as of 13) — fall back to a
-- manually-assembled cuid-shaped id if it's not available on the target.
DO $$
BEGIN
  BEGIN
    INSERT INTO "ConnectionMember" (id, "connectionId", "userId", role, "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, id, "userId", 'owner', now(), now() FROM "Connection";
  EXCEPTION WHEN undefined_function THEN
    INSERT INTO "ConnectionMember" (id, "connectionId", "userId", role, "createdAt", "updatedAt")
    SELECT 'cm' || substr(md5(random()::text || clock_timestamp()::text), 1, 23), id, "userId", 'owner', now(), now() FROM "Connection";
  END;
END $$;
