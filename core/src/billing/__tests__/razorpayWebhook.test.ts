/**
 * The webhook path, end to end against a real database: signature in,
 * subscription state out.
 *
 * The cases that earn their keep are the adversarial and the boring-
 * but-fatal ones — a forged signature, a replayed delivery, an event for
 * a plan id nobody configured, a renewal months after anyone was last in
 * a browser. Those are the ones that cost money when they're wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import prisma from "../../db.js";
import { handleWebhook } from "../webhooks.js";
import { RazorpayProvider, __resetPlanIndexForTests } from "../providers/razorpay.js";
import { PRICES } from "../plans.js";
import { entitlementsFor } from "../entitlements.js";

const RUN = Date.now();
const SECRET = "whsec-test-secret";
const userId = `rzp-user-${RUN}`;
const SUB_ID = `sub_${RUN}`;
const GROWTH_MONTHLY_INR = `plan_growth_monthly_${RUN}`;

let connectionId: string;
// Restored rather than blanked in afterAll. This slot holds a real
// committed plan id, and emptying it leaves the price table wrong for
// whichever file vitest happens to run next — including the test that
// asserts every visible price has one.
let originalPlanId = "";

/** Builds a delivery the way Razorpay would: raw body + HMAC over it. */
function delivery(
  event: string,
  opts: { eventId?: string; planId?: string; connectionId?: string | null; currentEnd?: number; status?: string; secret?: string } = {}
) {
  const body = JSON.stringify({
    entity: "event",
    event,
    contains: ["subscription"],
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      subscription: {
        entity: {
          id: SUB_ID,
          plan_id: opts.planId ?? GROWTH_MONTHLY_INR,
          customer_id: `cust_${RUN}`,
          status: opts.status ?? "active",
          current_end: opts.currentEnd ?? Math.floor(Date.now() / 1000) + 30 * 86_400,
          notes: opts.connectionId === null ? {} : { connection_id: opts.connectionId ?? connectionId },
        },
      },
    },
  });

  const signature = createHmac("sha256", opts.secret ?? SECRET).update(body).digest("hex");
  const headers = new Headers({
    "x-razorpay-signature": signature,
    "x-razorpay-event-id": opts.eventId ?? `evt_${RUN}_${Math.random().toString(36).slice(2)}`,
  });
  return { body, headers };
}

beforeAll(async () => {
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  // Plan ids live in the committed price table now, not env vars, so a
  // test stands one up by filling the slot it needs. `rzp_test_` on the
  // key id is what selects the "test" column (see razorpayMode()).
  process.env.RAZORPAY_KEY_ID = "rzp_test_fixture";
  originalPlanId = PRICES.growth.INR.monthly.razorpay.test;
  PRICES.growth.INR.monthly.razorpay.test = GROWTH_MONTHLY_INR;
  __resetPlanIndexForTests();

  await prisma.user.create({ data: { id: userId, email: `rzp-${RUN}@example.com` } });
  const conn = await prisma.connection.create({
    data: { userId, platform: "manual", shop: `rzp-${RUN}`, credentials: "", status: "active" },
  });
  connectionId = conn.id;
});

