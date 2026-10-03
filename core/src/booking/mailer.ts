/**
 * Email notifications and reminders. Ported from
 * shopify-openslot/app/lib/mailer.server.ts — same logic, adapted to core's
 * Prisma client. Functions that take `shop` directly now also take
 * `platform`; event-handler call sites read it off the `booking` row, which
 * (unlike shopify-openslot's single-platform schema) carries its own
 * `platform` column here.
 */
import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import type { Booking, Connection, ConnectionInvite, Waitlist } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Bookings from "./bookings.js";
import { manageUrl as waitlistManageUrl } from "./waitlist.js";
import { getSettings, template as settingTemplate, type Settings } from "./settings.js";
// The second channel, called alongside every send below rather than
// from inside them. Its failures are returned, never thrown: a WhatsApp
// message that cannot go must never take down the email that was going
// anyway. See whatsapp/notify.ts.
import * as WhatsApp from "../whatsapp/notify.js";
import { term } from "./settingsShared.js";
import events from "./events.js";
import { GetBooqinError } from "./errors.js";
import { tokens, previewTokens, replace } from "./notificationTokens.js";
import { buildIcs, icsFilename } from "./calendar.js";

export { tokens, previewTokens };

/**
 * Canonical list of every customizable notification. Drives the "Email
 * templates" section in Settings → Notifications.
 */
export interface TemplateDef {
  key: string;
  group: string;
  label: string;
  description: string;
  subject: string;
  body: string;
}

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    key: "customer_created",
    group: "Booking received",
    label: "Confirmed instantly",
    description: "Sent to the customer when their booking is auto-confirmed on request.",
    subject: "Your {{booking_term}} is confirmed — {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} is confirmed.\n\nWhen: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\nNeed to change it? Use this link:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
  },
  {
    key: "customer_created_pending",
    group: "Booking received",
    label: "Awaiting manual confirmation",
    description: "Sent instead of the above when new bookings require the business to approve them first.",
    subject: "We received your {{booking_term}} request — {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nThanks — we have your request for {{service}} with {{resource}} on {{date}} at {{time}} {{timezone}}.\n\nIt is not confirmed yet. We will email you again as soon as it is approved.\n\n{{manage_url}}\n\n{{business_name}}",
  },
  {
    key: "admin_created",
    group: "Booking received",
    label: "Notify the business",
    description: "Sent to the business every time a new booking (of any status) comes in.",
    subject: "New {{booking_term}}: {{customer_name}} — {{date}} {{time}}",
    body: "A new {{booking_term}} was made.\n\nService: {{service}}\nWith: {{resource}}\nWhen: {{date}} at {{time}} {{timezone}}\n\nName: {{customer_name}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\nNotes: {{notes}}\nSource: {{source}}",
  },
  {
    key: "customer_confirmed",
    group: "Confirmed",
    label: "Booking confirmed",
    description: "Sent to the customer when a pending request is approved by the business.",
    subject: "Confirmed: your {{booking_term}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nGood news — your {{booking_term}} is now confirmed.\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{manage_url}}\n\nSee you then,\n{{business_name}}",
  },
  {
    key: "customer_declined",
    group: "Declined",
    label: "Request declined",
    description: "Sent to the customer when the business declines their pending request.",
    subject: "We can't confirm your {{booking_term}} request for {{date}}",
    body: "Hi {{customer_name}},\n\nUnfortunately we are not able to confirm your {{booking_term}} request for {{service}} on {{date}} at {{time}} {{timezone}}.\n\n{{decline_reason_line}}\n\nFeel free to request another time on our website.\n\n{{business_name}}",
  },
  {
    key: "customer_cancelled",
    group: "Cancelled",
    label: "Notify the customer",
    description: "Sent to the customer when their booking is cancelled.",
    subject: "Your {{booking_term}} on {{date}} was cancelled",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} on {{date}} at {{time}} {{timezone}} has been cancelled.\n\nYou can book a new time any time on our website.\n\n{{business_name}}",
  },
  {
    key: "admin_cancelled",
    group: "Cancelled",
    label: "Notify the business",
    description: "Sent to the business when a booking is cancelled.",
    subject: "Cancelled: {{customer_name}} — {{date}} {{time}}",
    body: "{{customer_name}} cancelled their {{booking_term}} for {{service}} on {{date}} at {{time}} {{timezone}}.",
  },
  {
    key: "customer_moved",
    group: "Rescheduled",
    label: "Time changed",
    description: "Sent to the customer when their booking is moved to a new date or time.",
    subject: "Your {{booking_term}} has moved to {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} has been rescheduled.\n\nNew time: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\n{{manage_url}}\n\n{{business_name}}",
  },
  {
    key: "customer_reminder",
    group: "Reminder",
    label: "Upcoming booking reminder",
    description: "Sent to customers ahead of their appointment — see the reminder timing setting above.",
    subject: "Reminder: {{service}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nThis is a reminder for your {{booking_term}}:\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{manage_url}}\n\nSee you soon,\n{{business_name}}",
  },
  {
    key: "waitlist_joined",
    group: "Waitlist",
    label: "Added to the waitlist",
    description: "Sent when a customer joins the waitlist, confirming what they're queued for.",
    subject: "You're on the waitlist — {{service}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nYou're on the waitlist for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nWe'll email you the moment a spot opens up.\n\nChanged your mind? Leave the waitlist here:\n{{leave_url}}\n\n{{business_name}}",
  },
  {
    key: "waitlist_offered",
    group: "Waitlist",
    label: "Slot offered from the waitlist",
    description: "Sent when a cancellation frees a slot that matches someone on the waitlist.",
    subject: "A spot opened up — {{service}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nGood news — a spot just opened up for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nThis offer is first come, first served and expires at {{expires_at}}. Claim it here:\n{{claim_url}}\n\nNo longer need it? Leave the waitlist here:\n{{leave_url}}\n\nIf you don't respond in time, we'll offer it to the next person on the list.\n\n{{business_name}}",
  },
  {
    key: "waitlist_expired",
    group: "Waitlist",
    label: "Waitlist offer expired",
    description: "Sent when a customer doesn't claim their offered slot in time.",
    subject: "Your offer for {{date}} at {{time}} has expired",
    body: "Hi {{customer_name}},\n\nYour offer for {{service}} on {{date}} at {{time}} {{timezone}} wasn't claimed in time, so we've offered it to the next person on our list.\n\nYou're still on the waitlist — we'll let you know if another time opens up.\n\n{{business_name}}",
  },
];

