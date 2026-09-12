/**
 * Dunning — chasing a failed payment.
 *
 * **Neither Razorpay nor PayPal does this for you.** Stripe emails the
 * customer, retries on a schedule and surfaces a hosted "update your
 * card" page; here, the provider retries the charge and tells us what
 * happened, and everything a human sees is ours to send. That gap is the
 * single most underestimated item in the whole billing workstream, and
 * it is why a grace period without these emails is just a silent
 * countdown to being downgraded.
 *
 * Three touches, deliberately not more:
 *   1. the charge failed and we're retrying — nothing has changed yet;
 *   2. retries are exhausted, here is the date access actually stops;
 *   3. it stopped.
 *
 * No retry-schedule tuning, no card-expiry prediction, no win-back
 * sequence. Those are a growth exercise; this is the minimum that stops
 * a recoverable payment quietly becoming a churned account.
 */
import prisma from "../db.js";
import { getSettings } from "../booking/settings.js";
import { sendBillingNotice } from "../booking/mailer.js";
import { isEmail } from "../booking/bookingsShared.js";
import { PAST_DUE_GRACE_DAYS } from "./entitlements.js";
import { PLANS, type PlanId } from "./plans.js";

/**
 * Who hears about a billing problem: the person who owns the account,
 * at the address they log in with — not `settings.admin_email`, which is
 * where *booking* notifications go and may well be a shared inbox the
 * owner never reads.
 */
async function recipient(connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    select: { id: true, shop: true, platform: true, credentials: true, userId: true, status: true, connectedAt: true, createdAt: true, updatedAt: true, slug: true, user: { select: { email: true } } },
  });
  if (!connection || !isEmail(connection.user.email)) return null;

  const settings = await getSettings(connection.shop, connection.platform);
  return {
    connection,
    email: connection.user.email,
    businessName: settings.business_name || connection.shop,
  };
}

function billingUrl(connectionId: string): string {
  const base = process.env.APP_URL ?? "";
  return `${base}/dashboard/${connectionId}/settings?page=billing`;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(value);
}

/** Grace runs from the end of the period that wasn't paid for — same arithmetic entitlementsFor() uses. */
function graceEndsOn(currentPeriodEnd: Date | null): Date {
  const from = currentPeriodEnd ?? new Date();
  return new Date(from.getTime() + PAST_DUE_GRACE_DAYS * 86_400_000);
}

/**
 * First touch: the charge failed, the provider is retrying, nothing has
 * changed yet. Leads with that — a "payment failed" email that doesn't
 * say whether the service still works makes people panic or ignore it,
 * and both are bad.
 */
export async function sendPaymentFailed(connectionId: string, plan: PlanId, currentPeriodEnd: Date | null): Promise<void> {
  const target = await recipient(connectionId);
  if (!target) return;

  const deadline = formatDate(graceEndsOn(currentPeriodEnd));
  await sendBillingNotice(
    target.connection,
    target.email,
    `Your GetBooqin payment didn't go through`,
    `Hi,\n\n` +
      `We couldn't take this month's payment for ${target.businessName}.\n\n` +
      `Nothing has changed yet — your ${PLANS[plan].name} plan is still fully active, your booking page is still ` +
      `taking bookings, and we'll keep retrying the payment.\n\n` +
      `If it hasn't gone through by ${deadline}, the account moves to the Free plan. Nothing is deleted when ` +
      `that happens, but the Free limits would start to apply.\n\n` +
      `The usual cause is an expired card or a bank declining a recurring debit. You can fix it here:\n` +
      `${billingUrl(connectionId)}\n\n` +
      `GetBooqin`
  );
}

/**
 * Second touch: the provider has given up retrying. This is the one that
 * has to carry a date — "soon" is what people ignore.
 */
export async function sendPaymentFailedFinal(connectionId: string, plan: PlanId, currentPeriodEnd: Date | null): Promise<void> {
  const target = await recipient(connectionId);
  if (!target) return;

  const ends = graceEndsOn(currentPeriodEnd);
  const lapsed = ends.getTime() <= Date.now();

  await sendBillingNotice(
    target.connection,
    target.email,
    lapsed
      ? `${target.businessName} has moved to the Free plan`
      : `Action needed: ${target.businessName} moves to Free on ${formatDate(ends)}`,
    `Hi,\n\n` +
      (lapsed
        ? `We weren't able to take payment for ${target.businessName}, so the account has moved to the Free plan.\n\n`
        : `We've tried several times and still can't take payment for ${target.businessName}.\n\n` +
          `Your ${PLANS[plan].name} plan stays active until ${formatDate(ends)}. After that the account moves to ` +
          `the Free plan.\n\n`) +
      `To be clear about what that means: nothing is deleted. Your bookings, your customers and your settings ` +
      `all stay exactly as they are, and your booking page keeps working. What changes is that the Free plan's ` +
      `limits apply, so you may not be able to add new staff or services above them.\n\n` +
      `Paying restores everything immediately:\n${billingUrl(connectionId)}\n\n` +
      `If you'd rather not continue, you don't need to do anything.\n\n` +
      `GetBooqin`
  );
}
