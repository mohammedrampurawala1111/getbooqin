/**
 * Pure, DB-free helpers split out of settings.ts so UI components can call
 * them directly while rendering, without needing the Prisma-backed module.
 */
import type { Terms } from "./presets.js";
import { getPreset } from "./presets.js";

export interface GatewaySettings {
  [gatewayId: string]: Record<string, string | boolean>;
}

export interface VideoSettings {
  [providerId: string]: Record<string, string>;
}

// Credentials for the shop's own connected WhatsApp Business number — see
// core/src/booking/whatsapp.ts for how these are used and what each field
// means. Unlike gateways/video (a registry a merchant picks *among*), this
// is a single flat config object: there's one real way to send WhatsApp
// Business messages (Meta's Cloud API), so there's nothing to pick between.
// No template name/language here — those are fixed in whatsapp.ts
// (WHATSAPP_TEMPLATE_NAME/WHATSAPP_TEMPLATE_LANGUAGE), not merchant-typed,
// so a mistyped language code can't 404 a real send (see #132001 incident).
export interface WhatsAppSettings {
  phone_number_id?: string;
  access_token?: string;
  business_account_id?: string;
  display_phone_number?: string;
}

export interface IntakeField {
  key: string;
  label: string;
  type: "text" | "phone" | "email" | "textarea";
  required: boolean;
}

export interface Settings {
  preset: string;
  business_name: string;
  business_email: string;
  business_phone: string;
  // Surfaced on the public booking page's business header (Defect
  // Dossier's BQ-33 finding) — the page previously showed only the name
  // and a bare list of service durations.
  business_description: string;
  business_address: string;
  // Prepended to a customer-entered phone number that doesn't already
  // start with "+" — e.g. "+91" — before it's stored. A bare local number
  // with no country code (accepted with no format hint at all before this)
  // silently fails to deliver if WhatsApp is ever switched on, since Meta's
  // Cloud API requires E.164 (GetBooqin clinic audit's PB-03 finding).
  // Empty means "don't guess" — numbers are stored exactly as typed, same
  // as before this field existed.
  default_country_code: string;
  currency: string;
  currency_symbol: string;
  timezone: string;

  terms: Terms;

  slot_interval: number;
  min_notice_hours: number;
  max_advance_days: number;
  auto_confirm: boolean;
  allow_cancel: boolean;
  cancel_cutoff_hours: number;
  require_phone: boolean;
  consent_text: string;
  // A business's own privacy policy, linked from the public booking form's
  // required consent checkbox. Empty falls back to GetBooqin's own privacy
  // page — better than no link at all, but every business collecting real
  // contact and (for a clinic) health-adjacent data should point this at
  // their own notice once they have one. The booking form previously had
  // no consent checkbox, no privacy link and no statement of what's stored
  // or for how long at all — patients routinely typed symptoms into the
  // free-text notes field with zero notice given (GetBooqin clinic audit's
  // TS-01 finding; India's DPDP Act 2023 requires notice and consent at
  // the point of collection).
  privacy_notice_url: string;
  booking_page_url: string;
  intake_fields: IntakeField[];

  // When a booking's slot frees up early (cancelled/declined/no-show), offer
  // it to the next matching waitlist entry instead of just letting it reopen
  // silently. `waitlist_offer_window_hours` is how long that offer stays
  // claimable before it expires and cascades to the next entry — see
  // core/src/booking/waitlist.ts.
  waitlist_enabled: boolean;
  waitlist_offer_window_hours: number;

  // Email is collected unconditionally on the public booking form with no
  // setting to relax it, while phone has its own require_phone toggle right
  // next to it — a walk-in customer with no email address (common for a
  // clinic's older or lower-income patients) couldn't book online at all,
  // and the asymmetry meant phone could become the one *optional* contact
  // method while email stayed forced (GetBooqin clinic audit's PB-03
  // finding). Defaults true so no existing shop's booking form changes
  // behavior until an owner deliberately turns this off.
  require_email: boolean;

  enabled_gateways: string[];
  gateways: GatewaySettings;
  default_deposit: number;

  video_provider: string;
  video: VideoSettings;
  video_join_window: number;

  notify_customer: boolean;
  notify_admin: boolean;
  admin_email: string;
  reminder_enabled: boolean;
  reminder_hours: number;

  // WhatsApp Business notifications (Settings > WhatsApp) — a confirmation
  // sent through the merchant's own connected WhatsApp Business number
  // when a booking is confirmed. Off (whatsapp_enabled: false) until a
  // merchant both flips this on AND fills in `whatsapp` — see whatsapp.ts's
  // isConfigured(). Separate from email's notify_customer: a merchant can
  // run either channel, both, or neither, independently. No per-message
  // enabled/body settings the way email's template_enabled/templates
  // are — the message is sent through one of Meta's pre-approved Message
  // Templates Library entries (see whatsapp.ts's header comment), whose
  // wording is entirely fixed by Meta, so there's nothing here to toggle
  // or edit per notification.
  whatsapp_enabled: boolean;
  whatsapp: WhatsAppSettings;

