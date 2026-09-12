/**
 * Starting an upgrade.
 *
 * Everything provider-specific lives behind `providerFor()`, and
 * everything that decides *whether* an upgrade is allowed lives here, so
 * a second rail (PayPal, later) inherits the rules rather than
 * reimplementing them.
 *
 * This module deliberately writes **nothing** to `Subscription`. It
 * creates the mandate at the provider and hands back a URL; the plan is
 * granted by the webhook, and only once money has moved. A merchant can
 * abandon the hosted page, a mandate can authenticate and then fail its
 * first charge, and a browser redirect can be replayed — none of which
 * should produce a paid account.
 */
import prisma from "../db.js";
import { GetBooqinError } from "../booking/errors.js";
import { entitlementsFor } from "./entitlements.js";
import { createSubscription, cancelSubscription } from "./providers/razorpay.js";
import { ensureSubscription } from "./subscriptions.js";
import { getSettings } from "../booking/settings.js";
import {
  PLANS,
  planRank,
  priceFor,
  providerForCurrency,
  billingCurrencyFor,
  isBillingCycle,
  isPlanId,
  type BillingCycle,
  type Currency,
  type PlanId,
} from "./plans.js";

export interface CheckoutStart {
  /** Where to send the merchant to authorise the mandate. */
  approvalUrl: string;
  providerSubscriptionId: string;
  plan: PlanId;
  currency: Currency;
  cycle: BillingCycle;
}

/**
 * Works the billing currency out from the shop's own settings, and
 * persists it so the Billing screen and the checkout agree.
 */
export async function resolveBillingCurrency(connectionId: string, fallback: Currency): Promise<Currency> {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { shop: true, platform: true },
  });
  if (!connection) return fallback;

  const settings = await getSettings(connection.shop, connection.platform);
  const resolved = billingCurrencyFor(settings);

  if (resolved !== fallback) {
    await prisma.subscription.updateMany({
      // Guarded on there being no mandate yet, so a concurrent webhook
      // that has just frozen the currency wins over this.
      where: { connectionId, providerSubscriptionId: null },
      data: { currency: resolved },
    });
  }
  return resolved;
}

export function parsePlanSelection(plan: unknown, cycle: unknown): { plan: PlanId; cycle: BillingCycle } {
  if (!isPlanId(plan) || plan === "free") {
    throw new GetBooqinError("getbooqin_invalid_plan", "Pick a plan to upgrade to.", 400);
  }
  if (!isBillingCycle(cycle)) {
    throw new GetBooqinError("getbooqin_invalid_cycle", "Pick monthly or yearly billing.", 400);
  }
  return { plan, cycle };
}

/**
 * Creates the mandate and returns where to authorise it.
 *
 * The currency comes from the subscription row, not from the request:
 * it is frozen at first upgrade and never re-derived, because an account
 * whose country field changes must not silently start being billed in a
 * different currency on an existing mandate.
 */
export async function startCheckout(args: {
  connectionId: string;
  plan: PlanId;
  cycle: BillingCycle;
}): Promise<CheckoutStart> {
  const { connectionId } = args;

  const existing = await ensureSubscription(connectionId);
  const entitlements = await entitlementsFor(connectionId);

  // Currency is decided at the *first mandate*, not when the row was
  // created. A subscription row exists from signup, long before anyone
  // knows where the business is or whether it will ever pay, so guessing
  // then and freezing it produced accounts stuck on a currency we have
  // no plans for — which is exactly how this failed the first time it
  // was used. Once a mandate exists it really is frozen: re-deriving
  // would silently re-price a live subscription.
  const currency = existing.providerSubscriptionId
    ? (existing.currency as Currency)
    : await resolveBillingCurrency(connectionId, existing.currency as Currency);

  if (!priceFor(args.plan, currency, args.cycle)) {
    throw new GetBooqinError("getbooqin_invalid_plan", "That plan isn't available.", 400);
  }

  // A hidden tier can still be reached — but only by an account an admin
  // has already granted it to, which is the whole point of shipping
  // `business` defined-but-invisible.
  if (!PLANS[args.plan].visible && planRank(entitlements.plan) < planRank(args.plan)) {
    throw new GetBooqinError("getbooqin_plan_unavailable", "That plan isn't available on this account.", 403);
  }

  // Already on it, and paying for it. Re-running checkout would create a
  // second mandate at the provider and charge twice.
  if (
    entitlements.plan === args.plan &&
    entitlements.billingCycle === args.cycle &&
    (entitlements.status === "active" || entitlements.status === "past_due")
  ) {
    throw new GetBooqinError("getbooqin_already_subscribed", `You're already on ${PLANS[args.plan].name}.`, 409);
  }

  if (providerForCurrency(currency) !== "razorpay") {
    throw new GetBooqinError(
      "getbooqin_provider_unavailable",
      "Card payments aren't available for your region yet.",
      503
    );
  }

  // A live mandate has to be cancelled before a new one is authorised,
  // or the merchant ends up with two recurring debits. Razorpay has no
  // "swap the plan on this mandate" for a live subscription, so a change
  // of tier is genuinely cancel-then-resubscribe.
  if (existing.providerSubscriptionId && entitlements.status === "active") {
    try {
      await cancelSubscription(existing.providerSubscriptionId, { immediately: false });
    } catch (err) {
      // Worth failing on: proceeding would leave two mandates live, and
      // the merchant discovers that through their bank statement. The
      // provider's own reason is logged rather than returned — it is
      // operator detail, and this message is read by a merchant.
      console.error(`[getbooqin billing] cancel-before-upgrade failed for ${connectionId}:`, err);
      throw new GetBooqinError(
        "getbooqin_cancel_failed",
        "We couldn't close your current subscription, so we've stopped rather than risk charging you twice. Please get in touch.",
        502
      );
    }
  }

  let created;
  try {
    created = await createSubscription({ connectionId, plan: args.plan, currency, cycle: args.cycle });
  } catch (err) {
    console.error(`[getbooqin billing] checkout failed for ${connectionId}:`, err);
    throw new GetBooqinError(
      "getbooqin_checkout_failed",
      "We couldn't start that subscription. Please try again, or get in touch if it keeps happening.",
      502
    );
  }

  // Recorded so a webhook arriving before the merchant returns — which
  // is normal — can find the account by subscription id even if the
  // `notes` round-trip ever fails. Deliberately NOT a plan or status
  // change: nothing has been paid.
  await prisma.subscription.update({
    where: { connectionId },
    data: { providerSubscriptionId: created.providerSubscriptionId, billingProvider: "razorpay" },
  });

  return {
    approvalUrl: created.approvalUrl,
    providerSubscriptionId: created.providerSubscriptionId,
    plan: args.plan,
    currency,
    cycle: args.cycle,
  };
}

/**
 * Cancels at the provider and lets the webhook record it. Access
 * continues to the end of the paid period — see entitlementsFor().
 */
export async function cancelAtPeriodEnd(connectionId: string): Promise<void> {
  const row = await prisma.subscription.findUnique({ where: { connectionId } });
  if (!row?.providerSubscriptionId) {
    throw new GetBooqinError("getbooqin_no_subscription", "There's no active subscription to cancel.", 400);
  }
  await cancelSubscription(row.providerSubscriptionId, { immediately: false });
}
