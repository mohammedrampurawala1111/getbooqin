/**
 * Razorpay — signature verification and event normalisation.
 *
 * Verification is HMAC-SHA256 of the **raw request body** against the
 * webhook secret, compared to the `X-Razorpay-Signature` header. Raw
 * matters: re-serialising the parsed JSON changes key order and
 * whitespace, and the digest no longer matches. Every route that reaches
 * this must read `request.text()` and hand that exact string over.
 *
 * The comparison is `timingSafeEqual`, not `===`. A string compare exits
 * at the first differing byte, which leaks how much of a forged
 * signature was right — enough, over many attempts, to construct a valid
 * one. This is cheap to get right and expensive to get wrong.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PRICES,
  isBillingCycle,
  isCurrency,
  isPlanId,
  type BillingCycle,
  type Currency,
  type PlanId,
} from "../plans.js";
import type { BillingProvider, BillingEventType, NormalisedEvent } from "./provider.js";

const SIGNATURE_HEADER = "x-razorpay-signature";
const EVENT_ID_HEADER = "x-razorpay-event-id";

/**
 * Razorpay's event names → ours. Anything absent is recorded and ignored
 * rather than guessed at: a vendor adding an event we've never seen must
 * never be interpreted as a plan change.
 */
const EVENT_MAP: Record<string, BillingEventType> = {
  "subscription.authenticated": "mandate_authenticated",
  "subscription.activated": "subscription_active",
  // Every renewal. This is the event that cannot be obtained any other
  // way — month two onward there is no browser, no session and no
  // return URL to learn from.
  "subscription.charged": "subscription_active",
  "subscription.resumed": "subscription_active",
  "subscription.pending": "payment_failed_retrying",
  "subscription.halted": "payment_failed_final",
  "subscription.cancelled": "subscription_ended",
  "subscription.completed": "subscription_ended",
  "subscription.updated": "subscription_updated",
  "subscription.paused": "ignored",
};

export type RazorpayMode = "test" | "live";

/**
 * Test or live, derived from the API key's own prefix — Razorpay key ids
 * are literally `rzp_test_…` / `rzp_live_…`. No separate variable, so
 * the mode cannot drift out of step with the credentials it belongs to,
 * which is the classic way a deploy ends up charging test plans with
 * live keys or vice versa.
 *
 * Defaults to "test" when unset: a missing key must never select the
 * ids that move real money.
 */
export function razorpayMode(): RazorpayMode {
  return process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live_") ? "live" : "test";
}

/**
 * Reverse index from a Razorpay plan id back to the (plan, currency,
 * cycle) it represents — how a webhook works out what was just charged.
 *
 * Memoised per mode rather than rebuilt per event: the underlying table
 * is a committed constant, so the only thing that can change it at
 * runtime is the mode itself (and, in tests, a deliberate override —
 * see __resetPlanIndexForTests).
 */
let planIndex: Map<string, { plan: PlanId; currency: Currency; cycle: BillingCycle }> | null = null;
let planIndexMode: RazorpayMode | null = null;

function planIdIndex(): Map<string, { plan: PlanId; currency: Currency; cycle: BillingCycle }> {
  const mode = razorpayMode();
  if (planIndex && planIndexMode === mode) return planIndex;

  const entries: [string, { plan: PlanId; currency: Currency; cycle: BillingCycle }][] = [];
  for (const [plan, byCurrency] of Object.entries(PRICES)) {
    for (const [currency, byCycle] of Object.entries(byCurrency)) {
      for (const [cycle, price] of Object.entries(byCycle)) {
        const id = price.razorpay[mode];
        // Empty means the plan hasn't been created at Razorpay yet.
        if (!id) continue;
        if (!isPlanId(plan) || !isCurrency(currency) || !isBillingCycle(cycle)) continue;
        entries.push([id, { plan, currency, cycle }]);
      }
    }
  }

  planIndex = new Map(entries);
  planIndexMode = mode;
  return planIndex;
}

/**
 * Which Razorpay plan to subscribe someone to. Null means the plan
 * exists in our table but has no id at Razorpay for this mode yet — the
 * checkout must refuse rather than guess, since the alternative is
 * subscribing someone to the wrong price.
 */
export function providerPlanId(plan: PlanId, currency: Currency, cycle: BillingCycle): string | null {
  if (plan === "free") return null;
  return PRICES[plan][currency][cycle].razorpay[razorpayMode()] || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Razorpay sends unix seconds; null for anything missing or nonsensical. */
function fromUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

export const RazorpayProvider: BillingProvider = {
  id: "razorpay",

  isConfigured(): boolean {
    return !!process.env.RAZORPAY_WEBHOOK_SECRET;
  },

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    // No secret configured means nothing can be trusted. Fail closed —
    // this is the one place in billing where falling open would let
    // anyone on the internet set any account to any plan.
    if (!secret) return false;

    const provided = headers.get(SIGNATURE_HEADER);
    if (!provided) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    // timingSafeEqual throws on a length mismatch, which is itself a
    // (harmless) signal that the signature is wrong — but it has to be
    // handled rather than thrown out of a request handler.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  },

  parseEvent(rawBody: string, headers: Headers): NormalisedEvent | null {
    let body: Record<string, unknown> | null;
    try {
      body = asRecord(JSON.parse(rawBody));
    } catch {
      return null;
    }
    if (!body) return null;

    const eventName = typeof body.event === "string" ? body.event : "";
    if (!eventName) return null;

    const payload = asRecord(body.payload);
    const subscription = asRecord(asRecord(payload?.subscription)?.entity);

    // The event id header is the idempotency key. Falling back to a
    // composite of the subscription and the event's own timestamp keeps
    // a delivery that somehow lacks the header from being applied twice,
    // which matters more than the id being pretty.
    const providerEventId =
      headers.get(EVENT_ID_HEADER) ||
      `${eventName}:${String(subscription?.id ?? "unknown")}:${String(body.created_at ?? "0")}`;

    const notes = asRecord(subscription?.notes);
    const connectionId =
      typeof notes?.connection_id === "string" && notes.connection_id ? notes.connection_id : null;

    const matched = typeof subscription?.plan_id === "string" ? planIdIndex().get(subscription.plan_id) : undefined;

    return {
      providerEventId,
      type: EVENT_MAP[eventName] ?? "ignored",
      providerEventName: eventName,
      providerSubscriptionId: typeof subscription?.id === "string" ? subscription.id : null,
      providerCustomerId: typeof subscription?.customer_id === "string" ? subscription.customer_id : null,
      connectionId,
      plan: matched?.plan ?? null,
      currency: matched?.currency ?? null,
      billingCycle: matched?.cycle ?? null,
      // `current_end` is when the paid-for period runs out — the date the
      // grace window and "you keep this until…" are both measured from.
      currentPeriodEnd: fromUnixSeconds(subscription?.current_end),
      // Razorpay flags a subscription that will not renew but is still
      // inside its paid period.
      cancelAtPeriodEnd:
        subscription?.status === "cancelled" && !!fromUnixSeconds(subscription?.current_end),
    };
  },
};

/** Resets the memoised plan index. Tests only — production rebuilds on a mode change. */
export function __resetPlanIndexForTests(): void {
  planIndex = null;
  planIndexMode = null;
}
