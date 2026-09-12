/**
 * Phase 0 / B2 — the double-booking race.
 *
 * Bookings.create() checked availability and then inserted as two separate
 * unguarded statements: two customers clicking the last 10:00 slot at the
 * same moment both passed the check and both got booked. The fix is three
 * layers (src/booking/slotLock.ts has the full reasoning) and this file
 * exercises all three against real Postgres and real concurrency — no
 * mocked Prisma, no simulated interleaving.
 *
 * "Concurrent" here means Promise.all over independent create() calls on a
 * pooled client, which is genuine parallelism at the database: without the
 * advisory lock these tests produce two rows, with it they produce one and
 * a 409.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Data from "../data.js";
import * as Settings from "../settings.js";
import { isGetBooqinError } from "../errors.js";
import { RESOURCE_OVERLAP_CONSTRAINT, ROOM_OVERLAP_CONSTRAINT, overlapViolationKind } from "../slotLock.js";

const shop = `double-booking-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

// Next Monday, comfortably inside the default 2-hour notice / 60-day
// advance window whenever this happens to run.
function nextMonday(): DateTime {
  let d = DateTime.utc().plus({ days: 1 }).startOf("day");
  while (d.weekday !== 1) d = d.plus({ days: 1 });
  return d;
}
const monday = nextMonday();
const mondayStr = monday.toFormat("yyyy-MM-dd");
const mondayDow = monday.weekday % 7;

let soloServiceId: number;
let classServiceId: number;
let roomServiceId: number;
let practitionerId: number;
let secondPractitionerId: number;
let roomId: number;

async function makeService(opts: { suffix: string; capacity?: number; requiresRoom?: boolean }) {
  const productId = `db-svc-${opts.suffix}`;
  await Data.upsertProductCache(shop, platform, {
    productId,
    productHandle: productId,
    title: `Double-booking test ${opts.suffix}`,
    price: 50,
  });
  const saved = await Data.saveServiceConfig(shop, platform, {
    product_id: productId,
    product_handle: productId,
    duration_min: 30,
    capacity: opts.capacity ?? 1,
    requires_room: opts.requiresRoom ?? false,
    status: true,
  });
  return saved.id;
}

function args(serviceId: number, time: string, email: string, resourceId?: number) {
  return {
    service_id: serviceId,
    resource_id: resourceId,
    date: mondayStr,
    time,
    first_name: email.split("@")[0],
    email,
  };
}

/** Settled results of N racing create() calls, split into wins and rejections. */
async function race(calls: Array<Promise<unknown>>) {
  const settled = await Promise.allSettled(calls);
  return {
    created: settled.filter((r) => r.status === "fulfilled").length,
    errors: settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  };
}

