-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "User_emailKey_idx" ON "User"("emailKey");

-- Backfill, mirroring auth/emailIdentity.ts exactly. Kept as SQL rather
-- than a script so the column is never briefly wrong for an existing
-- account: a blank key matches nothing, so a half-migrated table would
-- let through the very duplicate this exists to catch.
--
--   strip everything from "+" onward          (sub-addressing, universal)
--   drop dots in the local part, gmail only   (dots are significant elsewhere)
--   fold googlemail.com onto gmail.com        (same mailbox, always has been)
UPDATE "User"
SET "emailKey" = CASE
  WHEN split_part(lower("email"), '@', 2) IN ('gmail.com', 'googlemail.com')
    THEN replace(split_part(split_part(lower("email"), '@', 1), '+', 1), '.', '') || '@gmail.com'
  ELSE split_part(split_part(lower("email"), '@', 1), '+', 1)
       || '@' || split_part(lower("email"), '@', 2)
END
WHERE "email" LIKE '%@%.%';
