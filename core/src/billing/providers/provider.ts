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
}

export interface BillingProvider {
  id: Exclude<ProviderId, "manual">;
  /** True only if the raw body genuinely came from the provider. Never parse before this passes. */
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  /** Vendor payload → our vocabulary. Returns null for a shape we don't recognise at all. */
  parseEvent(rawBody: string, headers: Headers): NormalisedEvent | null;
  /** Is this provider configured well enough to be used at all? */
  isConfigured(): boolean;
}