  chat_enabled: boolean;
  chat_position: "left" | "right";
  chat_color: string;
  chat_title: string;
  chat_subtitle: string;
  chat_greeting: string;
  chat_show_faq: boolean;
  chat_show_booking: boolean;
  chat_show_message: boolean;
  chat_offline_note: string;
  chat_hide_pages: string;
  chat_launcher_text: string;

  templates: Record<string, string>;
  // Per-template-def (by TEMPLATE_DEFS key, see mailer.ts) on/off switch —
  // absent or true means enabled, false means paused. Separate from
  // notify_customer/notify_admin, which gate customer- vs admin-bound mail
  // wholesale; this lets a merchant silence one specific notification (e.g.
  // payment-received) while keeping the rest on.
  template_enabled: Record<string, boolean>;

  // Overrides for the storefront booking widget's copy. Empty/missing key =
  // use the widget's own default text.
  widget_text: Record<string, string>;

  // ISO timestamp of the last time a platform's "embed" heartbeat ran, if
  // that platform has such a concept (Shopify's theme app embed does).
  // null/stale means "not detected yet."
  embed_last_seen_at: string | null;

  // Set once the post-install setup wizard is finished or explicitly
  // skipped, so it never blocks the dashboard again for this shop.
  onboarding_completed: boolean;

  // Set when a merchant explicitly chooses "Go live without Shopify"
  // during onboarding — a deliberate decision not to connect a channel,
  // not an unfinished step. Without this, the Overview checklist's
  // "Connect a channel" item stayed permanently incomplete for every
  // manual shop, nagging about the one thing the merchant had just said no
  // to (UX audit's B1 finding).
  channel_setup_skipped: boolean;

  // Cloud dashboard's Business template card (Settings > Template): Overview
  // card keys (cloud/app/components/account.tsx's OverviewCardKey) hidden
  // from dashboard.$connectionId._index.tsx. Empty = everything shown.
  hidden_overview_cards: string[];

  // Which of presets.ts's PRESET_CONTROLLED_KEYS this shop has hand-edited
  // since its preset was last applied. applyPreset() (settings.ts) skips
  // overwriting any key listed here, so switching or re-applying a preset
  // can never silently discard a merchant's own customization — only an
  // explicit "reset to industry defaults" (applyPreset's `force` option)
  // clears an entry. Settings UI in both apps reads this to show a "Preset
  // default" vs "Customized" indicator next to each affected field.
  customized_fields: string[];

  // Visit Summary (Clinic preset only — see
  // docs/patient-summary-cloud-integration-plan.md). Off by default for
  // every clinic, opt-in only. Deliberately NOT in presets.ts's
  // PRESET_CONTROLLED_KEYS — no preset should silently switch on an
  // AI-drafting-and-emailing-patients feature; gate check is
  // this flag AND core/src/booking/featureFlags.ts's VISIT_SUMMARIES_ENABLED
  // env var (see consultationSummary.ts).
  visit_summaries_enabled: boolean;
  // Pre-fills the intake screen's language selector; still overridable per
  // summary. "auto" maps to the prompt's own language-detection behavior.
  visit_summary_default_language: "auto" | "nl" | "en";
  // Optional consultation-consent notice. Not wired into any live
  // recording-consent screen yet (none exists in the product) — MVP
  // placement is purely as the opt-in {{summary_consent_line}} merge token
  // insertable into the customer_created/customer_created_pending email
  // templates (core/src/booking/mailer.ts). Empty means the merge token
  // renders nothing.
  visit_summary_consent_line: string;
}

export function term(settings: Settings, key: keyof Terms): string {
  return settings.terms?.[key] ?? getPreset("generic").terms[key];
}

export function money(settings: Settings, amount: number): string {
  return `${settings.currency_symbol}${amount.toFixed(2)}`;
}

export function gatewaySetting(
  settings: Settings,
  gatewayId: string,
  key: string,
  fallback = ""
): string {
  const value = settings.gateways?.[gatewayId]?.[key];
  return value !== undefined && value !== "" ? String(value) : fallback;
}

export function videoSetting(
  settings: Settings,
  providerId: string,
  key: string,
  fallback = ""
): string {
  const value = settings.video?.[providerId]?.[key];
  return value !== undefined && value !== "" ? String(value) : fallback;
}

