-- Identity moves to Clerk: User.id is now Clerk's own user id (populated by
-- cloud/app/routes/webhooks.clerk.tsx), and the homegrown password hash is
-- no longer used. Safe as a straight column drop — no real users yet.
ALTER TABLE "User" DROP COLUMN "passwordHash";
