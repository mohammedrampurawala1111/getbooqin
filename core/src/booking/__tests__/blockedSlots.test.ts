/**
 * Availability.slots()'s includeBlocked option — real Postgres, no mocking
 * Prisma, same pattern as overlap.test.ts. Backs the "waitlist for a
 * specific already-taken time" feature: a blocked slot only has one
 * coherent meaning when there's exactly one candidate resource, so this
 * also locks in that it silently stays available-only when resourceId=0
 * resolves to more than one resource.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Availability from "../availability.js";
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";

const shop = `blocked-slots-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
const testDate = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

let serviceId: number;
let resource1Id: number;
let resource2Id: number;

describe("Availability.slots() includeBlocked", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 30, timezone: "UTC" });

    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "blocked-test-service", title: "Blocked Test Service", price: 40 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "blocked-test-service", durationMin: 30 },
    });
    serviceId = service.id;

    const r1 = await prisma.resource.create({ data: { shop, platform, name: "resource-1" } });
    const r2 = await prisma.resource.create({ data: { shop, platform, name: "resource-2" } });
    resource1Id = r1.id;
    resource2Id = r2.id;

    await prisma.serviceResource.createMany({
      data: [
        { shop, platform, serviceId, resourceId: resource1Id },
        { shop, platform, serviceId, resourceId: resource2Id },
      ],
    });

    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].flatMap((dow) => [
        { shop, platform, resourceId: resource1Id, dayOfWeek: dow, startTime: "09:00", endTime: "13:00" },
        { shop, platform, resourceId: resource2Id, dayOfWeek: dow, startTime: "09:00", endTime: "13:00" },
      ]),
    });

    // Book resource1 out at 11:00-11:30. resource2 stays fully open.
    await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resource1Id,
      date: testDate,
      time: "11:00",
      first_name: "Existing",
      email: "existing-booking@example.com",
    });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("without includeBlocked, a taken slot is simply absent (existing behavior, unchanged)", async () => {
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resource1Id, testDate);
    expect(slots.every((s) => s.time !== "11:00")).toBe(true);
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it("with includeBlocked on a single specific resource, the taken slot appears with available:false", async () => {
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, resource1Id, testDate, 0, 0, true);
    const blocked = slots.find((s) => s.time === "11:00");
    expect(blocked).toBeTruthy();
    expect(blocked?.available).toBe(false);

    const open = slots.find((s) => s.time === "09:00");
    expect(open?.available).toBe(true);
  });

  it("includeBlocked is silently ignored when resourceId=0 resolves to more than one resource", async () => {
    const slots = await Availability.slots(shop, platform, "UTC", serviceId, 0, testDate, 0, 0, true);
    // resource2 is free at 11:00, so the aggregated "any resource" view
    // correctly shows 11:00 as available (resource2 can take it) — no
    // blocked entry should appear at all, since resource1's conflict
    // doesn't make the slot unavailable overall.
    expect(slots.every((s) => s.available)).toBe(true);
    expect(slots.some((s) => s.time === "11:00")).toBe(true);
  });
});