/** Per-template on/off switch, separate from the blanket notify_customer/notify_admin toggles. */
function templateEnabled(settings: Settings, key: string): boolean {
  return settings.template_enabled?.[key] !== false;
}

let transporter: nodemailer.Transporter | null | undefined;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_HOST) {
    transporter = null;
    return transporter;
  }
  // Warned once, when the transport is first built rather than on every
  // send. Without MAIL_FROM_EMAIL the fallback below sends as the
  // merchant's own address over our SMTP relay, which is the exact
  // spoof signature Gmail and Outlook filter on (see fromHeaders).
  if (!process.env.MAIL_FROM_EMAIL) {
    console.warn(
      "[getbooqin mailer] MAIL_FROM_EMAIL is not set — every message will be sent as the merchant's own address over this SMTP relay, which has no SPF/DKIM alignment for their domain and will be spam-foldered or rejected. Set MAIL_FROM_EMAIL to an address on a domain you control and have authenticated."
    );
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

/**
 * Can this process actually send mail?
 *
 * For /healthz?strict=1. Every email in the product is best-effort by
 * design — a failed confirmation must not fail the booking — which means
 * nothing in the request path can ever go red over it, and a relay that
 * stopped working looks exactly like a quiet hour. That is how the
 * 10-01-2026 review's item 7 went unnoticed. This is the signal that
 * originates outside the send path.
 *
 * Deliberately only "is there a transport and a sender identity", not a
 * live SMTP handshake: a health check that opens a TCP connection to a
 * third party on every poll is its own outage waiting to happen. A
 * misconfigured credential still shows up, as a rejected send in the
 * logs at the call site.
 */
export function mailerConfigured(): { ok: boolean; reason?: string } {
  if (!process.env.SMTP_HOST) return { ok: false, reason: "SMTP_HOST is not set" };
  if (!process.env.MAIL_FROM_EMAIL) {
    // Not fatal — fromHeaders() falls back to the merchant's own address
    // — but that fallback fails SPF/DKIM alignment and gets spam-foldered,
    // so it is degraded, not healthy.
    return { ok: false, reason: "MAIL_FROM_EMAIL is not set — mail will fail SPF/DKIM alignment" };
  }
  return { ok: true };
}

/**
 * A display name safe to drop inside a quoted string in a header.
 * `business_name` is merchant-supplied free text: a stray quote would
 * break the header, and a stray newline would let a merchant append
 * headers of their own (a Bcc, say) to every message the product sends
 * on their behalf.
 */
function quotedDisplayName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "").trim();
}

