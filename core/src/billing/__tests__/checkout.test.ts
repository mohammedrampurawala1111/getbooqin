/**
 * The rules that decide whether an upgrade may start. Deliberately
 * tested without reaching Razorpay: the provider call is the *last*
 * thing startCheckout does, so every refusal below is proven to happen
 * before any mandate could be created.
 *
 * The expensive mistakes here are all "charged twice" shaped — a second
 * mandate alongside a live one, a re-submitted form, a plan nobody can
 * actually be billed for.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../db.js";
import { startCheckout, parsePlanSelection } from "../checkout.js";
import { PRICES } from "../plans.js";
import { __resetPlanIndexForTests } from "../providers/razorpay.js";

const RUN = Date.now();
const userId = `co-user-${RUN}`;
let connectionId: string;

beforeAll(async () => {
  // No credentials: createSubscription() throws the moment it is
  // reached, so any test that gets that far fails loudly rather than
  // silently calling a real API.
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  __resetPlanIndexForTests();

  await prisma.user.create({ data: { id: userId, email: `co-${RUN}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId, platform: "manual", shop: `co-${RUN}`, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

afterEach(async () => {
  await prisma.subscription.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  __resetPlanIndexForTests();
});

async function subscribe(data: Record<string, unknown>) {
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.subscription.create({ data: { connectionId, currency: "INR", ...data } as never });
}

describe("parsePlanSelection()", () => {
  it("rejects the free plan — there is nothing to check out", () => {
    expect(() => parsePlanSelection("free", "monthly")).toThrow();
  });

  it("rejects an unknown plan or cycle rather than defaulting", () => {
    expect(() => parsePlanSelection("enterprise", "monthly")).toThrow();
    expect(() => parsePlanSelection("growth", "weekly")).toThrow();
    expect(() => parsePlanSelection(null, null)).toThrow();
  });

  it("accepts a real selection", () => {
    expect(parsePlanSelection("growth", "yearly")).toEqual({ plan: "growth", cycle: "yearly" });
  });
});

describe("startCheckout() refusals", () => {
  it("refuses a second mandate for the plan already being paid for", async () => {
    // A re-submitted form, or a double-click, must not create a second
    // recurring debit alongside the live one.
    await subscribe({ plan: "growth", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
      status: 409,
    });
  });

  it("refuses even while past_due — the mandate is still live", async () => {
    await subscribe({ plan: "growth", status: "past_due", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
    });
  });

  it("allows switching cycle on the same plan", async () => {
    // Monthly -> yearly is a real change, not a duplicate. It gets past
    // the guard and fails at the provider call instead, which is proof
    // the refusal isn't what stopped it.
    await subscribe({ plan: "growth", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "yearly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_already_subscribed" });
  });

  it("refuses a hidden tier for an account that hasn't been granted it", async () => {
    // `business` ships defined-but-invisible; reaching it by posting the
    // form directly shouldn't work.
    await subscribe({ plan: "free", status: "free" });
    await expect(startCheckout({ connectionId, plan: "business", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_plan_unavailable",
      status: 403,
    });
  });

  it("allows a hidden tier once an admin has actually put the account on it", async () => {
    await subscribe({ plan: "business", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, plan: "business", cycle: "yearly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_plan_unavailable" });
  });

  it("surfaces a provider failure as a 502 without leaking vendor detail to the merchant", async () => {
    await subscribe({ plan: "free", status: "free" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_checkout_failed",
      status: 502,
    });
  });

  it("writes no plan or status when checkout fails", async () => {
    // The whole design rests on nothing but the webhook granting a
    // plan. A failed checkout must leave the row exactly as it was.
    await subscribe({ plan: "free", status: "free" });
    await startCheckout({ connectionId, plan: "growth", cycle: "monthly" }).catch(() => {});
    const row = await prisma.subscription.findUnique({ where: { connectionId } });
    expect(row?.plan).toBe("free");
    expect(row?.status).toBe("free");
    expect(row?.providerSubscriptionId).toBeNull();
  });
});

describe("plan ids", () => {
  it("every INR price the checkout can sell has a test id configured", () => {
    // These are the four created in Razorpay test mode and verified
    // against their API. A missing one means checkout refuses that
    // price, which is safe but invisible until someone tries to buy it.
    for (const plan of ["starter", "growth"] as const) {
      for (const cycle of ["monthly", "yearly"] as const) {
        expect(PRICES[plan].INR[cycle].razorpay.test, `${plan}/${cycle}`).toMatch(/^plan_/);
      }
    }
  });

  it("growth yearly has no live id — the first live plan billed monthly", () => {
    // Guard against pasting plan_TbDSgwJW8j7O0t back in: it is named
    // yearly but was created with period=monthly, a 12x overcharge.
    expect(PRICES.growth.INR.yearly.razorpay.live).toBe("");
  });
});
