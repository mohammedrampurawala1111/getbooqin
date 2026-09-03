/**
 * Regression test for the Defect Dossier's BQ-35 finding: "Consultant
 * utilisation" divided booked minutes by every open hour across the whole
 * selected range, including days that hadn't happened yet — a month of
 * history mixed with a month of forecast produced a number ("60 of 23760
 * min") that could only ever look terrible. resourceUtilization() clamps
 * its "so far" figure to elapsed time only.
 *
 * Extended for the Round 2 follow-on finding R2-07: a range entirely in
 * the future made the elapsed-only fix show a permanent, confident 0.0%
 * with no way to tell "nothing happened yet" apart from "nothing was ever
 * booked." resourceUtilization() now returns a `soFar` figure (null when
 * no part of the range has elapsed) and a separate `bookedAhead` figure
 * for the remaining, future part of the range.
 */
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import { resourceUtilization } from "../metrics.js";

const shop = `resource-utilization-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

describe("resourceUtilization()", () => {
  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
  });

  it("only counts elapsed days toward the 'so far' available minutes, not a range's future portion", async () => {
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Solo" } });
    // Open every day, 09:00-17:00 (8h = 480 min/day).
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ shop, platform, resourceId: resource.id, dayOfWeek, startTime: "09:00", endTime: "17:00" })),
    });

    const from = DateTime.utc().minus({ days: 1 }).startOf("day").toJSDate();
    const to = DateTime.utc().plus({ days: 30 }).endOf("day").toJSDate();

    const results = await resourceUtilization(shop, platform, { from, to });
    const result = results.find((r) => r.resourceId === resource.id)!;

    // Elapsed span is "yesterday" through "today" — 2 days * 480 min, not
    // the full 32-day range's worth (15360 min) that a naive sum would give.
    expect(result.soFar).not.toBeNull();
    expect(result.soFar!.availableMinutes).toBeLessThanOrEqual(2 * 480);
    expect(result.soFar!.availableMinutes).toBeGreaterThan(0);
    // The remaining 30 days belong to "booked ahead" instead.
    expect(result.bookedAhead.availableMinutes).toBeGreaterThan(0);
  });

  it("does not count a future booking in the 'so far' figure, only in 'booked ahead'", async () => {
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Future" } });
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ shop, platform, resourceId: resource.id, dayOfWeek, startTime: "09:00", endTime: "17:00" })),
    });
    const customer = await prisma.customer.create({ data: { shop, platform, firstName: "F", lastName: "", email: `future-${Date.now()}@example.com` } });
    const productId = `p-${Date.now()}`;
    await prisma.productCache.create({ data: { shop, platform, productId, productHandle: productId, title: "Svc", price: 0 } });
    const service = await prisma.serviceConfig.create({ data: { shop, platform, productId, productHandle: productId, durationMin: 60 } });

    const futureStart = DateTime.utc().plus({ days: 10 }).set({ hour: 10, minute: 0 }).toJSDate();
    await prisma.booking.create({
      data: {
        shop, platform, uid: "future-booking-" + Date.now(), serviceId: service.id, resourceId: resource.id, customerId: customer.id,
        startUtc: futureStart, endUtc: DateTime.fromJSDate(futureStart).plus({ minutes: 60 }).toJSDate(),
        timezone: "UTC", status: "confirmed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
      },
    });

    const from = DateTime.utc().minus({ days: 1 }).startOf("day").toJSDate();
    const to = DateTime.utc().plus({ days: 30 }).endOf("day").toJSDate();
    const results = await resourceUtilization(shop, platform, { from, to });
    const result = results.find((r) => r.resourceId === resource.id)!;

    expect(result.soFar!.bookedMinutes).toBe(0);
    expect(result.bookedAhead.bookedMinutes).toBe(60);
  });

  it("hides 'so far' (returns null) when the whole range is in the future", async () => {
    const resource = await prisma.resource.create({ data: { shop, platform, name: "AllFuture" } });
    await prisma.schedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ shop, platform, resourceId: resource.id, dayOfWeek, startTime: "09:00", endTime: "17:00" })),
    });

    const from = DateTime.utc().plus({ days: 5 }).startOf("day").toJSDate();
    const to = DateTime.utc().plus({ days: 35 }).endOf("day").toJSDate();
    const results = await resourceUtilization(shop, platform, { from, to });
    const result = results.find((r) => r.resourceId === resource.id)!;

    expect(result.soFar).toBeNull();
    expect(result.bookedAhead.availableMinutes).toBeGreaterThan(0);
  });
});
