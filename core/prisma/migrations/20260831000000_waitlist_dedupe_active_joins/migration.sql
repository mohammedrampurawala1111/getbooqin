-- Task 3 (fixpromptwaitlist.md): guarantee at the DB level that the same
-- customer cannot hold two active (waiting|offered) waitlist entries for the
-- same service/resource/window. The application layer already pre-checks
-- and handles the race via P2002 (see Waitlist.join in waitlist.ts), but a
-- partial unique index is what actually closes the gap under concurrency --
-- Prisma's schema DSL can't express a WHERE-filtered unique index, so this
-- is hand-written.
--
-- Deliberately excludes claimed/expired/cancelled rows from the constraint:
-- a customer who was already served, or whose offer lapsed, must be able to
-- rejoin the same slot later.
CREATE UNIQUE INDEX "Waitlist_active_join_key" ON "Waitlist"(
  "platform", "shop", "serviceId", "resourceId", "windowStartUtc", "customerId"
) WHERE "status" IN ('waiting', 'offered');
