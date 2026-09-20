/**
 * The PayPal rail.
 *
 * Three things here can lose money quietly, and they are what this
 * covers: converting PayPal's decimal amounts into our minor units,
 * deciding which of its statuses means "paid", and refusing a delivery
 * we cannot prove came from PayPal.
 *
 * No network. The provider's own HTTP is stubbed, because what is being
 * tested is our reading of PayPal's answers, not PayPal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PayPalProvider,
  toMinorUnits,
  toDecimalString,
  statusFor,
  isLive,
  mode,
  __resetTokenForTests,
  __resetPlanIndexForTests,
} from "../providers/paypal.js";
import { PRICES } from "../plans.js";

const PLAN_ID = `P-TEST-${Date.now()}`;

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    // Every call is preceded by a token fetch; answer it once, here.
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3000 }), { status: 200 });
    }
    const result = handler(url, init as RequestInit);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  });
}

beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "id";
  process.env.PAYPAL_CLIENT_SECRET = "secret";
  process.env.PAYPAL_WEBHOOK_ID = "wh_1";
  process.env.PAYPAL_ENV = "sandbox";
  __resetTokenForTests();
  __resetPlanIndexForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID;
  delete process.env.PAYPAL_ENV;
  __resetTokenForTests();
  __resetPlanIndexForTests();
});

describe("money", () => {
  it("converts PayPal's decimal strings without going through a float", () => {
    // Number("11.45") * 100 is 1144.9999999999998. Rounding hides it
    // right up until an invoice is a penny off what was charged.
    expect(toMinorUnits("11.45")).toBe(1145);
    expect(toMinorUnits("5.00")).toBe(500);
    expect(toMinorUnits("0.01")).toBe(1);
    expect(toMinorUnits("1234.56")).toBe(123456);
  });

  it("handles amounts with one or no decimal place", () => {
    expect(toMinorUnits("5")).toBe(500);
    expect(toMinorUnits("5.5")).toBe(550);
  });

  it("handles a refund's negative amount", () => {
    expect(toMinorUnits("-5.00")).toBe(-500);
  });

  it("treats a missing amount as nothing, not NaN", () => {
    expect(toMinorUnits(undefined)).toBe(0);
    expect(toMinorUnits("")).toBe(0);
  });

  it("round-trips back to what PayPal expects", () => {
    expect(toDecimalString(500)).toBe("5.00");
    expect(toDecimalString(123456)).toBe("1234.56");
    expect(toDecimalString(1)).toBe("0.01");
  });
});

describe("status", () => {
  it("grants a plan only once PayPal says ACTIVE", () => {
    expect(statusFor("ACTIVE")).toBe("active");
  });

  it("grants nothing for an approval that has not been charged", () => {
    // APPROVED means the customer clicked through; the first charge can
    // still fail. Granting here hands out a paid tier for a click.
    expect(statusFor("APPROVED")).toBeNull();
    expect(statusFor("APPROVAL_PENDING")).toBeNull();
  });

  it("treats SUSPENDED as past_due, so access lapses on our grace clock", () => {
    expect(statusFor("SUSPENDED")).toBe("past_due");
  });

  it("ends a cancelled or expired subscription", () => {
    expect(statusFor("CANCELLED")).toBe("canceled");
    expect(statusFor("EXPIRED")).toBe("canceled");
  });

  it("knows which states could still take money", () => {
    // Used before starting a second subscription. Getting this wrong in
    // one direction costs a redundant API call; in the other it charges
    // someone twice.
    for (const live of ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"]) {
      expect(isLive(live), live).toBe(true);
    }
    for (const dead of ["CANCELLED", "EXPIRED"]) {
      expect(isLive(dead), dead).toBe(false);
    }
  });
});

describe("webhook verification", () => {
  it("refuses when the webhook id is not configured", async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;

    expect(await PayPalProvider.verifyWebhook("{}", new Headers())).toBe(false);
  });

  it("refuses a delivery missing PayPal's transmission headers", async () => {
    expect(await PayPalProvider.verifyWebhook("{}", new Headers({ "paypal-auth-algo": "SHA256withRSA" }))).toBe(false);
  });

  it("accepts only when PayPal itself says SUCCESS", async () => {
    stubFetch(() => ({ verification_status: "SUCCESS" }));

    expect(await PayPalProvider.verifyWebhook("{}", signedHeaders())).toBe(true);
  });

  it("refuses when PayPal says FAILURE", async () => {
    stubFetch(() => ({ verification_status: "FAILURE" }));

    expect(await PayPalProvider.verifyWebhook("{}", signedHeaders())).toBe(false);
  });

  it("fails closed when the verification call itself errors", async () => {
    // An unverifiable delivery is treated exactly like a forged one.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    expect(await PayPalProvider.verifyWebhook("{}", signedHeaders())).toBe(false);
  });
});

function signedHeaders(): Headers {
  return new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert.pem",
    "paypal-transmission-id": "t1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-09-13T00:00:00Z",
  });
}

describe("reading events", () => {
  beforeEach(() => {
    PRICES.starter.EUR.monthly.paypal = { test: PLAN_ID, live: "" };
    __resetPlanIndexForTests();
  });

  afterEach(() => {
    PRICES.starter.EUR.monthly.paypal = { test: "", live: "" };
    __resetPlanIndexForTests();
  });

  it("maps an activation onto our own vocabulary", () => {
    const event = PayPalProvider.parseEvent(
      JSON.stringify({
        id: "WH-1",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: {
          id: "I-SUB1",
          plan_id: PLAN_ID,
          custom_id: "conn_1",
          status: "ACTIVE",
          billing_info: { next_billing_time: "2026-11-12T10:00:00Z" },
        },
      }),
      new Headers()
    );

    expect(event).toMatchObject({
      type: "subscription_active",
      providerSubscriptionId: "I-SUB1",
      connectionId: "conn_1",
      plan: "starter",
      currency: "EUR",
      billingCycle: "monthly",
    });
    // An activation is not a payment — nothing to invoice against.
    expect(event?.payment).toBeNull();
  });

  it("reads the money out of a completed sale", () => {
    // The only event with an amount in it, and the only one an invoice
    // can be issued against.
    const event = PayPalProvider.parseEvent(
      JSON.stringify({
        id: "WH-2",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: {
          id: "PAY-1",
          billing_agreement_id: "I-SUB1",
          amount: { total: "5.00", currency: "EUR" },
        },
      }),
      new Headers()
    );

    expect(event?.type).toBe("subscription_active");
    expect(event?.providerSubscriptionId).toBe("I-SUB1");
    expect(event?.payment).toEqual({
      id: "PAY-1",
      amountMinor: 500,
      currency: "EUR",
      providerInvoiceId: null,
    });
  });

  it("finds the account through custom_id, months after any session", () => {
    const event = PayPalProvider.parseEvent(
      JSON.stringify({
        id: "WH-3",
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-SUB1", custom_id: "conn_42", plan_id: PLAN_ID },
      }),
      new Headers()
    );

    expect(event).toMatchObject({ type: "subscription_ended", connectionId: "conn_42" });
  });

  it("maps a suspension to the final-failure state, not to cancelled", () => {
    const event = PayPalProvider.parseEvent(
      JSON.stringify({ id: "WH-4", event_type: "BILLING.SUBSCRIPTION.SUSPENDED", resource: { id: "I-SUB1" } }),
      new Headers()
    );

    expect(event?.type).toBe("payment_failed_final");
  });

  it("records an event it does not act on rather than dropping it", () => {
    const event = PayPalProvider.parseEvent(
      JSON.stringify({ id: "WH-5", event_type: "PAYMENT.SALE.REFUNDED", resource: { id: "PAY-9" } }),
      new Headers()
    );

    expect(event?.type).toBe("ignored");
    expect(event?.providerEventName).toBe("PAYMENT.SALE.REFUNDED");
  });

  it("returns null for something that is not a PayPal event at all", () => {
    expect(PayPalProvider.parseEvent("not json", new Headers())).toBeNull();
    expect(PayPalProvider.parseEvent(JSON.stringify({ hello: "world" }), new Headers())).toBeNull();
  });

  it("does not guess a plan from an id this build doesn't know", () => {
    // An event for a plan created in the dashboard but never added to
    // plans.ts must not silently downgrade someone.
    const event = PayPalProvider.parseEvent(
      JSON.stringify({
        id: "WH-6",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-SUB1", plan_id: "P-UNKNOWN", custom_id: "conn_1" },
      }),
      new Headers()
    );

    expect(event?.plan).toBeNull();
    expect(event?.currency).toBeNull();
  });
});

describe("configuration", () => {
  it("defaults to sandbox rather than guessing live", () => {
    // PayPal credentials look identical in both environments, so this
    // is explicit — the wrong guess means real money.
    delete process.env.PAYPAL_ENV;
    expect(mode()).toBe("sandbox");

    process.env.PAYPAL_ENV = "live";
    expect(mode()).toBe("live");
  });

  it("is not configured without both credentials and a webhook id", () => {
    // Creating mandates it can never be told about is the failure that
    // takes money and grants nothing.
    expect(PayPalProvider.isConfigured()).toBe(true);

    delete process.env.PAYPAL_WEBHOOK_ID;
    expect(PayPalProvider.isConfigured()).toBe(false);
  });

  it("has no plan id until one has been created at PayPal", () => {
    expect(PayPalProvider.planId("starter", "EUR", "monthly")).toBe("");
  });
});

describe("creating a subscription", () => {
  beforeEach(() => {
    PRICES.starter.EUR.monthly.paypal = { test: PLAN_ID, live: "" };
    __resetPlanIndexForTests();
  });
  afterEach(() => {
    PRICES.starter.EUR.monthly.paypal = { test: "", live: "" };
    __resetPlanIndexForTests();
  });

  it("sends the return URL PayPal actually honours", async () => {
    // The thing Razorpay cannot do: bring the merchant back into the
    // product after they approve.
    let sent: Record<string, unknown> = {};
    stubFetch((url, init) => {
      if (url.includes("/v1/billing/subscriptions")) {
        sent = JSON.parse(String(init?.body));
        return { id: "I-NEW", links: [{ rel: "approve", href: "https://paypal.example/approve" }] };
      }
      return {};
    });

    const created = await PayPalProvider.createSubscription({
      connectionId: "conn_1",
      plan: "starter",
      currency: "EUR",
      cycle: "monthly",
      returnUrl: "https://app.example/back",
    });

    expect(created).toEqual({ providerSubscriptionId: "I-NEW", approvalUrl: "https://paypal.example/approve" });
    expect(sent.plan_id).toBe(PLAN_ID);
    // Our thread back, on every future event for this subscription.
    expect(sent.custom_id).toBe("conn_1");
    expect((sent.application_context as Record<string, string>).return_url).toBe("https://app.example/back");
  });

  it("refuses when no plan exists at PayPal for that currency", async () => {
    PRICES.starter.EUR.monthly.paypal = { test: "", live: "" };
    __resetPlanIndexForTests();

    await expect(
      PayPalProvider.createSubscription({ connectionId: "c", plan: "starter", currency: "EUR", cycle: "monthly" })
    ).rejects.toThrow(/No PayPal sandbox plan/);
  });
});

describe("cancelling something that was never approved", () => {
  /**
   * The failure this exists for, and it bit a real account.
   *
   * PayPal creates a subscription in APPROVAL_PENDING the moment
   * checkout starts. A merchant who closes the PayPal tab leaves that
   * id on the row — and `isLive` counts APPROVAL_PENDING as a live
   * mandate, correctly, because Razorpay's equivalent state can be
   * cancelled and this is the shared predicate.
   *
   * PayPal cannot cancel one. It answers 404. So the next upgrade
   * attempt was refused with "we couldn't close your current
   * subscription, so we've stopped rather than risk charging you
   * twice" — permanently, with no way for the merchant to clear it,
   * because there is nothing to cancel on a mandate nobody authorised.
   */
  it("treats a 404 as already cancelled rather than a hard failure", async () => {
    stubFetch((url) => {
      if (String(url).includes("/oauth2/token")) return { access_token: "t" };
      return new Response(JSON.stringify({ message: "The specified resource does not exist." }), { status: 404 });
    });

    await expect(PayPalProvider.cancelSubscription("I-NEVERAPPROVED", { immediately: false }))
      .resolves.toBeUndefined();
  });

  it("still treats 422 as already cancelled", async () => {
    stubFetch((url) => {
      if (String(url).includes("/oauth2/token")) return { access_token: "t" };
      return new Response(JSON.stringify({ message: "Invalid state." }), { status: 422 });
    });

    await expect(PayPalProvider.cancelSubscription("I-ALREADYGONE", {})).resolves.toBeUndefined();
  });

  it("still fails loudly on a real error", async () => {
    // A 500 is not "nothing to cancel" — proceeding past it could leave
    // two live mandates, which the merchant discovers through their
    // bank statement.
    stubFetch((url) => {
      if (String(url).includes("/oauth2/token")) return { access_token: "t" };
      return new Response(JSON.stringify({ message: "Internal error." }), { status: 500 });
    });

    await expect(PayPalProvider.cancelSubscription("I-LIVE", {})).rejects.toThrow(/500/);
  });
});
