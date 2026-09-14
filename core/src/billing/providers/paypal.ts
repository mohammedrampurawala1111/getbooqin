/**
 * PayPal Subscriptions — the rail for everyone outside India.
 *
 * Razorpay can technically charge a EUR or USD card, but it settles to
 * an Indian account and presents as an Indian merchant, which is a
 * worse experience for a European or American customer than the wallet
 * they already have. So the split is by where the customer is:
 * Razorpay for India, PayPal for everywhere else.
 *
 * ## Three ways PayPal differs from Razorpay, all of which bite
 *
 * **Auth is a token, not a key pair.** Every call needs a bearer token
 * from `/v1/oauth2/token`, which expires. Cached here until shortly
 * before it does.
 *
 * **Amounts are decimal strings.** PayPal says `"5.00"`; Razorpay says
 * `500`. Everything in our billing code is minor units, so amounts are
 * converted at this edge and nowhere else — a float leaking inward is
 * how money goes missing a rounding at a time.
 *
 * **Webhook verification is a round trip.** There is no local HMAC to
 * compute: the headers and body go back to PayPal with the webhook id
 * and PayPal says SUCCESS or FAILURE. That is why `verifyWebhook` is
 * async across the whole interface.
 *
 * One thing PayPal does better: a subscription carries `return_url`, so
 * a merchant who finishes approving actually lands back in the product
 * rather than stranded on the vendor's page.
 */
import type {
  BillingProvider,
  CreateSubscriptionArgs,
  CreatedSubscription,
  NormalisedEvent,
  ProviderCharge,
  ProviderSubscriptionSnapshot,
  BillingEventType,
} from "./provider.js";
import {
  PRICES,
  isPlanId,
  type BillingCycle,
  type Currency,
  type PlanId,
} from "../plans.js";

/**
 * PayPal's event vocabulary mapped onto ours.
 *
 * `PAYMENT.SALE.COMPLETED` is the one that cannot be obtained any other
 * way — it is the actual money movement on a renewal, months after
 * anyone was last in a browser, and it is what an invoice is issued
 * against. `BILLING.SUBSCRIPTION.ACTIVATED` says the mandate is live;
 * on its own it is not a payment.
 */
const EVENT_MAP: Record<string, BillingEventType> = {
  "BILLING.SUBSCRIPTION.ACTIVATED": "subscription_active",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED": "subscription_active",
  "PAYMENT.SALE.COMPLETED": "subscription_active",
  "BILLING.SUBSCRIPTION.CREATED": "mandate_authenticated",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "payment_failed_retrying",
  // PayPal suspends after its own retries are exhausted. Same meaning as
  // Razorpay's `halted`: stop hoping, start the grace clock.
  "BILLING.SUBSCRIPTION.SUSPENDED": "payment_failed_final",
  "BILLING.SUBSCRIPTION.CANCELLED": "subscription_ended",
  "BILLING.SUBSCRIPTION.EXPIRED": "subscription_ended",
  "BILLING.SUBSCRIPTION.UPDATED": "subscription_updated",
  "PAYMENT.SALE.REFUNDED": "ignored",
  "PAYMENT.SALE.REVERSED": "ignored",
};

