/**
 * Coverage for the appointments calendar's data-layer additions (Phase 1 of
 * the AP-01 "no calendar" audit finding): occupyingBetween()'s optional
 * status override, and the two new Data functions (timeoffBetween,
 * schedulesForResources) the calendar's loader needs that didn't exist
 * before — the same real-Postgres, no-mocking style as overlap.test.ts and
 * resourceUtilization.test.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Data from "../data.js";

const shop = `calendar-queries-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("occupyingBetween() statusIn option", () => {
  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
  });

  it("defaults to OCCUPYING only (confirmed/pending), excluding completed/cancelled — existing callers unaffected", async () => {
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Solo" } });
    const customer = await prisma.customer.create({ data: { shop, platform, firstName: "F", lastName: "", email: `oc-${Date.now()}@example.com` } });
    const productId = `p-${Date.now()}`;
    await prisma.productCache.create({ data: { shop, platform, productId, productHandle: productId, title: "Svc", price: 0 } });
    const service = await prisma.serviceConfig.create({ data: { shop, platform, productId, productHandle: productId, durationMin: 30 } });

    const day = DateTime.utc().plus({ days: 5 }).startOf("day");
    async function makeBooking(status: string, hour: number) {
      const start = day.set({ hour });
      await prisma.booking.create({
        data: {
          shop, platform, uid: `oc-${status}-${hour}-${Date.now()}`, serviceId: service.id, resourceId: resource.id, customerId: customer.id,
          startUtc: start.toJSDate(), endUtc: start.plus({ minutes: 30 }).toJSDate(),
          timezone: "UTC", status, price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
        },
      });
    }
    await makeBooking("confirmed", 9);
    await makeBooking("completed", 10);
    await makeBooking("cancelled", 11);

    const rangeStart = day.toJSDate();
    const rangeEnd = day.plus({ days: 1 }).toJSDate();

    const defaultRows = await Bookings.occupyingBetween(shop, platform, resource.id, rangeStart, rangeEnd);
    expect(defaultRows.map((r) => r.status).sort()).toEqual(["confirmed"]);

    const calendarRows = await Bookings.occupyingBetween(shop, platform, resource.id, rangeStart, rangeEnd, {
      statusIn: [...Bookings.OCCUPYING, "completed", "no_show"],
    });
    expect(calendarRows.map((r) => r.status).sort()).toEqual(["completed", "confirmed"]);
  });
});

describe("Data.timeoffBetween()", () => {
  afterAll(async () => {
    await prisma.timeOff.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
  });

  it("returns resource-specific and whole-business (resourceId 0) blocks overlapping the range, excludes other resources and non-overlapping blocks", async () => {
    const resourceA = await prisma.resource.create({ data: { shop, platform, name: "A" } });
    const resourceB = await prisma.resource.create({ data: { shop, platform, name: "B" } });

    const day = DateTime.utc().plus({ days: 5 }).startOf("day");
    const rangeStart = day.toJSDate();
    const rangeEnd = day.plus({ days: 1 }).toJSDate();

    const inRangeA = await prisma.timeOff.create({
      data: { shop, resourceId: resourceA.id, startUtc: day.set({ hour: 9 }).toJSDate(), endUtc: day.set({ hour: 10 }).toJSDate(), reason: "A off" },
    });
    const wholeBusiness = await prisma.timeOff.create({
      data: { shop, resourceId: 0, startUtc: day.set({ hour: 12 }).toJSDate(), endUtc: day.set({ hour: 13 }).toJSDate(), reason: "Closed" },
    });
    const otherResource = await prisma.timeOff.create({
      data: { shop, resourceId: resourceB.id, startUtc: day.set({ hour: 9 }).toJSDate(), endUtc: day.set({ hour: 10 }).toJSDate(), reason: "B off" },
    });
    const outsideRange = await prisma.timeOff.create({
      data: { shop, resourceId: resourceA.id, startUtc: day.minus({ days: 3 }).toJSDate(), endUtc: day.minus({ days: 3 }).plus({ hours: 1 }).toJSDate(), reason: "Old" },
    });
    // Straddles the range boundary — starts before, ends inside — must still count as overlapping.
    const straddling = await prisma.timeOff.create({
      data: { shop, resourceId: resourceA.id, startUtc: day.minus({ hours: 1 }).toJSDate(), endUtc: day.set({ hour: 1 }).toJSDate(), reason: "Straddle" },
    });

    const rows = await Data.timeoffBetween(shop, [resourceA.id], rangeStart, rangeEnd);
    const ids = rows.map((r) => r.id).sort();

    expect(ids).toContain(inRangeA.id);
    expect(ids).toContain(wholeBusiness.id);
    expect(ids).toContain(straddling.id);
    expect(ids).not.toContain(otherResource.id);
    expect(ids).not.toContain(outsideRange.id);
  });

  it("returns nothing (and doesn't error) when given an empty resource list, aside from whole-business blocks", async () => {
    const day = DateTime.utc().plus({ days: 6 }).startOf("day");
    const rows = await Data.timeoffBetween(shop, [], day.toJSDate(), day.plus({ days: 1 }).toJSDate());
    expect(rows.every((r) => r.resourceId === 0)).toBe(true);
  });
});

describe("Data.schedulesForResources()", () => {
  afterAll(async () => {
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
  });

  it("returns exactly the rows for the requested resources, grouped correctly", async () => {
    const resourceA = await prisma.resource.create({ data: { shop, platform, name: "A" } });
    const resourceB = await prisma.resource.create({ data: { shop, platform, name: "B" } });
    const resourceC = await prisma.resource.create({ data: { shop, platform, name: "C — not requested" } });

    await prisma.schedule.createMany({
      data: [
        { shop, platform, resourceId: resourceA.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
        { shop, platform, resourceId: resourceB.id, dayOfWeek: 2, startTime: "10:00", endTime: "14:00" },
        { shop, platform, resourceId: resourceC.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
      ],
    });

    const rows = await Data.schedulesForResources(shop, [resourceA.id, resourceB.id]);
    expect(rows.map((r) => r.resourceId).sort((a, b) => a - b)).toEqual([resourceA.id, resourceB.id].sort((a, b) => a - b));
    expect(rows.find((r) => r.resourceId === resourceA.id)?.startTime).toBe("09:00");
    expect(rows.find((r) => r.resourceId === resourceB.id)?.endTime).toBe("14:00");
  });

  it("returns an empty array (no query) for an empty resource list", async () => {
    const rows = await Data.schedulesForResources(shop, []);
    expect(rows).toEqual([]);
  });
});
