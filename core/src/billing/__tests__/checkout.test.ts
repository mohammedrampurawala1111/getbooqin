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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  // The shop's own currency, which is what resolveBillingCurrency()
  // reads. Without it every test here silently billed in USD — which
  // did not matter while one rail carried all three currencies, and
  // matters entirely now that USD routes to PayPal and INR to Razorpay.
  await prisma.shopSettings.create({
    data: {
      shop: conn.shop,
      platform: conn.platform,
      data: JSON.stringify({ currency: "INR", timezone: "Asia/Kolkata" }),
    },
  });
});

afterEach(async () => {
  await prisma.subscription.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  await prisma.shopSettings.deleteMany({ where: { shop: `co-${RUN}` } });
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

describe("tax identity", () => {
  it("requires a country", async () => {
    await subscribe({ plan: "free", status: "free" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_tax_identity",
    });
  });

  it("does not require a tax number outside India either", async () => {
    // One field, one behaviour everywhere: always shown, never
    // required, accepted when given. An EU merchant below their own
    // registration threshold has no VAT number, exactly as an Indian
    // one below theirs has no GSTIN, and neither should meet a wall.
    //
    // The tax position is not lost, only stated honestly: the sale
    // carries `eu_no_vat_id` rather than being labelled a reverse-charge
    // export it is not.
    await subscribe({ plan: "free", status: "free", currency: "EUR" });
    await expect(startCheckout({ connectionId, country: "NL", plan: "growth", cycle: "monthly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_tax_identity" });
  });

  it("does not require a GSTIN from an Indian customer", async () => {
    // Plenty of legitimate Indian businesses are below the registration
    // threshold. Blocking them would be wrong.
    await subscribe({ plan: "free", status: "free" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_tax_identity" });
  });

  it("state guards answer before tax validation does", async () => {
    // "You're already on this plan" is a more useful answer than "enter
    // your VAT number" for someone who double-submitted.
    await subscribe({ plan: "growth", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
    });
  });
});

describe("startCheckout() refusals", () => {
  it("refuses a second mandate for the plan already being paid for", async () => {
    // A re-submitted form, or a double-click, must not create a second
    // recurring debit alongside the live one.
    await subscribe({ plan: "growth", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
      status: 409,
    });
  });

  it("refuses even while past_due — the mandate is still live", async () => {
    await subscribe({ plan: "growth", status: "past_due", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
    });
  });

  it("allows switching cycle on the same plan", async () => {
    // Monthly -> yearly is a real change, not a duplicate. It gets past
    // the guard and fails at the provider call instead, which is proof
    // the refusal isn't what stopped it.
    await subscribe({ plan: "growth", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "yearly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_already_subscribed" });
  });

  it("refuses a hidden tier for an account that hasn't been granted it", async () => {
    // `business` ships defined-but-invisible; reaching it by posting the
    // form directly shouldn't work.
    await subscribe({ plan: "free", status: "free" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "business", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_plan_unavailable",
      status: 403,
    });
  });

  it("allows a hidden tier once an admin has actually put the account on it", async () => {
    await subscribe({ plan: "business", status: "active", billingCycle: "monthly" });
    await expect(startCheckout({ connectionId, country: "IN", plan: "business", cycle: "yearly" }))
      .rejects.not.toMatchObject({ code: "getbooqin_plan_unavailable" });
  });

  it("refuses before touching the vendor when no plan exists there for this currency", async () => {
    // A price in plans.ts is not a plan at the provider. Refusing here
    // rather than letting createSubscription fail means no mandate can
    // be half-created, and the merchant gets an answer about their
    // currency instead of a generic failure.
    await subscribe({ plan: "free", status: "free" });

    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_provider_unavailable",
      status: 503,
    });
  });

  it("surfaces a genuine provider failure as a 502 without leaking vendor detail", async () => {
    // Past every guard, so what fails is the vendor call itself. The
    // merchant must get one plain sentence, never Razorpay's own error
    // text — that is operator detail and it reads as our product being
    // broken in a way they could fix.
    const original = PRICES.growth.INR.monthly.razorpay;
    PRICES.growth.INR.monthly.razorpay = { test: `plan_fail_${RUN}`, live: "" };
    process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
    process.env.RAZORPAY_KEY_SECRET = "secret_fixture";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_fixture";
    __resetPlanIndexForTests();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { description: "Merchant account is suspended" } }), { status: 400 })
    );

    await subscribe({ plan: "free", status: "free" });

    const failure = await startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" }).catch(
      (e) => e
    );

    expect(failure).toMatchObject({ code: "getbooqin_checkout_failed", status: 502 });
    expect(String(failure.message)).not.toContain("suspended");

    vi.restoreAllMocks();
    PRICES.growth.INR.monthly.razorpay = original;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    __resetPlanIndexForTests();
  });

  it("writes no plan or status when checkout fails", async () => {
    // The whole design rests on nothing but the webhook granting a
    // plan. A failed checkout must leave the row exactly as it was.
    await subscribe({ plan: "free", status: "free" });
    await startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" }).catch(() => {});
    const row = await prisma.subscription.findUnique({ where: { connectionId } });
    expect(row?.plan).toBe("free");
    expect(row?.status).toBe("free");
    expect(row?.providerSubscriptionId).toBeNull();
  });
});

