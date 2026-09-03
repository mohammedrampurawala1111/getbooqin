/**
 * Regression test for the Defect Dossier's BQ-07 finding: nothing composed
 * closed-day/outside-hours/time-off/double-booking/inactive-resource-or-
 * service into one read-only report against an existing booking. A booking
 * outside its own business's rules (from a seed script, an import, or
 * opening hours changing after the fact) previously had no signal anywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";

const shop = `schedule-conflict-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

function nextWeekday(targetIsoWeekday: number, fromDaysOut = 21): string {
  let d = DateTime.utc().plus({ days: fromDaysOut }).startOf("day");
  while (d.weekday !== targetIsoWeekday) d = d.plus({ days: 1 });
  return d.toFormat("yyyy-MM-dd");
}

const friday = nextWeekday(5);
const sunday = nextWeekday(7);

let serviceId: number;
let resourceId: number;

describe("Bookings.scheduleConflict()", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, { slot_interval: 30, timezone: "UTC", min_notice_hours: 2, max_advance_days: 90 });
    await prisma.productCache.create({ data: { shop, platform, productId: "p1", productHandle: "discovery-call", title: "Discovery Call", price: 0 } });
    const service = await prisma.serviceConfig.create({ data: { shop, platform, productId: "p1", productHandle: "discovery-call", durationMin: 30 } });
    serviceId = service.id;
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Consultant" } });
    resourceId = resource.id;
    await prisma.serviceResource.create({ data: { shop, platform, serviceId, resourceId } });
    await prisma.schedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({ shop, platform, resourceId, dayOfWeek: dow, startTime: "09:00", endTime: "18:00" })),
    });
  });

  afterAll(async () => {
    await prisma.timeOff.deleteMany({ where: { shop } });
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.serviceResource.deleteMany({ where: { shop } });
    await prisma.schedule.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  });

  it("reports ok for a booking safely inside business hours", async () => {
    const booking = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId, resource_id: resourceId, date: friday, time: "10:00", first_name: "OK", email: "ok@example.com",
    });
    const result = await Bookings.scheduleConflict(shop, booking);
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("flags a booking outside its own business hours (e.g. seeded directly, bypassing create())", async () => {
    const created = await prisma.booking.create({
      data: {
        shop, platform, uid: "seed-uid-" + Date.now(), serviceId, resourceId, customerId: (await prisma.customer.create({
          data: { shop, platform, firstName: "Seed", lastName: "", email: "seed@example.com" },
        })).id,
        startUtc: DateTime.fromISO(`${sunday}T23:30:00Z`).toJSDate(),
        endUtc: DateTime.fromISO(`${sunday}T23:30:00Z`).plus({ minutes: 30 }).toJSDate(),
        timezone: "UTC", status: "confirmed", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
      },
    });
    const result = await Bookings.scheduleConflict(shop, created);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("The business is closed that day.");
  });

  it("reports ok for a cancelled booking regardless of its stored time — conflict flags only apply to occupying statuses", async () => {
    const created = await prisma.booking.create({
      data: {
        shop, platform, uid: "seed-uid-cancelled-" + Date.now(), serviceId, resourceId, customerId: (await prisma.customer.create({
          data: { shop, platform, firstName: "Cancelled", lastName: "", email: "cancelled@example.com" },
        })).id,
        startUtc: DateTime.fromISO(`${sunday}T23:30:00Z`).toJSDate(),
        endUtc: DateTime.fromISO(`${sunday}T23:30:00Z`).plus({ minutes: 30 }).toJSDate(),
        timezone: "UTC", status: "cancelled", price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
      },
    });
    const result = await Bookings.scheduleConflict(shop, created);
    expect(result).toEqual({ ok: true, reasons: [] });
  });
});
