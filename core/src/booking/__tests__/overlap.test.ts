/**
 * Regression test for the round-2 storefront QA report's BUG-19: a
 * 45-minute service on a 15-minute slot grid, one resource, could be
 * double-booked 30 minutes apart because the old conflict check only
 * withdrew the slot step nearest the booked start instead of every start
 * time that would actually overlap it.
 *
 * This exercises the real create()/slots() path against Postgres (no
 * mocking Prisma) — the same DB this workspace's other scripts (see
 * scripts_seed_local.ts) already assume is available locally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Availability from "../availability.js";
import * as Settings from "../settings.js";

const shop = `overlap-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
// A week out — comfortably inside the default min_notice_hours (2) and
// max_advance_days (60) window regardless of what "now" is when this runs.
const testDate = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

let serviceId: number;
let resourceId: number;

describe("booking overlap conflict check (BUG-19)", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 15, timezone: "UTC" });

    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "gel-manicure", title: "Gel Manicure", price: 55 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "gel-manicure", durationMin: 45 },
    });
    serviceId = service.id;

    const resource = await prisma.resource.create({ data: { shop, platform, name: "demo" } });
    resourceId = resource.id;
    await prisma.serviceResource.create({ data: { shop, platform, serviceId, resourceId } });

    // Wide open window on every day of the week so testDate's actual
    // weekday never matters.
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        shop,
        platform,
        resourceId,
        dayOfWeek: dow,
        startTime: "08:00",
        endTime: "20:00",
      })),
    });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("blocks every start time that would overlap an existing 45-minute booking, not just the nearest 15-minute step", async () => {
    const first = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: testDate,
      time: "11:00",
      first_name: "QA",
      email: "qa.test@example.com",
    });
    expect(first.startUtc.toISOString()).toBe(`${testDate}T11:00:00.000Z`);

    // The exact repro from the report: 30 minutes after a 45-minute booking
    // on the same resource. 11:00-11:45 is occupied, so 11:30 (which would
    // run to 12:15, a 15-minute collision) must be rejected.
    await expect(
      Bookings.create(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        date: testDate,
        time: "11:30",
        first_name: "QA Overlap",
        email: "qa.overlap@example.com",
      })
    ).rejects.toThrow();

    // Also the 15-minutes-after case (would run 11:15-12:00, still inside
    // the 11:00-11:45 booking).
    await expect(
      Bookings.create(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        date: testDate,
        time: "11:15",
        first_name: "QA Overlap 2",
        email: "qa.overlap2@example.com",
      })
    ).rejects.toThrow();

    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resourceId, testDate);
    const offered = slots.map((s) => s.time);

    // Every start in [11:00 - 45min, 11:45) must be withdrawn, not just the
    // slot immediately adjacent to 11:00.
    expect(offered).not.toContain("10:30"); // would end 11:15 — overlaps
    expect(offered).not.toContain("10:45");
    expect(offered).not.toContain("11:00");
    expect(offered).not.toContain("11:15");
    expect(offered).not.toContain("11:30"); // would end 12:15 — overlaps
    // The very next clear slot (starts exactly when the booking ends) must
    // still be offered — this isn't blocking more than it should either.
    expect(offered).toContain("11:45");
  });

  it("also blocks a second, different service on the same resource from overlapping (cross-service conflict)", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p2", productHandle: "classic-pedicure", title: "Classic Pedicure", price: 45 },
    });
    const pedicure = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p2", productHandle: "classic-pedicure", durationMin: 45 },
    });
    await prisma.serviceResource.create({ data: { shop, platform, serviceId: pedicure.id, resourceId } });

    // The 11:00-11:45 manicure from the previous test is still on the books.
    const slots = await Availability.slots(shop, platform, "UTC", pedicure.id, resourceId, testDate);
    const offered = slots.map((s) => s.time);
    expect(offered).not.toContain("10:30"); // would end 11:15 — inside the manicure
  });
});
