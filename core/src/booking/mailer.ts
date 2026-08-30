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
import type { Booking, ChatConversation, Waitlist } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Bookings from "./bookings.js";
import { getSettings, term, money, template as settingTemplate, type Settings } from "./settings.js";
import events from "./events.js";
import { GetBooqinError } from "./errors.js";

/**
 * Canonical list of every customizable notification. Drives the "Email
 * templates" section in Settings → Notifications.
 */
export const TEMPLATE_DEFS: { key: string; group: string; label: string; description: string; subject: string; body: string }[] = [
  {
    key: "customer_created",
    group: "Booking received",
    label: "Confirmed instantly",
    description: "Sent to the customer when their booking is auto-confirmed on request.",
    subject: "Your {{booking_term}} is confirmed — {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} is confirmed.\n\nWhen: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\n{{meeting_line}}\n{{payment_line}}\n\nNeed to change it? Use this link:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
  },
  {
    key: "customer_created_awaiting_payment",
    group: "Booking received",
    label: "Awaiting payment",
    description: "Sent instead of the above when the service requires payment before it's confirmed.",
    subject: "Almost there — your {{booking_term}} on {{date}} needs payment",
    body: "Hi {{customer_name}},\n\nWe have reserved {{date}} at {{time}} {{timezone}} for your {{booking_term}} ({{service}} with {{resource}}).\n\nIt is not confirmed yet — we are waiting for payment.\n\n{{payment_line}}\n\nManage your {{booking_term}}:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
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
    body: "A new {{booking_term}} was made.\n\nService: {{service}}\nWith: {{resource}}\nWhen: {{date}} at {{time}}\n\nName: {{customer_name}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\nNotes: {{notes}}\nSource: {{source}}",
  },
  {
    key: "customer_confirmed",
    group: "Confirmed",
    label: "Booking confirmed",
    description: "Sent to the customer when a pending request is approved by the business.",
    subject: "Confirmed: your {{booking_term}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nGood news — your {{booking_term}} is now confirmed.\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{meeting_line}}\n{{payment_line}}\n\n{{manage_url}}\n\nSee you then,\n{{business_name}}",
  },
  {
    key: "customer_declined",
    group: "Declined",
    label: "Request declined",
    description: "Sent to the customer when the business declines their pending request.",
    subject: "We can't confirm your {{booking_term}} request for {{date}}",
    body: "Hi {{customer_name}},\n\nUnfortunately we are not able to confirm your {{booking_term}} request for {{service}} on {{date}} at {{time}}.\n\n{{decline_reason_line}}\n\nFeel free to request another time on our website.\n\n{{business_name}}",
  },
  {
    key: "customer_cancelled",
    group: "Cancelled",
    label: "Notify the customer",
    description: "Sent to the customer when their booking is cancelled.",
    subject: "Your {{booking_term}} on {{date}} was cancelled",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} on {{date}} at {{time}} has been cancelled.\n\nYou can book a new time any time on our website.\n\n{{business_name}}",
  },
  {
    key: "admin_cancelled",
    group: "Cancelled",
    label: "Notify the business",
    description: "Sent to the business when a booking is cancelled.",
    subject: "Cancelled: {{customer_name}} — {{date}} {{time}}",
    body: "{{customer_name}} cancelled their {{booking_term}} for {{service}} on {{date}} at {{time}}.",
  },
  {
    key: "customer_paid",
    group: "Payment",
    label: "Payment received",
    description: "Sent to the customer once their payment for a booking is confirmed.",
    subject: "Payment received for {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nThanks — we have received {{amount_due}} for your {{booking_term}} on {{date}} at {{time}}.\n\n{{meeting_line}}\n\n{{manage_url}}\n\n{{business_name}}",
  },
  {
    key: "customer_moved",
    group: "Rescheduled",
    label: "Time changed",
    description: "Sent to the customer when their booking is moved to a new date or time.",
    subject: "Your {{booking_term}} has moved to {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} has been rescheduled.\n\nNew time: {{date}} at {{time}}\nWith: {{resource}}\n\n{{manage_url}}\n\n{{business_name}}",
  },
  {
    key: "customer_reminder",
    group: "Reminder",
    label: "Upcoming booking reminder",
    description: "Sent to customers ahead of their appointment — see the reminder timing setting above.",
    subject: "Reminder: {{service}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nThis is a reminder for your {{booking_term}}:\n\n{{service}} with {{resource}}\n{{date}} at {{time}}\n\n{{meeting_line}}\n\n{{manage_url}}\n\nSee you soon,\n{{business_name}}",
  },
  {
    key: "waitlist_offered",
    group: "Waitlist",
    label: "Slot offered from the waitlist",
    description: "Sent when a cancellation frees a slot that matches someone on the waitlist.",
    subject: "A spot opened up — {{service}} on {{date}} at {{time}}",
    body: "Hi {{customer_name}},\n\nGood news — a spot just opened up for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nThis offer is first come, first served and expires at {{expires_at}}. Claim it here:\n{{claim_url}}\n\nIf you don't respond in time, we'll offer it to the next person on the list.\n\n{{business_name}}",
  },
  {
    key: "waitlist_expired",
    group: "Waitlist",
    label: "Waitlist offer expired",
    description: "Sent when a customer doesn't claim their offered slot in time.",
    subject: "Your offer for {{date}} at {{time}} has expired",
    body: "Hi {{customer_name}},\n\nYour offer for {{service}} on {{date}} at {{time}} wasn't claimed in time, so we've offered it to the next person on our list.\n\nYou're still on the waitlist — we'll let you know if another time opens up.\n\n{{business_name}}",
  },
  {
    key: "admin_chat_lead",
    group: "Chat widget",
    label: "New lead from chat",
    description: "Sent to the business when a visitor leaves a message through the storefront chat widget.",
    subject: "New chat message from {{lead_name}}",
    body: "You received a new message through the website chat.\n\nName: {{lead_name}}\nEmail: {{lead_email}}\n\nMessage:\n{{lead_message}}\n\nPage: {{lead_page}}",
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
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function mail(to: string, subject: string, body: string, settings: Settings): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn(`[getbooqin mailer] SMTP not configured — dropping email to ${to}: ${subject}`);
    return;
  }
  const from = `"${settings.business_name}" <${process.env.MAIL_FROM_EMAIL || settings.business_email}>`;
  const info = await t.sendMail({ to, from, subject, text: body });
  console.log(
    `[getbooqin mailer] sent "${subject}" to ${to} from ${from} — messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)} rejected=${JSON.stringify(info.rejected)} response=${info.response}`
  );
}

