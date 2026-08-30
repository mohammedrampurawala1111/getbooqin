/**
 * Waitlist matching/offer/claim/expiry engine — exercised against real
 * Postgres (no mocking Prisma), same pattern as overlap.test.ts. Covers the
 * four behaviors the design leans on for correctness: FIFO + resource/window
 * matching, race-safety of two concurrent offers for one entry, claim()
 * producing a real booking (and rejecting a re-claim), and the expiry sweep
 * cascading to the next candidate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import prisma from "../../db.js";
import * as Waitlist from "../waitlist.js";
import * as Settings from "../settings.js";

const shop = `waitlist-test-${Date.now()}.myshopify.com`;
const platform = "shopify";
const testDate = DateTime.utc().plus({ days: 7 }).toFormat("yyyy-MM-dd");

let serviceId: number;
let resource1Id: number;
let resource2Id: number;

async function customerEmail(n: number) {
  return `waitlist-test-${Date.now()}-${n}@example.com`;
}

describe("Waitlist engine", () => {
  beforeAll(async () => {
    await Settings.setSettings(shop, platform, {
      slot_interval: 30,
      timezone: "UTC",
      waitlist_enabled: true,
      waitlist_offer_window_hours: 1,
      auto_confirm: true,
    });

    await prisma.productCache.create({
      data: { shop, platform, productId: "p1", productHandle: "waitlist-service", title: "Waitlist Service", price: 50 },
    });
    const service = await prisma.serviceConfig.create({
      data: { shop, platform, productId: "p1", productHandle: "waitlist-service", durationMin: 30 },
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
        { shop, platform, resourceId: resource1Id, dayOfWeek: dow, startTime: "08:00", endTime: "20:00" },
        { shop, platform, resourceId: resource2Id, dayOfWeek: dow, startTime: "08:00", endTime: "20:00" },
      ]),
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

  it("matches FIFO, skipping a wrong resource and a non-covering window", async () => {
    const freedStart = DateTime.fromISO(`${testDate}T10:00:00`, { zone: "utc" });
    const freedEnd = freedStart.plus({ minutes: 30 });

    const wrongResource = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resource2Id, // freed slot is on resource1 — this should never match
      window_start: testDate,
      first_name: "Wrong",
      email: await customerEmail(1),
    });

    const wrongWindow = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: DateTime.fromISO(testDate).plus({ days: 10 }).toFormat("yyyy-MM-dd"), // starts after the freed date
      first_name: "TooLate",
      email: await customerEmail(2),
    });

    const match = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: testDate,
      first_name: "Match",
      email: await customerEmail(3),
    });

    const offered = await Waitlist.matchAndOffer(shop, platform, {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: freedStart.toJSDate(),
      endUtc: freedEnd.toJSDate(),
    });

    expect(offered?.id).toBe(match.id);
    expect(offered?.status).toBe("offered");
    expect(offered?.offerToken).toBeTruthy();
    expect(offered?.offeredResourceId).toBe(resource1Id);

    const untouchedWrongResource = await prisma.waitlist.findUniqueOrThrow({ where: { id: wrongResource.id } });
    const untouchedWrongWindow = await prisma.waitlist.findUniqueOrThrow({ where: { id: wrongWindow.id } });
    expect(untouchedWrongResource.status).toBe("waiting");
    expect(untouchedWrongWindow.status).toBe("waiting");
  });

  it("only offers a slot once when two matchAndOffer calls race for the same entry", async () => {
    const entry = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: testDate,
      first_name: "Racer",
      email: await customerEmail(4),
    });

    const freedStart = DateTime.fromISO(`${testDate}T11:00:00`, { zone: "utc" });
    const freed = {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: freedStart.toJSDate(),
      endUtc: freedStart.plus({ minutes: 30 }).toJSDate(),
    };

    const [a, b] = await Promise.all([Waitlist.matchAndOffer(shop, platform, freed), Waitlist.matchAndOffer(shop, platform, freed)]);
    const results = [a, b].filter((r): r is NonNullable<typeof r> => r !== null);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(entry.id);

    const fresh = await prisma.waitlist.findUniqueOrThrow({ where: { id: entry.id } });
    expect(fresh.status).toBe("offered");
    expect(fresh.offerCount).toBe(1);
  });

  it("claim() creates a real booking and rejects a second claim on the same token", async () => {
    const entry = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: testDate,
      first_name: "Claimer",
      email: await customerEmail(5),
    });

    const freedStart = DateTime.fromISO(`${testDate}T12:00:00`, { zone: "utc" });
    const offered = await Waitlist.matchAndOffer(shop, platform, {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: freedStart.toJSDate(),
      endUtc: freedStart.plus({ minutes: 30 }).toJSDate(),
    });
    expect(offered?.id).toBe(entry.id);

    const booking = await Waitlist.claim(shop, platform, "UTC", offered!.offerToken!);
    expect(booking.serviceId).toBe(serviceId);
    expect(booking.resourceId).toBe(resource1Id);
    expect(booking.status).toBe("confirmed"); // auto_confirm: true in this test shop's settings
    expect(booking.source).toBe("waitlist");

    const claimedEntry = await prisma.waitlist.findUniqueOrThrow({ where: { id: entry.id } });
    expect(claimedEntry.status).toBe("claimed");
    expect(claimedEntry.resultingBookingId).toBe(booking.id);

    await expect(Waitlist.claim(shop, platform, "UTC", offered!.offerToken!)).rejects.toThrow();
  });

  it("expireStaleOffers() expires a past-due offer and cascades to the next candidate", async () => {
    const first = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: testDate,
      first_name: "First",
      email: await customerEmail(6),
    });
    const second = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      window_start: testDate,
      first_name: "Second",
      email: await customerEmail(7),
    });

    const freedStart = DateTime.fromISO(`${testDate}T13:00:00`, { zone: "utc" });
    const offered = await Waitlist.matchAndOffer(shop, platform, {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: freedStart.toJSDate(),
      endUtc: freedStart.plus({ minutes: 30 }).toJSDate(),
    });
    expect(offered?.id).toBe(first.id);

    // Simulate the offer window having already passed.
    await prisma.waitlist.update({ where: { id: first.id }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });

    const result = await Waitlist.expireStaleOffers();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.cascaded).toBeGreaterThanOrEqual(1);

    const expiredEntry = await prisma.waitlist.findUniqueOrThrow({ where: { id: first.id } });
    expect(expiredEntry.status).toBe("expired");

    const cascadedEntry = await prisma.waitlist.findUniqueOrThrow({ where: { id: second.id } });
    expect(cascadedEntry.status).toBe("offered");
    expect(cascadedEntry.offeredResourceId).toBe(resource1Id);
  });
});
