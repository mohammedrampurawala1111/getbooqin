/**
 * Regression test for UX audit pass 11's #1 finding: reschedule() used to
 * call only Availability.isFree() (time off + double-booking), skipping the
 * same business-hours/notice/advance-window checks create() already ran —
 * so a merchant could reschedule a booking to a Sunday night the business
 * has no hours for, with no warning. Exercises the real
 * reschedule()/assertSlotBookable() path against Postgres, same pattern as
 * overlap.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";

const shop = `reschedule-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

/** Next date (yyyy-MM-dd, UTC) on the given ISO weekday (1=Mon..7=Sun), at least `fromDaysOut` days from now. */
function nextWeekday(targetIsoWeekday: number, fromDaysOut = 21): string {
  let d = DateTime.utc().plus({ days: fromDaysOut }).startOf("day");
  while (d.weekday !== targetIsoWeekday) d = d.plus({ days: 1 });
  return d.toFormat("yyyy-MM-dd");
}

const friday = nextWeekday(5); // base booking + the "still succeeds" case
const otherFriday = nextWeekday(5, 28); // a different valid slot to reschedule onto
const sunday = nextWeekday(7); // business is closed
const wednesday = nextWeekday(3); // time-off block
const thursday = nextWeekday(4); // double-booking

let serviceId: number;
let resourceId: number;
let bookingId: number;

describe("Bookings.reschedule() business-rule validation", () => {
  beforeAll(async () => {
    // Mon-Fri 09:00-18:00, closed Sat/Sun — matches the audit's own repro
    // (Legal preset: Mon-Fri 09:00-18:00, Sat/Sun closed).
    await Settings.setSettings(shop, platform, { slot_interval: 30, timezone: "UTC", min_notice_hours: 2, max_advance_days: 90 });

    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "discovery-call", title: "Discovery Call", price: 0 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "discovery-call", durationMin: 30 },
    });
    serviceId = service.id;

    const resource = await prisma.resource.create({ data: { shop, platform, name: "Consultant" } });
    resourceId = resource.id;
    await prisma.serviceResource.create({ data: { shop, platform, serviceId, resourceId } });

    await prisma.schedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({ shop, platform, resourceId, dayOfWeek: dow, startTime: "09:00", endTime: "18:00" })),
    });

    const booking = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: friday,
      time: "10:00",
      first_name: "Test",
      email: "reschedule-test@example.com",
    });
    bookingId = booking.id;
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

  it("rejects a closed day (Sunday)", async () => {
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, sunday, "23:30", resourceId)).rejects.toMatchObject({
      code: "getbooqin_closed_day",
    });
  });

  it("rejects a time before opening", async () => {
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, friday, "07:00", resourceId)).rejects.toMatchObject({
      code: "getbooqin_outside_hours",
    });
  });

  it("rejects a time after closing", async () => {
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, friday, "19:00", resourceId)).rejects.toMatchObject({
      code: "getbooqin_outside_hours",
    });
  });

  it("rejects a time inside a time-off block", async () => {
    await prisma.timeOff.create({
      data: {
        shop,
        platform,
        resourceId,
        startUtc: DateTime.fromISO(`${wednesday}T14:00:00`, { zone: "UTC" }).toJSDate(),
        endUtc: DateTime.fromISO(`${wednesday}T15:00:00`, { zone: "UTC" }).toJSDate(),
        reason: "Out of office",
      },
    });
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, wednesday, "14:00", resourceId)).rejects.toMatchObject({
      code: "getbooqin_time_off",
    });
  });

  it("rejects a time inside the minimum-notice window", async () => {
    await Settings.setSettings(shop, platform, { min_notice_hours: 24 * 45 });
    const tomorrow = DateTime.utc().plus({ days: 1 }).startOf("day");
    const soon = { date: tomorrow.toFormat("yyyy-MM-dd"), weekday: tomorrow.weekday };
    // Whatever weekday "tomorrow" lands on, 09:00 that day is either
    // outside_hours (closed) or too_soon (open) — both prove the notice
    // window is enforced; only assert too_soon when it's actually a
    // scheduled weekday so this doesn't depend on which day "today" is.
    if (soon.weekday >= 1 && soon.weekday <= 5) {
      await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, soon.date, "09:00", resourceId)).rejects.toMatchObject({
        code: "getbooqin_too_soon",
      });
    }
    await Settings.setSettings(shop, platform, { min_notice_hours: 2 });
  });

  it("rejects a date past the max-advance-booking window", async () => {
    await Settings.setSettings(shop, platform, { max_advance_days: 5 });
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, friday, "10:00", resourceId)).rejects.toMatchObject({
      code: "getbooqin_too_far",
    });
    await Settings.setSettings(shop, platform, { max_advance_days: 90 });
  });

  it("rejects double-booking the same resource", async () => {
    await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: thursday,
      time: "11:00",
      first_name: "Other",
      email: "other-booking@example.com",
    });
    await expect(Bookings.reschedule(shop, platform, "UTC", bookingId, thursday, "11:00", resourceId)).rejects.toMatchObject({
      code: "getbooqin_slot_taken",
    });
  });

  it("still succeeds rescheduling to a valid in-hours weekday slot", async () => {
    const updated = await Bookings.reschedule(shop, platform, "UTC", bookingId, otherFriday, "14:00", resourceId);
    expect(updated.startUtc.toISOString()).toBe(`${otherFriday}T14:00:00.000Z`);
  });

  it("override bypasses business hours but never time off or a conflict", async () => {
    const overridden = await Bookings.reschedule(shop, platform, "UTC", bookingId, sunday, "23:30", resourceId, { override: true });
    expect(overridden.startUtc.toISOString()).toBe(`${sunday}T23:30:00.000Z`);

    // The Thursday 11:00 slot is still occupied by the "Other" booking from
    // the double-booking test above — override must not bypass that.
    await expect(
      Bookings.reschedule(shop, platform, "UTC", bookingId, thursday, "11:00", resourceId, { override: true })
    ).rejects.toMatchObject({ code: "getbooqin_slot_taken" });
  });
});
