/**
 * Rooms as a second bookable resource dimension (GetBooqin clinic audit's
 * RS-01 finding): "Practitioners & rooms" promised a resource type that
 * didn't exist, and nothing stopped two practitioners being booked into the
 * same physical chair at once. Exercises the real thing against Postgres —
 * schema, slot generation, and Bookings.create()'s room selection — not
 * just the pure helpers.
 */
import { afterAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../data.js";
import * as Availability from "../availability.js";
import * as Bookings from "../bookings.js";
import { DateTime } from "luxon";

const shop = `rooms-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

// Every date used below is the next Monday — stable across whenever the
// suite happens to run, and clear of any weekly-hours edge case around a
// day boundary. min_notice_hours/max_advance_days default to 2/60, so
// "next Monday" is always inside the bookable window.
function nextMonday(): DateTime {
  let d = DateTime.utc().plus({ days: 1 }).startOf("day");
  while (d.weekday !== 1) d = d.plus({ days: 1 });
  return d;
}
const monday = nextMonday();
const mondayStr = monday.toFormat("yyyy-MM-dd");
const mondayDow = monday.weekday % 7;

async function makeService(requiresRoom: boolean, suffix: string) {
  const productId = `room-svc-${suffix}`;
  await Data.upsertProductCache(shop, platform, { productId, productHandle: productId, title: `Room test ${suffix}`, price: 50 });
  return Data.saveServiceConfig(shop, platform, {
    product_id: productId,
    product_handle: productId,
    duration_min: 30,
    status: true,
    requires_room: requiresRoom,
  });
}

async function makePractitioner(name: string, serviceIds: number[]) {
  return Data.saveResource(shop, platform, {
    name,
    kind: "practitioner",
    schedule: [{ day: mondayDow, start: "09:00", end: "17:00" }],
    service_ids: serviceIds,
  });
}

async function makeRoom(name: string, serviceIds: number[]) {
  return Data.saveResource(shop, platform, {
    name,
    kind: "room",
    schedule: [{ day: mondayDow, start: "09:00", end: "17:00" }],
    service_ids: serviceIds,
  });
}

describe("Rooms as a bookable resource (RS-01)", () => {
  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
  });

  it("saveResource defaults kind to practitioner, and rooms/practitioners are separately queryable", async () => {
    const service = await makeService(false, "kind-default");
    const plain = await Data.saveResource(shop, platform, { name: "Untyped", service_ids: [service.id] });
    expect(plain.kind).toBe("practitioner");

    const room = await makeRoom("Kind Room", [service.id]);
    expect(room.kind).toBe("room");

    const practitioners = await Data.resourcesForService(shop, platform, service.id);
    expect(practitioners.map((r) => r.id)).toContain(plain.id);
    expect(practitioners.map((r) => r.id)).not.toContain(room.id);

    const rooms = await Data.roomsForService(shop, platform, service.id);
    expect(rooms.map((r) => r.id)).toEqual([room.id]);
  });

  it("a service that requires a room with none assigned is unbookable, exactly like zero practitioners", async () => {
    const service = await makeService(true, "no-room");
    await makePractitioner("Dr. No Room", [service.id]);
    // Deliberately no room assigned.

    expect(await Availability.isServiceBookable(shop, platform, service.id, 0)).toBe(false);
    const slots = await Availability.slots(shop, platform, "UTC", service.id, 0, mondayStr);
    expect(slots).toEqual([]);

    const unbookable = await Data.unbookableServiceIds(shop, platform);
    expect(unbookable.has(service.id)).toBe(true);
  });

  it("slots() only offers a time when both a practitioner AND an assigned room are free for it", async () => {
    const service = await makeService(true, "gate");
    const doc = await makePractitioner("Dr. Gate", [service.id]);
    const room = await makeRoom("Room Gate", [service.id]);

    const slots = await Availability.slots(shop, platform, "UTC", service.id, doc.id, mondayStr);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.time === "09:00")).toBe(true);

    // Room-only time off at 09:00-09:30 removes that slot even though the
    // practitioner is completely free — the exact RS-01 mechanism a plain
    // practitioner-only schedule check could never catch.
    await prisma.timeOff.create({
      data: {
        shop,
        resourceId: room.id,
        startUtc: monday.set({ hour: 9 }).toUTC().toJSDate(),
        endUtc: monday.set({ hour: 9, minute: 30 }).toUTC().toJSDate(),
      },
    });
    const afterTimeOff = await Availability.slots(shop, platform, "UTC", service.id, doc.id, mondayStr);
    expect(afterTimeOff.some((s) => s.time === "09:00")).toBe(false);
    // An unaffected later time is still offered — the whole day isn't shut,
    // only the room-blocked moment.
    expect(afterTimeOff.some((s) => s.time === "09:30")).toBe(true);
  });

  it("Bookings.create() persists the picked room, and a second practitioner can no longer be booked into that same chair at the same time", async () => {
    const service = await makeService(true, "double-book");
    const drA = await makePractitioner("Dr. A", [service.id]);
    const drB = await makePractitioner("Dr. B", [service.id]);
    const room = await makeRoom("Only Room", [service.id]); // one shared room for both practitioners

    const first = await Bookings.create(shop, platform, "UTC", {
      service_id: service.id,
      resource_id: drA.id,
      date: mondayStr,
      time: "10:00",
      first_name: "Patient A",
      email: "patient-a@example.com",
    });
    expect(first.roomId).toBe(room.id);

    // Same exact time, a *different* practitioner, the *same* (only) room —
    // this is precisely the audit's reproduction: "two practitioners are
    // both bookable at 10:00 whether or not there is a chair free for the
    // second one." Must now fail once the one shared room is occupied.
    await expect(
      Bookings.create(shop, platform, "UTC", {
        service_id: service.id,
        resource_id: drB.id,
        date: mondayStr,
        time: "10:00",
        first_name: "Patient B",
        email: "patient-b@example.com",
      })
    ).rejects.toMatchObject({ code: "getbooqin_no_room" });

    // The practitioner-only slot listing (no service-level room gate) would
    // have shown Dr. B as free at 10:00 — confirms the failure is really
    // about the shared room, not some other overlap.
    const drBOwnConflict = await Availability.hasBookingConflict(
      shop,
      drB.id,
      DateTime.fromJSDate(first.startUtc, { zone: "utc" }),
      DateTime.fromJSDate(first.endUtc, { zone: "utc" }),
      service
    );
    expect(drBOwnConflict).toBe(false);
  });

  it("two rooms assigned to a service means a second practitioner CAN be booked at the same time, into the other room", async () => {
    const service = await makeService(true, "two-rooms");
    const drA = await makePractitioner("Dr. TwoRooms A", [service.id]);
    const drB = await makePractitioner("Dr. TwoRooms B", [service.id]);
    const roomOne = await makeRoom("Room One", [service.id]);
    const roomTwo = await makeRoom("Room Two", [service.id]);

    const first = await Bookings.create(shop, platform, "UTC", {
      service_id: service.id, resource_id: drA.id, date: mondayStr, time: "11:00",
      first_name: "Patient C", email: "patient-c@example.com",
    });
    const second = await Bookings.create(shop, platform, "UTC", {
      service_id: service.id, resource_id: drB.id, date: mondayStr, time: "11:00",
      first_name: "Patient D", email: "patient-d@example.com",
    });

    expect(new Set([first.roomId, second.roomId])).toEqual(new Set([roomOne.id, roomTwo.id]));
  });

  it("scheduleConflict() reports a room-side reason once the room is deactivated", async () => {
    const service = await makeService(true, "conflict-report");
    const doc = await makePractitioner("Dr. Report", [service.id]);
    const room = await makeRoom("Report Room", [service.id]);

    const booking = await Bookings.create(shop, platform, "UTC", {
      service_id: service.id, resource_id: doc.id, date: mondayStr, time: "13:00",
      first_name: "Patient E", email: "patient-e@example.com", force_status: "confirmed",
    });

    expect((await Bookings.scheduleConflict(shop, booking)).ok).toBe(true);

    await prisma.resource.update({ where: { id: room.id }, data: { status: false } });
    const conflict = await Bookings.scheduleConflict(shop, booking);
    expect(conflict.ok).toBe(false);
    expect(conflict.reasons.some((r) => r.toLowerCase().includes("room"))).toBe(true);
  });
});
