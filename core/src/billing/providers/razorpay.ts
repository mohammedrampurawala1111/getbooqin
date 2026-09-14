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

  /**
   * Both halves, deliberately.
   *
   * API credentials alone would let this rail create mandates it can
   * never be told about — money taken, plan never granted, which is the
   * exact failure reconciliation exists to survive rather than to
   * make acceptable. A rail missing either half is not usable, and
   * saying so up front beats discovering it after a customer has paid.
   */
  isConfigured(): boolean {
    return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET && !!process.env.RAZORPAY_WEBHOOK_SECRET;
  },

  // Async only to match the interface — Razorpay's answer is a local
  // HMAC and needs no round trip. PayPal's does, and one signature has
  // to cover both.
  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
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

    // subscription.charged carries the payment beside the subscription.
    // No other event does, which is exactly right — a charge is the
    // only thing there is to invoice.
    const paymentEntity = asRecord(asRecord(payload?.payment)?.entity);
    const payment =
      paymentEntity && typeof paymentEntity.id === "string" && typeof paymentEntity.amount === "number"
        ? {
            id: paymentEntity.id,
            amountMinor: paymentEntity.amount,
            currency: typeof paymentEntity.currency === "string" ? paymentEntity.currency : "",
            providerInvoiceId: typeof paymentEntity.invoice_id === "string" ? paymentEntity.invoice_id : null,
          }
        : null;

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
      payment,
    };
  },

  // The lifecycle half of the interface. These are thin wrappers over
  // the functions below rather than the implementations themselves,
  // because those predate the seam and are imported by name in a few
  // places (and by the plan-creation scripts); moving them wholesale
  // would be churn for no gain.
  // "" rather than null for "no plan here", matching the interface —
  // the two mean the same thing and one shape is easier to check.
  planId: (plan, currency, cycle) => providerPlanId(plan, currency, cycle) ?? "",
  createSubscription: (args) => createSubscription(args),
  fetchSubscription: (id) => fetchSubscription(id),
  fetchPaidCharges: (id) => fetchPaidCharges(id),
  cancelSubscription: (id, opts) => cancelSubscription(id, opts),
  statusFor: statusFromProvider,
  isLive: isLiveAtProvider,
};

/** Resets the memoised plan index. Tests only — production rebuilds on a mode change. */
export function __resetPlanIndexForTests(): void {
  planIndex = null;
  planIndexMode = null;
}

/* ------------------------------------------------------------------ */
/* Subscription creation                                               */
/* ------------------------------------------------------------------ */

const API_BASE = "https://api.razorpay.com/v1";

/**
 * How many cycles a subscription runs for. Razorpay requires a finite
 * `total_count` — there is no "until cancelled" — so this is the
 * practical equivalent: ten years of either cadence. A subscription that
 * actually reaches the end emits `subscription.completed`, which we
 * handle like any other ending.
 */
const TOTAL_COUNT: Record<BillingCycle, number> = { monthly: 120, yearly: 10 };

