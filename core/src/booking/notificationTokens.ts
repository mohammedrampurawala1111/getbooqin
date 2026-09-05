/**
 * {{token}} merge-field resolution shared by every outbound notification
 * channel. Split out of mailer.ts so a non-email channel (see whatsapp.ts)
 * can reuse the exact same "{{customer_name}}" substitution and sample
 * preview data without importing "email notifications" to get it.
 */
import { DateTime } from "luxon";
import type { Booking } from "@prisma/client";
import * as Data from "./data.js";
import * as Bookings from "./bookings.js";
import { term, money, type Settings } from "./settingsShared.js";
import { zoneAbbr } from "./tz.js";

export function parseCustomFields(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

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
    "{{summary_url}}": Bookings.summaryUrl(booking, settings),
    "{{summary_consent_line}}": settings.visit_summary_consent_line || "",
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

/**
 * Sample data for Settings > Notifications' "Preview" (Defect Dossier's
 * BQ-34 finding, item 2) — no real booking exists to render against there,
 * so this fabricates a plausible one instead of touching the database.
 * Covers every token any email or WhatsApp template body uses.
 */
export function previewTokens(settings: Settings): Record<string, string> {
  const sampleDate = DateTime.now().setZone(settings.timezone).plus({ days: 2 }).set({ hour: 10, minute: 0 });
  const expiresAt = DateTime.now().setZone(settings.timezone).plus({ hours: 2 });
  const manageUrl = `${settings.booking_page_url}?getbooqin_booking=sample`;
  return {
    "{{business_name}}": settings.business_name || "Your business",
    "{{booking_term}}": term(settings, "booking_single").toLowerCase(),
    "{{service}}": `Example ${term(settings, "service_single").toLowerCase()}`,
    "{{resource}}": "Jamie Rivera",
    "{{date}}": sampleDate.toFormat("d LLL yyyy"),
    "{{time}}": sampleDate.toFormat("HH:mm"),
    "{{status}}": "confirmed",
    "{{timezone}}": zoneAbbr(sampleDate.toJSDate(), settings.timezone),
    "{{price}}": money(settings, 45),
    "{{amount_due}}": money(settings, 45),
    "{{notes}}": "Please arrive 10 minutes early.",
    "{{source}}": "form",
    "{{customer_name}}": "Jordan Lee",
    "{{customer_email}}": "jordan@example.com",
    "{{customer_phone}}": "+1 555 0100",
    "{{manage_url}}": manageUrl,
    "{{summary_url}}": `${settings.booking_page_url}?getbooqin_summary=sample`,
    "{{summary_consent_line}}": settings.visit_summary_consent_line || "",
    "{{meeting_url}}": "https://meet.example.com/sample",
    "{{meeting_line}}": "Join the video call here: https://meet.example.com/sample",
    "{{payment_status}}": "unpaid",
    "{{payment_line}}": `Outstanding: ${money(settings, 45)}. You can pay here: ${manageUrl}`,
    "{{decline_reason_line}}": "Reason: Fully booked that day.",
    "{{addons_summary}}": `Add-ons: Extra 15 minutes (${money(settings, 10)})`,
    "{{expires_at}}": expiresAt.toFormat("HH:mm"),
    "{{claim_url}}": `${settings.booking_page_url}?getbooqin_claim=sample`,
    "{{leave_url}}": `${settings.booking_page_url}?getbooqin_leave=sample`,
    "{{lead_name}}": "Jordan Lee",
    "{{lead_email}}": "jordan@example.com",
    "{{lead_message}}": "Do you have anything available this Friday afternoon?",
    "{{lead_page}}": settings.booking_page_url,
  };
}

export function replace(text: string, replacements: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out.replace(/\{\{[a-z_]+\}\}/g, "");
}
