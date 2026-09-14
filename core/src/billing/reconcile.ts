/**
 * Asking the provider what actually happened.
 *
 * The webhook is the normal path and, for renewals, the only possible
 * one — month two has no browser, no session and no return URL to learn
 * from. But a webhook is a message a third party has to successfully
 * deliver to us, and when it doesn't arrive there is no error anywhere:
 * the card is charged, the provider shows the subscription active, and
 * the account quietly stays on its old plan. Money taken, service not
 * granted.
 *
 * The ways that happens are ordinary, not exotic:
 *
 *  - Razorpay keeps webhooks **separately per mode**, so an endpoint
 *    registered in live mode delivers nothing for a test-mode payment.
 *  - The secret is rotated on one side only, and every delivery fails
 *    signature verification.
 *  - The app is mid-deploy, returns 5xx, and retries are exhausted.
 *
 * So activation must not depend on delivery alone. This module pulls
 * the same state the webhook would have pushed and applies it through
 * exactly the same function, `applyProviderState` — so a reconciled
 * account and a webhook-driven one are indistinguishable afterwards,
 * and there is no second definition of what each provider status means.
 *
 * It is deliberately not a substitute for the webhook. Renewals,
 * failures and cancellations months from now still arrive that way;
 * this closes the window around the one moment a human is actually
 * waiting: they just paid, and they are looking at the screen.
 */
import prisma from "../db.js";
import { applyProviderState } from "./subscriptions.js";
import { providerFor } from "./providers/index.js";
import { issueAndSendInvoice } from "./invoiceDelivery.js";
import type { BillingCycle, Currency, PlanId } from "./plans.js";
import type { BillingProvider } from "./providers/provider.js";

export interface ReconcileResult {
  /** True when the local row was actually changed. */
  changed: boolean;
  reason: string;
  plan?: PlanId;
  status?: string;
  providerStatus?: string;
}

/**
 * Brings one account's subscription into line with the provider.
 *
 * Safe to call on any schedule and from any number of places at once:
 * it writes only when the provider's answer differs from what is
 * already stored, and the write is the same idempotent
 * `applyProviderState` the webhook performs — so this racing a webhook
 * that arrives at the same moment produces the same row either way.
 *
 * Never throws for the ordinary reasons. A merchant loading their
 * Billing page must not see an error because Razorpay is slow, and a
 * failure here means "we learned nothing", not "something is broken".
 */
