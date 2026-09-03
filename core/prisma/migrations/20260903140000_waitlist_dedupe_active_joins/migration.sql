-- Task 3 (fixpromptwaitlist.md) reprise: guarantee at the DB level that the
-- same customer cannot hold two active (waiting|offered) waitlist entries
-- for the same service/resource/window. The application layer already
-- pre-checks and handles the race via P2002 (see Waitlist.join in
-- waitlist.ts), but a partial unique index is what actually closes the gap
-- under concurrency -- Prisma's schema DSL can't express a WHERE-filtered
-- unique index, so this is hand-written.
--
-- This is a redo of 20260831000000_waitlist_dedupe_active_joins, which
-- applied fine here but failed against production the same day (commit
-- 3f90a98) because CREATE UNIQUE INDEX can't apply over pre-existing
-- duplicate active rows -- that migration jumped straight to the
-- constraint with no dedupe step. This version dedupes first: for any
-- (platform, shop, serviceId, resourceId, windowStartUtc, customerId)
-- group with more than one active row, keep the earliest and cancel the
-- rest -- Waitlist.status already has a "cancelled" state for exactly
-- this ("no longer actually waiting"), so this is a soft resolution, not
-- a data-destroying one.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY platform, shop, "serviceId", "resourceId", "windowStartUtc", "customerId"
           ORDER BY "createdAt" ASC, id ASC
         ) AS rn
  FROM "Waitlist"
  WHERE status IN ('waiting', 'offered')
)
UPDATE "Waitlist"
SET status = 'cancelled', "updatedAt" = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Deliberately excludes claimed/expired/cancelled rows from the constraint:
-- a customer who was already served, or whose offer lapsed or was
-- cancelled (including by the dedupe step above), must be able to rejoin
-- the same slot later.
CREATE UNIQUE INDEX "Waitlist_active_join_key" ON "Waitlist"(
  "platform", "shop", "serviceId", "resourceId", "windowStartUtc", "customerId"
) WHERE "status" IN ('waiting', 'offered');
