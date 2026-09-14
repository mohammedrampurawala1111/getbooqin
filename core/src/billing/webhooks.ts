/**
 * The webhook processor. Provider-agnostic by construction: it takes a
 * `BillingProvider`, and everything below the `parseEvent()` call works
 * in our own vocabulary.
 *
 * ## This is the only path that may set a paid state
 *
 * Checkout return pages never write subscription state — they redirect,
 * and let a delivery here be the truth. That is the single most common
 * way billing integrations go wrong: a user closes the tab before the
 * redirect and never gets their plan, or a redirect is replayed and
 * grants one they didn't buy.
 *
 * ## Idempotency is a unique index, not a check-then-write
 *
 * Both vendors retry, and two retries can land concurrently. Inserting
 * `BillingEvent` first and letting the unique index on
 * `providerEventId` reject the duplicate is race-free in a way that
 * "look it up, then decide" is not.
 *
 * ## Recording is separate from applying
 *
 * The raw payload is stored before anything is interpreted, and
 * `processedAt` is set only once the state change lands. An event that
 * throws stays on the record with its error, so it can be replayed
 * rather than lost — which is what you need when a merchant says they
 * paid and the dashboard disagrees.
 */
import prisma from "../db.js";
import { applyProviderState } from "./subscriptions.js";
import { sendPaymentFailed, sendPaymentFailedFinal } from "./emails.js";
import { issueAndSendInvoice } from "./invoiceDelivery.js";
import type { BillingProvider, NormalisedEvent } from "./providers/provider.js";

export type WebhookOutcome =
  | { ok: true; status: "applied"; type: string; connectionId: string }
  | { ok: true; status: "duplicate"; providerEventId: string }
  | { ok: true; status: "ignored"; type: string; reason: string }
  | { ok: false; status: "unverified" }
  | { ok: false; status: "unparseable" };

/** Postgres unique-violation, surfaced through Prisma. */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

/**
 * Which connection an event belongs to. Prefers what the provider echoed
 * back (Razorpay carries it in `notes`), then falls back to the
 * subscription id we recorded when the mandate was created. Both can
 * legitimately be absent — a `subscription.authenticated` for a checkout
 * that was abandoned before we stored anything — which is a reason to
 * record and move on, not to fail.
 */
async function resolveConnectionId(event: NormalisedEvent): Promise<string | null> {
  if (event.connectionId) {
    const exists = await prisma.connection.findUnique({
      where: { id: event.connectionId },
      select: { id: true },
    });
    if (exists) return exists.id;
  }
  if (event.providerSubscriptionId) {
    const row = await prisma.subscription.findUnique({
      where: { providerSubscriptionId: event.providerSubscriptionId },
      select: { connectionId: true },
    });
    if (row) return row.connectionId;
  }
  return null;
}