function apiBase(): string {
  return mode() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/**
 * Sandbox or live. Explicit, unlike Razorpay where the key id says so
 * itself — PayPal's credentials look identical in both environments,
 * which makes "why did nothing happen" a genuinely hard question if
 * this is guessed.
 */
export function mode(): "sandbox" | "live" {
  return process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
}

function credentials(): { id: string; secret: string } | null {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

/* ------------------------------------------------------------------ */
/* Access tokens                                                       */
/* ------------------------------------------------------------------ */

let cachedToken: { value: string; expiresAt: number } | null = null;

/** Resets the cached token. Tests only, and after a credential change. */
export function __resetTokenForTests(): void {
  cachedToken = null;
}

async function accessToken(): Promise<string> {
  const creds = credentials();
  if (!creds) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not configured.");

  // A minute of headroom: a token that expires between being read here
  // and arriving at PayPal produces a 401 that looks like bad
  // credentials.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`PayPal refused the credentials (${response.status}).`);
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("PayPal returned no access token.");

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3000) * 1000,
  };
  return cachedToken.value;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */

/**
 * PayPal's decimal string to our minor units.
 *
 * Parsed as digits rather than via a float: `Number("11.45") * 100` is
 * 1144.9999999999998, and `Math.round` hides that right up until the
 * amount on an invoice is a penny off the amount charged.
 */
export function toMinorUnits(value: string | number | undefined): number {
  if (typeof value === "number") return Math.round(value * 100);
  if (!value) return 0;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return Math.round(Number(value) * 100) || 0;
  const [, sign, whole, fraction = ""] = match;
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign === "-" ? -minor : minor;
}

/** Our minor units to the decimal string PayPal expects. */
export function toDecimalString(minor: number): string {
  return (minor / 100).toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Plan ids                                                            */
/* ------------------------------------------------------------------ */

export function planId(plan: PlanId, currency: Currency, cycle: BillingCycle): string {
  if (plan === "free") return "";
  const price = PRICES[plan]?.[currency]?.[cycle];
  if (!price?.paypal) return "";
  return mode() === "live" ? price.paypal.live : price.paypal.test;
}

/** PayPal plan id → what it means, for reading an event back. */
let planIndex: Map<string, { plan: PlanId; currency: Currency; cycle: BillingCycle }> | null = null;
let planIndexMode: string | null = null;

function planIdIndex() {
  if (planIndex && planIndexMode === mode()) return planIndex;

  const index = new Map<string, { plan: PlanId; currency: Currency; cycle: BillingCycle }>();
  for (const [plan, byCurrency] of Object.entries(PRICES)) {
    for (const [currency, byCycle] of Object.entries(byCurrency)) {
      for (const [cycle, price] of Object.entries(byCycle)) {
        const id = mode() === "live" ? price.paypal?.live : price.paypal?.test;
        if (id && isPlanId(plan)) {
          index.set(id, { plan, currency: currency as Currency, cycle: cycle as BillingCycle });
        }
      }
    }
  }

  planIndex = index;
  planIndexMode = mode();
  return index;
}

/** Resets the memoised plan index. Tests only. */
export function __resetPlanIndexForTests(): void {
  planIndex = null;
  planIndexMode = null;
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * PayPal's subscription status in our terms.
 *
 * `APPROVAL_PENDING` and `APPROVED` are both "no money has moved" —
 * APPROVED in particular means the customer clicked through but the
 * first charge has not settled, which is exactly the state Razorpay
 * calls `authenticated`. Granting a plan on it would hand out a paid
 * tier for a click.
 */
export function statusFor(providerStatus: string): "active" | "past_due" | "canceled" | null {
  switch (providerStatus) {
    case "ACTIVE":
      return "active";
    // Suspended is PayPal having given up retrying. Still past_due, not
    // cancelled: access lapses on our grace clock, not the instant the
    // vendor stops trying.
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
    case "EXPIRED":
      return "canceled";
    default:
      return null;
  }
}

export function isLive(providerStatus: string): boolean {
  return ["APPROVAL_PENDING", "APPROVED", "ACTIVE", "SUSPENDED"].includes(providerStatus);
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const PayPalProvider: BillingProvider = {
  id: "paypal",

  mode,

  isConfigured(): boolean {
    return !!credentials() && !!process.env.PAYPAL_WEBHOOK_ID;
  },

  /**
   * Asks PayPal whether it sent this.
   *
   * There is no local signature to check — the transmission headers
   * mean nothing without PayPal's certificate, so the supported answer
   * is to hand the whole delivery back and be told. Fails closed on any
   * error: an unverifiable delivery is treated exactly like a forged
   * one.
   */
  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId || !credentials()) return false;

    const required = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    if (required.some((h) => !headers.get(h))) return false;

    try {
      const response = await api("/v1/notifications/verify-webhook-signature", {
        method: "POST",
        body: JSON.stringify({
          auth_algo: headers.get("paypal-auth-algo"),
          cert_url: headers.get("paypal-cert-url"),
          transmission_id: headers.get("paypal-transmission-id"),
          transmission_sig: headers.get("paypal-transmission-sig"),
          transmission_time: headers.get("paypal-transmission-time"),
          webhook_id: webhookId,
          // The parsed body, not the raw string — PayPal's verifier
          // wants `webhook_event` as JSON and re-serialises it itself.
          webhook_event: JSON.parse(rawBody),
        }),
      });

      if (!response.ok) return false;
      const body = (await response.json()) as { verification_status?: string };
      return body.verification_status === "SUCCESS";
    } catch (err) {
      console.error("[getbooqin billing] PayPal webhook verification failed:", err);
      return false;
    }
  },

  parseEvent(rawBody: string, headers: Headers): NormalisedEvent | null {
    void headers;
    let body: Record<string, unknown> | null;
    try {
      body = asRecord(JSON.parse(rawBody));
    } catch {
      return null;
    }
    if (!body) return null;

    const eventName = typeof body.event_type === "string" ? body.event_type : "";
    if (!eventName) return null;

    const resource = asRecord(body.resource);

    // A subscription event carries the subscription as its resource; a
    // sale carries the payment, with the subscription id in
    // `billing_agreement_id`. Both have to resolve to the same account.
    const subscriptionId =
      (typeof resource?.id === "string" && eventName.startsWith("BILLING.SUBSCRIPTION") ? resource.id : null) ??
      (typeof resource?.billing_agreement_id === "string" ? resource.billing_agreement_id : null);

    const matched = typeof resource?.plan_id === "string" ? planIdIndex().get(resource.plan_id) : undefined;

    // PAYMENT.SALE.COMPLETED is the only event with money in it.
    const amount = asRecord(resource?.amount);
    const payment =
      eventName === "PAYMENT.SALE.COMPLETED" && typeof resource?.id === "string"
        ? {
            id: resource.id,
            amountMinor: toMinorUnits(
              (typeof amount?.total === "string" ? amount.total : undefined) ??
                (typeof amount?.value === "string" ? amount.value : undefined)
            ),
            currency:
              (typeof amount?.currency === "string" ? amount.currency : "") ||
              (typeof amount?.currency_code === "string" ? amount.currency_code : ""),
            providerInvoiceId: typeof resource?.invoice_number === "string" ? resource.invoice_number : null,
          }
        : null;

    const billingInfo = asRecord(resource?.billing_info);

    return {
      // PayPal's own event id. Unique per delivery, which is what makes
      // a redelivery idempotent for us.
      providerEventId: typeof body.id === "string" ? body.id : `${eventName}:${subscriptionId ?? "unknown"}`,
      type: EVENT_MAP[eventName] ?? "ignored",
      providerEventName: eventName,
      providerSubscriptionId: subscriptionId,
      providerCustomerId:
        typeof asRecord(resource?.subscriber)?.payer_id === "string"
          ? (asRecord(resource?.subscriber)!.payer_id as string)
          : null,
      // custom_id is our own round-trip, the same job Razorpay's `notes`
      // does — it is how an event arriving months later with no session
      // still finds the right account.
      connectionId: typeof resource?.custom_id === "string" && resource.custom_id ? resource.custom_id : null,
      plan: matched?.plan ?? null,
      currency: matched?.currency ?? null,
      billingCycle: matched?.cycle ?? null,
      currentPeriodEnd: asDate(billingInfo?.next_billing_time),
      cancelAtPeriodEnd: false,
      payment,
    };
  },

  planId,

  async createSubscription(args: CreateSubscriptionArgs): Promise<CreatedSubscription> {
    const plan = planId(args.plan, args.currency, args.cycle);
    if (!plan) {
      throw new Error(`No PayPal ${mode()} plan for ${args.plan}/${args.currency}/${args.cycle}`);
    }

    const response = await api("/v1/billing/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        plan_id: plan,
        // Our thread back, on every event for this subscription.
        custom_id: args.connectionId,
        ...(args.customer?.email || args.customer?.name
          ? {
              subscriber: {
                ...(args.customer.email ? { email_address: args.customer.email } : {}),
                ...(args.customer.name ? { name: { given_name: args.customer.name.slice(0, 140) } } : {}),
              },
            }
          : {}),
        application_context: {
          brand_name: "GetBooqin",
          user_action: "SUBSCRIBE_NOW",
          // Unlike Razorpay, PayPal takes these — so a merchant who
          // finishes approving lands back in the product instead of on
          // the vendor's page wondering whether it worked.
          ...(args.returnUrl ? { return_url: args.returnUrl } : {}),
          ...(args.cancelUrl ? { cancel_url: args.cancelUrl } : {}),
        },
      }),
    });

    const body = (await response.json()) as {
      id?: string;
      links?: { rel?: string; href?: string }[];
      message?: string;
    };

    const approvalUrl = body.links?.find((l) => l.rel === "approve")?.href;
    if (!response.ok || !body.id || !approvalUrl) {
      throw new Error(`PayPal refused the subscription (${response.status}): ${body.message ?? "no detail"}`);
    }

    return { providerSubscriptionId: body.id, approvalUrl };
  },

  async fetchSubscription(id: string): Promise<ProviderSubscriptionSnapshot | null> {
    const response = await api(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(`PayPal refused the lookup (${response.status}): ${body.message ?? "no detail"}`);
    }

    const sub = asRecord(await response.json());
    if (!sub || typeof sub.id !== "string") return null;

    const matched = typeof sub.plan_id === "string" ? planIdIndex().get(sub.plan_id) : undefined;
    const billingInfo = asRecord(sub.billing_info);

    return {
      providerSubscriptionId: sub.id,
      providerStatus: typeof sub.status === "string" ? sub.status : "",
      plan: matched?.plan ?? null,
      currency: matched?.currency ?? null,
      billingCycle: matched?.cycle ?? null,
      providerCustomerId:
        typeof asRecord(sub.subscriber)?.payer_id === "string" ? (asRecord(sub.subscriber)!.payer_id as string) : null,
      currentPeriodEnd: asDate(billingInfo?.next_billing_time),
      cancelAtPeriodEnd: false,
    };
  },

  async fetchPaidCharges(id: string): Promise<ProviderCharge[]> {
    // PayPal wants an explicit window and will not default one. Ten
    // years back covers any subscription this product could have.
    const end = new Date();
    const start = new Date(end.getTime() - 3650 * 86_400_000);
    const query = `start_time=${start.toISOString().slice(0, 19)}Z&end_time=${end.toISOString().slice(0, 19)}Z`;

    const response = await api(`/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions?${query}`);
    if (response.status === 404) return [];
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(`PayPal refused the transaction list (${response.status}): ${body.message ?? "no detail"}`);
    }

    const body = asRecord(await response.json());
    const transactions = Array.isArray(body?.transactions) ? body.transactions : [];

    return transactions
      .map((t) => asRecord(t))
      .filter((t): t is Record<string, unknown> => !!t && t.status === "COMPLETED")
      .filter((t) => typeof t.id === "string")
      .map((t) => {
        const gross = asRecord(t.amount_with_breakdown)?.gross_amount;
        const amount = asRecord(gross);
        return {
          paymentId: t.id as string,
          providerInvoiceId: "",
          amountMinor: toMinorUnits(typeof amount?.value === "string" ? amount.value : undefined),
          currency: typeof amount?.currency_code === "string" ? amount.currency_code : "",
          paidAt: asDate(t.time),
          periodStart: null,
          periodEnd: null,
        };
      });
  },

  async cancelSubscription(id: string, opts: { immediately?: boolean }): Promise<void> {
    // PayPal has no "cancel at period end". Cancelling stops future
    // charges and the customer keeps what they paid for — which is what
    // entitlementsFor() already honours via currentPeriodEnd, so the
    // behaviour matches Razorpay's cancel_at_cycle_end even though the
    // API shape doesn't.
    void opts;
    const response = await api(`/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Cancelled from GetBooqin" }),
    });

    // 204 on success. 422 usually means it is already cancelled, which
    // is the state we wanted anyway.
    if (response.ok || response.status === 422) return;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(`PayPal refused the cancellation (${response.status}): ${body.message ?? "no detail"}`);
  },

  statusFor,
  isLive,
};
