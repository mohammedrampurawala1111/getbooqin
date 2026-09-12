-- Phase 0 / B2 — the double-booking race.
--
-- Bookings.create() checked availability and then inserted as two separate
-- statements with nothing in between holding the slot. Two customers
-- clicking the last 10:00 slot at the same moment both passed the check and
-- both got booked. The application-side fix (a per-shop advisory lock plus
-- a re-check inside the insert's transaction) lives in
-- src/booking/slotLock.ts; this migration adds the database-level backstop
-- that makes an overlap *impossible* rather than merely unlikely — including
-- for writes that never go through Bookings.create() at all (a seed script,
-- an import, a psql session, a future code path that forgets).
--
-- Two constraints, because a booking occupies two independent resources:
-- the practitioner (`resourceId`) and, when the service requires one, the
-- room (`roomId`) — see the Booking.roomId schema comment.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- `exclusive` tells the constraint predicate what it cannot look up for
-- itself: whether this booking's service seats one customer per slot or
-- many. A capacity > 1 service (a class, a cohort) is *supposed* to have
-- several bookings sharing one range on one practitioner, so those rows stay
-- out of the practitioner index entirely. See the schema comment.
ALTER TABLE "Booking" ADD COLUMN "exclusive" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Booking" b
   SET "exclusive" = false
  FROM "ServiceConfig" s
 WHERE s."id" = b."serviceId"
   AND s."capacity" > 1;

-- Fail loudly, with the offending ids, rather than letting ADD CONSTRAINT
-- fail with a message that names one row and no context. If this fires,
-- run `npx tsx scripts_find_overlapping_bookings.ts` against the same
-- database for the full report, resolve the overlaps (cancel or reschedule
-- one side of each pair), and re-run the migration.
DO $$
DECLARE
  resource_dupes bigint;
  room_dupes     bigint;
  sample         text;
BEGIN
  SELECT count(*), left(string_agg(pair, ', ' ORDER BY pair), 500)
    INTO resource_dupes, sample
    FROM (
      SELECT a."id" || '/' || b."id" AS pair
        FROM "Booking" a
        JOIN "Booking" b
          ON b."id" > a."id"
         AND b."resourceId" = a."resourceId"
         AND b."startUtc" < a."endUtc"
         AND b."endUtc" > a."startUtc"
       WHERE a."exclusive" AND b."exclusive"
         AND a."status" IN ('pending', 'confirmed')
         AND b."status" IN ('pending', 'confirmed')
    ) x;

  IF resource_dupes > 0 THEN
    RAISE EXCEPTION
      'Cannot add Booking_resource_no_overlap: % existing pending/confirmed booking pair(s) already overlap on the same practitioner. Offending id pairs: %',
      resource_dupes, sample;
  END IF;

  SELECT count(*), left(string_agg(pair, ', ' ORDER BY pair), 500)
    INTO room_dupes, sample
    FROM (
      SELECT a."id" || '/' || b."id" AS pair
        FROM "Booking" a
        JOIN "Booking" b
          ON b."id" > a."id"
         AND b."roomId" = a."roomId"
         AND b."startUtc" < a."endUtc"
         AND b."endUtc" > a."startUtc"
       WHERE a."roomId" IS NOT NULL AND b."roomId" IS NOT NULL
         AND a."status" IN ('pending', 'confirmed')
         AND b."status" IN ('pending', 'confirmed')
    ) x;

  IF room_dupes > 0 THEN
    RAISE EXCEPTION
      'Cannot add Booking_room_no_overlap: % existing pending/confirmed booking pair(s) already share a room at overlapping times. Offending id pairs: %',
      room_dupes, sample;
  END IF;
END $$;

-- Only pending/confirmed occupy a slot — the same OCCUPYING set
-- src/booking/bookingsShared.ts defines and every availability query
-- filters on. A cancelled/declined/completed/no_show row drops out of the
-- index, which is what lets a cancelled 10:00 be rebooked.
--
-- The range is the booking's own start/end, *without* the service's
-- before/after buffers: buffers are per-service policy that can be edited
-- after the fact, so baking them into a stored constraint would retroactively
-- invalidate rows that were legal when written. Buffer overlaps stay the
-- application check's job (Availability.hasBookingConflict, now re-run under
-- the advisory lock); this constraint guarantees the part that is never
-- policy — two bookings cannot literally occupy the same resource at the
-- same time.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_resource_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tsrange("startUtc", "endUtc") WITH &&
  )
  WHERE ("exclusive" AND "status" IN ('pending', 'confirmed'));

-- No `exclusive` gate here, deliberately: a room seats one booking at a
-- time regardless of how many customers the service seats per slot, which
-- is exactly what Availability.hasRoomConflict() already enforces (it has
-- no capacity branch — see its doc comment). Matching it keeps this
-- constraint a pure backstop: it can never reject a write the application
-- would have accepted.
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_room_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    tsrange("startUtc", "endUtc") WITH &&
  )
  WHERE ("roomId" IS NOT NULL AND "status" IN ('pending', 'confirmed'));