describe("concurrent bookings for one slot (B2)", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 15, timezone: "UTC", auto_confirm: true });

    soloServiceId = await makeService({ suffix: "solo" });
    classServiceId = await makeService({ suffix: "class", capacity: 3 });
    roomServiceId = await makeService({ suffix: "room", requiresRoom: true });

    const hours = [{ day: mondayDow, start: "08:00", end: "20:00" }];
    const p1 = await Data.saveResource(shop, platform, {
      name: "Practitioner one",
      kind: "practitioner",
      schedule: hours,
      service_ids: [soloServiceId, classServiceId, roomServiceId],
    });
    practitionerId = p1.id;
    const p2 = await Data.saveResource(shop, platform, {
      name: "Practitioner two",
      kind: "practitioner",
      schedule: hours,
      service_ids: [roomServiceId],
    });
    secondPractitionerId = p2.id;
    const room = await Data.saveResource(shop, platform, {
      name: "Room one",
      kind: "room",
      schedule: hours,
      service_ids: [roomServiceId],
    });
    roomId = room.id;
  });

  afterAll(async () => {
    await prisma.bookingAddon.deleteMany({ where: { shop } });
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("gives exactly one booking and one clean 409 when two requests hit the same slot at once", async () => {
    const time = "10:00";
    const { created, errors } = await race([
      Bookings.create(shop, platform, "UTC", args(soloServiceId, time, "racer-a@example.com")),
      Bookings.create(shop, platform, "UTC", args(soloServiceId, time, "racer-b@example.com")),
    ]);

    expect(created).toBe(1);
    expect(errors).toHaveLength(1);
    expect(isGetBooqinError(errors[0])).toBe(true);
    expect(errors[0]).toMatchObject({ code: "getbooqin_slot_taken", status: 409 });

    const rows = await prisma.booking.findMany({
      where: { shop, serviceId: soloServiceId, startUtc: monday.set({ hour: 10 }).toJSDate() },
    });
    expect(rows).toHaveLength(1);
  });

  it("holds under more than two racers", async () => {
    const time = "11:00";
    const { created, errors } = await race(
      Array.from({ length: 5 }, (_, i) =>
        Bookings.create(shop, platform, "UTC", args(soloServiceId, time, `crowd-${i}@example.com`))
      )
    );

    expect(created).toBe(1);
    expect(errors).toHaveLength(4);
    for (const err of errors) {
      expect(err).toMatchObject({ code: "getbooqin_slot_taken", status: 409 });
    }
  });

  it("serialises overlapping-but-not-identical start times too", async () => {
    // A 30-minute service on a 15-minute grid: 12:00 and 12:15 overlap
    // without sharing a start time, so a per-slot lock would have missed
    // this pair. Only one can win.
    const { created, errors } = await race([
      Bookings.create(shop, platform, "UTC", args(soloServiceId, "12:00", "overlap-a@example.com")),
      Bookings.create(shop, platform, "UTC", args(soloServiceId, "12:15", "overlap-b@example.com")),
    ]);

    expect(created).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ status: 409 });
  });

  it("lets a capacity-3 class fill to exactly 3 concurrent seats, not 4", async () => {
    const time = "14:00";
    const { created, errors } = await race(
      Array.from({ length: 4 }, (_, i) =>
        Bookings.create(shop, platform, "UTC", args(classServiceId, time, `seat-${i}@example.com`))
      )
    );

    expect(created).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ status: 409 });

    const rows = await prisma.booking.findMany({ where: { shop, serviceId: classServiceId } });
    expect(rows).toHaveLength(3);
    // Group bookings share their practitioner by design, so they must stay
    // out of the practitioner exclusion index — that's what `exclusive`
    // false means.
    expect(rows.every((r) => r.exclusive === false)).toBe(true);
  });

  it("won't put two practitioners in the same room at once", async () => {
    // Neither request names a resource, so each is free to pick a
    // different practitioner — but there is only one room, and the room is
    // the thing they collide over.
    const time = "15:00";
    const { created, errors } = await race([
      Bookings.create(shop, platform, "UTC", args(roomServiceId, time, "room-a@example.com", practitionerId)),
      Bookings.create(shop, platform, "UTC", args(roomServiceId, time, "room-b@example.com", secondPractitionerId)),
    ]);

    expect(created).toBe(1);
    expect(errors).toHaveLength(1);
    const rows = await prisma.booking.findMany({ where: { shop, serviceId: roomServiceId, roomId } });
    expect(rows).toHaveLength(1);
  });
});

