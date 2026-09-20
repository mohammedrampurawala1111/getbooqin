/**
 * One interface, one implementation today.
 *
 * PayPal is a later iteration (see plans.ts on why Razorpay carries all
 * three currencies for now), and the point of this seam is that adding it
 * touches only `providerFor()` and a sibling file — never the webhook
 * processor, never entitlements, never a route.
 *
 * The hard rule the seam enforces: **the rest of the codebase never sees
 * a vendor payload.** Both vendors' event vocabularies are normalised
 * into `NormalisedEvent` at the edge. Razorpay says
 * `subscription.halted`; PayPal says `BILLING.SUBSCRIPTION.SUSPENDED`;
 * everything downstream sees `payment_failed_final` and doesn't care
 * which vendor sent it.
 */
import type { BillingCycle, Currency, PlanId, ProviderId } from "../plans.js";

/** Our own event vocabulary. Deliberately smaller than either vendor's. */
export type BillingEventType =
  /** A mandate exists but hasn't charged yet — UPI AutoPay approved, card authenticated. */
  | "mandate_authenticated"
  /** Money moved, plan is live. Covers both the first charge and every renewal. */
  | "subscription_active"
  /** A charge failed and the provider is retrying. Grace period starts. */
  | "payment_failed_retrying"
  /** Retries are exhausted. Entitlements drop once the grace window closes. */
  | "payment_failed_final"
  /** Cancelled by anyone, or ran out its cycle count. Paid-for time is still honoured. */
  | "subscription_ended"
  /** Plan or cycle changed at the provider. */
  | "subscription_updated"
  /** A real event we recognise but deliberately act on in no way. Recorded, not applied. */
  | "ignored";

export interface NormalisedEvent {
  /** The provider's own event id. Unique per delivery — this is what makes retries idempotent. */
  providerEventId: string;
  type: BillingEventType;
  /** Vendor's own string, kept for the audit trail and for debugging "they say they paid". */
  providerEventName: string;
  providerSubscriptionId: string | null;
  providerCustomerId: string | null;
  /**
   * Our connection id, when the provider echoed it back. Razorpay carries
   * it in `notes` on the subscription; the processor falls back to a
   * lookup by `providerSubscriptionId` when it's absent.
   */
  connectionId: string | null;
  plan: PlanId | null;
  currency: Currency | null;
  billingCycle: BillingCycle | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /**
   * The money that actually moved, when this event is one that moved
   * any. Only a charge carries it — an activation or a cancellation
   * has no payment attached — and it is what an invoice is issued
   * against, so its `id` doubles as the once-per-payment key.
   *
   * Null rather than zero when absent: "no payment in this event" and
   * "a payment of nothing" are different facts, and only one of them
   * should produce an invoice.
   */
  payment: {
    id: string;
    /** Minor units, as the provider reports them. */
    amountMinor: number;
    currency: string;
    /** The provider's own invoice for this charge, if it makes one. */
    providerInvoiceId: string | null;
  } | null;
}

/** What a provider knows about a subscription when asked directly. */
export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string;
  /** The vendor's own word for the state, kept for logs and support questions. */
  providerStatus: string;
  /** Null when the subscription is on a plan id this build doesn't know. */
  plan: PlanId | null;
  currency: Currency | null;
  billingCycle: BillingCycle | null;
  providerCustomerId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * How a merchant's subscription to *us* is actually being paid.
 *
 * Not to be confused with Settings → Payments, which is how a merchant
 * collects money from **their** customers over UPI or PayPal.me. That
 * one we are genuinely not party to. This one runs through our own
 * provider account, so the vendor will tell us what instrument is
 * behind the mandate — and a merchant asking "which card is this coming
 * off?" deserves an answer rather than a link out.
 *
 * Read from the vendor rather than stored at checkout, because the
 * instrument can change without us: a card is replaced on expiry, a UPI
 * mandate is moved to another app. The most recent successful charge is
 * the only thing that actually says what is paying today.
 */
