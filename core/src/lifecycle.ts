/**
 * Lifecycle emails — the four moments in an account's life that deserve
 * a message, and the bookkeeping that stops any of them being sent
 * twice.
 *
 *   welcome        the merchant has gone live and has a booking link
 *   first_booking  their very first real booking has arrived
 *   trial_ending   three days left
 *   trial_ended    the trial is over and the account is on Free
 *
 * Payment failure is the fifth touch and lives in billing/emails.ts,
 * where it belongs — it is driven by provider webhooks, not by time.
 *
 * ## Why the trial nudges matter more than they look
 *
 * A trial that simply stops is indistinguishable, from the merchant's
 * side, from the product breaking. They come back a week later, find
 * they can't add a service, and conclude it's broken rather than that
 * they need to pay. The two nudges cost four paragraphs and are the
 * difference between a conversion decision and a silent lapse.
 *
 * ## Exactly-once
 *
 * `LifecycleEmail` has a unique index on (connectionId, kind), and that
 * index — not any check in this file — is what makes each of these send
 * once. The sweep runs on the same ten-minute interval as reminders, so
 * without it "your trial ends in 3 days" would arrive 432 times.
 *
 * The row is claimed *before* the send and deleted again if the send
 * throws, which makes this at-least-once rather than at-most-once: a
 * crashed send is retried on the next sweep instead of being lost. A
 * duplicate welcome is mildly embarrassing; a trial that ends with no
 * warning costs the sale.
 */
import prisma from "./db.js";
import events from "./booking/events.js";
import { getSettings } from "./booking/settings.js";
import { sendBillingNotice } from "./booking/mailer.js";
import { isEmail } from "./booking/bookingsShared.js";
import { PLANS, TRIAL_PLAN } from "./billing/plans.js";

export type LifecycleKind = "welcome" | "first_booking" | "trial_ending" | "trial_ended";

/** How much notice the trial nudge gives. Three days: long enough to act, short enough to feel real. */
export const TRIAL_NUDGE_DAYS = 3;

/**
 * The account owner, at the address they log in with — deliberately not
 * `settings.admin_email`, which is where *booking* notifications go and
 * is often a shared inbox nobody owns.
 */
async function recipient(connectionId: string) {
  const connection = await prisma.connection.findUnique({
    where: { id: connectionId },
    include: { user: { select: { email: true } } },
  });
  if (!connection || !isEmail(connection.user.email)) return null;

  const settings = await getSettings(connection.shop, connection.platform);
  return {
    connection,
    email: connection.user.email,
    businessName: settings.business_name || connection.shop,
    bookingUrl: settings.booking_page_url,
  };
}

function dashboardUrl(connectionId: string, page = ""): string {
  const base = process.env.APP_URL ?? "";
  return `${base}/dashboard/${connectionId}${page}`;
}

/**
 * Claims the right to send `kind` to this account, sends it, and
 * releases the claim if the send fails.
 *
 * Returns whether an email actually went out, which is what the sweep
 * counts.
 */
async function once(connectionId: string, kind: LifecycleKind, send: () => Promise<void>): Promise<boolean> {
  try {
    await prisma.lifecycleEmail.create({ data: { connectionId, kind } });
  } catch (err) {
    // P2002 — the unique index did its job. Any other error is real.
    if ((err as { code?: string }).code === "P2002") return false;
    throw err;
  }

  try {
    await send();
    return true;
  } catch (err) {
    // Give the claim back so the next sweep retries, rather than marking
    // an email sent that never left.
    await prisma.lifecycleEmail
      .deleteMany({ where: { connectionId, kind } })
      .catch(() => {});
    throw err;
  }
}

/* ----------------------------------------------------------- The emails */

/**
 * Sent when onboarding finishes, not when the account row is created.
 * The draft Connection exists from the moment someone lands on step 1,
 * and welcoming a person who is still filling in their business name —
 * and may never finish — is both premature and useless: the one thing
 * this email is for is handing over the booking link, which does not
 * exist yet.
 */