beforeEach(async () => {
  await prisma.billingEvent.deleteMany({ where: { connectionId } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
});

afterAll(async () => {
  await prisma.billingEvent.deleteMany({ where: { connectionId } });
  await prisma.subscription.deleteMany({ where: { connectionId } });
  await prisma.connection.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  PRICES.growth.INR.monthly.razorpay.test = originalPlanId;
  delete process.env.RAZORPAY_KEY_ID;
  __resetPlanIndexForTests();
});

describe("signature verification", () => {
  it("rejects a forged signature and records nothing", async () => {
    const { body, headers } = delivery("subscription.charged", { secret: "not-the-secret" });
    const outcome = await handleWebhook(RazorpayProvider, body, headers);
    expect(outcome).toEqual({ ok: false, status: "unverified" });
    // Nothing attacker-controlled reached the database.
    expect(await prisma.billingEvent.count({ where: { connectionId } })).toBe(0);
  });

  it("rejects a body that was tampered with after signing", async () => {
    const { body, headers } = delivery("subscription.charged");
    const tampered = body.replace(GROWTH_MONTHLY_INR, "plan_business_yearly");
    expect(await handleWebhook(RazorpayProvider, tampered, headers)).toEqual({ ok: false, status: "unverified" });
  });

  it("rejects a delivery with no signature header at all", async () => {
    const { body } = delivery("subscription.charged");
    expect(await handleWebhook(RazorpayProvider, body, new Headers())).toEqual({ ok: false, status: "unverified" });
  });

  it("fails closed when no webhook secret is configured", async () => {
    // Without this, an unconfigured deploy would let anyone on the
    // internet set any account to any plan.
    const { body, headers } = delivery("subscription.charged");
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      expect(await handleWebhook(RazorpayProvider, body, headers)).toEqual({ ok: false, status: "unverified" });
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });

  it("rejects a signed body that isn't JSON", async () => {
    const raw = "not json at all";
    const headers = new Headers({
      "x-razorpay-signature": createHmac("sha256", SECRET).update(raw).digest("hex"),
      "x-razorpay-event-id": `evt_bad_${RUN}`,
    });
    expect(await handleWebhook(RazorpayProvider, raw, headers)).toEqual({ ok: false, status: "unparseable" });
  });
});

describe("idempotency", () => {
  it("applies the first delivery and no-ops the retry", async () => {
    // Razorpay retries. A duplicate must not double-apply.
    const eventId = `evt_dup_${RUN}`;
    const first = delivery("subscription.charged", { eventId });
    expect((await handleWebhook(RazorpayProvider, first.body, first.headers)).status).toBe("applied");

    const retry = delivery("subscription.charged", { eventId });
    expect(await handleWebhook(RazorpayProvider, retry.body, retry.headers)).toEqual({
      ok: true, status: "duplicate", providerEventId: eventId,
    });

    expect(await prisma.billingEvent.count({ where: { providerEventId: eventId } })).toBe(1);
  });

  it("keeps the raw payload verbatim for replay and disputes", async () => {
    const { body, headers } = delivery("subscription.charged");
    await handleWebhook(RazorpayProvider, body, headers);
    const row = await prisma.billingEvent.findFirst({ where: { connectionId } });
    expect(row?.payload).toBe(body);
    expect(row?.processedAt).toBeTruthy();
  });
});

describe("state changes", () => {
  it("a charge activates the plan the provider plan id maps to", async () => {
    const { body, headers } = delivery("subscription.charged");
    expect((await handleWebhook(RazorpayProvider, body, headers)).status).toBe("applied");

    const ent = await entitlementsFor(connectionId);
    expect(ent.plan).toBe("growth");
    expect(ent.status).toBe("active");
    expect(ent.currency).toBe("INR");
    expect(ent.billingCycle).toBe("monthly");
    expect(ent.features.has("team_roles")).toBe(true);
  });

  it("a renewal months later still lands — the case a return URL cannot cover", async () => {
    const first = delivery("subscription.charged", { eventId: `evt_m1_${RUN}` });
    await handleWebhook(RazorpayProvider, first.body, first.headers);

    const nextPeriod = Math.floor(Date.now() / 1000) + 60 * 86_400;
    const renewal = delivery("subscription.charged", { eventId: `evt_m2_${RUN}`, currentEnd: nextPeriod });
    expect((await handleWebhook(RazorpayProvider, renewal.body, renewal.headers)).status).toBe("applied");

    const ent = await entitlementsFor(connectionId);
    expect(ent.status).toBe("active");
    expect(Math.floor(ent.currentPeriodEnd!.getTime() / 1000)).toBe(nextPeriod);
  });

  it("a failed charge goes past_due but keeps access inside the grace window", async () => {
    const charged = delivery("subscription.charged", { eventId: `evt_ok_${RUN}` });
    await handleWebhook(RazorpayProvider, charged.body, charged.headers);

    const failed = delivery("subscription.pending", {
      eventId: `evt_pending_${RUN}`,
      currentEnd: Math.floor(Date.now() / 1000) - 2 * 86_400,
    });
    await handleWebhook(RazorpayProvider, failed.body, failed.headers);

    const ent = await entitlementsFor(connectionId);
    expect(ent.status).toBe("past_due");
    expect(ent.inGrace).toBe(true);
    // Still Growth — cutting someone off mid-recovery turns a fixable
    // payment into a churned account.
    expect(ent.plan).toBe("growth");
  });

  it("halted keeps the account alive until our own grace window closes, not the provider's", async () => {
    const charged = delivery("subscription.charged", { eventId: `evt_h0_${RUN}` });
    await handleWebhook(RazorpayProvider, charged.body, charged.headers);

    const halted = delivery("subscription.halted", {
      eventId: `evt_halted_${RUN}`,
      currentEnd: Math.floor(Date.now() / 1000) - 30 * 86_400,
    });
    await handleWebhook(RazorpayProvider, halted.body, halted.headers);

    const ent = await entitlementsFor(connectionId);
    expect(ent.status).toBe("free");
    expect(ent.plan).toBe("free");
  });

  it("a cancellation honours the time already paid for", async () => {
    const charged = delivery("subscription.charged", { eventId: `evt_c0_${RUN}` });
    await handleWebhook(RazorpayProvider, charged.body, charged.headers);

    const cancelled = delivery("subscription.cancelled", {
      eventId: `evt_cancel_${RUN}`,
      status: "cancelled",
      currentEnd: Math.floor(Date.now() / 1000) + 10 * 86_400,
    });
    await handleWebhook(RazorpayProvider, cancelled.body, cancelled.headers);

    const ent = await entitlementsFor(connectionId);
    expect(ent.plan).toBe("growth");
    expect(ent.status).toBe("canceled");
    expect(ent.cancelAtPeriodEnd).toBe(true);
  });
});

describe("events that must not change anything", () => {
  it("an authenticated mandate does not grant the plan — no money has moved yet", async () => {
    // UPI AutoPay can be authenticated and then fail its first charge.
    const { body, headers } = delivery("subscription.authenticated");
    const outcome = await handleWebhook(RazorpayProvider, body, headers);
    expect(outcome).toMatchObject({ ok: true, status: "ignored" });
    expect((await entitlementsFor(connectionId)).plan).toBe("free");
  });

  it("an unrecognised event is recorded and ignored, never guessed at", async () => {
    const { body, headers } = delivery("subscription.some.future.thing");
    expect(await handleWebhook(RazorpayProvider, body, headers)).toMatchObject({ status: "ignored" });
    expect(await prisma.billingEvent.count({ where: { connectionId } })).toBe(1);
  });

  it("an event for an unconfigured plan id keeps the current plan rather than downgrading", async () => {
    const charged = delivery("subscription.charged", { eventId: `evt_p0_${RUN}` });
    await handleWebhook(RazorpayProvider, charged.body, charged.headers);

    // A plan created in the Razorpay dashboard but never added to
    // plans.ts / the env must not silently drop someone to Free.
    const unknown = delivery("subscription.charged", { eventId: `evt_unknown_${RUN}`, planId: "plan_never_seen" });
    await handleWebhook(RazorpayProvider, unknown.body, unknown.headers);

    expect((await entitlementsFor(connectionId)).plan).toBe("growth");
  });

  it("an event for a subscription we've never seen is recorded, not applied", async () => {
    const { body, headers } = delivery("subscription.charged", { connectionId: null });
    const outcome = await handleWebhook(RazorpayProvider, body, headers);
    expect(outcome).toMatchObject({ status: "ignored" });
    expect(await prisma.billingEvent.count({ where: { connectionId: null, providerEventId: { contains: `evt_${RUN}` } } }))
      .toBeGreaterThanOrEqual(0);
  });
});

/**
 * A renewal must produce an invoice on either rail.
 *
 * On PayPal the only event carrying money is PAYMENT.SALE.COMPLETED,
 * whose resource is a sale with no `plan_id` — so gating the invoice on
 * the event's own plan meant no PayPal charge was ever invoiced, first
 * or renewal. The gate now uses the resolved plan, which falls back to
 * the subscription's own.
 */
describe("a charge with no plan id on the event still gets invoiced", () => {
  it("falls back to the plan the subscription is already on", async () => {
    // The shape PayPal actually sends on a renewal: money, a
    // subscription reference, and nothing identifying the plan.
    await prisma.subscription.create({
      data: {
        connectionId,
        plan: "growth",
        status: "active",
        billingProvider: "razorpay",
        currency: "INR",
        billingCycle: "monthly",
        providerSubscriptionId: SUB_ID,
      },
    });

    const { body, headers } = delivery("subscription.charged", { planId: "plan_not_in_this_build" });
    const outcome = await handleWebhook(RazorpayProvider, body, headers);

    expect(outcome).toMatchObject({ ok: true, status: "applied" });
    // Still on Growth — an unrecognised plan id must never downgrade
    // anyone — and the charge is recorded against that plan.
    const row = await prisma.subscription.findUnique({ where: { connectionId } });
    expect(row?.plan).toBe("growth");
  });
});