/**
 * Phase 0 / B3 — who these messages actually come from.
 *
 * They used to go out as `"Business Name" <the merchant's own address>`
 * over our SMTP relay. Our relay is not authorised to send for a domain
 * we do not control, so every confirmation, reminder and cancellation
 * failed SPF and DKIM alignment at the receiving end — textbook spoof
 * signals, and the reason those messages land in spam or get rejected
 * outright. There was no Reply-To either, so a customer hitting reply
 * answered an address we were forging.
 *
 * The fix is the standard "sent on behalf of" shape: send from one
 * address on a domain we control and have authenticated (SPF + DKIM +
 * DMARC), keep the merchant's identity in the display name so the
 * customer still sees who it's from, and point replies back at the
 * merchant.
 *
 * When MAIL_FROM_EMAIL isn't configured there is nothing to send *as*, so
 * this falls back to the old behaviour rather than dropping the mail —
 * wrong in exactly the way it was before, loudly warned about at startup,
 * and harmless in local development where SMTP usually isn't set at all.
 */
export function fromHeaders(settings: Settings): { from: string; replyTo?: string } {
  const platformAddress = process.env.MAIL_FROM_EMAIL;
  const merchantAddress = Bookings.isRealEmail(settings.business_email) ? settings.business_email : "";
  const businessName = quotedDisplayName(settings.business_name) || "GetBooqin";

  if (!platformAddress) {
    return { from: `"${businessName}" <${merchantAddress}>` };
  }

  const platformName = quotedDisplayName(process.env.MAIL_FROM_NAME || "GetBooqin");

  return {
    from: `"${businessName} via ${platformName}" <${platformAddress}>`,
    // Only when it is actually somewhere else to reply to. Setting
    // Reply-To equal to From is noise, and a missing/garbage
    // business_email would otherwise produce a header that bounces.
    ...(merchantAddress && merchantAddress !== platformAddress ? { replyTo: merchantAddress } : {}),
  };
}

interface Attachment {
  filename: string;
  content: string;
  contentType: string;
}

async function mail(
  to: string,
  subject: string,
  body: string,
  settings: Settings,
  attachments: Attachment[] = []
): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // In production, an unconfigured transport is an outage, not a
    // no-op. Returning quietly here is why "booking confirmation and
    // cancellation emails are not being received" (10-01-2026 review,
    // item 7) looked like nothing at all from inside the product: the
    // send path reported success, the confirmation page told the
    // customer "a confirmation has been sent to your email", and the
    // only trace was a console.warn nobody reads. Throwing routes it
    // into the caller's own error handling — logMailError for the
    // booking events, `emailSent: false` for a team invite — so a
    // missing SMTP_HOST surfaces the same way a rejected send does.
    //
    // Still a quiet no-op outside production: local development and the
    // test suite both run with no SMTP at all, and neither should fail a
    // booking over it.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `SMTP is not configured (SMTP_HOST is unset) — cannot send "${subject}" to ${to}. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS and MAIL_FROM_EMAIL.`
      );
    }
    console.warn(`[getbooqin mailer] SMTP not configured — dropping email to ${to}: ${subject}`);
    return;
  }
  const { from, replyTo } = fromHeaders(settings);
  const info = await t.sendMail({
    to,
    from,
    ...(replyTo ? { replyTo } : {}),
    subject,
    text: body,
    ...(attachments.length ? { attachments } : {}),
  });
  console.log(
    `[getbooqin mailer] sent "${subject}" to ${to} from ${from}${replyTo ? ` (reply-to ${replyTo})` : ""} — messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} response=${info.response}`
  );
}

/* --------------------------------------------------------------- Tokens */

/** Public wrapper for the settings UI's preview — same substitution the real send path uses. */
export function renderTemplate(text: string, sampleTokens: Record<string, string>): string {
  return replace(text, sampleTokens);
}

export { templateEnabled };

/**
 * The .ics to attach to a customer email, or nothing.
 *
 * Only for a booking that is actually on: attaching a calendar entry to a
 * pending request would put an appointment in someone's diary that the
 * business has not agreed to yet, and attaching one to a cancellation
 * would re-add the thing being cancelled.
 *
 * Never fails a send. A calendar file is a convenience; losing the email
 * itself because a service name could not be read is a real failure, so
 * this swallows its own errors and lets the email go without it.
 */