describe("the mandate the app doesn't know is live", () => {
  /**
   * The failure these guard is the one a QA pass hit in production: a
   * subscription went active at Razorpay, the webhook never arrived, and
   * the local row still said "trialing". Every guard in startCheckout
   * reads that row — so the merchant was offered, and could take, a
   * second recurring debit beside the one already charging them.
   */
  function providerSays(body: unknown, status = 200) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      );
  }

  afterEach(() => vi.restoreAllMocks());

  it("asks the provider before trusting a row that says the account isn't paying", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
    process.env.RAZORPAY_KEY_SECRET = "secret_fixture";
    // Saved, not assumed empty: this slot carries a real committed plan
    // id, and restoring it to "" leaves the price table wrong for every
    // test that runs after this one.
    const original = PRICES.growth.INR.monthly.razorpay.test;
    PRICES.growth.INR.monthly.razorpay.test = `plan_co_${RUN}`;
    __resetPlanIndexForTests();

    await subscribe({
      plan: "growth",
      status: "trialing",
      billingCycle: "monthly",
      billingProvider: "razorpay",
      providerSubscriptionId: `sub_co_${RUN}`,
      trialEndsAt: new Date(Date.now() + 20 * 86_400_000),
    });

    // Razorpay: this is active, and on Growth monthly.
    providerSays({
      id: `sub_co_${RUN}`,
      plan_id: `plan_co_${RUN}`,
      status: "active",
      current_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
    });

    // Reconciled first, so the "already subscribed" guard now sees the
    // truth and refuses — instead of cheerfully starting a second one.
    await expect(startCheckout({ connectionId, country: "IN", plan: "growth", cycle: "monthly" })).rejects.toMatchObject({
      code: "getbooqin_already_subscribed",
    });

    PRICES.growth.INR.monthly.razorpay.test = original;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    __resetPlanIndexForTests();
  });
});

describe("plan ids", () => {
  it("every visible price has a test id in all three currencies", () => {
    // All twelve were created in Razorpay test mode and read back
    // against their API before being committed. A missing one means
    // checkout refuses that price — safe, but invisible until someone
    // tries to buy it, which is how the first two attempts failed.
    for (const plan of ["starter", "growth"] as const) {
      for (const currency of ["INR", "USD", "EUR"] as const) {
        for (const cycle of ["monthly", "yearly"] as const) {
          expect(PRICES[plan][currency][cycle].razorpay.test, `${plan}/${currency}/${cycle}`).toMatch(/^plan_/);
        }
      }
    }
  });

  it("the hidden business tier has no ids — it is not for sale yet", () => {
    for (const currency of ["INR", "USD", "EUR"] as const) {
      for (const cycle of ["monthly", "yearly"] as const) {
        expect(PRICES.business[currency][cycle].razorpay.test, `${currency}/${cycle}`).toBe("");
      }
    }
  });

  it("growth yearly has no live id — the first live plan billed monthly", () => {
    // Guard against pasting plan_TbDSgwJW8j7O0t back in: it is named
    // yearly but was created with period=monthly, a 12x overcharge.
    expect(PRICES.growth.INR.yearly.razorpay.live).toBe("");
  });
});