/* --------------------------------------------------------------- Tokens */

export async function tokens(shop: string, booking: Booking, settings: Settings): Promise<Record<string, string>> {
  const service = await Data.catalogService(shop, booking.serviceId);
  const resource = await Data.resource(shop, booking.resourceId);
  const customer = await Data.customer(shop, booking.customerId);
  const customFields = parseCustomFields(booking.customFields);
  const addons = await Data.bookingAddons(shop, booking.id);
  const addonsSummary = addons.length
    ? "Add-ons: " + addons.map((a) => (a.price > 0 ? `${a.name} (${money(settings, a.price)})` : a.name)).join(", ")
    : "";

  return {
    "{{business_name}}": settings.business_name,
    "{{booking_term}}": term(settings, "booking_single").toLowerCase(),
    "{{service}}": service?.name ?? "",
    "{{resource}}": resource?.name ?? "",
    "{{date}}": Bookings.localDate(booking, settings.timezone),
    "{{time}}": Bookings.localTime(booking, settings.timezone),
    "{{status}}": booking.status,
    "{{timezone}}": Bookings.localTzLabel(booking, settings.timezone),
    "{{price}}": booking.price > 0 ? money(settings, booking.price) : "",
    "{{notes}}": booking.notes ?? "",
    "{{source}}": booking.source,
    "{{customer_name}}": customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
    "{{customer_email}}": customer?.email ?? "",
    "{{customer_phone}}": customer?.phone ?? "",
    "{{manage_url}}": Bookings.manageUrl(booking, settings),
    "{{meeting_url}}": booking.meetingUrl,
    "{{meeting_line}}": booking.meetingUrl ? `Join the video call here: ${booking.meetingUrl}` : "",
    "{{amount_due}}": booking.amountDue > 0 ? money(settings, booking.amountDue) : "",
    "{{payment_status}}": booking.paymentStatus,
    "{{payment_line}}": Bookings.needsPayment(booking)
      ? `Outstanding: ${money(settings, booking.amountDue)}. You can pay here: ${Bookings.manageUrl(booking, settings)}`
      : "",
    "{{decline_reason_line}}": customFields._decline_reason ? `Reason: ${customFields._decline_reason}` : "",
    "{{addons_summary}}": addonsSummary,
  };
}

