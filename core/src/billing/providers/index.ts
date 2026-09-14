/**
 * Which vendor holds a given mandate.
 *
 * Two rails now: Razorpay for India, PayPal for everywhere else.
 *
 * The important rule is that **an existing subscription never moves**.
 * Which provider to use is answered from `Subscription.billingProvider`
 * for any account that already has a mandate, and only from the
 * currency for one that doesn't — because migrating a live subscription
 * between vendors means cancel-and-re-authorise, which loses the
 * customer. An account that started on Razorpay in EUR before PayPal
 * existed stays on Razorpay, and reconciling it keeps asking Razorpay.
 */
import { RazorpayProvider } from "./razorpay.js";
import { PayPalProvider } from "./paypal.js";
import type { BillingProvider } from "./provider.js";
import { providerForCurrency, type Currency, type ProviderId } from "../plans.js";

const PROVIDERS: Record<Exclude<ProviderId, "manual">, BillingProvider> = {
  razorpay: RazorpayProvider,
  paypal: PayPalProvider,
};

/** By id. Throws for "manual", which is an admin grant with no vendor behind it. */
export function providerFor(id: string): BillingProvider {
  const provider = PROVIDERS[id as Exclude<ProviderId, "manual">];
  if (!provider) throw new Error(`No billing provider named "${id}"`);
  return provider;
}

/** The rail a *new* subscription in this currency starts on. */
export function providerForNewSubscription(currency: Currency): BillingProvider {
  return providerFor(providerForCurrency(currency));
}

/**
 * The rail an account is already on, falling back to what its currency
 * would choose if it has no mandate yet.
 */
export function providerForSubscription(row: {
  billingProvider: string;
  providerSubscriptionId: string | null;
  currency: string;
}): BillingProvider {
  if (row.providerSubscriptionId && row.billingProvider !== "manual") {
    return providerFor(row.billingProvider);
  }
  return providerForNewSubscription(row.currency as Currency);
}

export function allProviders(): BillingProvider[] {
  return Object.values(PROVIDERS);
}
