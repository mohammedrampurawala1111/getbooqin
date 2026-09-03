/**
 * Regression test for the Defect Dossier's BQ-03 finding: Bookings.create()'s
 * per-candidate-resource loop used to discard the specific reason
 * assertSlotBookable() threw (closed day, outside hours, notice window,
 * advance window, time off) and always reported either "not one of the
 * available slots" (off-grid) or a generic "just taken" 409 — so booking a
 * closed Sunday through the public form or the Add-consultation dialog
 * reported the wrong reason, even though Bookings.reschedule() already got
 * this right for the same underlying rule. create() must now surface the
 * same specific reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";

const shop = `create-reason-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

function nextWeekday(targetIsoWeekday: number, fromDaysOut = 21): string {
  let d = DateTime.utc().plus({ days: fromDaysOut }).startOf("day");
  while (d.weekday !== targetIsoWeekday) d = d.plus({ days: 1 });
  return d.toFormat("yyyy-MM-dd");
}

const sunday = nextWeekday(7);
const friday = nextWeekday(5);

let serviceId: number;
let resourceId: number;

describe("Bookings.create() surfaces the real rejection reason (BQ-03)", () => {
  beforeAll(async () => {
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
    // Mon-Fri only — Sunday is genuinely closed, no Schedule row at all.
    await prisma.schedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({ shop, platform, resourceId, dayOfWeek: dow, startTime: "09:00", endTime: "18:00" })),
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

  it("reports getbooqin_closed_day, not the generic slot_taken, for a closed-day request", async () => {
    await expect(
      Bookings.create(shop, platform, "UTC", {
        service_id: serviceId,
        resource_id: resourceId,
        date: sunday,
        time: "23:30",
        first_name: "QA",
        email: "qa-reason@example.com",
      })
    ).rejects.toMatchObject({ code: "getbooqin_closed_day" });
  });

  it("override bypasses the closed-day rule the same way it does for reschedule", async () => {
    const booking = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: sunday,
      time: "23:30",
      first_name: "QA",
      email: "qa-reason-override@example.com",
      override: true,
    });
    expect(booking.startUtc.toISOString()).toBe(`${sunday}T23:30:00.000Z`);
  });

  it("force_status confirms a manually-created booking regardless of auto_confirm", async () => {
    await Settings.setSettings(shop, platform, { auto_confirm: false });
    const booking = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resourceId,
      date: friday,
      time: "10:00",
      first_name: "QA",
      email: "qa-force-status@example.com",
      force_status: "confirmed",
    });
    expect(booking.status).toBe("confirmed");
  });
});
