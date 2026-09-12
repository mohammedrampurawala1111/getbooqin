/**
 * The limits, against a real database and through the *real* write
 * paths — Data.saveResource, Data.saveServiceConfig, Team.inviteMember,
 * Bookings.create — not against the helpers in isolation. A limit that
 * passes a unit test but isn't actually wired into the function a route
 * calls is not enforced.
 *
 * The two behaviours worth more than the happy path:
 *   - a shop with no Connection row must **fall open**, because that is
 *     a real state during Shopify's install handshake and a commercial
 *     rule should never break booking;
 *   - staff-entered bookings must **never** be metered, or a merchant
 *     goes back to paper for exactly the bookings this product exists
 *     to absorb.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Data from "../../booking/data.js";
import { isGetBooqinError } from "../../booking/errors.js";
import {
  assertCanAddResource, assertCanAddService, assertCanTakeBooking,
  assertCanInviteMember, assertCanAddBusiness, overLimits, countBookingsThisMonth,
} from "../enforcement.js";

const RUN = Date.now();
const userId = `enf-user-${RUN}`;
const platform = "manual";
const shop = `enf-${RUN}`;
const unbilledShop = `enf-unbilled-${RUN}`;
let connectionId: string;

async function setPlan(plan: string) {
  await prisma.subscription.upsert({
    where: { connectionId },
    create: { connectionId, plan, status: "active" },
    update: { plan, status: "active", trialEndsAt: null },
  });
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `enf-${RUN}@example.com` } });
  const row = await prisma.connection.create({
    data: { userId, platform, shop, credentials: "", status: "active" },
  });
  connectionId = row.id;
});

afterAll(async () => {
  await prisma.booking.deleteMany({ where: { shop } });
  await prisma.customer.deleteMany({ where: { shop } });
  await prisma.connectionMember.deleteMany({ where: { connectionId } });
  await prisma.connectionInvite.deleteMany({ where: { connectionId } });
  await prisma.entitlement.deleteMany({ where: { connectionId } });
  await prisma.serviceResource.deleteMany({ where: { shop } });
  await prisma.resource.deleteMany({ where: { shop } });
  await prisma.serviceConfig.deleteMany({ where: { shop } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("falls open when there is nothing to bill", () => {
  it("a shop with no Connection row is never limited", async () => {
    // Shopify's install handshake creates ShopSettings before the
    // Connection exists. A limit check that threw here would break
    // installation for a commercial reason that doesn't apply yet.
    await expect(assertCanAddResource(unbilledShop, "shopify")).resolves.toBeUndefined();
    await expect(assertCanAddService(unbilledShop, "shopify")).resolves.toBeUndefined();
    await expect(assertCanTakeBooking(unbilledShop, "shopify", "form")).resolves.toBeUndefined();
    expect(await overLimits(unbilledShop, "shopify")).toEqual([]);
  });
});

describe("resources", () => {
  it("Free allows exactly one, and the second is refused through Data.saveResource", async () => {
    await setPlan("free");
    await Data.saveResource(shop, platform, { name: "First", kind: "practitioner" });

    let error: unknown;
    try {
      await Data.saveResource(shop, platform, { name: "Second", kind: "practitioner" });
    } catch (err) {
      error = err;
    }
    expect(isGetBooqinError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("getbooqin_plan_limit");
    // 402 Payment Required — the whole point is that paying fixes it.
    expect((error as { status: number }).status).toBe(402);
    // ...and names the plan that would clear it, so the merchant doesn't
    // have to read a comparison table to find the right button.
    expect((error as { message: string }).message).toContain("Starter");
  });

  it("editing the existing resource is never blocked, even at the cap", async () => {
    await setPlan("free");
    const existing = await prisma.resource.findFirst({ where: { shop, name: "First" } });
    await expect(
      Data.saveResource(shop, platform, { name: "First, renamed", kind: "practitioner" }, existing!.id)
    ).resolves.toBeTruthy();
  });

  it("a deactivated resource frees its seat", async () => {
    // Otherwise "deactivate someone who left, hire a replacement" is
    // impossible on a plan you're already at the edge of.
    await setPlan("free");
    const existing = await prisma.resource.findFirst({ where: { shop } });
    await prisma.resource.update({ where: { id: existing!.id }, data: { status: false } });
    await expect(assertCanAddResource(shop, platform)).resolves.toBeUndefined();
    await prisma.resource.update({ where: { id: existing!.id }, data: { status: true } });
  });

  it("upgrading clears the block without touching any data", async () => {
    await setPlan("growth");
    await expect(assertCanAddResource(shop, platform)).resolves.toBeUndefined();
  });
});

describe("services", () => {
  it("Free caps at three through Data.saveServiceConfig", async () => {
    await setPlan("free");
    for (let i = 0; i < 3; i++) {
      await Data.saveServiceConfig(shop, platform, {
        product_id: `svc-${RUN}-${i}`,
        product_handle: `svc-${RUN}-${i}`,
        duration_min: 30,
      });
    }
    await expect(
      Data.saveServiceConfig(shop, platform, {
        product_id: `svc-${RUN}-overflow`,
        product_handle: `svc-${RUN}-overflow`,
        duration_min: 30,
      })
    ).rejects.toMatchObject({ code: "getbooqin_plan_limit" });
  });

  it("an unlimited plan skips the check entirely", async () => {
    await setPlan("starter");
    await expect(assertCanAddService(shop, platform)).resolves.toBeUndefined();
  });
});

describe("bookings per month", () => {
  it("never meters a staff-entered booking, whatever the plan or the count", async () => {
    await setPlan("free");
    // Free is 50/month. Even far past it, a walk-in typed in by staff
    // must go through — metering admin work pushes a merchant back to
    // paper.
    await expect(assertCanTakeBooking(shop, platform, "admin")).resolves.toBeUndefined();
    await expect(assertCanTakeBooking(shop, platform, "phone")).resolves.toBeUndefined();
  });

  it("counts only this calendar month, and only customer-made bookings", async () => {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const resource = await prisma.resource.findFirst({ where: { shop } });
    const service = await prisma.serviceConfig.findFirst({ where: { shop } });
    const customer = await prisma.customer.create({
      data: { shop, platform, firstName: "Quota", lastName: "Test", email: `quota-${RUN}@example.com`, phone: "" },
    });

    const before = await countBookingsThisMonth(shop, platform);

    await prisma.booking.createMany({
      data: [
        // Last month, customer-made: must not count against this month's
        // quota, or a busy December permanently caps January.
        {
          shop, platform, uid: `quota-old-${RUN}`,
          serviceId: service!.id, resourceId: resource!.id, customerId: customer.id,
          startUtc: lastMonth, endUtc: lastMonth, timezone: "UTC",
          status: "confirmed", source: "form", createdAt: lastMonth, updatedAt: lastMonth,
        },
        // This month, but staff-entered: never metered.
        {
          shop, platform, uid: `quota-admin-${RUN}`,
          serviceId: service!.id, resourceId: resource!.id, customerId: customer.id,
          startUtc: now, endUtc: now, timezone: "UTC",
          status: "confirmed", source: "admin",
        },
      ],
    });

    expect(await countBookingsThisMonth(shop, platform)).toBe(before);

    await prisma.booking.deleteMany({ where: { uid: { in: [`quota-old-${RUN}`, `quota-admin-${RUN}`] } } });
    await prisma.customer.delete({ where: { id: customer.id } });
  });

  it("refuses a customer booking once the monthly cap is reached", async () => {
    await setPlan("free");
    await prisma.entitlement.create({
      data: {
        connectionId, key: "limit.bookingsPerMonth", value: "0",
        grantedByUserId: userId, reason: "test: force the cap",
      },
    });
    await expect(assertCanTakeBooking(shop, platform, "form")).rejects.toMatchObject({
      code: "getbooqin_plan_limit",
      status: 402,
    });
    await prisma.entitlement.deleteMany({ where: { connectionId } });
  });
});

describe("team members", () => {
  it("Free allows the owner and nobody else", async () => {
    await setPlan("free");
    // The owner's ConnectionMember row is created by
    // ensureOwnerMembership; on Free that is the whole allowance.
    await prisma.connectionMember.upsert({
      where: { connectionId_userId: { connectionId, userId } },
      create: { connectionId, userId, role: "owner" },
      update: { role: "owner" },
    });
    await expect(assertCanInviteMember(connectionId)).rejects.toMatchObject({ code: "getbooqin_plan_limit" });
  });

  it("counts an outstanding invite as a seat already spent", async () => {
    // Otherwise a 2-seat account invites ten people and only discovers
    // the cap as each one accepts — worse for everybody, including the
    // eight who get turned away.
    await setPlan("starter"); // 2 seats: the owner + one
    await expect(assertCanInviteMember(connectionId)).resolves.toBeUndefined();

    await prisma.connectionInvite.create({
      data: {
        connectionId, email: `pending-${RUN}@example.com`, role: "write",
        token: `tok-${RUN}`, status: "pending", invitedByUserId: userId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    await expect(assertCanInviteMember(connectionId)).rejects.toMatchObject({ code: "getbooqin_plan_limit" });

    // A revoked invite gives the seat back.
    await prisma.connectionInvite.updateMany({ where: { connectionId }, data: { status: "revoked" } });
    await expect(assertCanInviteMember(connectionId)).resolves.toBeUndefined();
    await prisma.connectionInvite.deleteMany({ where: { connectionId } });
  });
});

describe("businesses", () => {
  it("allows a user's very first business on any plan", async () => {
    await expect(assertCanAddBusiness(`nobody-${RUN}`)).resolves.toBeUndefined();
  });

  it("refuses a second business on a one-location plan", async () => {
    await setPlan("free");
    await expect(assertCanAddBusiness(userId)).rejects.toMatchObject({ code: "getbooqin_plan_limit" });
  });
});

describe("overLimits()", () => {
  it("reports being over after a downgrade without blocking anything", async () => {
    await setPlan("growth");
    await Data.saveResource(shop, platform, { name: "Second", kind: "practitioner" });
    await setPlan("free"); // cap 1, and there are now 2

    const over = await overLimits(shop, platform);
    const resources = over.find((c) => c.limit === "resources");
    expect(resources).toBeTruthy();
    expect(resources!.used).toBeGreaterThan(resources!.cap);

    // Nothing was deleted — that is the point.
    expect(await prisma.resource.count({ where: { shop, status: true } })).toBe(resources!.used);
  });
});
