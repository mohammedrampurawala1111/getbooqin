/**
 * Where WhatsApp joins the notifications that already work.
 *
 * ## A second channel, never a replacement
 *
 * Email still sends. Every time. The merchant's plan can lapse, Meta
 * can pause a template, a customer can not be on WhatsApp, the token
 * can be revoked — and in all of those the confirmation still has to
 * arrive. So this module is called *alongside* the mailer and its
 * failures are returned rather than thrown: nothing here may take down
 * the notification that was going anyway.
 *
 * That is also why it is not wired into `mailer.ts` itself. The mailer
 * knows how to compose and send email; making it conditionally
 * responsible for a second transport is how the "did the email go?"
 * question stops having a simple answer.
 *
 * ## Four gates, in cost order
 *
 * Cheapest first, so the common no-op costs one indexed lookup rather
 * than a round trip:
 *
 *   1. the shop has a connected, active WhatsApp account
 *   2. the merchant's plan includes the feature
 *   3. the merchant has the channel switched on for this template
 *   4. **the customer opted in**, and has a usable number
 *
 * Gate 4 is the one with legal weight. Meta requires demonstrable
 * consent before a business sends a template message, and a merchant
 * whose number gets reported loses the channel entirely — so a missing
 * opt-in is a silent skip, never a "send it anyway and see".
 */
import { DateTime } from "luxon";
import prisma from "../db.js";
import type { Booking, Waitlist as WaitlistRow } from "@prisma/client";
import * as Data from "../booking/data.js";
import * as Bookings from "../booking/bookings.js";
import { entitlementsForShop } from "../billing/enforcement.js";
import type { Settings } from "../booking/settingsShared.js";
import * as Accounts from "./accounts.js";
import { sendTemplate, type SendOutcome } from "./send.js";
import type { TemplateVariable, WhatsAppTemplateKey } from "./templates.js";

/** Nothing happened, and that is fine. */
const SKIPPED: SendOutcome = { sent: false, reason: "not_connected" };

/**
 * The plan feature this channel sits behind.
 *
 * Its own key rather than riding on an existing one: the merchant pays
 * Meta directly for the messages, so what a plan grants here is the
 * integration, and that is a different thing from `email_templates` or
 * `no_badge`.
 */
export const WHATSAPP_FEATURE = "whatsapp" as const;

async function accountFor(shop: string, platform: string) {
  const connection = await prisma.connection.findUnique({
    where: { platform_shop: { platform, shop } },
    select: { id: true, slug: true },
  });
  if (!connection) return null;

  const account = await prisma.whatsAppAccount.findUnique({ where: { connectionId: connection.id } });
  if (!account || account.status !== "active") return null;

  const entitlements = await entitlementsForShop(shop, platform);
  // Null means no billable connection — the Shopify install handshake
  // is a real case. Falls open exactly as every other feature check
  // does, rather than inventing a stricter rule here.
  if (entitlements && !entitlements.features.has(WHATSAPP_FEATURE)) return null;

  return { account, connection };
}

/**
 * A manage link on **our** origin, which is not the same question as
 * the one the email answers.
 *
 * `Bookings.manageUrl` builds from `settings.booking_page_url`, which
 * for a Shopify merchant is a page on their own storefront. That is
 * right for an email, where the link is the whole link — and wrong
 * here, because a WhatsApp template's URL button is registered with a
 * **fixed base** and Meta only appends a suffix to it. The base we
 * register is APP_URL, so a storefront link would have its origin
 * silently swapped and the button would point at a path that does not
 * exist on our domain.
 *
 * So this is built from APP_URL deliberately, and it resolves for both
 * platforms: /book/:slugOrId is ours, and it already handles
 * ?getbooqin_booking=.
 */
function manageUrlOnAppOrigin(connection: { id: string; slug: string | null }, uid: string): string {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  return `${base}/book/${connection.slug || connection.id}?getbooqin_booking=${uid}`;
}

/**
 * Consent, and a number that can receive it.
 *
 * Returns the E.164 number only when both are true, so a caller cannot
 * accidentally hold a number it is not allowed to message.
 */
async function consentedPhone(shop: string, customerId: number): Promise<string | null> {
  const customer = await Data.customer(shop, customerId);
  if (!customer || !customer.whatsappOptIn) return null;

  const phone = (customer.phone ?? "").trim();
  return phone ? phone : null;
}

/** Per-template switch, so a merchant can take reminders without confirmations. */
function channelEnabled(settings: Settings, key: WhatsAppTemplateKey): boolean {
  return settings.whatsapp_templates?.[key] !== false;
}

interface BookingValues {
  values: Partial<Record<TemplateVariable, string>>;
  phone: string;
}