async function calendarAttachment(shop: string, booking: Booking, settings: Settings): Promise<Attachment[]> {
  if (booking.status !== "confirmed") return [];
  try {
    const service = await Data.catalogService(shop, booking.serviceId);
    const resource = await Data.resource(shop, booking.resourceId);
    const title = [service?.name || term(settings, "booking_single"), resource?.name && `with ${resource.name}`]
      .filter(Boolean)
      .join(" ");

    const ics = buildIcs({
      uid: booking.uid,
      start: booking.startUtc,
      end: booking.endUtc,
      title,
      description: `Booked with ${settings.business_name}`.trim(),
      // A video link is where the appointment actually happens; the
      // street address is only right when it doesn't.
      location: booking.meetingUrl || settings.business_address || undefined,
      url: Bookings.manageUrl(booking, settings),
    });

    return [
      {
        filename: icsFilename(service?.name || "booking"),
        content: ics,
        // METHOD has to agree with the one inside the file, or Outlook
        // treats the mismatch as a malformed invitation.
        contentType: "text/calendar; charset=utf-8; method=PUBLISH",
      },
    ];
  } catch (err) {
    console.warn(`[getbooqin mailer] could not build .ics for booking ${booking.uid} — sending without it:`, err);
    return [];
  }
}

async function sendToCustomer(
  shop: string,
  booking: Booking,
  settings: Settings,
  subject: string,
  body: string,
  opts: { calendar?: boolean } = {}
) {
  const customer = await Data.customer(shop, booking.customerId);
  if (!customer || !Bookings.isRealEmail(customer.email)) {
    console.warn(
      `[getbooqin mailer] skipped customer email for booking ${booking.uid} — ${!customer ? "no customer record" : `invalid email "${customer.email}"`}`
    );
    return;
  }
  const t = await tokens(shop, booking, settings);
  const attachments = opts.calendar ? await calendarAttachment(shop, booking, settings) : [];
  await mail(customer.email, replace(subject, t), replace(body, t), settings, attachments);
}

async function sendToAdmin(shop: string, booking: Booking, settings: Settings, subject: string, body: string) {
  const to = settings.admin_email || settings.business_email;
  if (!Bookings.isEmail(to)) {
    console.warn(`[getbooqin mailer] skipped admin email for booking ${booking.uid} — invalid address "${to}"`);
    return;
  }
  const t = await tokens(shop, booking, settings);
  await mail(to, replace(subject, t), replace(body, t), settings);
}

/* --------------------------------------------------------------- Triggers */

function createdCopy(booking: Booking) {
  if (booking.status === "confirmed") {
    return {
      key: "customer_created",
      subject: "Your {{booking_term}} is confirmed — {{date}} at {{time}}",
      body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} is confirmed.\n\nWhen: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\nNeed to change it? Use this link:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
    };
  }
  return {
    key: "customer_created_pending",
    subject: "We received your {{booking_term}} request — {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nThanks — we have your request for {{service}} with {{resource}} on {{date}} at {{time}} {{timezone}}.\n\nIt is not confirmed yet. We will email you again as soon as it is approved.\n\n{{manage_url}}\n\n{{business_name}}",
  };
}

/** Manual re-send of the original booking confirmation/pending email — an explicit merchant action, so it ignores the notify_customer toggle. */
export async function resendConfirmation(shop: string, platform: string, bookingId: number): Promise<void> {
  const booking = await Bookings.get(shop, bookingId);
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

  const settings = await getSettings(shop, platform);
  const copy = createdCopy(booking);
  await sendToCustomer(
    shop,
    booking,
    settings,
    settingTemplate(settings, `${copy.key}_subject`, copy.subject),
    settingTemplate(settings, `${copy.key}_body`, copy.body),
    { calendar: true }
  );
}

async function onCreated(booking: Booking) {
  const shop = booking.shop;
  const settings = await getSettings(shop, booking.platform);
  // Re-read: another booking_created listener may have changed the row.
  const fresh = (await Bookings.get(shop, booking.id)) ?? booking;

  if (settings.notify_customer) {
    const copy = createdCopy(fresh);
    if (templateEnabled(settings, copy.key)) {
      await sendToCustomer(
        shop,
        fresh,
        settings,
        settingTemplate(settings, `${copy.key}_subject`, copy.subject),
        settingTemplate(settings, `${copy.key}_body`, copy.body),
        { calendar: true }
      );
    } else {
      console.log(`[getbooqin mailer] booking_created customer email skipped for ${fresh.uid} — template "${copy.key}" disabled`);
    }
  } else {
    console.log(`[getbooqin mailer] booking_created customer email skipped for ${fresh.uid} — notify_customer is off`);
  }
  // Only for a booking that is actually confirmed. A pending request is
  // not an appointment yet, and there is no approved template that says
  // "we'll get back to you" — sending the confirmed one would tell a
  // customer they have a slot they may not get.
  if (settings.notify_customer && fresh.status === "confirmed") {
    await WhatsApp.notifyBooking(shop, fresh.platform, fresh, settings, "booking_confirmed");
  }

  if (settings.notify_admin && templateEnabled(settings, "admin_created")) {
    await sendToAdmin(
      shop,
      fresh,
      settings,
      settingTemplate(settings, "admin_created_subject", "New {{booking_term}}: {{customer_name}} — {{date}} {{time}}"),
      settingTemplate(
        settings,
        "admin_created_body",
        "A new {{booking_term}} was made.\n\nService: {{service}}\nWith: {{resource}}\nWhen: {{date}} at {{time}} {{timezone}}\n\nName: {{customer_name}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\nNotes: {{notes}}\nSource: {{source}}"
      )
    );
  }
}

