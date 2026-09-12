/**
 * Phase 0 / B2 — pre-flight for the double-booking constraints.
 *
 * `20260912090000_booking_overlap_exclusion` refuses to apply if any two
 * pending/confirmed bookings already occupy one practitioner (or one
 * room) at overlapping times, because an `EXCLUDE` constraint cannot be
 * added over data that already violates it. That migration names the
 * offending id pairs but has nowhere to put the context you need to
 * decide what to do about them; this does.
 *
 * Read-only. Run it against production *before* deploying:
 *
 *   DATABASE_URL=… npx tsx core/scripts_find_overlapping_bookings.ts
 *
 * Exits 0 when clean, 1 when it finds something — so it can gate a
 * deploy. For each pair, cancel or reschedule one side (the later
 * `createdAt` is usually the one that shouldn't have got in), then run it
 * again.
 *
 * Finding nothing is the expected outcome: the race needed two customers
 * on the same slot within the same few milliseconds, which at current
 * traffic is unlikely to have happened yet. That is exactly why it is
 * worth fixing now rather than after it has.
 */
import "dotenv/config";
import prisma from "./src/db.js";

interface OverlapRow {
  kind: "practitioner" | "room";
  shop: string;
  resource_name: string | null;
  a_id: number;
  a_uid: string;
  a_start: Date;
  a_end: Date;
  a_status: string;
  a_created: Date;
  b_id: number;
  b_uid: string;
  b_start: Date;
  b_end: Date;
  b_status: string;
  b_created: Date;
}

async function main() {
  const rows = await prisma.$queryRaw<OverlapRow[]>`
    SELECT 'practitioner' AS kind, a."shop", r."name" AS resource_name,
           a."id" AS a_id, a."uid" AS a_uid, a."startUtc" AS a_start, a."endUtc" AS a_end,
           a."status" AS a_status, a."createdAt" AS a_created,
           b."id" AS b_id, b."uid" AS b_uid, b."startUtc" AS b_start, b."endUtc" AS b_end,
           b."status" AS b_status, b."createdAt" AS b_created
      FROM "Booking" a
      JOIN "Booking" b ON b."id" > a."id"
                      AND b."resourceId" = a."resourceId"
                      AND b."startUtc" < a."endUtc"
                      AND b."endUtc" > a."startUtc"
      LEFT JOIN "Resource" r ON r."id" = a."resourceId"
      -- Exclusivity is read from the service's capacity, not from
      -- Booking.exclusive: this has to run BEFORE the migration that adds
      -- that column, which is the whole point of a pre-flight. Capacity is
      -- what the migration's own backfill derives the column from, so the
      -- two agree.
      JOIN "ServiceConfig" sa ON sa."id" = a."serviceId"
      JOIN "ServiceConfig" sb ON sb."id" = b."serviceId"
     WHERE sa."capacity" <= 1 AND sb."capacity" <= 1
       AND a."status" IN ('pending','confirmed')
       AND b."status" IN ('pending','confirmed')

    UNION ALL

    SELECT 'room' AS kind, a."shop", r."name" AS resource_name,
           a."id", a."uid", a."startUtc", a."endUtc", a."status", a."createdAt",
           b."id", b."uid", b."startUtc", b."endUtc", b."status", b."createdAt"
      FROM "Booking" a
      JOIN "Booking" b ON b."id" > a."id"
                      AND b."roomId" = a."roomId"
                      AND b."startUtc" < a."endUtc"
                      AND b."endUtc" > a."startUtc"
      LEFT JOIN "Resource" r ON r."id" = a."roomId"
     WHERE a."roomId" IS NOT NULL AND b."roomId" IS NOT NULL
       AND a."status" IN ('pending','confirmed')
       AND b."status" IN ('pending','confirmed')

     ORDER BY 2, 4
  `;

  if (rows.length === 0) {
    console.log("No overlapping pending/confirmed bookings. The exclusion constraints can be applied.");
    return 0;
  }

  console.log(`Found ${rows.length} overlapping booking pair(s). Resolve each before migrating.\n`);
  for (const r of rows) {
    const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);
    console.log(`${r.kind} "${r.resource_name ?? "?"}" @ ${r.shop}`);
    console.log(`  #${r.a_id} ${r.a_uid}  ${when(r.a_start)}–${when(r.a_end)}  ${r.a_status}  booked ${when(r.a_created)}`);
    console.log(`  #${r.b_id} ${r.b_uid}  ${when(r.b_start)}–${when(r.b_end)}  ${r.b_status}  booked ${when(r.b_created)}`);
    console.log(`  -> usually the later booking (#${r.a_created > r.b_created ? r.a_id : r.b_id}) is the one that shouldn't have got in.\n`);
  }
  return 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(2);
  });