async function bookingValues(
  shop: string,
  booking: Booking,
  settings: Settings
): Promise<BookingValues | null> {
  const phone = await consentedPhone(shop, booking.customerId);
  if (!phone) return null;

  const [service, resource, customer] = await Promise.all([
    Data.catalogService(shop, booking.serviceId),
    Data.resource(shop, booking.resourceId),
    Data.customer(shop, booking.customerId),
  ]);

  return {
    phone,
    values: {
      // Meta rejects a blank parameter outright, so each of these has a
      // fallback that is a real word rather than an empty string. "our
      // team" reads fine in a message; a 132000 does not.
      customer_name: `${customer?.firstName ?? ""}`.trim() || "there",
      business_name: settings.business_name || "us",
      service: service?.name || "your booking",
      date: Bookings.localDate(booking, settings.timezone),
      time: Bookings.localTime(booking, settings.timezone),
      resource: resource?.name || "our team",
    },
  };
}

/**
 * Send a booking-shaped template, if every gate passes.
 *
 * Never throws. A WhatsApp failure is information, not an incident —
 * the email that accompanies it has already gone.
 */
export async function notifyBooking(
  shop: string,
  platform: string,
  booking: Booking,
  settings: Settings,
  template: Extract<
    WhatsAppTemplateKey,
    "booking_confirmed" | "booking_reminder" | "booking_cancelled" | "booking_rescheduled"
  >
): Promise<SendOutcome> {
  try {
    if (!channelEnabled(settings, template)) return SKIPPED;

    const connected = await accountFor(shop, platform);
    if (!connected) return SKIPPED;

    const prepared = await bookingValues(shop, booking, settings);
    if (!prepared) return { sent: false, reason: "not_opted_in" };

    return await sendTemplate({
      account: connected.account,
      template,
      toPhone: prepared.phone,
      values: {
        ...prepared.values,
        manage_url: manageUrlOnAppOrigin(connected.connection, booking.uid),
      },
      bookingId: booking.id,
    });
  } catch (error) {
    // The catch-all matters more here than anywhere else in this
    // module: this runs inside the mailer's own event handlers, and an
    // unhandled rejection there would take down the email path that
    // WhatsApp is only ever supplementing.
    console.error(`[getbooqin whatsapp] ${template} failed for booking ${booking.uid}:`, error);
    return { sent: false, reason: "failed" };
  }
}

export async function notifyWaitlistOffer(
  shop: string,
  platform: string,
  entry: WaitlistRow,
  settings: Settings,
  links: { claimUrl: string; expiresAt: string }
): Promise<SendOutcome> {
  try {
    if (!channelEnabled(settings, "waitlist_offered")) return SKIPPED;

    const connected = await accountFor(shop, platform);
    if (!connected) return SKIPPED;

    const phone = await consentedPhone(shop, entry.customerId);
    if (!phone) return { sent: false, reason: "not_opted_in" };

    const [service, customer] = await Promise.all([
      Data.catalogService(shop, entry.serviceId),
      Data.customer(shop, entry.customerId),
    ]);

    // The *offered* slot, not the window the customer originally asked
    // for. "A spot opened up, sometime next week" is not something
    // anyone can act on, and it is the offer that expires.
    const offeredAt = entry.offeredStartUtc ?? entry.windowStartUtc;
    const local = DateTime.fromJSDate(offeredAt).setZone(settings.timezone || "UTC");

    return await sendTemplate({
      account: connected.account,
      template: "waitlist_offered",
      toPhone: phone,
      values: {
        customer_name: `${customer?.firstName ?? ""}`.trim() || "there",
        business_name: settings.business_name || "us",
        service: service?.name || "your booking",
        date: local.toFormat("DDD"),
        time: local.toFormat("t"),
        expires_at: links.expiresAt,
        claim_url: links.claimUrl,
      },
      waitlistId: entry.id,
    });
  } catch (error) {
    console.error(`[getbooqin whatsapp] waitlist offer failed for entry ${entry.id}:`, error);
    return { sent: false, reason: "failed" };
  }
}

/**
 * Record a customer's consent.
 *
 * Three columns rather than a boolean because Meta's requirement is
 * *demonstrable* consent — being able to say when it was given and
 * where. Withdrawing sets false and keeps the timestamp, so the record
 * of having asked survives the answer changing.
 */
export async function setOptIn(
  shop: string,
  customerId: number,
  optIn: boolean,
  source: string
): Promise<void> {
  await prisma.customer.updateMany({
    where: { id: customerId, shop },
    data: {
      whatsappOptIn: optIn,
      whatsappOptInAt: new Date(),
      whatsappOptInSource: source.slice(0, 40),
    },
  });
}

export { Accounts };