function parseCustomFields(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function replace(text: string, replacements: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out.replace(/\{\{[a-z_]+\}\}/g, "");
}

async function sendToCustomer(shop: string, booking: Booking, settings: Settings, subject: string, body: string) {
  const customer = await Data.customer(shop, booking.customerId);
  if (!customer || !Bookings.isEmail(customer.email)) {
    console.warn(
      `[getbooqin mailer] skipped customer email for booking ${booking.uid} — ${!customer ? "no customer record" : `invalid email "${customer.email}"`}`
    );
    return;
  }
  const t = await tokens(shop, booking, settings);
  await mail(customer.email, replace(subject, t), replace(body, t), settings);
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
      body: "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} is confirmed.\n\nWhen: {{date}} at {{time}} {{timezone}}\nWith: {{resource}}\n\n{{meeting_line}}\n{{payment_line}}\n\nNeed to change it? Use this link:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
    };
  }
  if (Bookings.needsPayment(booking)) {
    return {
      key: "customer_created_awaiting_payment",
      subject: "Almost there — your {{booking_term}} on {{date}} needs payment",
      body: "Hi {{customer_name}},\n\nWe have reserved {{date}} at {{time}} {{timezone}} for your {{booking_term}} ({{service}} with {{resource}}).\n\nIt is not confirmed yet — we are waiting for payment.\n\n{{payment_line}}\n\nManage your {{booking_term}}:\n{{manage_url}}\n\nThanks,\n{{business_name}}",
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
    settingTemplate(settings, `${copy.key}_body`, copy.body)
  );
}

async function onCreated(booking: Booking) {
  const shop = booking.shop;
  const settings = await getSettings(shop, booking.platform);
  // Re-read: MeetingManager may have attached a join link by now.
  const fresh = (await Bookings.get(shop, booking.id)) ?? booking;

  if (settings.notify_customer) {
    const copy = createdCopy(fresh);
    if (templateEnabled(settings, copy.key)) {
      await sendToCustomer(
        shop,
        fresh,
        settings,
        settingTemplate(settings, `${copy.key}_subject`, copy.subject),
        settingTemplate(settings, `${copy.key}_body`, copy.body)
      );
    } else {
      console.log(`[getbooqin mailer] booking_created customer email skipped for ${fresh.uid} — template "${copy.key}" disabled`);
    }
  } else {
    console.log(`[getbooqin mailer] booking_created customer email skipped for ${fresh.uid} — notify_customer is off`);
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
        "A new {{booking_term}} was made.\n\nService: {{service}}\nWith: {{resource}}\nWhen: {{date}} at {{time}}\n\nName: {{customer_name}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\nNotes: {{notes}}\nSource: {{source}}"
      )
    );
  }
}

