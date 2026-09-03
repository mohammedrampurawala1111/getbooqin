/**
 * Regression test for the Defect Dossier's BQ-26 finding: status actions
 * weren't gated by the booking's own state or by time. A pending, future
 * booking could be marked no-show before anyone had confirmed it would even
 * happen, and completed/no-show could both be applied to an appointment
 * that hadn't started yet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Bookings from "../bookings.js";

const shop = `status-machine-test-${Date.now()}.myshopify.com`;
const platform = "shopify";

let serviceId: number;
let resourceId: number;
let customerId: number;

async function seedBooking(status: string, startUtc: Date) {
  const booking = await prisma.booking.create({
    data: {
      shop, platform, uid: `seed-${status}-${Date.now()}-${Math.random()}`, serviceId, resourceId, customerId,
      startUtc, endUtc: DateTime.fromJSDate(startUtc).plus({ minutes: 30 }).toJSDate(),
      timezone: "UTC", status, price: 0, amountDue: 0, currency: "USD", paymentStatus: "not_required",
    },
  });
  return booking;
}

describe("booking status state machine", () => {
  beforeAll(async () => {
    await prisma.productCache.create({ data: { shop, platform, productId: "p1", productHandle: "discovery-call", title: "Discovery Call", price: 0 } });
    const service = await prisma.serviceConfig.create({ data: { shop, platform, productId: "p1", productHandle: "discovery-call", durationMin: 30 } });
    serviceId = service.id;
    const resource = await prisma.resource.create({ data: { shop, platform, name: "Consultant" } });
    resourceId = resource.id;
    const customer = await prisma.customer.create({ data: { shop, platform, firstName: "Test", lastName: "", email: "test@example.com" } });
    customerId = customer.id;
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { shop } });
    await prisma.resource.deleteMany({ where: { shop } });
    await prisma.serviceConfig.deleteMany({ where: { shop } });
    await prisma.productCache.deleteMany({ where: { shop } });
    await prisma.customer.deleteMany({ where: { shop } });
  });

  it("rejects moving a pending booking straight to no_show — no one has confirmed it will happen", async () => {
    const booking = await seedBooking("pending", DateTime.utc().plus({ days: 3 }).toJSDate());
    await expect(Bookings.setStatus(shop, booking.id, "no_show")).rejects.toThrow(/Cannot move a booking/);
  });

  it("rejects marking a future confirmed booking completed — it hasn't happened yet", async () => {
    const booking = await seedBooking("confirmed", DateTime.utc().plus({ days: 3 }).toJSDate());
    await expect(Bookings.setStatus(shop, booking.id, "completed")).rejects.toThrow(/can't be marked completed before it starts/);
  });

  it("rejects marking a future confirmed booking no_show — it hasn't happened yet", async () => {
    const booking = await seedBooking("confirmed", DateTime.utc().plus({ days: 3 }).toJSDate());
    await expect(Bookings.setStatus(shop, booking.id, "no_show")).rejects.toThrow(/can't be marked no-show before it starts/);
  });

  it("allows marking a past confirmed booking completed", async () => {
    const booking = await seedBooking("confirmed", DateTime.utc().minus({ days: 1 }).toJSDate());
    const updated = await Bookings.setStatus(shop, booking.id, "completed");
    expect(updated.status).toBe("completed");
  });

  it("allows marking a past confirmed booking no_show", async () => {
    const booking = await seedBooking("confirmed", DateTime.utc().minus({ days: 1 }).toJSDate());
    const updated = await Bookings.setStatus(shop, booking.id, "no_show");
    expect(updated.status).toBe("no_show");
  });
});
