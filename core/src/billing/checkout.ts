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
import { createSubscription, cancelSubscription, providerPlanId } from "./providers/razorpay.js";
import { ensureSubscription } from "./subscriptions.js";
import { getSettings } from "../booking/settings.js";
import { validateTaxIdentity, type TaxIdentity } from "./tax.js";
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
  country?: string | null;
  taxId?: string | null;
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

  // Tax identity, after the state guards above and before anything is
  // created at the provider. Deliberately not first: telling a merchant
  // who is already subscribed to "enter your VAT number" is a worse
  // answer than telling them they're already subscribed, and the state
  // checks are about whether this action makes sense at all.
  //
  // GetBooqin sells from an Indian entity, so outside India this is a
  // zero-rated B2B export and the customer's tax number is the evidence
  // for it — selling to an EU *consumer* instead triggers non-Union OSS
  // registration from the first euro, with no threshold. Captured rather
  // than derived: the billing currency is a guess from the shop's
  // settings, and a tax position must not rest on a guess.
  const tax = validateTaxIdentity({ country: args.country, taxId: args.taxId });
  if (!tax.identity) {
    throw new GetBooqinError("getbooqin_tax_identity", tax.problems[0]!.message, 400);
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
    data: {
      providerSubscriptionId: created.providerSubscriptionId,
      billingProvider: "razorpay",
      taxCountry: tax.identity.country,
      taxId: tax.identity.taxId,
      taxStatus: tax.identity.status,
    },
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

/**
 * Which (plan, cycle) pairs can actually be sold in this currency right
 * now — i.e. have a plan id at the provider for the current mode.
 *
 * The Billing screen renders from this rather than from the price table,
 * because a price existing in plans.ts says nothing about whether
 * anyone can be charged it. Without this the page offered an Upgrade
 * button for a currency with no plans behind it, and the only feedback
 * was a generic "we couldn't start that subscription" after the click.
 * Refusing server-side was correct; offering the button at all was not.
 */
export function sellablePrices(currency: Currency): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const plan of ["starter", "growth", "business"] as const) {
    for (const cycle of ["monthly", "yearly"] as const) {
      out[`${plan}:${cycle}`] = providerPlanId(plan, currency, cycle) !== null;
    }
  }
  return out;
}