export async function handleWebhook(
  provider: BillingProvider,
  rawBody: string,
  headers: Headers
): Promise<WebhookOutcome> {
  // Verify before parsing. An unverified body is attacker-controlled
  // input and must not reach a JSON parser, let alone a state change.
  if (!(await provider.verifyWebhook(rawBody, headers))) {
    return { ok: false, status: "unverified" };
  }

  const event = provider.parseEvent(rawBody, headers);
  if (!event) return { ok: false, status: "unparseable" };

  const connectionId = await resolveConnectionId(event);

  // Record first. If this insert is rejected by the unique index, the
  // event has already been delivered and handled — the retry is a
  // no-op, which is exactly what it should be.
  let recordId: string;
  try {
    const recorded = await prisma.billingEvent.create({
      data: {
        connectionId,
        provider: provider.id,
        providerEventId: event.providerEventId,
        type: event.type,
        payload: rawBody,
      },
      select: { id: true },
    });
    recordId = recorded.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: true, status: "duplicate", providerEventId: event.providerEventId };
    }
    throw err;
  }

  const skip = (reason: string): WebhookOutcome => {
    // Marked processed: there was nothing to do, and leaving it unset
    // would make the "received but not applied" query useless for
    // finding events that genuinely failed.
    void prisma.billingEvent.update({ where: { id: recordId }, data: { processedAt: new Date() } }).catch(() => {});
    return { ok: true, status: "ignored", type: event.type, reason };
  };

  if (event.type === "ignored") return skip(`no action for ${event.providerEventName}`);
  if (!connectionId) return skip("no connection matches this subscription yet");
  if (event.type === "mandate_authenticated") {
    // A mandate exists but no money has moved. Deliberately not a plan
    // change: UPI AutoPay can be authenticated and then fail its first
    // charge, and granting the plan here would hand out a paid tier for
    // an authorisation alone.
    return skip("mandate authenticated; waiting for the first charge");
  }

  const status =
    event.type === "subscription_active" ? "active"
    : event.type === "payment_failed_retrying" ? "past_due"
    // Retries exhausted. Still "past_due" rather than cancelled: the
    // grace window in entitlementsFor() runs from currentPeriodEnd, so
    // access lapses on our clock rather than the instant the provider
    // gives up. Neither vendor chases a customer the way Stripe does,
    // and cutting someone off mid-recovery is how a fixable payment
    // becomes a churned account.
    : event.type === "payment_failed_final" ? "past_due"
    : event.type === "subscription_ended" ? "canceled"
    : null;

  // Resolved outside the `if` because the invoice below needs the same
  // answers the state change used.
  const existing = await prisma.subscription.findUnique({ where: { connectionId } });
  // An event for a plan id we don't recognise (created in the
  // dashboard but never added to plans.ts / the env) must not
  // silently downgrade someone to whatever `plan` defaults to.
  const plan = event.plan ?? (existing?.plan as never) ?? "free";
  const currency = event.currency ?? (existing?.currency as never) ?? "INR";
  const billingCycle = event.billingCycle ?? (existing?.billingCycle as never) ?? "monthly";

  /**
   * When the paid-for period runs to.
   *
   * PayPal puts `billing_info.next_billing_time` on the *subscription*
   * resource, and a renewal arrives as `PAYMENT.SALE.COMPLETED`, whose
   * resource is a sale with no such field. Left alone, the value written
   * at activation was preserved forever by applyProviderState's
   * `?? existing` — so a year of renewals never advanced it, and
   * cancelling in month twelve dropped the merchant to Free
   * *immediately*, throwing away the month they had just paid for.
   *
   * One extra provider call per renewal, only when the event itself
   * couldn't say. Failure is survivable: the period end simply stays
   * where it was, which is the old behaviour.
   */
  let currentPeriodEnd = event.currentPeriodEnd;
  if (!currentPeriodEnd && event.payment && event.providerSubscriptionId) {
    currentPeriodEnd = await provider
      .fetchSubscription(event.providerSubscriptionId)
      .then((snapshot) => snapshot?.currentPeriodEnd ?? null)
      .catch((err) => {
        console.error(`[getbooqin billing] could not refresh the period end for ${connectionId}:`, err);
        return null;
      });
  }

  try {
    if (status) {
      await applyProviderState(connectionId, {
        plan,
        status,
        provider: provider.id,
        providerSubscriptionId: event.providerSubscriptionId ?? existing?.providerSubscriptionId ?? "",
        providerCustomerId: event.providerCustomerId,
        currency,
        billingCycle,
        currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      });
    }

    // The invoice, for an event that actually took money. After the
    // state change and before the event is marked processed, but not
    // *inside* the state change: issuing is idempotent on the payment
    // id, so a retry cannot double-invoice, and a failure here must not
    // roll back a plan the customer has paid for.
    //
    // Deliberately awaited, unlike the dunning emails below. An invoice
    // is a legal record with a consecutive number; it is worth the
    // provider waiting a moment for, and issueAndSendInvoice() never
    // throws.
    //
    // Gated on the *resolved* plan, not on `event.plan`. On the PayPal
    // rail the two are never the same thing: the only event carrying
    // money is PAYMENT.SALE.COMPLETED, whose resource is a sale with no
    // `plan_id` — so `event.plan` is always null there, and requiring it
    // meant no PayPal charge was ever invoiced. Not the first one, not
    // any renewal. The resolved plan falls back to the subscription's
    // own, which is exactly what the state change above just used.
    if (event.payment && status === "active" && plan !== "free") {
      await issueAndSendInvoice({
        connectionId,
        provider: provider.id,
        providerPaymentId: event.payment.id,
        providerInvoiceId: event.payment.providerInvoiceId,
        amountMinor: event.payment.amountMinor,
        currency: (event.currency ?? event.payment.currency) as never,
        plan,
        cycle: billingCycle,
        periodEnd: currentPeriodEnd,
      });
    }

    await prisma.billingEvent.update({ where: { id: recordId }, data: { processedAt: new Date() } });

    // Dunning. Fired after the state change and deliberately not
    // awaited into the webhook's own success: the provider is waiting on
    // this response, and a slow or failing SMTP relay must not turn a
    // correctly-applied event into a 500 and a retry — which would then
    // re-send the same email on every retry. The state change is the
    // part that has to be right; the email is best-effort by design.
    if (status === "past_due" && event.plan !== null) {
      const notify =
        event.type === "payment_failed_final"
          ? sendPaymentFailedFinal(connectionId, event.plan, event.currentPeriodEnd)
          : sendPaymentFailed(connectionId, event.plan, event.currentPeriodEnd);
      void notify.catch((err) =>
        console.error(`[getbooqin billing] dunning email failed for ${connectionId}:`, err)
      );
    }

    return { ok: true, status: "applied", type: event.type, connectionId };
  } catch (err) {
    // Left unprocessed and with its error on the record, so it shows up
    // in "received but not applied" and can be replayed. Rethrown so the
    // route answers non-2xx and the provider retries it for us.
    await prisma.billingEvent.update({
      where: { id: recordId },
      data: { error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500) },
    });
    throw err;
  }
}