async function onStatusChanged(booking: Booking, oldStatus: string, newStatus: string, reason: string) {
  if (oldStatus === newStatus) return;
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.notify_customer) return;
  if (newStatus === "cancelled" || reason === "payment_received") return; // own listeners

  if (newStatus === "confirmed" && templateEnabled(settings, "customer_confirmed")) {
    await sendToCustomer(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "customer_confirmed_subject", "Confirmed: your {{booking_term}} on {{date}} at {{time}}"),
      settingTemplate(
        settings,
        "customer_confirmed_body",
        "Hi {{customer_name}},\n\nGood news — your {{booking_term}} is now confirmed.\n\n{{service}} with {{resource}}\n{{date}} at {{time}} {{timezone}}\n\n{{meeting_line}}\n{{payment_line}}\n\n{{manage_url}}\n\nSee you then,\n{{business_name}}"
      )
    );
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
        "Hi {{customer_name}},\n\nUnfortunately we are not able to confirm your {{booking_term}} request for {{service}} on {{date}} at {{time}}.\n\n{{decline_reason_line}}\n\nFeel free to request another time on our website.\n\n{{business_name}}"
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
        "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} on {{date}} at {{time}} has been cancelled.\n\nYou can book a new time any time on our website.\n\n{{business_name}}"
      )
    );
  }
  if (settings.notify_admin && templateEnabled(settings, "admin_cancelled")) {
    await sendToAdmin(
      booking.shop,
      booking,
      settings,
      settingTemplate(settings, "admin_cancelled_subject", "Cancelled: {{customer_name}} — {{date}} {{time}}"),
      settingTemplate(settings, "admin_cancelled_body", "{{customer_name}} cancelled their {{booking_term}} for {{service}} on {{date}} at {{time}}.")
    );
  }
}

async function onPaymentCompleted(booking: Booking) {
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.notify_customer || !templateEnabled(settings, "customer_paid")) return;
  await sendToCustomer(
    booking.shop,
    booking,
    settings,
    settingTemplate(settings, "customer_paid_subject", "Payment received for {{date}} at {{time}}"),
    settingTemplate(
      settings,
      "customer_paid_body",
      "Hi {{customer_name}},\n\nThanks — we have received {{amount_due}} for your {{booking_term}} on {{date}} at {{time}}.\n\n{{meeting_line}}\n\n{{manage_url}}\n\n{{business_name}}"
    )
  );
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
      "Hi {{customer_name}},\n\nYour {{booking_term}} for {{service}} has been rescheduled.\n\nNew time: {{date}} at {{time}}\nWith: {{resource}}\n\n{{manage_url}}\n\n{{business_name}}"
    )
  );
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

    try {
      await sendToCustomer(
        booking.shop,
        booking,
        settings,
        settingTemplate(settings, "customer_reminder_subject", "Reminder: {{service}} on {{date}} at {{time}}"),
        settingTemplate(
          settings,
          "customer_reminder_body",
          "Hi {{customer_name}},\n\nThis is a reminder for your {{booking_term}}:\n\n{{service}} with {{resource}}\n{{date}} at {{time}}\n\n{{meeting_line}}\n\n{{manage_url}}\n\nSee you soon,\n{{business_name}}"
        )
      );

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

export async function sendChatLead(
  shop: string,
  platform: string,
  data: { name: string; email: string; message: string },
  conversation: ChatConversation
): Promise<void> {
  const settings = await getSettings(shop, platform);
  if (!templateEnabled(settings, "admin_chat_lead")) return;
  const to = settings.admin_email || settings.business_email;
  const replacements = {
    "{{lead_name}}": data.name,
    "{{lead_email}}": data.email,
    "{{lead_message}}": data.message,
    "{{lead_page}}": conversation.pageUrl,
  };
  const subject = settingTemplate(settings, "admin_chat_lead_subject", "New chat message from {{lead_name}}");
  const body = settingTemplate(
    settings,
    "admin_chat_lead_body",
    "You received a new message through the website chat.\n\nName: {{lead_name}}\nEmail: {{lead_email}}\n\nMessage:\n{{lead_message}}\n\nPage: {{lead_page}}"
  );
  try {
    await mail(to, replace(subject, replacements), replace(body, replacements), settings);
  } catch (error) {
    console.error(`[getbooqin mailer] chat lead email failed for shop ${shop} (conversation ${conversation.uid}):`, error);
  }
}

function logMailError(context: string, shop: string, uid: string, error: unknown) {
  console.error(`[getbooqin mailer] ${context} failed for shop ${shop} (booking ${uid}):`, error);
}

/**
 * A waitlist entry isn't a Booking row until claimed, so its tokens can't
 * reuse tokens() above — built from the entry's offered slot instead. The
 * claim link is the app-proxy route shopify-openslot mounts publicly at
 * /apps/getbooqin/* (see proxy.server.ts's appProxyBase), not
 * booking_page_url — there's no storefront widget view for this yet.
 */
async function waitlistTokens(shop: string, entry: Waitlist, settings: Settings): Promise<Record<string, string>> {
  const service = await Data.catalogService(shop, entry.serviceId);
  const resource = entry.offeredResourceId ? await Data.resource(shop, entry.offeredResourceId) : null;
  const customer = await prisma.customer.findFirst({ where: { shop, id: entry.customerId } });
  const tz = settings.timezone || "UTC";
  const start = entry.offeredStartUtc ? DateTime.fromJSDate(entry.offeredStartUtc, { zone: "utc" }).setZone(tz) : null;

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
  };
}

