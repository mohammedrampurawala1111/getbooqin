/**
 * Which price points can actually be charged.
 *
 * A plan id is created by hand at the provider and pasted into
 * plans.ts, so an empty slot is the ordinary state of a price nobody
 * has created yet — and it is indistinguishable from a working one
 * everywhere except here. These tests are about the operator's view of
 * that, which is the view that has to exist *before* a merchant finds
 * out from an empty Billing screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { billingCoverage } from "../checkout.js";
import { PRICES } from "../plans.js";
import { __resetPlanIndexForTests } from "../providers/razorpay.js";

const SAVED = { ...process.env };

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_live_test";
  process.env.PAYPAL_ENV = "live";
});

afterEach(() => {
  process.env = { ...SAVED };
  __resetPlanIndexForTests();
});

describe("billingCoverage()", () => {
  it("covers every paid price point — three plans, three currencies, two cycles", () => {
    expect(billingCoverage().totalCount).toBe(18);
  });

  it("names the rail each currency routes to, so a gap points at the right vendor", () => {
    const { prices } = billingCoverage();

    expect(prices.filter((p) => p.currency === "INR").every((p) => p.provider === "razorpay")).toBe(true);
    expect(prices.filter((p) => p.currency !== "INR").every((p) => p.provider === "paypal")).toBe(true);
  });

  it("reports the mode each rail is in, because that decides whether money moves", () => {
    const { prices } = billingCoverage();

    expect(prices.find((p) => p.currency === "INR")!.mode).toBe("live");
    expect(prices.find((p) => p.currency === "USD")!.mode).toBe("live");
  });

  it("flags a currency where nothing at all can be bought", () => {
    // The state this was written for: PayPal plan ids never created, so
    // a USD or EUR merchant reaches a Billing screen with nothing on it.
    const coverage = billingCoverage();
    const usdSellable = coverage.prices.some((p) => p.currency === "USD" && p.sellable);

    expect(coverage.deadCurrencies.includes("USD")).toBe(!usdSellable);
  });

  it("counts a price as sellable only once its id exists in the mode being run", () => {
    const before = billingCoverage();
    const slot = PRICES.starter.USD.monthly.paypal!;
    const restore = { ...slot };

    slot.live = "P-LIVE-STARTER-USD-MONTHLY";
    const after = billingCoverage();

    expect(after.sellableCount).toBe(before.sellableCount + 1);
    expect(after.prices.find((p) => p.plan === "starter" && p.currency === "USD" && p.cycle === "monthly")!.sellable)
      .toBe(true);
    expect(after.deadCurrencies).not.toContain("USD");

    Object.assign(slot, restore);
  });

  it("does not count a live id when the rail is running in sandbox", () => {
    // The asymmetry that makes a sandbox deployment look configured:
    // the id is right there in the table, and it is the wrong half.
    //
    // Both halves are set explicitly rather than only `live`, so this
    // observes the property regardless of which slots happen to be
    // populated. It first failed when the real sandbox ids landed —
    // the assertion was right and the fixture had quietly stopped
    // isolating it.
    const slot = PRICES.starter.USD.monthly.paypal!;
    const restore = { ...slot };
    slot.test = "";
    slot.live = "P-LIVE-STARTER-USD-MONTHLY";

    process.env.PAYPAL_ENV = "sandbox";

    expect(billingCoverage().prices.find(
      (p) => p.plan === "starter" && p.currency === "USD" && p.cycle === "monthly"
    )!.sellable).toBe(false);

    Object.assign(slot, restore);
  });
});
