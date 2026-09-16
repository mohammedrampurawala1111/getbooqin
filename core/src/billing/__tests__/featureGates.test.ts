/**
 * The feature half of entitlements, through the real call sites.
 *
 * These exist because the keys were decorative for a while: they
 * resolved correctly, appeared in the admin console and wrote audit rows
 * when granted — and gated nothing, because `assertFeature` was called
 * from nowhere. A feature key that gates nothing is worse than no key,
 * since it makes two plans look different when they aren't.
 *
 * Every case runs against a shop with a real Connection. That matters:
 * `entitlementsForShop` falls open for a shop with no connection (a
 * legitimate state during Shopify's install handshake), so a test
 * without one would pass regardless of the gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import * as Waitlist from "../../booking/waitlist.js";
import * as Team from "../../team.js";
import { setSettings } from "../../booking/settings.js";
import { entitlementsFor } from "../entitlements.js";
import { PLANS, type FeatureKey } from "../plans.js";

const RUN = Date.now();
const ownerId = `fg-owner-${RUN}`;
const shop = `fg-${RUN}`;
const platform = "manual";
let connectionId: string;
let serviceId: number;
let resourceId: number;

async function setPlan(plan: string) {
  await prisma.subscription.upsert({
    where: { connectionId },
    create: { connectionId, plan, status: "active" },
    update: { plan, status: "active", trialEndsAt: null },
  });
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: ownerId, email: `fg-${RUN}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId: ownerId, platform, shop, credentials: "", status: "active" },
  });
  connectionId = conn.id;
  await prisma.connectionMember.create({ data: { connectionId, userId: ownerId, role: "owner" } });
  await prisma.shopSettings.create({
    data: { shop, platform, data: JSON.stringify({ business_name: "Gate Test", waitlist_enabled: true }) },
  });

  const resource = await prisma.resource.create({ data: { shop, platform, name: "Alex", status: true } });
  resourceId = resource.id;
  await prisma.productCache.create({
    data: { shop, platform, productId: `p-${shop}`, productHandle: `p-${shop}`, title: "Cut", price: 30 },
  });
  const service = await prisma.serviceConfig.create({
    data: { shop, platform, productId: `p-${shop}`, productHandle: `p-${shop}`, durationMin: 30, status: true },
  });
  serviceId = service.id;
  await prisma.serviceResource.create({ data: { shop, platform, serviceId, resourceId } });
  // Open every day: Waitlist.join refuses a window the business is
  // closed for, which would otherwise mask whether the plan gate fired.
  await prisma.schedule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      shop, platform, resourceId, dayOfWeek, startTime: "09:00", endTime: "18:00",
    })),
  });
});

beforeEach(async () => {
  await prisma.entitlement.deleteMany({ where: { connectionId } });
  await prisma.connectionInvite.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  await prisma.waitlist.deleteMany({ where: { shop } });
  await prisma.schedule.deleteMany({ where: { shop } });
  await prisma.customer.deleteMany({ where: { shop } });
  await prisma.serviceResource.deleteMany({ where: { shop } });
  await prisma.serviceConfig.deleteMany({ where: { shop } });
  await prisma.productCache.deleteMany({ where: { shop } });
  await prisma.resource.deleteMany({ where: { shop } });
  await prisma.shopSettings.deleteMany({ where: { shop } });
  await prisma.connectionInvite.deleteMany({ where: { connectionId } });
  await prisma.connectionMember.deleteMany({ where: { connectionId } });
  await prisma.entitlement.deleteMany({ where: { connectionId } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { id: connectionId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

function joinArgs(suffix: string) {
  return {
    service_id: serviceId,
    first_name: "Jo",
    last_name: "Lee",
    email: `wl-${RUN}-${suffix}@example.com`,
    // yyyy-MM-dd, shop-local — not an ISO timestamp.
    window_start: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    window_end: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  } as Parameters<typeof Waitlist.join>[3];
}

describe("every plan feature is enforced somewhere", () => {
  it("no plan grants a feature key that nothing can honour", () => {
    // The audit that produced this file: `embed` was in the ladder with
    // no embed snippet in the product, so Starter claimed something that
    // did not exist. Keep this list honest as features are added.
    // "branding" is enforced in Settings.setSettings() — a save that
    // sets a logo or accent colour calls assertFeature, and the booking
    // page re-checks the entitlement rather than trusting the stored
    // value, so a lapsed account's page reverts on its own.
    const enforced: FeatureKey[] = [
      "no_badge", "branding", "waitlist", "team_roles", "email_templates", "shopify", "export",
    ];
    const markers: FeatureKey[] = ["priority_support", "early_access"];
    for (const plan of Object.values(PLANS)) {
      for (const feature of plan.features) {
        expect([...enforced, ...markers], `${plan.id} grants unenforceable "${feature}"`).toContain(feature);
      }
    }
  });
});

describe("waitlist", () => {
  it("is refused on Free — including from the public booking page", async () => {
    // The gate lives in Waitlist.join, not in a dashboard route, because
    // the public page joins the waitlist too.
    await setPlan("free");
    await expect(Waitlist.join(shop, platform, "UTC", joinArgs("free"))).rejects.toMatchObject({
      code: "getbooqin_plan_feature",
      status: 402,
    });
  });

  it("names the plan that would unlock it", async () => {
    await setPlan("free");
    await Waitlist.join(shop, platform, "UTC", joinArgs("msg")).catch((err) => {
      expect(err.message).toContain("Starter");
    });
  });

  it("works on Starter", async () => {
    await setPlan("starter");
    const entry = await Waitlist.join(shop, platform, "UTC", joinArgs("starter"));
    expect(entry.id).toBeTruthy();
  });

  it("an admin grant unlocks it on Free without changing the plan", async () => {
    await setPlan("free");
    await prisma.entitlement.create({
      data: { connectionId, key: "waitlist", value: "on", grantedByUserId: ownerId, reason: "pilot" },
    });
    const entry = await Waitlist.join(shop, platform, "UTC", joinArgs("granted"));
    expect(entry.id).toBeTruthy();
    expect((await entitlementsFor(connectionId)).plan).toBe("free");
  });
});

describe("team roles", () => {
  it("refuses a role the plan doesn't include, rather than quietly granting another", async () => {
    // This used to downgrade the request to "write" and report success.
    // A merchant inviting a receptionist as **read** got a success
    // toast and an account that could create, edit and delete bookings,
    // services and customers — with nothing on the form, in the toast,
    // or on the pending-invite row saying why. updateMemberRole already
    // refused the same operation loudly; inviting is the commoner path
    // and now does too.
    await setPlan("starter");

    await expect(
      Team.inviteMember({
        connectionId, email: `role-a-${RUN}@example.com`, role: "read", invitedByUserId: ownerId,
      })
    ).rejects.toMatchObject({ code: "getbooqin_plan_feature" });
  });

  it("still invites at 'write' without the feature — the seat is what the plan sells", async () => {
    // The seat is what the *limit* sells; role choice is the upgrade.
    // Refusing every invite would gate the wrong thing.
    await setPlan("starter");
    const { invite } = await Team.inviteMember({
      connectionId, email: `role-w-${RUN}@example.com`, role: "write", invitedByUserId: ownerId,
    });
    expect(invite.role).toBe("write");
  });

  it("with the feature, the chosen role is honoured", async () => {
    await setPlan("growth");
    const { invite } = await Team.inviteMember({
      connectionId, email: `role-b-${RUN}@example.com`, role: "admin", invitedByUserId: ownerId,
    });
    expect(invite.role).toBe("admin");
  });

  it("changing an existing member's role is refused outright without the feature", async () => {
    // A select that appears to work and silently does nothing is worse
    // than one that says why.
    await setPlan("starter");
    await expect(
      Team.updateMemberRole({ connectionId, targetUserId: ownerId, role: "read", actingUserId: ownerId })
    ).rejects.toMatchObject({ code: "getbooqin_plan_feature" });
  });
});

describe("email templates", () => {
  it("editing wording is refused without the feature", async () => {
    await setPlan("starter");
    await expect(
      setSettings(shop, platform, { templates: { customer_created_subject: "Hi!" } })
    ).rejects.toMatchObject({ code: "getbooqin_plan_feature", status: 402 });
  });

  it("turning a notification OFF is never gated — that must work on any plan", async () => {
    // A merchant on any plan has to be able to stop a message going out.
    // Only the wording is the paid part.
    await setPlan("free");
    const saved = await setSettings(shop, platform, { template_enabled: { customer_reminder: false } });
    expect(saved.template_enabled.customer_reminder).toBe(false);
  });

  it("every other setting still saves freely on Free", async () => {
    await setPlan("free");
    const saved = await setSettings(shop, platform, { business_phone: "+91 555 0100" });
    expect(saved.business_phone).toBe("+91 555 0100");
  });

  it("works on Growth", async () => {
    await setPlan("growth");
    const saved = await setSettings(shop, platform, { templates: { customer_created_subject: "Hi!" } });
    expect(saved.templates.customer_created_subject).toBe("Hi!");
  });
});