async function onStatusChanged(booking: Booking, oldStatus: string, newStatus: string) {
  if (oldStatus === newStatus) return;
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.notify_customer) return;
  if (newStatus === "cancelled") return; // onCancelled has its own listener

  if (newStatus === "confirmed" && templateEnabled(settings, "customer_confirmed")) {
    await sendToCustomer(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "customer_confirmed_subject", "Confirmed: your {{booking_term}} on {{date}} at {{time}}"),
      settingTemplate(
        settings,
        "customer_confirmed_body",
        "Hi {{customer_name}},\n\nGood news — your {{booking_term}} is now confirmed.\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{manage_url}}\n\nSee you then,\n{{business_name}}"
      ),
      { calendar: true }
    );
    // The same template as a straight-to-confirmed booking, because to
    // the customer it is the same news — they asked, and now they have
    // it. onCreated deliberately stayed quiet for this booking when it
    // was still pending.
    await WhatsApp.notifyBooking(booking.shop, booking.platform, booking, settings, "booking_confirmed");
  }

  if (newStatus === "declined" && templateEnabled(settings, "customer_declined")) {
    await sendToCustomer(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "customer_declined_subject", "We can't confirm your {{booking_term}} request for {{date}}"),
      settingTemplate(
        settings,
        "customer_declined_body",
        "Hi {{customer_name}},\n\nUnfortunately we are not able to confirm your {{booking_term}} request for {{service}} on {{date}} at {{time}} {{timezone}}.\n\n{{decline_reason_line}}\n\nFeel free to request another time on our website.\n\n{{business_name}}"
      )
    );
  }
}

async function onCancelled(booking: Booking, _reason: string) {
  const settings = await getSettings(booking.shop, booking.platform);
  if (settings.notify_customer && templateEnabled(settings, "customer_cancelled")) {
    await sendToCustomer(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "customer_cancelled_subject", "Your {{booking_term}} on {{date}} was cancelled"),
      settingTemplate(
        settings,
        "customer_cancelled_body",
        "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} on {{date}} at {{time}} {{timezone}} has been cancelled.\n\nYou can book a new time any time on our website.\n\n{{business_name}}"
      )
    );
  }
  if (settings.notify_customer) {
    await WhatsApp.notifyBooking(booking.shop, booking.platform, booking, settings, "booking_cancelled");
  }

  if (settings.notify_admin && templateEnabled(settings, "admin_cancelled")) {
    await sendToAdmin(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "admin_cancelled_subject", "Cancelled: {{customer_name}} — {{date}} {{time}}"),
      settingTemplate(settings, "admin_cancelled_body", "{{customer_name}} cancelled their {{booking_term}} for {{service}} on {{date}} at {{time}} {{timezone}}.")
    );
  }
}

async function onRescheduled(booking: Booking) {
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.notify_customer || !templateEnabled(settings, "customer_moved")) return;
  await sendToCustomer(
    booking.shop,
    booking,
    settings,
    settingTemplate(settings, "customer_moved_subject", "Your {{booking_term}} has moved to {{date}} at {{time}}"),
    settingTemplate(
      settings,
      "customer_moved_body",
      "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} has been rescheduled.\n\nNew time: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\n{{manage_url}}\n\n{{business_name}}"
    ),
    // Same UID as the original, so a calendar moves the existing entry
    // rather than leaving the customer with two.
    { calendar: true }
  );
  await WhatsApp.notifyBooking(booking.shop, booking.platform, booking, settings, "booking_rescheduled");
}