export async function sendWelcome(connectionId: string): Promise<boolean> {
  const target = await recipient(connectionId);
  if (!target) return false;

  return once(connectionId, "welcome", () =>
    sendBillingNotice(
      target.connection,
      target.email,
      `${target.businessName} is live on GetBooqin`,
      `Hi,\n\n` +
        `${target.businessName} is set up and your booking page is taking bookings.\n\n` +
        `Your booking link — put this anywhere you'd normally say "call us":\n${target.bookingUrl}\n\n` +
        `Three things worth five minutes each:\n\n` +
        `1. Book yourself in from that link. You'll see exactly what a customer sees, and the confirmation ` +
        `email that follows.\n` +
        `2. Check your opening hours under Settings — everything else has a sensible default, but only you ` +
        `know when you're open.\n` +
        `3. Put the link in your Instagram bio, your Google listing and your email signature.\n\n` +
        `Your dashboard:\n${dashboardUrl(connectionId)}\n\n` +
        `Reply to this email if anything is in your way — it comes straight to us.\n\n` +
        `GetBooqin`
    )
  );
}

/**
 * The first real booking. Worth its own email because it is the moment
 * the product has actually done something for them, and because it is
 * the natural place to say "here is where these live from now on"
 * before the notification becomes routine.
 */
export async function sendFirstBookingReceived(connectionId: string): Promise<boolean> {
  const target = await recipient(connectionId);
  if (!target) return false;

  return once(connectionId, "first_booking", () =>
    sendBillingNotice(
      target.connection,
      target.email,
      `You've taken your first booking on GetBooqin`,
      `Hi,\n\n` +
        `${target.businessName} just took its first booking through GetBooqin. Someone found your link, picked ` +
        `a time and booked it — with no phone call and nothing for you to type in.\n\n` +
        `It's in your calendar here:\n${dashboardUrl(connectionId, "/bookings")}\n\n` +
        `From now on you'll get an email for each one, and your customer gets a confirmation with the ` +
        `appointment attached, so it lands in their own calendar. Reminders go out automatically before ` +
        `the appointment — that is the setting that does the most to cut no-shows, and it's on.\n\n` +
        `GetBooqin`
    )
  );
}

/** Three days left. The one job of this email is to name a date. */
export async function sendTrialEnding(connectionId: string, trialEndsAt: Date): Promise<boolean> {
  const target = await recipient(connectionId);
  if (!target) return false;

  const ends = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(trialEndsAt);

  return once(connectionId, "trial_ending", () =>
    sendBillingNotice(
      target.connection,
      target.email,
      `Your GetBooqin trial ends on ${ends}`,
      `Hi,\n\n` +
        `Your free trial of the ${PLANS[TRIAL_PLAN].name} plan ends on ${ends}.\n\n` +
        `Nothing is deleted when it does. Your bookings, customers and settings stay exactly as they are and ` +
        `your booking page keeps taking bookings — the account moves to the Free plan, and the Free plan's ` +
        `limits start to apply, so some things you can do today you may not be able to do afterwards.\n\n` +
        `Pick a plan here, and it carries on without interruption:\n${dashboardUrl(connectionId, "/settings?page=billing")}\n\n` +
        `If GetBooqin hasn't earned it, that's a fair answer too — you don't need to do anything, and Free is ` +
        `a real plan, not a lockout.\n\n` +
        `GetBooqin`
    )
  );
}