export function template(settings: Settings, key: string, fallback: string): string {
  return settings.templates?.[key] || fallback;
}

/**
 * Server-side range + cross-field validation for the Booking rules form.
 * Before this, the four number fields' only guard was each <input>'s own
 * `min` HTML attribute — the client-side-only check a GetBooqin clinic
 * audit defeated by posting the form directly (slot_interval: -5,
 * min_notice_hours: -100, max_advance_days: 0 all saved verbatim and
 * `200 OK`, then fed straight into the slot engine — a negative interval
 * came out as its absolute value, a negative minimum notice removed the
 * floor on same-moment bookings). No field had an upper bound at all
 * (finding BR-01).
 *
 * The min_notice/max_advance check below is the exact mechanism the same
 * audit reproduced under BR-02: minimum notice is in hours, maximum
 * advance is in days, and nothing compared them — setting minimum notice
 * to 3000 hours (125 days) against a 90-day advance window left the
 * public booking page with zero bookable slots on every service,
 * indefinitely, with a green "Saved just now" and no warning anywhere.
 * `min_notice_hours >= max_advance_days * 24` is a precise, false-positive-
 * free test for that: whenever it holds, availability.ts's own
 * `earliest > latest` guarantees no slot can ever fall in range,
 * regardless of what resources or schedules exist — so blocking on it can
 * never wrongly reject a configuration that could actually book.
 */
export const BOOKING_RULE_LIMITS = {
  slot_interval: { min: 5, max: 480, unit: "minutes" },
  min_notice_hours: { min: 0, max: 720, unit: "hours" },
  max_advance_days: { min: 1, max: 730, unit: "days" },
  cancel_cutoff_hours: { min: 0, max: 720, unit: "hours" },
  waitlist_offer_window_hours: { min: 0.25, max: 168, unit: "hours" },
} as const;

export type BookingRuleField = keyof typeof BOOKING_RULE_LIMITS;

export interface BookingRuleInput {
  slot_interval: number;
  min_notice_hours: number;
  max_advance_days: number;
  cancel_cutoff_hours: number;
  waitlist_offer_window_hours: number;
}

export function validateBookingRules(values: BookingRuleInput): Partial<Record<BookingRuleField, string>> {
  const errors: Partial<Record<BookingRuleField, string>> = {};

  for (const key of Object.keys(BOOKING_RULE_LIMITS) as BookingRuleField[]) {
    const limit = BOOKING_RULE_LIMITS[key];
    const value = values[key];
    if (!Number.isFinite(value)) {
      errors[key] = "Enter a number.";
    } else if (value < limit.min || value > limit.max) {
      errors[key] = `Enter a value between ${limit.min} and ${limit.max} ${limit.unit}.`;
    }
  }

  if (!errors.min_notice_hours && !errors.max_advance_days && values.min_notice_hours >= values.max_advance_days * 24) {
    errors.min_notice_hours = `At ${values.min_notice_hours}h, minimum notice leaves no bookable moment before your ${values.max_advance_days}-day maximum advance window (${values.max_advance_days * 24}h) — lower this or raise maximum advance below.`;
    errors.max_advance_days = `Conflicts with minimum notice above (${values.min_notice_hours}h) — raise this past ${Math.ceil(values.min_notice_hours / 24)} days, or lower minimum notice.`;
  }

  return errors;
}

/**
 * Non-blocking heads-up, not a validation error: a cancellation cutoff at
 * or beyond minimum notice means every booking made at the earliest
 * permitted moment is un-cancellable from the instant it's created — a
 * real gap (GetBooqin clinic audit's PB-01 finding) but one a business can
 * legitimately intend (e.g. same-day emergency slots that are deliberately
 * final), so this only ever informs, never blocks a save.
 */
export function cancelCutoffExceedsNotice(settings: Pick<Settings, "cancel_cutoff_hours" | "min_notice_hours" | "allow_cancel">): boolean {
  return settings.allow_cancel && settings.cancel_cutoff_hours > settings.min_notice_hours;
}

/**
 * True whenever the live min_notice/max_advance combination leaves no
 * bookable moment at all — same arithmetic validateBookingRules() blocks a
 * *save* on, checked here against whatever is actually stored so Overview
 * can show a standing "online booking is closed" banner even if these
 * values reached the database before this check existed (a row written
 * before this fix shipped, or written by anything that bypasses this
 * module's own setSettings()). GetBooqin clinic audit's BR-02 finding:
 * nothing anywhere told an owner their calendar had gone fully dark.
 */
export function bookingWindowIsClosed(settings: Pick<Settings, "min_notice_hours" | "max_advance_days">): boolean {
  return settings.min_notice_hours >= settings.max_advance_days * 24;
}
