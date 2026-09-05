/**
 * WhatsApp Business notifications, via Meta's WhatsApp Cloud API. A
 * merchant connects their own WhatsApp Business number on Settings >
 * WhatsApp (Phone number ID + a permanent access token from a Meta System
 * User — see settingsFields() below for exactly what they paste in), and
 * a confirmation message goes out through that number when their booking
 * is confirmed.
 *
 * Template: a message the business sends first — a booking confirmation,
 * not a reply to something the customer just said — counts as
 * "business-initiated" under Meta's policy, and must use a pre-approved
 * message template; free-form text is only allowed inside the 24h window
 * a customer opens by messaging in first. GetBooqin customers normally
 * book through a web widget rather than by messaging first, so the send
 * here always goes through the template endpoint.
 *
 * Earlier attempts at this had merchants write and submit their own
 * template for manual review — slow, and error-prone (Meta's #132000/
 * #132001 errors, from a body/param mismatch and a name typo, both hit in
 * testing). Meta also publishes a Message Templates Library: pre-written,
 * pre-approved content a business adds to its own account with no review
 * wait. REQUIRED_TEMPLATE below is one specific library entry — "Utility >
 * Event reminder > Appointment confirmation", library name
 * `appointment_confirmation_1` — that a human confirmed via WhatsApp
 * Manager's own library picker (screenshot, this feature's build
 * session). Every merchant must add that exact library template to their
 * own WhatsApp Business Account, name it EXACTLY WHATSAPP_TEMPLATE_NAME in
 * EXACTLY WHATSAPP_TEMPLATE_LANGUAGE, and set its "View details" button to
 * their own site — see requiredTemplate() for the merchant-facing
 * instructions and REQUIRED_TEMPLATE_BODY for the fixed wording.
 *
 * Because the wording is entirely Meta's (that is the whole point of
 * using the library — no review wait), there is no merchant-editable copy
 * here the way mailer.ts's email templates have. GetBooqin only supplies
 * the five values the approved template's body already has slots for, in
 * order: customer name, business name, service, date, time.
 *
 * Scope: only the "booking confirmed" moment — booking_created when
 * auto-confirmed, and booking_status_changed into "confirmed" — matching
 * this feature's original ask (booking/appointment confirmation).
 * Declined/cancelled/rescheduled/reminder messages would each need their
 * own separately-approved template with its own variable layout; out of
 * scope for this pass. Admin-facing messages and inbound webhooks/
 * delivery-status are also out of scope.
 */
import type { Booking } from "@prisma/client";
import * as Data from "./data.js";
import * as Bookings from "./bookings.js";
import { getSettings, setSettings, type Settings } from "./settings.js";
import { tokens } from "./notificationTokens.js";
import events from "./events.js";
import { GetBooqinError } from "./errors.js";

// Fixed, not merchant-configurable. Every merchant's own WhatsApp Business
// Account must have a template with exactly this name, in exactly this
// language, added from Meta's library (see requiredTemplate() below) — a
// merchant free-typing their own name/language into Settings is exactly
// how sends previously failed with Meta's #132001 ("template does not
// exist in the translation").
export const WHATSAPP_TEMPLATE_NAME = "appointment_confirmation_1";
export const WHATSAPP_TEMPLATE_LANGUAGE = "en_US";

// The library template's fixed body, exactly as Meta's picker previews it
// (WhatsApp Manager → Message templates → Create template → browse the
// library → "appointment_confirmation_1"). Not sent anywhere — shown to
// the merchant in Settings so they can confirm they picked the right one,
// and kept here as the source of truth for REQUIRED_TEMPLATE_VARIABLES'
// order below.
const REQUIRED_TEMPLATE_BODY =
  "Your appointment is booked\n\nHello {{1}},\n\nThank you for booking with {{2}}.\n\nYour appointment for {{3}} on {{4}} at {{5}} is confirmed.";

// Which GetBooqin token fills each of the template's five numbered slots,
// in order. Pulled from notificationTokens.ts's tokens() — the same
// {{token}} set the email templates resolve against — so this is just a
// positional re-slice of values GetBooqin already computes per booking.
const REQUIRED_TEMPLATE_VARIABLES = [
  { label: "Customer name", token: "{{customer_name}}" },
  { label: "Business name", token: "{{business_name}}" },
  { label: "Service", token: "{{service}}" },
  { label: "Date", token: "{{date}}" },
  { label: "Time", token: "{{time}}" },
] as const;

/**
 * Everything a merchant needs to set this up correctly, surfaced as an
 * instruction on Settings > WhatsApp (not an input — see the header
 * comment for why the name/language can't be merchant-typed).
 */
export function requiredTemplate(): {
  name: string;
  language: string;
  category: string;
  libraryPath: string;
  body: string;
  variables: readonly { label: string; token: string }[];
} {
  return {
    name: WHATSAPP_TEMPLATE_NAME,
    language: WHATSAPP_TEMPLATE_LANGUAGE,
    category: "Utility",
    libraryPath: "Event reminder → Appointment confirmation",
    body: REQUIRED_TEMPLATE_BODY,
    variables: REQUIRED_TEMPLATE_VARIABLES,
  };
}

/** Credentials present. Doesn't verify they're *valid*, or that the library template was actually added — a bad token or missing template only surfaces when a send actually fails. */
export function isConfigured(settings: Settings): boolean {
  const w = settings.whatsapp;
  return !!(w?.phone_number_id && w?.access_token);
}

