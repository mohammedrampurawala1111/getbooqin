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
  if (!provider.verifyWebhook(rawBody, headers)) {
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

  try {
    if (status) {
      const existing = await prisma.subscription.findUnique({ where: { connectionId } });
      // An event for a plan id we don't recognise (created in the
      // dashboard but never added to plans.ts / the env) must not
      // silently downgrade someone to whatever `plan` defaults to.
      const plan = event.plan ?? (existing?.plan as never) ?? "free";

      await applyProviderState(connectionId, {
        plan,
        status,
        provider: provider.id,
        providerSubscriptionId: event.providerSubscriptionId ?? existing?.providerSubscriptionId ?? "",
        providerCustomerId: event.providerCustomerId,
        currency: event.currency ?? (existing?.currency as never) ?? "INR",
        billingCycle: event.billingCycle ?? (existing?.billingCycle as never) ?? "monthly",
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      });
    }

    await prisma.billingEvent.update({ where: { id: recordId }, data: { processedAt: new Date() } });
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