export interface ProviderPaymentMethod {
  /** card | upi | emandate | netbanking | wallet | paypal — the vendor's own word, lowercased. */
  kind: string;
  /**
   * Ready to render, and deliberately never the full instrument:
   * "Visa ending 4526", "priya@okhdfcbank", "priya@example.com".
   *
   * Built here rather than in the UI so that one vendor's `card.network`
   * and another's payer email land in the same shape, and so nothing
   * downstream has to know which rail it is looking at.
   */
  label: string;
}

/** One payment that was actually taken. An invoice is issued against one of these. */
export interface ProviderCharge {
  paymentId: string;
  providerInvoiceId: string;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export interface CreatedSubscription {
  providerSubscriptionId: string;
  /** Where to send the merchant to authorise the mandate. */
  approvalUrl: string;
}

export interface CreateSubscriptionArgs {
  connectionId: string;
  plan: PlanId;
  currency: Currency;
  cycle: BillingCycle;
  customer?: { name?: string; email?: string };
  /**
   * Where the provider should return the merchant afterwards.
   *
   * Honoured by whoever can. PayPal takes return/cancel URLs on the
   * subscription itself; Razorpay's hosted page has no per-request
   * equivalent and ignores this. A provider that ignores it is not
   * broken — the Billing page reconciles on load either way.
   */
  returnUrl?: string;
  cancelUrl?: string;
}

/**
 * Everything the billing code needs from a payment vendor.
 *
 * Wider than it was: it used to cover only the webhook edge, while
 * checkout.ts reached straight into the Razorpay module for creating
 * and cancelling mandates. That was fine with one rail and became the
 * thing in the way the moment there were two — so the lifecycle is part
 * of the seam now, and nothing outside `providers/` names a vendor.
 */
export interface BillingProvider {
  id: Exclude<ProviderId, "manual">;

  /**
   * True only if the raw body genuinely came from the provider. Never
   * parse before this passes.
   *
   * Async because PayPal's answer is a round trip: verification posts
   * the headers and body back to PayPal along with the webhook id.
   * Razorpay's is a local HMAC and returns immediately, but one
   * signature has to cover both.
   */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;

  /** Vendor payload → our vocabulary. Returns null for a shape we don't recognise at all. */
  parseEvent(rawBody: string, headers: Headers): NormalisedEvent | null;

  /** Is this provider configured well enough to be used at all? */
  isConfigured(): boolean;

  /**
   * Which set of books this rail is keeping, in the vendor's own word —
   * "test" / "live" at Razorpay, "sandbox" / "live" at PayPal.
   *
   * Part of the seam rather than a detail inside it, because the one
   * thing an operator has to be able to read off a running deployment
   * is whether an upgrade would move real money. Both rails already
   * derive it (Razorpay from its key's prefix, PayPal from PAYPAL_ENV);
   * this is what lets something ask without naming a vendor.
   */
  mode(): string;

  /** The vendor's own id for one of our plans, or "" when it has none. */
  planId(plan: PlanId, currency: Currency, cycle: BillingCycle): string;

  createSubscription(args: CreateSubscriptionArgs): Promise<CreatedSubscription>;

  /**
   * The instrument behind a live mandate, or null when the vendor will
   * not say — a subscription authorised but never charged has nothing
   * to report yet, and that is an ordinary state rather than a fault.
   */
  fetchPaymentMethod(id: string): Promise<ProviderPaymentMethod | null>;

  /** Null when the vendor has never heard of it — a live id after a mode switch reads like this. */
  fetchSubscription(id: string): Promise<ProviderSubscriptionSnapshot | null>;

  /** Every paid charge on a subscription, oldest or newest first — callers sort. */
  fetchPaidCharges(id: string): Promise<ProviderCharge[]>;

  cancelSubscription(id: string, opts: { immediately?: boolean }): Promise<void>;

  /** The vendor's state in our terms, or null for states that grant nothing. */
  statusFor(providerStatus: string): "active" | "past_due" | "canceled" | null;

  /** Could this mandate still take money? Errs toward true when unsure. */
  isLive(providerStatus: string): boolean;
}