/** Sends reminders for every shop with bookings inside the window. */
export async function sendReminders(): Promise<{ sent: number }> {
  let sent = 0;
  const candidates = await prisma.booking.findMany({
    where: {
      reminderSent: false,
      status: { in: ["pending", "confirmed"] },
      startUtc: { gt: new Date() },
    },
    take: 500,
  });

  for (const booking of candidates) {
    const settings = await getSettings(booking.shop, booking.platform);
    if (!settings.reminder_enabled || !templateEnabled(settings, "customer_reminder")) continue;

    const hours = Math.max(1, settings.reminder_hours);
    const windowEnd = new Date(Date.now() + hours * 3600_000);
    if (booking.startUtc > windowEnd) continue;

    // A reminder's whole point is to arrive some time *before* the booking
    // — if its ideal send moment (start minus lead time) had already
    // passed by the time the booking was even made, sending it "right
    // away" on the next sweep instead reads as a system glitch, not a
    // reminder: a patient who books at 9am for 9:50am gets an email at
    // 9:01 (GetBooqin clinic audit's BR-06 finding, the live consequence
    // of reminder_hours >= min_notice_hours, which the Notifications page
    // already warns about but never actually prevented). Suppressed here
    // rather than sent late — reminderSent still flips to true so this
    // never gets retried, it just never fires for a booking that could
    // never have received it "ahead of time" in the first place.
    const naturalFireTime = booking.startUtc.getTime() - hours * 3600_000;
    if (naturalFireTime <= booking.createdAt.getTime()) {
      await prisma.booking.update({ where: { id: booking.id }, data: { reminderSent: true } });
      console.log(`[getbooqin mailer] reminder suppressed for booking uid=${booking.uid} — booked too close to its own start time for a lead-time reminder to make sense`);
      continue;
    }

    try {
      await sendToCustomer(
        booking.shop,
        booking,
        settings,
        settingTemplate(settings, "customer_reminder_subject", "Reminder: {{service}} on {{date}} at {{time}}"),
        settingTemplate(
          settings,
          "customer_reminder_body",
          "Hi {{customer_name}},\n\nThis is a reminder for your {{booking_term}}:\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{manage_url}}\n\nSee you soon,\n{{business_name}}"
        )
      );

      // After the email and inside the same try, but it cannot throw —
      // notifyBooking returns its failures. reminderSent must flip on
      // the strength of the email alone: a WhatsApp outage that held
      // the flag back would re-send the email on every sweep.
      await WhatsApp.notifyBooking(booking.shop, booking.platform, booking, settings, "booking_reminder");

      await prisma.booking.update({ where: { id: booking.id }, data: { reminderSent: true } });
      sent += 1;
    } catch (error) {
      console.error(`[getbooqin mailer] reminder send failed for booking uid=${booking.uid} (shop=${booking.shop}):`, error);
    }
  }

  return { sent };
}

/**
 * Fulfils a mandatory data-request-style webhook (Shopify's
 * customers/data_request today). There's no self-serve export yet, so this
 * emails the shop's admin the full JSON dump of what GetBooqin holds for
 * that customer.
 */
export async function sendDataRequestExport(shop: string, platform: string, customerEmail: string, exportData: unknown): Promise<void> {
  const settings = await getSettings(shop, platform);
  const to = settings.admin_email || settings.business_email;
  if (!Bookings.isEmail(to)) {
    console.warn(`[getbooqin mailer] no admin email configured for shop ${shop} — cannot forward data request for ${customerEmail}`);
    return;
  }
  const body =
    `A data request was received for the customer ${customerEmail}.\n\n` +
    `Below is everything GetBooqin holds for them. Forward this (or the relevant parts) to the customer to fulfil the request.\n\n` +
    JSON.stringify(exportData, null, 2);
  await mail(to, `Customer data request: ${customerEmail}`, body, settings);
}

// Same base URL convention cloud's own getAppUrl() (cloud/app/lib/env.server.ts)
// uses — core can't import that (cloud depends on core, not the reverse),
// and this module already reads its own env vars directly elsewhere
// (SMTP_HOST, MAIL_FROM_EMAIL above), so this just does the same for
// APP_URL. Core and cloud share one Node process (cloud imports core as a
// workspace package), so this reads the same value cloud's own copy does.
function appUrl(): string {
  const url = process.env.APP_URL;
  if (!url) throw new Error("APP_URL is not set");
  return url;
}

/**
 * Team invite email (Team settings page — see core/src/team.ts's
 * inviteMember/resendInvite, which both call this after persisting/
 * refreshing the ConnectionInvite row). Not a customizable TemplateDef —
 * invite copy isn't merchant-editable content, same reasoning as
 * sendDataRequestExport just above. `invite.token` is the DB row's *current*
 * token — team.ts's rotateAndSend() always calls this only after writing
 * the fresh token, so a resend's email always carries the link that's
 * actually still valid.
 */
