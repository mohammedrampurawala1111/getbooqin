/**
 * Erasure has to actually erase. These count what is left afterwards
 * rather than trusting a cascade — almost every tenant table is keyed by
 * (shop, platform) rather than connectionId, so deleting the Connection
 * alone leaves orphaned rows nobody can reach and nobody can delete,
 * which is the opposite of the right this feature exists to satisfy.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { preview, deleteBusiness, deleteUserAccount } from "../deletion.js";

const RUN = Date.now();
const ownerId = `del-owner-${RUN}`;
const mateId = `del-mate-${RUN}`;
let seq = 0;

async function seedBusiness(userId = ownerId) {
  const shop = `del-${RUN}-${seq++}`;
  const platform = "manual";
  const connection = await prisma.connection.create({
    data: { userId, platform, shop, credentials: "", status: "active" },
  });
  await prisma.connectionMember.create({ data: { connectionId: connection.id, userId, role: "owner" } });
  await prisma.shopSettings.create({
    data: { shop, platform, data: JSON.stringify({ business_name: "Test Salon" }) },
  });
  await prisma.subscription.create({ data: { connectionId: connection.id, plan: "growth", status: "trialing" } });

  const resource = await prisma.resource.create({ data: { shop, platform, name: "Alex", status: true } });
  await prisma.schedule.create({
    data: { shop, platform, resourceId: resource.id, dayOfWeek: 1, startTime: "09:00", endTime: "17:00" },
  });
  await prisma.productCache.create({
    data: { shop, platform, productId: `p-${shop}`, productHandle: `p-${shop}`, title: "Cut", price: 30 },
  });
  const service = await prisma.serviceConfig.create({
    data: { shop, platform, productId: `p-${shop}`, productHandle: `p-${shop}`, durationMin: 30, status: true },
  });
  await prisma.serviceResource.create({ data: { shop, platform, serviceId: service.id, resourceId: resource.id } });
  const customer = await prisma.customer.create({
    data: { shop, platform, firstName: "Jo", lastName: "Lee", email: `jo-${shop}@example.com`, phone: "" },
  });
  const booking = await prisma.booking.create({
    data: {
      shop, platform, uid: `uid-${shop}`, serviceId: service.id, resourceId: resource.id, customerId: customer.id,
      startUtc: new Date(), endUtc: new Date(), timezone: "UTC", status: "confirmed", source: "form",
    },
  });
  // A real Addon, because BookingAddon.addonId is a real foreign key —
  // which is also why the purge has to delete BookingAddon before Addon.
  const addon = await prisma.addon.create({ data: { shop, platform, name: "Extra", price: 5, status: true } });
  await prisma.serviceAddon.create({ data: { shop, platform, serviceId: service.id, addonId: addon.id } });
  await prisma.bookingAddon.create({
    data: { shop, platform, bookingId: booking.id, addonId: addon.id, name: "Extra", price: 5 },
  });

  return { connectionId: connection.id, shop, platform };
}

/** Everything keyed by (shop, platform) that must be gone afterwards. */
async function remainingRows(shop: string, platform: string): Promise<Record<string, number>> {
  const scope = { shop, platform };
  const [settings, services, products, resources, schedules, serviceResources, customers, bookings, bookingAddons, addons, serviceAddons] =
    await Promise.all([
      prisma.shopSettings.count({ where: scope }),
      prisma.serviceConfig.count({ where: scope }),
      prisma.productCache.count({ where: scope }),
      prisma.resource.count({ where: scope }),
      prisma.schedule.count({ where: scope }),
      prisma.serviceResource.count({ where: scope }),
      prisma.customer.count({ where: scope }),
      prisma.booking.count({ where: scope }),
      prisma.bookingAddon.count({ where: scope }),
      prisma.addon.count({ where: scope }),
      prisma.serviceAddon.count({ where: scope }),
    ]);
  return { settings, services, products, resources, schedules, serviceResources, customers, bookings, bookingAddons, addons, serviceAddons };
}

beforeEach(async () => {
  await prisma.user.upsert({ where: { id: ownerId }, create: { id: ownerId, email: `del-owner-${RUN}@example.com` }, update: {} });
  await prisma.user.upsert({ where: { id: mateId }, create: { id: mateId, email: `del-mate-${RUN}@example.com` }, update: {} });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, mateId] } } });
});