function auth(): string | null {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return null;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export interface CreatedSubscription {
  providerSubscriptionId: string;
  /** Razorpay's own hosted authorisation page. Where the merchant is sent to approve the mandate. */
  approvalUrl: string;
}

/**
 * Creates the subscription at Razorpay and returns where to send the
 * merchant to authorise it.
 *
 * Nothing here grants a plan. The row this eventually produces is
 * written by the webhook and only once money has actually moved — a
 * mandate can be authenticated and then fail its first charge, and a
 * merchant can close the tab on the hosted page at any point. This
 * function's only lasting effect is at Razorpay.
 *
 * `notes.connection_id` is the thread back: every webhook for this
 * subscription carries it, which is how an event that arrives months
 * later with no session attached still finds the right account.
 */
export async function createSubscription(args: {
  connectionId: string;
  plan: PlanId;
  currency: Currency;
  cycle: BillingCycle;
  customerNotify?: boolean;
  /** Passed to Razorpay so its own receipts have somewhere to go. */
  customer?: { name?: string; email?: string };
}): Promise<CreatedSubscription> {
  const authorization = auth();
  if (!authorization) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");
  }

  const planId = providerPlanId(args.plan, args.currency, args.cycle);
  if (!planId) {
    // A price that exists in our table but has no id at Razorpay for
    // this mode. Refusing is the point: the alternative is subscribing
    // someone to whatever plan id happens to be lying around.
    throw new Error(
      `No Razorpay ${razorpayMode()} plan is configured for ${args.plan}/${args.currency}/${args.cycle}.`
    );
  }

  const response = await fetch(`${API_BASE}/subscriptions`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      total_count: TOTAL_COUNT[args.cycle],
      quantity: 1,
      // Razorpay emails its own mandate confirmations. Left on: a
      // merchant authorising a recurring debit should get a record of it
      // from the party taking the money, not only from us.
      customer_notify: args.customerNotify === false ? 0 : 1,
      // customer_notify on its own does nothing: Razorpay creates a
      // customer from the checkout with only a phone number, so there
      // is no address for it to notify and its per-charge invoice is
      // generated and never sent. Supplying these is what makes that
      // setting mean anything.
      ...(args.customer?.email || args.customer?.name
        ? {
            customer: {
              ...(args.customer.name ? { name: args.customer.name } : {}),
              ...(args.customer.email ? { email: args.customer.email } : {}),
            },
          }
        : {}),
      notes: { connection_id: args.connectionId },
      // No callback_url here, deliberately. It looks like the obvious
      // fix for a merchant being stranded on api.razorpay.com after
      // paying — but it is a *Checkout widget* option, not a
      // Subscriptions API one: create-subscription accepts only
      // plan_id, total_count, quantity, start_at, expire_by,
      // customer_notify, addons, offer_id and notes, and Razorpay
      // rejects a request carrying anything else. Sending it would turn
      // "no return redirect" into "no checkout at all".
      //
      // Getting the merchant back needs the hosted short_url replaced
      // with Razorpay Standard Checkout (subscription_id passed to
      // checkout.js), which is a different integration, not a
      // parameter. Until then the Billing page reconciles against the
      // API on load, so a merchant who navigates back themselves sees
      // the right plan.
    }),
  });

  const body = (await response.json()) as {
    id?: string;
    short_url?: string;
    error?: { description?: string; code?: string };
  };

  if (!response.ok || !body.id || !body.short_url) {
    throw new Error(
      `Razorpay refused the subscription (${response.status}): ${body.error?.description ?? "no detail"}`
    );
  }

  return { providerSubscriptionId: body.id, approvalUrl: body.short_url };
}

/**
 * What Razorpay currently believes about a subscription.
 *
 * The webhook is how we normally learn this, and for renewals it is the
 * only way — month two has no browser and no session. But a webhook is
 * a message someone else has to deliver, and when it does not arrive
 * the account silently stays on its old plan while the card is being
 * charged. That is the one failure a billing system must not have, so
 * this exists to *ask* rather than wait: same question, pull instead of
 * push.
 *
 * Razorpay keeps webhooks separately per mode, so a test-mode payment
 * against an endpoint only registered in live mode delivers nothing at
 * all — no error anywhere, just an account that never activates.
 */
export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string;
  /** Razorpay's own word: created|authenticated|active|pending|halted|cancelled|completed|expired|paused. */
  providerStatus: string;
  /** Null when the subscription is on a plan id this build doesn't know. */
  plan: PlanId | null;
  currency: Currency | null;
  billingCycle: BillingCycle | null;
  providerCustomerId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export async function fetchSubscription(id: string): Promise<ProviderSubscriptionSnapshot | null> {
  const authorization = auth();
  if (!authorization) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");

  const response = await fetch(`${API_BASE}/subscriptions/${encodeURIComponent(id)}`, {
    headers: { Authorization: authorization },
  });

  // A subscription created in the other mode is simply not there. Null,
  // not an exception: "Razorpay has never heard of this" is an answer,
  // and the caller decides what it means.
  if (response.status === 404) return null;

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { description?: string } };
    throw new Error(`Razorpay refused the lookup (${response.status}): ${body.error?.description ?? "no detail"}`);
  }

  const sub = asRecord(await response.json());
  if (!sub || typeof sub.id !== "string") return null;

  const matched = typeof sub.plan_id === "string" ? planIdIndex().get(sub.plan_id) : undefined;

  return {
    providerSubscriptionId: sub.id,
    providerStatus: typeof sub.status === "string" ? sub.status : "",
    plan: matched?.plan ?? null,
    currency: matched?.currency ?? null,
    billingCycle: matched?.cycle ?? null,
    providerCustomerId: typeof sub.customer_id === "string" ? sub.customer_id : null,
    currentPeriodEnd: fromUnixSeconds(sub.current_end),
    cancelAtPeriodEnd: sub.status === "cancelled" && !!fromUnixSeconds(sub.current_end),
  };
}