/**
 * Billing mail — dunning.
 *
 * Like sendTeamInvite below, deliberately **not** a customizable
 * TemplateDef. A merchant editing the wording of "your payment failed"
 * makes no sense: this is our message to them about their account, not
 * their message to their customers. TEMPLATE_DEFS is for the latter.
 *
 * Exported as one function taking pre-resolved copy so the billing layer
 * owns the words and this module stays the transport — core/src/billing
 * must not import "email notifications" wholesale to send one.
 */
export async function sendBillingNotice(
  connection: Connection,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const settings = await getSettings(connection.shop, connection.platform);
  await mail(to, subject, body, settings);
}

/**
 * The invoice, attached to the email that says the payment went
 * through.
 *
 * One email, not two. A "payment received" note and an invoice
 * delivered separately are the same fact arriving twice, and the second
 * one always looks like a duplicate charge to somebody.
 */
export async function sendInvoiceEmail(
  connection: Connection,
  to: string,
  subject: string,
  body: string,
  attachment: { filename: string; content: Buffer }
): Promise<void> {
  const settings = await getSettings(connection.shop, connection.platform);
  await mail(to, subject, body, settings, [
    {
      filename: attachment.filename,
      content: attachment.content as unknown as string,
      contentType: "application/pdf",
    },
  ]);
}

export async function sendTeamInvite(connection: Connection, invite: ConnectionInvite, inviterEmail: string): Promise<void> {
  const settings = await getSettings(connection.shop, connection.platform);
  const businessName = settings.business_name || connection.shop;
  const acceptUrl = `${appUrl()}/invite/${invite.token}`;
  const roleLabel = invite.role.charAt(0).toUpperCase() + invite.role.slice(1);
  const inviterLine = inviterEmail ? ` by ${inviterEmail}` : "";
  const body =
    `Hi,\n\n` +
    `You've been invited${inviterLine} to join ${businessName} on GetBooqin with ${roleLabel} access.\n\n` +
    `Accept your invite:\n${acceptUrl}\n\n` +
    `This link expires in 7 days.\n\n` +
    `${businessName}`;
  await mail(invite.email, `You're invited to join ${businessName} on GetBooqin`, body, settings);
}

function logMailError(context: string, shop: string, uid: string, error: unknown) {
  console.error(`[getbooqin mailer] ${context} failed for shop ${shop} (booking ${uid}):`, error);
}

/**
 * A waitlist entry isn't a Booking row until claimed, so its tokens can't
 * reuse tokens() above — built from the entry's offered slot instead, or
 * (before an offer exists yet — the join-confirmation email) its requested
 * window. The claim link is the app-proxy route shopify-openslot mounts
 * publicly at /apps/getbooqin/* (see proxy.server.ts's appProxyBase), not
 * booking_page_url — there's no storefront widget view for that flow. The
 * leave link is the opposite: it does have a storefront view (Waitlist.
 * manageUrl -> booking_page_url + ?getbooqin_waitlist=uid, same convention
 * as Bookings.manageUrl), same as every other waitlist email regardless of
 * whether an offer has been made yet.
 */
async function waitlistTokens(shop: string, entry: Waitlist, settings: Settings): Promise<Record<string, string>> {
  const service = await Data.catalogService(shop, entry.serviceId);
  const resource = entry.offeredResourceId ? await Data.resource(shop, entry.offeredResourceId) : null;
  const customer = await prisma.customer.findFirst({ where: { shop, id: entry.customerId } });
  const tz = settings.timezone || "UTC";
  const startUtc = entry.offeredStartUtc ?? entry.windowStartUtc;
  const start = startUtc ? DateTime.fromJSDate(startUtc, { zone: "utc" }).setZone(tz) : null;

  return {
    "{{business_name}}": settings.business_name,
    "{{service}}": service?.name ?? "",
    "{{resource}}": resource?.name ?? "",
    "{{date}}": start?.toFormat("DDD") ?? "",
    "{{time}}": start?.toFormat("h:mm a") ?? "",
    "{{timezone}}": start ? start.toFormat("z") : "",
    "{{customer_name}}": customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
    "{{expires_at}}": entry.offerExpiresAt ? DateTime.fromJSDate(entry.offerExpiresAt, { zone: "utc" }).setZone(tz).toFormat("h:mm a") : "",
    "{{claim_url}}": `https://${shop}/apps/getbooqin/waitlist/${entry.offerToken ?? ""}`,
    "{{leave_url}}": waitlistManageUrl(entry, settings),
  };
}

async function sendToWaitlistCustomer(shop: string, entry: Waitlist, settings: Settings, subject: string, body: string) {
  const customer = await prisma.customer.findFirst({ where: { shop, id: entry.customerId } });
  if (!customer || !Bookings.isRealEmail(customer.email)) {
    console.warn(
      `[getbooqin mailer] skipped waitlist email for entry ${entry.uid} — ${!customer ? "no customer record" : `invalid email "${customer.email}"`}`
    );
    return;
  }
  const t = await waitlistTokens(shop, entry, settings);
  await mail(customer.email, replace(subject, t), replace(body, t), settings);
}