/** It's over. Says what changed, in plain terms, and how to undo it. */
export async function sendTrialEnded(connectionId: string): Promise<boolean> {
  const target = await recipient(connectionId);
  if (!target) return false;

  return once(connectionId, "trial_ended", () =>
    sendBillingNotice(
      target.connection,
      target.email,
      `Your GetBooqin trial has ended`,
      `Hi,\n\n` +
        `Your trial of the ${PLANS[TRIAL_PLAN].name} plan has ended and ${target.businessName} is now on the ` +
        `Free plan.\n\n` +
        `Your booking page is still live and still taking bookings. Nothing has been deleted. What's changed ` +
        `is the limits — Free covers a smaller number of services, staff and bookings a month, so if you were ` +
        `above them you'll be asked to upgrade before adding more.\n\n` +
        `Upgrading takes a minute and restores everything immediately:\n` +
        `${dashboardUrl(connectionId, "/settings?page=billing")}\n\n` +
        `GetBooqin`
    )
  );
}

/* ------------------------------------------------------------- The sweep */

export interface TrialNudgeResult {
  ending_sent: number;
  ended_sent: number;
}

/**
 * Finds trials that are about to end and trials that have ended, and
 * sends each account the appropriate email once.
 *
 * Reads `trialEndsAt` directly rather than going through
 * `entitlementsFor()`: expiry is evaluated lazily per-request there,
 * which is right for correctness but means a trial nobody has looked at
 * is still `trialing` in the database. That is exactly the account most
 * in need of the email.
 *
 * One failed send does not abandon the rest — an account with a broken
 * email address must not stop everyone else's trial nudge.
 */
export async function runTrialNudges(now = new Date()): Promise<TrialNudgeResult> {
  const nudgeBefore = new Date(now.getTime() + TRIAL_NUDGE_DAYS * 86_400_000);
  const result: TrialNudgeResult = { ending_sent: 0, ended_sent: 0 };

  const trials = await prisma.subscription.findMany({
    where: { status: "trialing", trialEndsAt: { not: null, lt: nudgeBefore } },
    select: { connectionId: true, trialEndsAt: true },
  });

  for (const trial of trials) {
    const endsAt = trial.trialEndsAt!;
    const over = endsAt.getTime() <= now.getTime();
    try {
      if (over) {
        // Both, in order, for a trial that ended without anyone ever
        // running the sweep — the warning is worthless now, but sending
        // it would be worse than claiming it silently, so claim it and
        // send only the one that is still true.
        await prisma.lifecycleEmail
          .create({ data: { connectionId: trial.connectionId, kind: "trial_ending" } })
          .catch(() => {});
        if (await sendTrialEnded(trial.connectionId)) result.ended_sent += 1;
      } else if (await sendTrialEnding(trial.connectionId, endsAt)) {
        result.ending_sent += 1;
      }
    } catch (err) {
      console.error(`[getbooqin lifecycle] trial nudge failed for connection ${trial.connectionId}:`, err);
    }
  }

  return result;
}

/* ---------------------------------------------------------------- Wiring */

/**
 * Subscribes to the booking bus. A listener rather than a call inside
 * the mailer, so this module can import the mailer without the two
 * importing each other.
 */
export function init() {
  events.onEvent("booking_created", (booking) => {
    void (async () => {
      try {
        const connection = await prisma.connection.findFirst({
          where: { shop: booking.shop, platform: booking.platform },
          select: { id: true },
        });
        if (!connection) return;

        // "First" means first ever, counted rather than assumed: a
        // booking the merchant entered by hand while setting up is still
        // their first, and a second booking arriving in the same second
        // as the first must not produce two emails (the unique index
        // catches that anyway, but the count keeps the intent honest).
        // A merchant's own setup test is not their first booking. Sent
        // on it, the "You've taken your first booking" email arrives for
        // something they did themselves thirty seconds earlier — and
        // then never arrives for the real one.
        if (booking.source === "test") return;

        const count = await prisma.booking.count({
          where: { shop: booking.shop, platform: booking.platform, source: { not: "test" } },
        });
        if (count !== 1) return;

        await sendFirstBookingReceived(connection.id);
      } catch (err) {
        console.error(`[getbooqin lifecycle] first-booking email failed for shop ${booking.shop}:`, err);
      }
    })();
  });
}
