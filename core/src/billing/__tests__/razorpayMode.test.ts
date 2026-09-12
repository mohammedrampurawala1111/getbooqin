/**
 * Mode selection. Small surface, expensive to get wrong: picking the
 * wrong column means either charging test plans with live keys (nobody
 * pays, and it looks like it worked) or the reverse.
 */
import { afterEach, describe, expect, it } from "vitest";
import { razorpayMode, providerPlanId, __resetPlanIndexForTests } from "../providers/razorpay.js";
import { PRICES } from "../plans.js";

const saved = process.env.RAZORPAY_KEY_ID;

afterEach(() => {
  if (saved === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = saved;
  PRICES.growth.INR.monthly.razorpay.test = "";
  PRICES.growth.INR.monthly.razorpay.live = "";
  __resetPlanIndexForTests();
});

describe("razorpayMode()", () => {
  it("reads live from the key's own prefix", () => {
    process.env.RAZORPAY_KEY_ID = "rzp_live_AbC123";
    expect(razorpayMode()).toBe("live");
  });

  it("reads test from the key's own prefix", () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_AbC123";
    expect(razorpayMode()).toBe("test");
  });

  it("defaults to test when no key is set", () => {
    // A missing key must never select the ids that move real money.
    delete process.env.RAZORPAY_KEY_ID;
    expect(razorpayMode()).toBe("test");
  });

  it("defaults to test for a malformed key rather than guessing live", () => {
    process.env.RAZORPAY_KEY_ID = "not-a-razorpay-key";
    expect(razorpayMode()).toBe("test");
  });
});

describe("providerPlanId()", () => {
  it("returns the id for the mode the key selects", () => {
    PRICES.growth.INR.monthly.razorpay.test = "plan_test_growth";
    PRICES.growth.INR.monthly.razorpay.live = "plan_live_growth";

    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    expect(providerPlanId("growth", "INR", "monthly")).toBe("plan_test_growth");

    process.env.RAZORPAY_KEY_ID = "rzp_live_x";
    expect(providerPlanId("growth", "INR", "monthly")).toBe("plan_live_growth");
  });

  it("returns null when the plan hasn't been created at Razorpay yet", () => {
    // The checkout must refuse rather than guess — the alternative is
    // subscribing someone to the wrong price.
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    expect(providerPlanId("growth", "INR", "monthly")).toBeNull();
  });

  it("has nothing to sell on the free plan", () => {
    expect(providerPlanId("free", "INR", "monthly")).toBeNull();
  });
});
