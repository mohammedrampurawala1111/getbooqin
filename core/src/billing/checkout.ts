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
import { providerForNewSubscription, providerForSubscription } from "./providers/index.js";
import { reconcileSubscription } from "./reconcile.js";
import type { BillingProvider } from "./providers/provider.js";
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
  type PaidPlanId,
  type PlanId,
  type ProviderId,
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
  /** Who the invoice is made out to, and where. Required to issue one. */
  billingName?: string | null;
  billingAddress?: string | null;
  /** Where the provider should return the merchant. PayPal honours these; Razorpay ignores them. */
  returnUrl?: string;
  cancelUrl?: string;
}): Promise<CheckoutStart> {
  const { connectionId } = args;


  await ensureSubscription(connectionId);

  // Ask the provider first, every time. If a previous attempt actually
  // succeeded and we never heard about it, the guards below are being
  // evaluated against a stale row — and the specific thing they would
  // then wave through is a *second* live mandate on an account that is
  // already paying. Cheap, and it runs only when there is an
  // unactivated mandate to ask about.
  await reconcileSubscription(connectionId).catch(() => undefined);

  const existing = await ensureSubscription(connectionId);
  const entitlements = await entitlementsFor(connectionId);
  const owner = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { user: { select: { email: true } } },
  });

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
  // GetBooqin sells from an Indian entity, so the country decides
  // between a domestic GST supply and a zero-rated export. Captured
  // rather than derived: the billing currency is a guess from the
  // shop's settings, and a tax position must not rest on a guess.
  //
  // The tax number itself is optional everywhere — see tax.ts. What it
  // changes is the position recorded on the invoice, not whether the
  // sale is allowed.
  const tax = validateTaxIdentity({ country: args.country, taxId: args.taxId });
  if (!tax.identity) {
    throw new GetBooqinError("getbooqin_tax_identity", tax.problems[0]!.message, 400);
  }

  // Which rail this subscription starts on, or stays on. An account
  // that already has a mandate keeps its existing provider even if the
  // currency would now route elsewhere — migrating a live subscription
  // means cancel-and-re-authorise, which loses the customer.
  const provider = providerForSubscription({ ...existing, currency });

  if (!provider.isConfigured()) {
    throw new GetBooqinError(
      "getbooqin_provider_unavailable",
      "Card payments aren't available for your region yet.",
      503
    );
  }
  // A price existing in plans.ts says nothing about whether anyone can
  // be charged it — that needs a plan created at the vendor, in this
  // mode. Checked here as well as in sellablePrices() so a hand-posted
  // form is refused the same way the button is hidden, and refused
  // *before* a mandate could be created rather than as a 502 afterwards.
  if (!provider.planId(args.plan, currency, args.cycle)) {
    throw new GetBooqinError(
      "getbooqin_provider_unavailable",
      "That plan isn't available in your currency yet.",
      503
    );
  }

  // A live mandate has to be cancelled before a new one is authorised,
  // or the merchant ends up with two recurring debits. Razorpay has no
  // "swap the plan on this mandate" for a live subscription, so a change
  // of tier is genuinely cancel-then-resubscribe.
  //
  // The condition used to be `entitlements.status === "active"`, which
  // reads the *local* row — so a mandate that was created, authorised
  // and charged at Razorpay while the activation never reached us was
  // not cancelled, and clicking the still-offered "Switch to …" button
  // authorised a second recurring debit beside it. The provider's own
  // answer is the only trustworthy one here, so that is what is asked.
  if (existing.providerSubscriptionId && (await liveMandateExists(provider, existing.providerSubscriptionId))) {
    try {
      await provider.cancelSubscription(existing.providerSubscriptionId, { immediately: false });
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
    created = await provider.createSubscription({
      connectionId,
      plan: args.plan,
      currency,
      cycle: args.cycle,
      // So Razorpay's own payment receipts can actually reach someone.
      // Without a customer email it creates the customer anyway, emails
      // nothing, and `customer_notify: 1` is quietly inert.
      customer: {
        name: args.billingName?.trim() || existing.billingName || undefined,
        email: owner?.user.email || undefined,
      },
      returnUrl: args.returnUrl,
      cancelUrl: args.cancelUrl,
    });
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
      billingProvider: provider.id,
      taxCountry: tax.identity.country,
      taxId: tax.identity.taxId,
      taxStatus: tax.identity.status,
      // Only overwrite when something was actually supplied — a
      // returning merchant who leaves these alone keeps what they gave
      // last time rather than having it blanked.
      ...(args.billingName?.trim() ? { billingName: args.billingName.trim() } : {}),
      ...(args.billingAddress?.trim() ? { billingAddress: args.billingAddress.trim() } : {}),
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
 * Is there still a mandate at the provider that could take money?
 *
 * Errs toward "yes". A lookup that fails tells us nothing, and the two
 * wrong answers are not symmetrical: believing a dead mandate is alive
 * costs one redundant cancel call, believing a live one is dead charges
 * the merchant twice.
 */
async function liveMandateExists(provider: BillingProvider, providerSubscriptionId: string): Promise<boolean> {
  try {
    const snapshot = await provider.fetchSubscription(providerSubscriptionId);
    if (!snapshot) return false; // The provider has never heard of it.
    return provider.isLive(snapshot.providerStatus);
  } catch (err) {
    console.error(`[getbooqin billing] could not check ${providerSubscriptionId} before re-subscribing:`, err);
    return true;
  }
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
  // Whichever rail this mandate is actually on.
  await providerForSubscription(row).cancelSubscription(row.providerSubscriptionId, { immediately: false });
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
      // Asked of the rail this currency routes to, so a EUR account is
      // told what PayPal can sell rather than what Razorpay can.
      out[`${plan}:${cycle}`] = !!providerForNewSubscription(currency).planId(plan, currency, cycle);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* What can actually be charged, right now                             */
/* ------------------------------------------------------------------ */

/**
 * Every price point, and whether the rail it routes to can charge it in
 * the mode this deployment is running in.
 *
 * `sellablePrices()` above answers this for one merchant, on their own
 * Billing screen, at the moment they try to upgrade. That is the right
 * place to *refuse*, and the wrong place to *find out* — by then a
 * customer has already reached a page with nothing to buy on it, and we
 * learn about it from them.
 *
 * A plan id is created by hand at the provider and pasted into
 * plans.ts, and an empty slot is the normal state of a price nobody has
 * got round to creating yet. It looks identical to a configured one
 * from everywhere except here. So this is the same question asked from
 * the operator's side and asked about *all* of it: which of the
 * eighteen paid price points a customer can complete today, which rail
 * each would go to, and which mode that rail is in.
 *
 * Read by /admin, where somebody sees it before a merchant does.
 */
export interface PriceCoverage {
  plan: PaidPlanId;
  currency: Currency;
  cycle: BillingCycle;
  /** The rail this currency routes a new subscription to. */
  provider: Exclude<ProviderId, "manual">;
  /** "test" | "live" | "sandbox" — whichever word that provider uses. */
  mode: string;
  /** False when the provider has no plan id for this price in this mode. */
  sellable: boolean;
}

export interface BillingCoverage {
  prices: PriceCoverage[];
  /** Currencies with no purchasable plan at all — a merchant there cannot upgrade. */
  deadCurrencies: Currency[];
  sellableCount: number;
  totalCount: number;
}

export function billingCoverage(): BillingCoverage {
  const prices: PriceCoverage[] = [];

  for (const plan of ["starter", "growth", "business"] as const) {
    for (const currency of ["INR", "USD", "EUR"] as const) {
      const provider = providerForNewSubscription(currency);
      for (const cycle of ["monthly", "yearly"] as const) {
        prices.push({
          plan,
          currency,
          cycle,
          provider: providerForCurrency(currency),
          mode: provider.mode(),
          sellable: !!provider.planId(plan, currency, cycle),
        });
      }
    }
  }

  const deadCurrencies = (["INR", "USD", "EUR"] as const).filter(
    (c) => !prices.some((p) => p.currency === c && p.sellable)
  );

  return {
    prices,
    deadCurrencies,
    sellableCount: prices.filter((p) => p.sellable).length,
    totalCount: prices.length,
  };
}