async function onWaitlistJoined(entry: Waitlist) {
  const settings = await getSettings(entry.shop, entry.platform);
  if (!settings.notify_customer || !templateEnabled(settings, "waitlist_joined")) return;
  await sendToWaitlistCustomer(
    entry.shop,
    entry,
    settings,
    settingTemplate(settings, "waitlist_joined_subject", "You're on the waitlist — {{service}} on {{date}} at {{time}}"),
    settingTemplate(
      settings,
      "waitlist_joined_body",
      "Hi {{customer_name}},\n\nYou're on the waitlist for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nWe'll email you the moment a spot opens up.\n\nChanged your mind? Leave the waitlist here:\n{{leave_url}}\n\n{{business_name}}"
    )
  );
}

async function onWaitlistOffered(entry: Waitlist) {
  const settings = await getSettings(entry.shop, entry.platform);
  if (!settings.notify_customer) return;

  // Before the email rather than after it, and the only place in this
  // file where that ordering is deliberate. A waitlist offer is first
  // come, first served with a hard expiry — WhatsApp is read in
  // minutes and email in hours, so the slower channel going first
  // costs the customer part of the window they are competing for.
  const t = await waitlistTokens(entry.shop, entry, settings);
  await WhatsApp.notifyWaitlistOffer(entry.shop, entry.platform, entry, settings, {
    claimUrl: t["{{claim_url}}"] ?? "",
    expiresAt: t["{{expires_at}}"] ?? "",
  });

  if (!templateEnabled(settings, "waitlist_offered")) return;
  await sendToWaitlistCustomer(
    entry.shop,
    entry,
    settings,
    settingTemplate(settings, "waitlist_offered_subject", "A spot opened up — {{service}} on {{date}} at {{time}}"),
    settingTemplate(
      settings,
      "waitlist_offered_body",
      "Hi {{customer_name}},\n\nGood news — a spot just opened up for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nThis offer is first come, first served and expires at {{expires_at}}. Claim it here:\n{{claim_url}}\n\nNo longer need it? Leave the waitlist here:\n{{leave_url}}\n\nIf you don't respond in time, we'll offer it to the next person on the list.\n\n{{business_name}}"
    )
  );
}

async function onWaitlistExpired(entry: Waitlist) {
  const settings = await getSettings(entry.shop, entry.platform);
  if (!settings.notify_customer || !templateEnabled(settings, "waitlist_expired")) return;
  await sendToWaitlistCustomer(
    entry.shop,
    entry,
    settings,
    settingTemplate(settings, "waitlist_expired_subject", "Your offer for {{date}} at {{time}} has expired"),
    settingTemplate(
      settings,
      "waitlist_expired_body",
      "Hi {{customer_name}},\n\nYour offer for {{service}} on {{date}} at {{time}} {{timezone}} wasn't claimed in time, so we've offered it to the next person on our list.\n\nYou're still on the waitlist — we'll let you know if another time opens up.\n\n{{business_name}}"
    )
  );
}

export function init() {
  events.onEvent("booking_created", (booking) =>
    onCreated(booking).catch((err) => logMailError("booking_created", booking.shop, booking.uid, err))
  );
  events.onEvent("booking_cancelled", (booking, reason) =>
    onCancelled(booking, reason).catch((err) => logMailError("booking_cancelled", booking.shop, booking.uid, err))
  );
  events.onEvent("booking_status_changed", (booking, oldStatus, newStatus) =>
    onStatusChanged(booking, oldStatus, newStatus).catch((err) =>
      logMailError("booking_status_changed", booking.shop, booking.uid, err)
    )
  );
  events.onEvent("booking_rescheduled", (booking) =>
    onRescheduled(booking).catch((err) => logMailError("booking_rescheduled", booking.shop, booking.uid, err))
  );
  events.onEvent("waitlist_joined", (entry) =>
    onWaitlistJoined(entry).catch((err) => logMailError("waitlist_joined", entry.shop, entry.uid, err))
  );
  events.onEvent("waitlist_offered", (entry) =>
    onWaitlistOffered(entry).catch((err) => logMailError("waitlist_offered", entry.shop, entry.uid, err))
  );
  events.onEvent("waitlist_expired", (entry) =>
    onWaitlistExpired(entry).catch((err) => logMailError("waitlist_expired", entry.shop, entry.uid, err))
  );
}