describe("preview()", () => {
  it("counts exactly what is about to be destroyed", async () => {
    const { connectionId } = await seedBusiness();
    const p = await preview(connectionId);
    expect(p).toMatchObject({ businessName: "Test Salon", bookings: 1, customers: 1, resources: 1, services: 1, teamMembers: 1 });
    // A trial is not a live mandate — there is nothing to cancel.
    expect(p!.liveSubscription).toBeNull();
    await deleteBusiness(connectionId);
  });

  it("reports a live mandate so the dialog can say it will be cancelled", async () => {
    const { connectionId } = await seedBusiness();
    await prisma.subscription.update({
      where: { connectionId },
      data: { status: "active", billingProvider: "razorpay", providerSubscriptionId: `sub_del_${RUN}` },
    });
    expect((await preview(connectionId))!.liveSubscription).toMatchObject({ provider: "razorpay" });
    // Put it back so the delete below doesn't try to reach Razorpay.
    await prisma.subscription.update({
      where: { connectionId },
      data: { status: "trialing", providerSubscriptionId: null },
    });
    await deleteBusiness(connectionId);
  });

  it("returns null for a business that is already gone", async () => {
    expect(await preview(`nope-${RUN}`)).toBeNull();
  });
});

describe("deleteBusiness()", () => {
  it("leaves no row behind in any (shop, platform)-keyed table", async () => {
    // The regression that matters: cascade alone would have left every
    // one of these orphaned and unreachable.
    const { connectionId, shop, platform } = await seedBusiness();
    await deleteBusiness(connectionId);

    for (const [table, count] of Object.entries(await remainingRows(shop, platform))) {
      expect(count, `${table} still has rows`).toBe(0);
    }
    expect(await prisma.connection.count({ where: { id: connectionId } })).toBe(0);
    expect(await prisma.connectionMember.count({ where: { connectionId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { connectionId } })).toBe(0);
  });

  it("keeps BillingEvent rows, detached — they are the record that money moved", async () => {
    const { connectionId } = await seedBusiness();
    await prisma.billingEvent.create({
      data: {
        connectionId, provider: "razorpay", providerEventId: `evt_del_${RUN}`,
        type: "subscription_active", payload: "{}",
      },
    });

    await deleteBusiness(connectionId);

    const kept = await prisma.billingEvent.findUnique({ where: { providerEventId: `evt_del_${RUN}` } });
    expect(kept, "billing history must survive erasure").toBeTruthy();
    expect(kept!.connectionId, "but must no longer point at a person").toBeNull();
    await prisma.billingEvent.delete({ where: { providerEventId: `evt_del_${RUN}` } });
  });

  it("refuses a business that no longer exists rather than reporting success", async () => {
    await expect(deleteBusiness(`nope-${RUN}`)).rejects.toMatchObject({ code: "getbooqin_not_found" });
  });

  it("does not touch a second, unrelated business", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await deleteBusiness(a.connectionId);

    const left = await remainingRows(b.shop, b.platform);
    expect(left.bookings).toBe(1);
    expect(left.customers).toBe(1);
    await deleteBusiness(b.connectionId);
  });
});

describe("deleteUserAccount()", () => {
  it("deletes every business the person owns, then the person", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();

    expect((await deleteUserAccount(ownerId)).businessesDeleted).toBe(2);
    expect(await prisma.user.count({ where: { id: ownerId } })).toBe(0);

    for (const biz of [a, b]) {
      const left = await remainingRows(biz.shop, biz.platform);
      expect(Object.values(left).every((n) => n === 0)).toBe(true);
    }
  });

  it("refuses while a business still has other team members", async () => {
    // Silently deleting a working business out from under a team is
    // worse than making someone hand it over first.
    const { connectionId, shop, platform } = await seedBusiness();
    await prisma.connectionMember.create({ data: { connectionId, userId: mateId, role: "admin" } });

    await expect(deleteUserAccount(ownerId)).rejects.toMatchObject({ code: "getbooqin_business_has_team" });

    // Nothing was destroyed on the way to refusing.
    expect(await prisma.connection.count({ where: { id: connectionId } })).toBe(1);
    expect((await remainingRows(shop, platform)).bookings).toBe(1);

    await prisma.connectionMember.deleteMany({ where: { connectionId, userId: mateId } });
    await deleteBusiness(connectionId);
  });

  it("leaves businesses the person merely belongs to alone", async () => {
    const mine = await seedBusiness(ownerId);
    const theirs = await seedBusiness(mateId);
    await prisma.connectionMember.create({ data: { connectionId: theirs.connectionId, userId: ownerId, role: "write" } });

    await deleteUserAccount(ownerId);

    // Someone else's business is not mine to erase.
    expect(await prisma.connection.count({ where: { id: theirs.connectionId } })).toBe(1);
    expect((await remainingRows(theirs.shop, theirs.platform)).bookings).toBe(1);
    expect((await remainingRows(mine.shop, mine.platform)).bookings).toBe(0);

    await deleteBusiness(theirs.connectionId);
  });
});
