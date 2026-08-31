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
import * as Bookings from "../bookings.js";
import * as Settings from "../settings.js";
import * as Data from "../data.js";
import { uid } from "../ids.js";

/**
 * Waitlist.join() now validates the requested slot/day against the real
 * schedule (fixpromptwaitlist.md Task 1) — a plain "any resource, whole
 * day" join on a day that's still wide open (this file's default fixture)
 * correctly gets rejected as "book it directly instead." The tests below
 * that exercise matchAndOffer/claim/expireStaleOffers care about entries
 * that already exist, not about join()'s own validation (that's covered
 * separately), so they construct rows directly at the shape join() would
 * have produced rather than fighting validation that's orthogonal to what
 * they're actually testing.
 */
async function seedEntry(args: {
  serviceId: number;
  resourceId?: number;
  windowStartUtc: Date;
  windowEndUtc?: Date | null;
  email: string;
  firstName: string;
}) {
  const customerId = await Data.findOrCreateCustomer(shop, platform, {
    first_name: args.firstName,
    email: args.email,
  });
  return prisma.waitlist.create({
    data: {
      shop,
      platform,
      uid: uid(),
      serviceId: args.serviceId,
      resourceId: args.resourceId ?? 0,
      customerId,
      windowStartUtc: args.windowStartUtc,
      windowEndUtc: args.windowEndUtc ?? null,
    },
  });
}

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
    const dayStart = DateTime.fromISO(testDate, { zone: "utc" }).startOf("day").toJSDate();

    const wrongResource = await seedEntry({
      serviceId,
      resourceId: resource2Id, // freed slot is on resource1 — this should never match
      windowStartUtc: dayStart,
      email: await customerEmail(1),
      firstName: "Wrong",
    });

    const wrongWindow = await seedEntry({
      serviceId,
      windowStartUtc: DateTime.fromISO(testDate, { zone: "utc" }).plus({ days: 10 }).startOf("day").toJSDate(), // starts after the freed date
      email: await customerEmail(2),
      firstName: "TooLate",
    });

    const match = await seedEntry({
      serviceId,
      windowStartUtc: dayStart,
      email: await customerEmail(3),
      firstName: "Match",
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
    const entry = await seedEntry({
      serviceId,
      windowStartUtc: DateTime.fromISO(testDate, { zone: "utc" }).startOf("day").toJSDate(),
      email: await customerEmail(4),
      firstName: "Racer",
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
    const entry = await seedEntry({
      serviceId,
      windowStartUtc: DateTime.fromISO(testDate, { zone: "utc" }).startOf("day").toJSDate(),
      email: await customerEmail(5),
      firstName: "Claimer",
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
    const dayStart = DateTime.fromISO(testDate, { zone: "utc" }).startOf("day").toJSDate();
    const first = await seedEntry({
      serviceId,
      windowStartUtc: dayStart,
      email: await customerEmail(6),
      firstName: "First",
    });
    const second = await seedEntry({
      serviceId,
      windowStartUtc: dayStart,
      email: await customerEmail(7),
      firstName: "Second",
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

  it("joining with a specific time only matches a freed slot at that exact instant, not other times the same day", async () => {
    const wantedTime = "14:00";

    // A per-slot join must name an already-blocked slot (Task 1) — book it
    // out first, same as a real customer would only ever see the "join the
    // waitlist for this time" prompt on a slot that's actually taken.
    const blocker = await Bookings.create(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resource1Id,
      date: testDate,
      time: wantedTime,
      first_name: "Blocker",
      email: await customerEmail(9),
    });

    const entry = await Waitlist.join(shop, platform, "UTC", {
      service_id: serviceId,
      resource_id: resource1Id,
      window_start: testDate,
      time: wantedTime,
      first_name: "ExactTime",
      email: await customerEmail(8),
    });

    const wantedStart = DateTime.fromISO(`${testDate}T${wantedTime}:00`, { zone: "utc" });
    expect(entry.windowStartUtc.toISOString()).toBe(wantedStart.toISO());
    expect(entry.windowEndUtc?.toISOString()).toBe(wantedStart.toISO());

    // A different time freeing up the same day should not match this entry.
    const missedOffer = await Waitlist.matchAndOffer(shop, platform, {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: wantedStart.plus({ hours: 1 }).toJSDate(),
      endUtc: wantedStart.plus({ hours: 1, minutes: 30 }).toJSDate(),
    });
    expect(missedOffer?.id).not.toBe(entry.id);

    // Actually free the wanted slot before checking it's offered — matchAndOffer
    // re-verifies availability itself, so it wouldn't match a slot the
    // blocker booking still occupies.
    await prisma.booking.delete({ where: { id: blocker.id } });

    // The exact requested instant freeing up should match it.
    const exactOffer = await Waitlist.matchAndOffer(shop, platform, {
      shop,
      platform,
      serviceId,
      resourceId: resource1Id,
      startUtc: wantedStart.toJSDate(),
      endUtc: wantedStart.plus({ minutes: 30 }).toJSDate(),
    });
    expect(exactOffer?.id).toBe(entry.id);
  });
});
