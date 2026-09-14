/**
 * Reconciliation — the answer to "the payment went through and the app
 * never noticed".
 *
 * This is the exact failure a QA pass found against production: a
 * test-mode subscription went active at Razorpay, the webhook never
 * arrived (Razorpay registers webhooks separately per mode, so a
 * live-mode endpoint hears nothing about a test-mode charge), and the
 * account sat on its trial still offering the upgrade it had already
 * been paid for.
 *
 * Real database, `fetch` stubbed — the provider call is the one thing
 * that cannot be made against Razorpay from a test run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../db.js";
import { reconcileSubscription, worthReconciling } from "../reconcile.js";
import { __resetPlanIndexForTests } from "../providers/razorpay.js";
import { PRICES } from "../plans.js";
import { entitlementsFor } from "../entitlements.js";

const RUN = Date.now();
const userId = `rec-user-${RUN}`;
const SUB_ID = `sub_rec_${RUN}`;
const STARTER_MONTHLY_EUR = `plan_starter_monthly_eur_${RUN}`;
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 86_400;

let connectionId: string;
/** The committed plan id this test borrows the slot of — restored, not blanked. */
let originalPlanId = "";

/**
 * Razorpay's answer to a subscription lookup. A fresh Response per
 * call, not one shared object — a body can only be read once, so
 * reusing it makes the second lookup in a test look like a network
 * failure.
 */
function providerSays(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
}

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    entity: "subscription",
    plan_id: STARTER_MONTHLY_EUR,
    customer_id: `cust_rec_${RUN}`,
    status: "active",
    current_end: PERIOD_END,
    notes: { connection_id: connectionId },
    ...over,
  };
}

/** The state the bug leaves behind: a mandate recorded, a trial still running. */
async function stuckOnTrial() {
  await prisma.subscription.upsert({
    where: { connectionId },
    create: {
      connectionId,
      plan: "growth",
      status: "trialing",
      billingProvider: "razorpay",
      currency: "EUR",
      billingCycle: "monthly",
      providerSubscriptionId: SUB_ID,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    update: {
      plan: "growth",
      status: "trialing",
      billingProvider: "razorpay",
      currency: "EUR",
      billingCycle: "monthly",
      providerSubscriptionId: SUB_ID,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
  });
}

beforeAll(async () => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
  process.env.RAZORPAY_KEY_SECRET = "secret_fixture";
  originalPlanId = PRICES.starter.EUR.monthly.razorpay.test;
  PRICES.starter.EUR.monthly.razorpay.test = STARTER_MONTHLY_EUR;
  __resetPlanIndexForTests();

  await prisma.user.create({ data: { id: userId, email: `rec-${RUN}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId, platform: "manual", shop: `rec-${RUN}`, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

beforeEach(stuckOnTrial);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  PRICES.starter.EUR.monthly.razorpay.test = originalPlanId;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  __resetPlanIndexForTests();
});

describe("the payment cleared but no webhook arrived", () => {
  it("activates the plan from the provider's own answer", async () => {
    providerSays(subscription());

    const result = await reconcileSubscription(connectionId);

    expect(result.changed).toBe(true);
    const ent = await entitlementsFor(connectionId);
    expect(ent.plan).toBe("starter");
    expect(ent.status).toBe("active");
  });

  it("takes the plan, currency and cycle from the plan id that was actually charged", async () => {
    // Not from what the local row happened to say — the row says Growth
    // and the merchant paid for Starter.
    providerSays(subscription());

    await reconcileSubscription(connectionId);

    const row = await prisma.subscription.findUnique({ where: { connectionId } });
    expect(row).toMatchObject({ plan: "starter", currency: "EUR", billingCycle: "monthly" });
    expect(row?.currentPeriodEnd?.getTime()).toBe(PERIOD_END * 1000);
    // The trial is over — it was superseded by a real subscription.
    expect(row?.trialEndsAt).toBeNull();
  });

  it("is idempotent — running it again changes nothing", async () => {
    providerSays(subscription());
    await reconcileSubscription(connectionId);

    const second = await reconcileSubscription(connectionId);

    expect(second.changed).toBe(false);
    expect(second.reason).toBe("already in step");
  });
});

describe("states that must not grant a plan", () => {
  it("does not activate on an authorised mandate that has not been charged", async () => {
    // UPI AutoPay can authenticate and then fail its first charge.
    // Granting here hands out a paid tier for an authorisation alone —
    // the same line the webhook draws for subscription.authenticated.
    providerSays(subscription({ status: "authenticated" }));

    const result = await reconcileSubscription(connectionId);

    expect(result.changed).toBe(false);
    expect((await entitlementsFor(connectionId)).status).toBe("trialing");
  });

  it("does not activate on a subscription that was only created", async () => {
    providerSays(subscription({ status: "created" }));

    expect((await reconcileSubscription(connectionId)).changed).toBe(false);
    expect((await entitlementsFor(connectionId)).status).toBe("trialing");
  });

  it("records a failing subscription as past_due, not cancelled", async () => {
    // Access lapses on our clock, via the grace window — not the instant
    // Razorpay stops retrying.
    providerSays(subscription({ status: "halted" }));

    await reconcileSubscription(connectionId);

    expect((await prisma.subscription.findUnique({ where: { connectionId } }))?.status).toBe("past_due");
  });

  it("records a cancelled subscription as canceled", async () => {
    providerSays(subscription({ status: "cancelled" }));

    await reconcileSubscription(connectionId);

    expect((await prisma.subscription.findUnique({ where: { connectionId } }))?.status).toBe("canceled");
  });
});

describe("when the provider cannot answer", () => {
  it("leaves the account alone if the subscription is unknown to it", async () => {
    // A test-mode id after a switch to live keys reads exactly like
    // this. Wiping the plan here would be worse than knowing nothing.
    providerSays({ error: { description: "not found" } }, 404);

    const result = await reconcileSubscription(connectionId);

    expect(result.changed).toBe(false);
    expect((await entitlementsFor(connectionId)).status).toBe("trialing");
  });

  it("never throws when the lookup fails — this runs on a page load", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(reconcileSubscription(connectionId)).resolves.toMatchObject({ changed: false });
  });

  it("does not touch an admin-granted plan, which has no provider to ask", async () => {
    await prisma.subscription.update({
      where: { connectionId },
      data: { billingProvider: "manual", plan: "business", status: "active" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await reconcileSubscription(connectionId);

    expect(result.changed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await entitlementsFor(connectionId)).plan).toBe("business");
  });
});

describe("worthReconciling — when it is worth a round trip at all", () => {
  it("asks when there is a mandate we do not believe is paying", () => {
    expect(worthReconciling({ billingProvider: "razorpay", providerSubscriptionId: SUB_ID, status: "trialing" })).toBe(true);
    expect(worthReconciling({ billingProvider: "razorpay", providerSubscriptionId: SUB_ID, status: "past_due" })).toBe(true);
  });

  it("stays quiet for an account already recorded as active", () => {
    // Otherwise every Billing page load pays for a Razorpay round trip
    // to be told what it already knows.
    expect(worthReconciling({ billingProvider: "razorpay", providerSubscriptionId: SUB_ID, status: "active" })).toBe(false);
  });

  it("stays quiet when there is nothing at a provider", () => {
    expect(worthReconciling({ billingProvider: "razorpay", providerSubscriptionId: null, status: "trialing" })).toBe(false);
    expect(worthReconciling({ billingProvider: "manual", providerSubscriptionId: SUB_ID, status: "trialing" })).toBe(false);
  });
});