export async function reconcileSubscription(connectionId: string): Promise<ReconcileResult> {
  const row = await prisma.subscription.findUnique({ where: { connectionId } });

  if (!row) return { changed: false, reason: "no subscription row" };
  if (row.billingProvider === "manual") {
    // An admin comp. There is nothing at a provider to ask about, and
    // overwriting it from one would revoke a grant somebody made
    // deliberately.
    return { changed: false, reason: "manually granted; no provider to ask" };
  }
  if (!row.providerSubscriptionId) return { changed: false, reason: "no mandate at the provider yet" };

  // Whoever holds this mandate, not whoever the currency would pick
  // today — an account on the old rail is still reconciled there.
  const provider = providerFor(row.billingProvider);

  let snapshot;
  try {
    snapshot = await provider.fetchSubscription(row.providerSubscriptionId);
  } catch (err) {
    console.error(`[getbooqin billing] reconcile lookup failed for ${connectionId}:`, err);
    return { changed: false, reason: "provider lookup failed" };
  }

  if (!snapshot) {
    // Created in the other mode, or deleted. Not an error and not a
    // reason to touch the local row — a test-mode id after a switch to
    // live keys reads exactly like this.
    return { changed: false, reason: "provider does not recognise this subscription" };
  }

  const status = provider.statusFor(snapshot.providerStatus);
  if (!status) {
    // created / authenticated / paused — a mandate may exist but no
    // money has moved. Granting a plan here would hand out a paid tier
    // for an authorisation alone, which is the same line the webhook
    // draws for subscription.authenticated.
    return { changed: false, reason: `nothing paid yet (${snapshot.providerStatus})`, providerStatus: snapshot.providerStatus };
  }

  const plan = (snapshot.plan ?? (row.plan as PlanId)) as PlanId;
  const currency = (snapshot.currency ?? (row.currency as Currency)) as Currency;
  const billingCycle = (snapshot.billingCycle ?? (row.billingCycle as BillingCycle)) as BillingCycle;

  const alreadyRight =
    row.status === status &&
    row.plan === plan &&
    row.currency === currency &&
    row.billingCycle === billingCycle &&
    row.cancelAtPeriodEnd === snapshot.cancelAtPeriodEnd &&
    sameInstant(row.currentPeriodEnd, snapshot.currentPeriodEnd);

  if (alreadyRight) {
    return { changed: false, reason: "already in step", plan, status, providerStatus: snapshot.providerStatus };
  }

  await applyProviderState(connectionId, {
    plan,
    status,
    provider: provider.id,
    providerSubscriptionId: snapshot.providerSubscriptionId,
    providerCustomerId: snapshot.providerCustomerId,
    currency,
    billingCycle,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
  });

  console.log(
    `[getbooqin billing] reconciled ${connectionId} from the provider: ${row.plan}/${row.status} -> ${plan}/${status} (${provider.id} says "${snapshot.providerStatus}")`
  );

  // A charge we only learned about by asking still has to be invoiced.
  // This is the path that covers the whole reason reconciliation
  // exists: the webhook never arrived, so nothing has issued an invoice
  // for money that was genuinely taken. Issuing is idempotent on the
  // payment id, so a webhook that turns up later invoices nothing twice.
  if (status === "active") {
    await invoiceUnbilledCharges(connectionId, provider, snapshot.providerSubscriptionId, plan, billingCycle).catch((err) =>
      console.error(`[getbooqin billing] could not invoice charges for ${connectionId}:`, err)
    );
  }

  return { changed: true, reason: "applied the provider's state", plan, status, providerStatus: snapshot.providerStatus };
}

/**
 * Whether reconciling is worth a network round trip on this page load.
 *
 * True exactly when there is a mandate at the provider that we do not
 * believe is paying — which is the stuck state and nothing else. An
 * account already recorded as active asks nothing, so the Billing page
 * costs no extra latency in the normal case; renewals and later
 * failures keep arriving by webhook.
 */
export function worthReconciling(row: {
  billingProvider: string;
  providerSubscriptionId: string | null;
  status: string;
}): boolean {
  if (row.billingProvider === "manual" || !row.providerSubscriptionId) return false;
  return row.status !== "active";
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * Issues an invoice for every paid charge on a subscription that does
 * not have one yet.
 *
 * Walks the provider's own list rather than assuming a single charge:
 * an account that went months without a working webhook has months of
 * payments, and each one is a separate invoice with its own number.
 * Issuing is keyed on the payment id, so charges already invoiced are
 * skipped without a second thought.
 */
export async function invoiceUnbilledCharges(
  connectionId: string,
  provider: BillingProvider,
  providerSubscriptionId: string,
  plan: PlanId,
  billingCycle: BillingCycle
): Promise<number> {
  const charges = await provider.fetchPaidCharges(providerSubscriptionId);
  let issued = 0;

  // Oldest first, so invoice numbers run in the order the money moved
  // rather than in whatever order the provider listed them.
  for (const charge of [...charges].sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0))) {
    const invoice = await issueAndSendInvoice({
      connectionId,
      provider: provider.id,
      providerPaymentId: charge.paymentId,
      providerInvoiceId: charge.providerInvoiceId,
      amountMinor: charge.amountMinor,
      currency: charge.currency as Currency,
      plan,
      cycle: billingCycle,
      periodStart: charge.periodStart,
      periodEnd: charge.periodEnd,
      issuedAt: charge.paidAt ?? undefined,
    });
    if (invoice) issued += 1;
  }

  return issued;
}