async function sendToWaitlistCustomer(shop: string, entry: Waitlist, settings: Settings, subject: string, body: string) {
  const customer = await prisma.customer.findFirst({ where: { shop, id: entry.customerId } });
  if (!customer || !Bookings.isEmail(customer.email)) {
    console.warn(
      `[getbooqin mailer] skipped waitlist email for entry ${entry.uid} — ${!customer ? "no customer record" : `invalid email "${customer.email}"`}`
    );
    return;
  }
  const t = await waitlistTokens(shop, entry, settings);
  await mail(customer.email, replace(subject, t), replace(body, t), settings);
}

async function onWaitlistOffered(entry: Waitlist) {
  const settings = await getSettings(entry.shop, entry.platform);
  if (!settings.notify_customer || !templateEnabled(settings, "waitlist_offered")) return;
  await sendToWaitlistCustomer(
    entry.shop,
    entry,
    settings,
    settingTemplate(settings, "waitlist_offered_subject", "A spot opened up — {{service}} on {{date}} at {{time}}"),
    settingTemplate(
      settings,
      "waitlist_offered_body",
      "Hi {{customer_name}},\n\nGood news — a spot just opened up for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nThis offer is first come, first served and expires at {{expires_at}}. Claim it here:\n{{claim_url}}\n\nIf you don't respond in time, we'll offer it to the next person on the list.\n\n{{business_name}}"
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
      "Hi {{customer_name}},\n\nYour offer for {{service}} on {{date}} at {{time}} wasn't claimed in time, so we've offered it to the next person on our list.\n\nYou're still on the waitlist — we'll let you know if another time opens up.\n\n{{business_name}}"
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
  events.onEvent("booking_status_changed", (booking, oldStatus, newStatus, reason) =>
    onStatusChanged(booking, oldStatus, newStatus, reason).catch((err) =>
      logMailError("booking_status_changed", booking.shop, booking.uid, err)
    )
  );
  events.onEvent("booking_rescheduled", (booking) =>
    onRescheduled(booking).catch((err) => logMailError("booking_rescheduled", booking.shop, booking.uid, err))
  );
  events.onEvent("payment_completed", (booking) =>
    onPaymentCompleted(booking).catch((err) => logMailError("payment_completed", booking.shop, booking.uid, err))
  );
  events.onEvent("waitlist_offered", (entry) =>
    onWaitlistOffered(entry).catch((err) => logMailError("waitlist_offered", entry.shop, entry.uid, err))
  );
  events.onEvent("waitlist_expired", (entry) =>
    onWaitlistExpired(entry).catch((err) => logMailError("waitlist_expired", entry.shop, entry.uid, err))
  );
}
