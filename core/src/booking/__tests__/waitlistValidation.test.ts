/**
 * Regression tests for fixpromptwaitlist.md:
 *  - Task 1: join() must validate the requested date/time against the real
 *    schedule instead of accepting anything with a valid email/name.
 *  - Task 3: a repeat join (same person, same slot) must not create a
 *    second row.
 *  - Task 4: a customer can look up and leave their own entry by uid.
 *  - Task 5a: require_phone is honoured on the waitlist form too.
 *  - Task 7: freeing a booking must notify waitlist entries queued on
 *    *adjacent* slots that newly overlap the freed window, not only an
 *    entry waiting on the freed booking's own exact start time (7.1); a
 *    "waiting" entry whose own window has already passed is swept instead
 *    of lingering (7.4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
// Side-effect import: registers Waitlist.init()'s booking_slot_freed
// listener. Every other test file here calls matchAndOffer directly, so
// none of them needed this — the Task 7 test below relies on the actual
// event chain (Bookings.setStatus -> booking_slot_freed -> matchAndOffer).
import "../boot.js";
import * as Waitlist from "../waitlist.js";
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";
import * as Data from "../data.js";
import { uid } from "../ids.js";

const shop = `waitlist-validation-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
// Tue-Sat schedule below; walk forward to a Wednesday so testDate is
// reliably a working day regardless of when this runs.
const testDate = (() => {
  let d = DateTime.utc().plus({ days: 7 });
  while (d.weekday !== 3) d = d.plus({ days: 1 }); // 3 = Wednesday
  return d.toFormat("yyyy-MM-dd");
})();
const closedDate = (() => {
  // The following Sunday after testDate -- schedule below has no Sunday window.
  let d = DateTime.fromISO(testDate, { zone: "utc" }).plus({ days: 1 });
  while (d.weekday !== 7) d = d.plus({ days: 1 }); // 7 = Sunday
  return d.toFormat("yyyy-MM-dd");
})();

let serviceId: number;
let resourceId: number;

async function customerEmail(n: number) {
  return `waitlist-validation-${Date.now()}-${n}@example.com`;
}

describe("Waitlist.join() validation (Task 1) and dedupe (Task 3)", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, {
      slot_interval: 15,
      timezone: "UTC",
      waitlist_enabled: true,
      auto_confirm: true,
    });

    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "waitlist-validation-service", title: "Gel Manicure", price: 55 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "waitlist-validation-service", durationMin: 45 },
    });
    serviceId = service.id;

    const resource = await prisma.resource.create({ data: { shop, platform, name: "demo" } });
    resourceId = resource.id;
    await prisma.serviceResource.create({ data: { shop, platform, serviceId, resourceId } });

    // Tue-Sat, 10:00-19:00 -- Sunday/Monday are genuinely closed.
    await prisma.schedule.createMany({
      data: [2, 3, 4, 5, 6].map((dow) => ({ shop, platform, resourceId, dayOfWeek: dow, startTime: "10:00", endTime: "19:00" })),
    });
  });

  afterAll(async () => {
    await prisma.waitlist.deleteMany({ where: { shop } });
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("rejects a join for a slot that's currently free", async () => {
    await expect(
      Waitlist.join(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        window_start: testDate,
        time: "11:00",
        first_name: "QA",
        email: await customerEmail(1),
      })
    ).rejects.toMatchObject({ code: "getbooqin_slot_available" });
  });

  it("rejects a join for a permanently closed day", async () => {
    await expect(
      Waitlist.join(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        window_start: closedDate,
        time: "11:00",
        first_name: "QA",
        email: await customerEmail(2),
      })
    ).rejects.toMatchObject({ code: "getbooqin_day_closed" });
  });

  it("rejects a join for a date five years in the past", async () => {
    await expect(
      Waitlist.join(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        window_start: "2020-01-15",
        time: "11:00",
        first_name: "QA",
        email: await customerEmail(3),
      })
    ).rejects.toMatchObject({ code: "getbooqin_date_past" });
  });

  it("rejects a join for a time hours after closing", async () => {
    await expect(
      Waitlist.join(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        window_start: testDate,
        time: "23:00",
        first_name: "QA",
        email: await customerEmail(4),
      })
    ).rejects.toMatchObject({ code: "getbooqin_slot_not_offered" });
  });

  it("accepts a join for a genuinely blocked slot, and de-duplicates a repeat join", async () => {
    const holder = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: testDate,
      time: "11:00",
      first_name: "Holder",
      email: await customerEmail(5),
    });

    const email = await customerEmail(6);
    const args = {
      service_id: serviceId,
      resource_id: resourceId,
      window_start: testDate,
      time: "11:00",
      first_name: "QA",
      email,
    };

    const first = await Waitlist.join(shop, platform, "UTC", args);
    expect(first.uid).toBeTruthy();

    // Task 3: same person, same slot, joined again -- must not create a
    // second row, must hand back the same entry.
    const second = await Waitlist.join(shop, platform, "UTC", args);
    const third = await Waitlist.join(shop, platform, "UTC", args);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const rows = await prisma.waitlist.findMany({ where: { shop, serviceId, resourceId, customerId: first.customerId } });
    expect(rows).toHaveLength(1);

    await prisma.booking.delete({ where: { id: holder.id } });
  });

  it("rejects a join with no phone once require_phone is enabled (Task 5a)", async () => {
    await Settings.setSettings(shop, platform, { require_phone: true });
    await expect(
      Waitlist.join(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        window_start: testDate,
        first_name: "QA",
        email: await customerEmail(7),
      })
    ).rejects.toMatchObject({ code: "getbooqin_missing_phone" });
    await Settings.setSettings(shop, platform, { require_phone: false });
  });

  it("getByUid/leaveByUid round-trip: leaving flips status to cancelled (Task 4)", async () => {
    const holder = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: testDate,
      time: "11:00",
      first_name: "Holder",
      email: await customerEmail(8),
    });

    const entry = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      window_start: testDate,
      time: "11:00",
      first_name: "QA",
      email: await customerEmail(9),
    });
    expect(entry.status).toBe("waiting");

    const found = await Waitlist.getByUid(shop, entry.uid);
    expect(found?.id).toBe(entry.id);

    await Waitlist.leaveByUid(shop, entry.uid);
    const after = await Waitlist.getByUid(shop, entry.uid);
    expect(after?.status).toBe("cancelled");

    // Idempotent -- leaving an already-inactive entry is a silent no-op,
    // not an error (the customer's intent -- "I don't want this" -- is
    // already satisfied).
    await expect(Waitlist.leaveByUid(shop, entry.uid)).resolves.toBeUndefined();

    await prisma.booking.delete({ where: { id: holder.id } });
  });

  it("expirePastWaiting sweeps a waiting entry whose window has already passed (Task 7.4)", async () => {
    const customerId = await Data.findOrCreateCustomer(shop, platform, {
      first_name: "QA",
      email: await customerEmail(10),
    });
    const past = await prisma.waitlist.create({
      data: {
        shop,
        platform,
        uid: uid(),
        serviceId,
        resourceId,
        customerId,
        windowStartUtc: DateTime.utc().minus({ days: 10 }).toJSDate(),
        windowEndUtc: DateTime.utc().minus({ days: 9 }).toJSDate(),
        status: "waiting",
      },
    });

    const swept = await Waitlist.expirePastWaiting();
    expect(swept).toBeGreaterThanOrEqual(1);

    const after = await prisma.waitlist.findUnique({ where: { id: past.id } });
    expect(after?.status).toBe("expired");
  });
});

describe("Waitlist matchAndOffer notifies adjacent slots freed by a cancellation (Task 7)", () => {
  const shop2 = `waitlist-adjacent-test-${Date.now()}.myshopify.com`;
  let svcId: number;
  let resId: number;

  beforeAll(async () => {
    await Settings.setSettings(shop2, platform, { slot_interval: 15, timezone: "UTC", waitlist_enabled: true, auto_confirm: true });
    await prisma.productCache.create({
      data: { shop: shop2, platform, productId: "p1", productHandle: "adjacent-service", title: "Gel Manicure", price: 55 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop: shop2, platform, productId: "p1", productHandle: "adjacent-service", durationMin: 45 },
    });
    svcId = service.id;
    const resource = await prisma.resource.create({ data: { shop: shop2, platform, name: "demo" } });
    resId = resource.id;
    await prisma.serviceResource.create({ data: { shop: shop2, platform, serviceId: svcId, resourceId: resId } });
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ shop: shop2, platform, resourceId: resId, dayOfWeek: dow, startTime: "08:00", endTime: "20:00" })),
    });
  });

  afterAll(async () => {
    await prisma.waitlist.deleteMany({ where: { shop: shop2 } });
    await prisma.booking.deleteMany({ where: { shop: shop2 } });
    await prisma.serviceResource.deleteMany({ where: { shop: shop2 } });
    await prisma.schedule.deleteMany({ where: { shop: shop2 } });
    await prisma.resource.deleteMany({ where: { shop: shop2 } });
    await prisma.serviceConfig.deleteMany({ where: { shop: shop2 } });
    await prisma.productCache.deleteMany({ where: { shop: shop2 } });
    await prisma.customer.deleteMany({ where: { shop: shop2 } });
    await prisma.shopSettings.deleteMany({ where: { shop: shop2 } });
  });

  it("offers 10:30 to its own waitlist entry when an 11:00-11:45 cancellation frees it, even though 10:30 isn't the freed booking's own start time", async () => {
    const testDate2 = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

    // Two 45-minute bookings back to back: 10:30-11:15 and 11:00-11:45
    // can't both exist (they overlap) -- so book only 11:00-11:45, then
    // queue someone for the 10:30 start that its existence currently
    // blocks (10:30 would run to 11:15, inside the 11:00 booking).
    const held = await Bookings.create(shop2, platform, "UTC", {
      service_id: svcId,
      resource_id: resId,
      date: testDate2,
      time: "11:00",
      first_name: "Holder",
      email: `adjacent-holder-${Date.now()}@example.com`,
    });

    const waiting = await Waitlist.join(shop2, platform, "UTC", {
      service_id: svcId,
      resource_id: resId,
      window_start: testDate2,
      time: "10:30",
      first_name: "Waiting",
      email: `adjacent-waiter-${Date.now()}@example.com`,
    });
    expect(waiting.status).toBe("waiting");

    // Cancel the 11:00 booking -- this is the real trigger path (not a
    // direct matchAndOffer call), exercising events.ts's booking_slot_freed
    // -> Waitlist.init()'s listener -> matchAndOffer end to end.
    await Bookings.setStatus(shop2, held.id, "cancelled");

    // matchAndOffer runs asynchronously off the event; poll briefly.
    let offered = null;
    for (let i = 0; i < 20; i++) {
      offered = await prisma.waitlist.findUnique({ where: { id: waiting.id } });
      if (offered?.status === "offered") break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(offered?.status).toBe("offered");
    expect(offered?.offeredStartUtc?.toISOString()).toBe(
      DateTime.fromISO(`${testDate2}T10:30:00`, { zone: "utc" }).toISO()
    );
  });
});