describe("the database backstop, for writes that never take the lock (B2)", () => {
  // The advisory lock only protects code that goes through
  // Bookings.create()/reschedule()/setStatus(). These write straight to the
  // table the way a seed script, an import or a psql session would, and
  // assert the constraints stop them anyway.
  const rawShop = `overlap-constraint-test-${Date.now()}.myshopify.com`;
  let serviceId: number;
  let resourceId: number;
  let otherResourceId: number;
  let rawRoomId: number;
  let customerId: number;

  const start = new Date("2031-03-03T10:00:00Z");
  const end = new Date("2031-03-03T10:30:00Z");
  const overlappingStart = new Date("2031-03-03T10:15:00Z");
  const overlappingEnd = new Date("2031-03-03T10:45:00Z");

  function row(uid: string, over: Partial<Record<string, unknown>> = {}) {
    return {
      shop: rawShop,
      platform,
      uid,
      serviceId,
      resourceId,
      customerId,
      startUtc: start,
      endUtc: end,
      status: "confirmed",
      ...over,
    } as never;
  }

  beforeAll(async () => {
    await prisma.productCache.create({
      data: { shop: rawShop, platform, productId: "raw", productHandle: "raw", title: "Raw", price: 1 },
    });
    const svc = await prisma.serviceConfig.create({
      data: { shop: rawShop, platform, productId: "raw", productHandle: "raw", durationMin: 30 },
    });
    serviceId = svc.id;
    resourceId = (await prisma.resource.create({ data: { shop: rawShop, platform, name: "r1" } })).id;
    otherResourceId = (await prisma.resource.create({ data: { shop: rawShop, platform, name: "r2" } })).id;
    rawRoomId = (await prisma.resource.create({ data: { shop: rawShop, platform, name: "room", kind: "room" } })).id;
    customerId = (
      await prisma.customer.create({ data: { shop: rawShop, platform, firstName: "Raw", email: "raw@example.com" } })
    ).id;
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop: rawShop } });
    await prisma.customer.deleteMany({ where: { shop: rawShop } });
    await prisma.serviceConfig.deleteMany({ where: { shop: rawShop } });
    await prisma.resource.deleteMany({ where: { shop: rawShop } });
    await prisma.productCache.deleteMany({ where: { shop: rawShop } });
  });

  it("rejects a raw insert that overlaps an existing booking on the same practitioner", async () => {
    await prisma.booking.create({ data: row("raw-1") });
    const err = await prisma.booking.create({ data: row("raw-2", { startUtc: overlappingStart, endUtc: overlappingEnd }) }).catch((e) => e);

    expect(overlapViolationKind(err)).toBe("resource");
    expect(String(err.message)).toContain(RESOURCE_OVERLAP_CONSTRAINT);
  });

  it("rejects a raw insert that puts a second booking in an occupied room", async () => {
    // A window of its own: sharing `start` with the practitioner test
    // above would trip Booking_resource_no_overlap first and never reach
    // the room constraint this test is about.
    const roomStart = new Date("2031-03-05T10:00:00Z");
    const roomEnd = new Date("2031-03-05T10:30:00Z");
    await prisma.booking.create({ data: row("raw-room-1", { roomId: rawRoomId, startUtc: roomStart, endUtc: roomEnd }) });
    const err = await prisma.booking
      .create({
        data: row("raw-room-2", {
          roomId: rawRoomId,
          resourceId: otherResourceId,
          startUtc: new Date("2031-03-05T10:15:00Z"),
          endUtc: new Date("2031-03-05T10:45:00Z"),
        }),
      })
      .catch((e) => e);

    expect(overlapViolationKind(err)).toBe("room");
    expect(String(err.message)).toContain(ROOM_OVERLAP_CONSTRAINT);
  });

  it("lets a cancelled booking's slot be taken — only pending/confirmed occupy one", async () => {
    const cancelledStart = new Date("2031-03-04T09:00:00Z");
    const cancelledEnd = new Date("2031-03-04T09:30:00Z");
    await prisma.booking.create({
      data: row("raw-cancelled", { startUtc: cancelledStart, endUtc: cancelledEnd, status: "cancelled" }),
    });
    const replacement = await prisma.booking.create({
      data: row("raw-replacement", { startUtc: cancelledStart, endUtc: cancelledEnd, status: "confirmed" }),
    });

    expect(replacement.id).toBeGreaterThan(0);
  });

  it("does not confuse an unrelated error for a slot conflict", () => {
    expect(overlapViolationKind(new Error("some other failure"))).toBeNull();
    expect(overlapViolationKind(new Error('duplicate key value violates unique constraint "Booking_uid_key"'))).toBeNull();
    expect(overlapViolationKind(null)).toBeNull();
  });
});
