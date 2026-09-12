/**
 * entitlementsFor() is the single function every gate in the product
 * resolves through, so these run against a real Postgres (same
 * convention as src/booking/__tests__ — no Prisma mocking, unique
 * per-run identifiers, cleanup in afterAll).
 *
 * The cases that matter most are the ones where the *row* and the
 * *truth* disagree: an expired trial that nothing has swept, a past-due
 * account inside its grace window, a cancellation that still has paid-for
 * time left. Those are exactly the states a nightly job would get wrong
 * if it hadn't run, and the reason expiry is evaluated lazily.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { entitlementsFor, checkLimit, settleExpiredTrial, PAST_DUE_GRACE_DAYS } from "../entitlements.js";
import { PLANS } from "../plans.js";

const RUN = Date.now();
const userId = `ent-user-${RUN}`;
const ids: string[] = [];

const DAY = 86_400_000;

async function connection(suffix: string): Promise<string> {
  const row = await prisma.connection.create({
    data: {
      userId,
      platform: "manual",
      shop: `ent-${RUN}-${suffix}`,
      credentials: "",
      status: "active",
    },
  });
  ids.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `ent-${RUN}@example.com` } });
});

afterAll(async () => {
  await prisma.entitlement.deleteMany({ where: { connectionId: { in: ids } } });
  await prisma.subscription.deleteMany({ where: { connectionId: { in: ids } } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("entitlementsFor()", () => {
  it("a connection with no subscription row resolves as Free rather than throwing", async () => {
    // Real state: a Connection created before billing existed, or one
    // whose backfill hasn't run yet. It must degrade to the free plan,
    // not 500 the dashboard.
    const id = await connection("norow");
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("free");
    expect(ent.status).toBe("free");
    expect(ent.limits).toEqual(PLANS.free.limits);
    expect(ent.features.size).toBe(0);
  });

  it("a trial with hours left still reads as a day, never as zero", async () => {
    const id = await connection("trial-hours");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() + 3 * 3_600_000) },
    });
    const ent = await entitlementsFor(id);
    expect(ent.trialDaysLeft).toBe(1);
    expect(ent.plan).toBe("growth");
  });

  it("a live trial confers the trialled plan and counts days left", async () => {
    const id = await connection("trialing");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() + 10 * DAY) },
    });
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("growth");
    expect(ent.status).toBe("trialing");
    // Rounded up: the partial day that elapsed between writing the row
    // and reading it must not cost the merchant a day off the counter.
    expect(ent.trialDaysLeft).toBe(10);
    expect(ent.features.has("team_roles")).toBe(true);
  });

  it("an expired trial resolves as Free even though the row still says trialing", async () => {
    // The whole point of lazy expiry: correctness must not depend on a
    // sweep having run.
    const id = await connection("expired");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() - DAY) },
    });

    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("free");
    expect(ent.status).toBe("free");
    expect(ent.features.has("team_roles")).toBe(false);
    expect(ent.limits.resources).toBe(PLANS.free.limits.resources);

    // ...and the row is untouched until something settles it.
    const row = await prisma.subscription.findUnique({ where: { connectionId: id } });
    expect(row?.status).toBe("trialing");
  });

  it("settleExpiredTrial() tidies the row, and is a no-op the second time", async () => {
    const id = await connection("settle");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() - DAY) },
    });
    expect(await settleExpiredTrial(id)).toBe(true);
    expect(await settleExpiredTrial(id)).toBe(false);
    const row = await prisma.subscription.findUnique({ where: { connectionId: id } });
    expect(row?.status).toBe("free");
  });

  it("settleExpiredTrial() leaves a live trial alone", async () => {
    const id = await connection("settle-live");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() + 5 * DAY) },
    });
    expect(await settleExpiredTrial(id)).toBe(false);
  });

  it("past_due keeps full access inside the grace window, and reports that it is in grace", async () => {
    // Neither provider chases the customer the way Stripe does, so the
    // grace period is ours to honour — cutting someone off the moment a
    // card bounces is how a recoverable payment becomes a churned
    // account.
    const id = await connection("pastdue-grace");
    await prisma.subscription.create({
      data: {
        connectionId: id, plan: "growth", status: "past_due",
        currentPeriodEnd: new Date(Date.now() - 2 * DAY),
      },
    });
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("growth");
    expect(ent.status).toBe("past_due");
    expect(ent.inGrace).toBe(true);
  });

  it("past_due drops to Free once the grace window has run out", async () => {
    const id = await connection("pastdue-lapsed");
    await prisma.subscription.create({
      data: {
        connectionId: id, plan: "growth", status: "past_due",
        currentPeriodEnd: new Date(Date.now() - (PAST_DUE_GRACE_DAYS + 1) * DAY),
      },
    });
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("free");
    expect(ent.inGrace).toBe(false);
  });

  it("a cancelled subscription keeps the plan until the paid-for period actually ends", async () => {
    const id = await connection("cancelled-paid");
    await prisma.subscription.create({
      data: {
        connectionId: id, plan: "starter", status: "canceled",
        cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 3 * DAY),
      },
    });
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("starter");
    expect(ent.status).toBe("canceled");
    expect(ent.cancelAtPeriodEnd).toBe(true);
  });

  it("a cancelled subscription drops to Free once that period is over", async () => {
    const id = await connection("cancelled-done");
    await prisma.subscription.create({
      data: {
        connectionId: id, plan: "starter", status: "canceled",
        currentPeriodEnd: new Date(Date.now() - DAY),
      },
    });
    expect((await entitlementsFor(id)).plan).toBe("free");
  });
});

describe("admin overrides", () => {
  it("grants a feature the plan doesn't include — the early-access mechanism", async () => {
    const id = await connection("grant");
    await prisma.subscription.create({ data: { connectionId: id, plan: "free", status: "free" } });
    await prisma.entitlement.create({
      data: { connectionId: id, key: "waitlist", value: "on", grantedByUserId: userId, reason: "design partner" },
    });
    const ent = await entitlementsFor(id);
    expect(ent.features.has("waitlist")).toBe(true);
    expect(ent.overrides[0]).toMatchObject({ key: "waitlist", reason: "design partner" });
  });

  it("revokes a feature the plan does include", async () => {
    const id = await connection("revoke");
    await prisma.subscription.create({ data: { connectionId: id, plan: "growth", status: "active" } });
    await prisma.entitlement.create({
      data: { connectionId: id, key: "export", value: "off", grantedByUserId: userId, reason: "abuse" },
    });
    expect((await entitlementsFor(id)).features.has("export")).toBe(false);
  });

  it("raises a numeric limit", async () => {
    const id = await connection("limit-raise");
    await prisma.subscription.create({ data: { connectionId: id, plan: "free", status: "free" } });
    await prisma.entitlement.create({
      data: { connectionId: id, key: "limit.resources", value: "25", grantedByUserId: userId, reason: "pilot" },
    });
    expect((await entitlementsFor(id)).limits.resources).toBe(25);
  });

  it("accepts 'unlimited' as a limit override", async () => {
    const id = await connection("limit-unlimited");
    await prisma.subscription.create({ data: { connectionId: id, plan: "free", status: "free" } });
    await prisma.entitlement.create({
      data: { connectionId: id, key: "limit.bookingsPerMonth", value: "unlimited", grantedByUserId: userId, reason: "comp" },
    });
    expect((await entitlementsFor(id)).limits.bookingsPerMonth).toBe(Infinity);
  });

  it("an expired grant stops applying but stays on the record", async () => {
    const id = await connection("grant-expired");
    await prisma.subscription.create({ data: { connectionId: id, plan: "free", status: "free" } });
    await prisma.entitlement.create({
      data: {
        connectionId: id, key: "waitlist", value: "on", grantedByUserId: userId,
        reason: "two-week trial of the feature", expiresAt: new Date(Date.now() - DAY),
      },
    });
    const ent = await entitlementsFor(id);
    expect(ent.features.has("waitlist")).toBe(false);
    // Not in force, but not deleted either — /admin still shows it lapsed.
    expect(ent.overrides).toHaveLength(0);
    expect(await prisma.entitlement.count({ where: { connectionId: id } })).toBe(1);
  });

  it("an override on an expired trial applies over Free, not over the trialled plan", async () => {
    const id = await connection("grant-over-expired-trial");
    await prisma.subscription.create({
      data: { connectionId: id, plan: "growth", status: "trialing", trialEndsAt: new Date(Date.now() - DAY) },
    });
    await prisma.entitlement.create({
      data: { connectionId: id, key: "waitlist", value: "on", grantedByUserId: userId, reason: "keep the waitlist" },
    });
    const ent = await entitlementsFor(id);
    expect(ent.plan).toBe("free");
    expect(ent.features.has("waitlist")).toBe(true);
    // ...and nothing else from Growth leaked through.
    expect(ent.features.has("team_roles")).toBe(false);
  });
});

describe("checkLimit()", () => {
  const free = {
    limits: PLANS.free.limits,
    plan: "free" as const,
  } as Parameters<typeof checkLimit>[0];

  it("allows up to, but not including, the cap", () => {
    expect(checkLimit(free, "services", 2).allowed).toBe(true);
    expect(checkLimit(free, "services", 3).allowed).toBe(false);
  });

  it("reports being over the cap without blocking — a downgrade is never destructive", () => {
    // A Growth account with 6 resources that drops to Starter keeps all
    // 6; what's blocked is creating the 7th. This is what drives the
    // banner rather than a deletion.
    const over = checkLimit(free, "resources", 6);
    expect(over.over).toBe(true);
    expect(over.used).toBe(6);
    expect(over.cap).toBe(1);
  });

  it("never reports 'over' when usage is exactly at the cap", () => {
    const atCap = checkLimit(free, "resources", 1);
    expect(atCap.over).toBe(false);
    expect(atCap.allowed).toBe(false);
  });

  it("always allows when the cap is unlimited", () => {
    const growth = { limits: PLANS.growth.limits, plan: "growth" as const } as Parameters<typeof checkLimit>[0];
    expect(checkLimit(growth, "bookingsPerMonth", 10_000).allowed).toBe(true);
    expect(checkLimit(growth, "bookingsPerMonth", 10_000).over).toBe(false);
  });
});
