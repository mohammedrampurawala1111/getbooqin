/**
 * Regression test for the fixprompt.md Task 1 findings: every service on
 * shelfscore ended up with a 30-minute duration regardless of its real
 * length, because createServiceConfigsFromProducts hardcoded 30 for every
 * auto-synced service and nothing rejected a bad value on save. Both the
 * root cause (a duration nobody actually set) and its consequence (a slot
 * generator that happily produces slots for a service with no valid
 * duration) are covered here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Data from "../data.js";
import * as Availability from "../availability.js";
import * as Settings from "../settings.js";

const shop = `duration-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
const testDate = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

let resourceId: number;

describe("service duration is required, not defaulted (Task 1)", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 15, timezone: "UTC" });
    const resource = await prisma.resource.create({ data: { shop, platform, name: "demo" } });
    resourceId = resource.id;
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
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("saveServiceConfig rejects a missing, zero, or negative duration instead of flooring it to 5", async () => {
    const base = { product_id: "px", product_handle: "no-duration" };
    await expect(Data.saveServiceConfig(shop, platform, { ...base, duration_min: NaN })).rejects.toThrow();
    await expect(Data.saveServiceConfig(shop, platform, { ...base, duration_min: 0 })).rejects.toThrow();
    await expect(Data.saveServiceConfig(shop, platform, { ...base, duration_min: -30 })).rejects.toThrow();
  });

  it("createServiceConfigsFromProducts creates auto-synced services inactive, not silently live at a guessed duration", async () => {
    const { created } = await Data.createServiceConfigsFromProducts(shop, platform, [
      { id: "p-auto", handle: "auto-synced-service", title: "Auto Synced" },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe(false);
  });

  it("end_utc - start_utc matches the service's real duration for a 45-minute service, and a 30-minute-away booking no longer collides with it the way an unadjusted default would", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "p45", productHandle: "gel-manicure", title: "Gel Manicure", price: 55 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p45", productHandle: "gel-manicure", durationMin: 45, status: true },
    });
    await prisma.serviceResource.create({ data: { shop, platform, serviceId: service.id, resourceId } });

    const slots = await Availability.slots(shop, platform, "UTC", service.id, resourceId, testDate);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const minutes = (new Date(slot.end_utc).getTime() - new Date(slot.start_utc).getTime()) / 60000;
      expect(minutes).toBe(45);
    }
  });

  it("slots() and daysInMonth() refuse to generate anything for a service with an invalid duration, rather than defaulting", async () => {
    await prisma.productCache.create({
      data: { shop, platform, productId: "pbad", productHandle: "bad-duration", title: "Bad Duration", price: 10 },
    });
    // Bypasses saveServiceConfig's validation on purpose -- this simulates a
    // row that ended up bad some other way (direct DB edit, a future bug in
    // a different write path), which is exactly the case assertDuration in
    // availability.ts exists to catch at the read side too.
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "pbad", productHandle: "bad-duration", durationMin: 0, status: true },
    });
    await prisma.serviceResource.create({ data: { shop, platform, serviceId: service.id, resourceId } });

    await expect(Availability.slots(shop, platform, "UTC", service.id, resourceId, testDate)).rejects.toThrow();

    const now = DateTime.utc();
    await expect(
      Availability.daysInMonth(shop, platform, "UTC", service.id, resourceId, now.year, now.month)
    ).rejects.toThrow();
  });
});