/** Credential fields rendered on Settings → WhatsApp. No template name/language field — those are fixed, see requiredTemplate(). */
export function settingsFields(): Array<{ key: string; label: string; type: string; description?: string }> {
  return [
    {
      key: "phone_number_id",
      label: "Phone number ID",
      type: "text",
      description: "Meta Business Manager → WhatsApp → API Setup — the connected number's Phone number ID (not the phone number itself).",
    },
    {
      key: "access_token",
      label: "Access token",
      type: "password",
      description: "A permanent token for a System User with whatsapp_business_messaging permission. The temporary token shown on the API Setup page expires in 24 hours.",
    },
    {
      key: "display_phone_number",
      label: "Connected number",
      type: "text",
      description: "Optional, for your own reference — the number customers will see these messages come from.",
    },
    {
      key: "business_account_id",
      label: "WhatsApp Business Account ID",
      type: "text",
      description: "Optional, for your own reference.",
    },
  ];
}

export async function saveWhatsAppSettings(shop: string, platform: string, values: Record<string, string>): Promise<Settings> {
  const current = await getSettings(shop, platform);
  return setSettings(shop, platform, { whatsapp: { ...current.whatsapp, ...values } });
}

const GRAPH_API_VERSION = "v20.0";

async function sendCloudApiMessage(settings: Settings, toDigits: string, bodyParams: string[]): Promise<void> {
  const w = settings.whatsapp;
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(w.phone_number_id!)}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${w.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATE_NAME,
        language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
        // No "button" component here — the template's "View details" button
        // uses a Static URL (fixed at template-creation time in each
        // merchant's own WhatsApp Manager), which needs no runtime
        // parameter. Only a Dynamic button URL would need one.
        components: [
          { type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: (text || "-").slice(0, 1024) })) },
        ],
      },
    }),
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`WhatsApp send failed (HTTP ${response.status}): ${errBody.slice(0, 500)}`);
  }
}

// Meta's Cloud API takes the recipient as digits only — country code, no
// leading "+", no spaces/dashes/parens.
function toWhatsAppDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/** Builds the five body parameters, in the approved template's order — see REQUIRED_TEMPLATE_VARIABLES. */
async function confirmationParams(shop: string, booking: Booking, settings: Settings): Promise<string[]> {
  const t = await tokens(shop, booking, settings);
  return REQUIRED_TEMPLATE_VARIABLES.map((v) => t[v.token] ?? "");
}

async function sendConfirmation(shop: string, booking: Booking, settings: Settings): Promise<void> {
  const customer = await Data.customer(shop, booking.customerId);
  if (!customer || !Bookings.isPhone(customer.phone)) {
    console.warn(
      `[getbooqin whatsapp] skipped booking ${booking.uid} — ${!customer ? "no customer record" : `no usable phone number ("${customer.phone}")`}`
    );
    return;
  }
  const params = await confirmationParams(shop, booking, settings);
  await sendCloudApiMessage(settings, toWhatsAppDigits(customer.phone), params);
  console.log(`[getbooqin whatsapp] sent confirmation to ${customer.phone} for booking ${booking.uid}`);
}

function logError(context: string, shop: string, uid: string, error: unknown) {
  console.error(`[getbooqin whatsapp] ${context} failed for shop ${shop} (booking ${uid}):`, error);
}

async function onCreated(booking: Booking) {
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.whatsapp_enabled || !isConfigured(settings)) return;
  if (booking.status !== "confirmed") return; // pending/awaiting-payment bookings aren't confirmed yet — nothing to send
  // Re-read: MeetingManager may have attached a join link by now, same as mailer.ts's own onCreated.
  const fresh = (await Bookings.get(booking.shop, booking.id)) ?? booking;
  await sendConfirmation(booking.shop, fresh, settings);
}

async function onStatusChanged(booking: Booking, oldStatus: string, newStatus: string) {
  if (oldStatus === newStatus || newStatus !== "confirmed") return;
  const settings = await getSettings(booking.shop, booking.platform);
  if (!settings.whatsapp_enabled || !isConfigured(settings)) return;
  await sendConfirmation(booking.shop, booking, settings);
}

/** Manual "Send a test message" action from Settings > WhatsApp, so a merchant can verify credentials and their template before relying on real bookings. */
export async function sendTestMessage(shop: string, platform: string, toPhone: string): Promise<void> {
  const settings = await getSettings(shop, platform);
  if (!isConfigured(settings)) {
    throw new GetBooqinError("getbooqin_whatsapp_not_configured", "Add your WhatsApp credentials first.", 400);
  }
  if (!Bookings.isPhone(toPhone)) {
    throw new GetBooqinError("getbooqin_invalid_phone", "Enter a valid phone number.", 400);
  }
  const now = new Date();
  const sampleParams = [
    "Jordan",
    settings.business_name || "your business",
    "a test service",
    now.toLocaleDateString(),
    now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  ];
  await sendCloudApiMessage(settings, toWhatsAppDigits(toPhone), sampleParams);
}

export function init() {
  events.onEvent("booking_created", (booking) => onCreated(booking).catch((err) => logError("booking_created", booking.shop, booking.uid, err)));
  events.onEvent("booking_status_changed", (booking, oldStatus, newStatus) =>
    onStatusChanged(booking, oldStatus, newStatus).catch((err) => logError("booking_status_changed", booking.shop, booking.uid, err))
  );
}