/**
 * Razorpay's subscription status in our terms, or null for the states
 * that are not a subscription outcome at all.
 *
 * `created` and `authenticated` are both "no money has moved" —
 * authenticated in particular is a mandate that exists and may still
 * fail its first charge, so granting a paid plan on it would hand out a
 * tier for an authorisation alone. Same reasoning as the webhook's
 * mandate_authenticated branch, deliberately identical.
 */
export function statusFromProvider(providerStatus: string): "active" | "past_due" | "canceled" | null {
  switch (providerStatus) {
    case "active":
      return "active";
    // Retrying, and given up retrying. Both past_due: the grace window
    // in entitlementsFor() runs from currentPeriodEnd, so access lapses
    // on our clock rather than the instant Razorpay stops trying.
    case "pending":
    case "halted":
      return "past_due";
    case "cancelled":
    case "completed":
    case "expired":
      return "canceled";
    default:
      return null;
  }
}

/**
 * Every paid charge on a subscription, as Razorpay records it.
 *
 * The webhook is how we normally hear about a charge, and it carries
 * the payment inline. When it never arrives, this is the only way to
 * find out that money moved — and an invoice has to be issued against
 * a real payment, not against the fact that a plan looks active.
 *
 * Razorpay creates one invoice object per charge on a subscription,
 * which makes this the authoritative list of "times this customer was
 * billed".
 */
export interface ProviderCharge {
  paymentId: string;
  providerInvoiceId: string;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export async function fetchPaidCharges(subscriptionId: string): Promise<ProviderCharge[]> {
  const authorization = auth();
  if (!authorization) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");

  const response = await fetch(
    `${API_BASE}/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100`,
    { headers: { Authorization: authorization } }
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { description?: string } };
    throw new Error(`Razorpay refused the invoice lookup (${response.status}): ${body.error?.description ?? "no detail"}`);
  }

  const body = asRecord(await response.json());
  const items = Array.isArray(body?.items) ? body.items : [];

  return items
    .map((item) => asRecord(item))
    .filter((inv): inv is Record<string, unknown> => !!inv && inv.status === "paid")
    // A paid invoice with no payment id has nothing to invoice against,
    // and the payment id is what makes issuing once-per-charge work.
    .filter((inv) => typeof inv.payment_id === "string" && inv.payment_id)
    .map((inv) => ({
      paymentId: inv.payment_id as string,
      providerInvoiceId: typeof inv.id === "string" ? inv.id : "",
      amountMinor: typeof inv.amount === "number" ? inv.amount : 0,
      currency: typeof inv.currency === "string" ? inv.currency : "",
      paidAt: fromUnixSeconds(inv.paid_at),
      periodStart: fromUnixSeconds(inv.billing_start),
      periodEnd: fromUnixSeconds(inv.billing_end),
    }));
}

/** Non-terminal at the provider — a mandate that could still take money. */
export function isLiveAtProvider(providerStatus: string): boolean {
  return ["created", "authenticated", "active", "pending", "halted", "paused"].includes(providerStatus);
}

/**
 * Cancels at the provider. `cancel_at_cycle_end` is the default because
 * paid-for time is paid for — an immediate cancel would take away
 * something the merchant has already bought, and generate a refund
 * conversation nobody wanted.
 */
export async function cancelSubscription(
  providerSubscriptionId: string,
  opts: { immediately?: boolean } = {}
): Promise<void> {
  const authorization = auth();
  if (!authorization) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");

  const response = await fetch(`${API_BASE}/subscriptions/${providerSubscriptionId}/cancel`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ cancel_at_cycle_end: opts.immediately ? 0 : 1 }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { description?: string } };
    throw new Error(`Razorpay refused the cancellation (${response.status}): ${body.error?.description ?? "no detail"}`);
  }
  // Deliberately no local write. The webhook is the only thing that
  // moves subscription state — see billing/webhooks.ts.
}
