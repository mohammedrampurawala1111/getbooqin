/**
 * Pure, DB-free helpers split out of settings.ts so UI components can call
 * them directly while rendering, without needing the Prisma-backed module.
 */
import type { Terms } from "./presets.js";
import { defaultTerms } from "./presets.js";

export interface IntakeField {
  key: string;
  label: string;
  type: "text" | "phone" | "email" | "textarea";
  required: boolean;
}

export interface Settings {
  // What kind of business this is, as a plain label — the starter
  // template the account was seeded from during onboarding. Analytics
  // only: no behaviour keys off it any more, and the words the product
  // shows come from `terms` below (see presets.ts).
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
  // with no country code was accepted with no format hint at all before
  // this (GetBooqin clinic audit's PB-03 finding), leaving the business
  // with numbers it can't reliably dial back. Empty means "don't guess" —
  // numbers are stored exactly as typed, same as before this field
  // existed.
  default_country_code: string;
  currency: string;
  currency_symbol: string;
  timezone: string;

  // The nouns this business uses, free text, editable on Settings >
  // General. Every user-facing "booking"/"service"/"customer"/"staff" in
  // the dashboard, the public booking page and the emails resolves
  // through here.
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
  /**
   * Where to send the customer once a booking is confirmed, instead of
   * rendering our own "You're booked!" panel (10-01-2026 review, item 9).
   *
   * Empty means "stay here", which is the default and the right one for
   * most merchants — the built-in panel carries the reference, the manage
   * link and the add-to-calendar chooser, and a custom page carries
   * whatever the merchant put on it. The reason to set this is a merchant
   * who wants their own thank-you page, usually for conversion tracking.
   *
   * MUST be validated with isSafeRedirectUrl() before it is stored. This
   * is a merchant-controlled string that becomes a redirect target on the
   * one page in the product an anonymous visitor reaches.
   */
  thank_you_url: string;
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

  notify_customer: boolean;
  notify_admin: boolean;
  admin_email: string;
  reminder_enabled: boolean;
  reminder_hours: number;

  templates: Record<string, string>;
  // Per-template-def (by TEMPLATE_DEFS key, see mailer.ts) on/off switch —
  // absent or true means enabled, false means paused. Separate from
  // notify_customer/notify_admin, which gate customer- vs admin-bound mail
  // wholesale; this lets a merchant silence one specific notification (e.g.
  // the waitlist emails) while keeping the rest on.
  template_enabled: Record<string, boolean>;

  // Per-WhatsApp-template on/off, keyed by whatsapp/templates.ts's
  // catalogue key. Absent or true means on, exactly like
  // template_enabled above. Independent of it: a merchant may well want
  // the reminder on WhatsApp and the confirmation by email, since the
  // confirmation carries a calendar attachment that WhatsApp cannot.
  whatsapp_templates: Record<string, boolean>;

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

  // Overview card keys (cloud/app/components/account.tsx's
  // OverviewCardKey) hidden from dashboard.$connectionId._index.tsx.
  // Empty = everything shown.
  hidden_overview_cards: string[];

  // Booking-page branding, sold with the `branding` entitlement.
  //
  // The logo is a data URL rather than a file in object storage. There
  // is no blob store in this deployment, and adding one to hold a
  // 40KB image would be the most infrastructure in the product for one
  // of its smallest features. The upload is downscaled in the browser
  // before it ever reaches us and capped server-side — see
  // BRAND_LOGO_MAX_BYTES.
  brand_logo: string;
  /** Hex, e.g. "#8f3aa9". Empty means the GetBooqin default. */
  brand_accent: string;

  // Where a customer's booking payment goes. Both are the merchant's
  // own — GetBooqin never receives the money, so these are rendered
  // into a link and nothing more. See booking/paymentLinks.ts.
  upi_id: string;
  paypal_me: string;


}

/**
 * Is this `shop` value the internal tenant key of a non-platform account,
 * rather than something a human should ever read?
 *
 * connections.ts's createManualConnection() mints `manual-<uuid>` as the
 * shop key for an account with no Shopify store behind it. That key is a
 * join column, but defaultSettings() seeds `business_name` from it — so
 * until the merchant saves a real name, anything rendering business_name
 * renders a UUID. It reached the public booking page ("with
 * manual-77cd2e49-…"), the confirmation email, and every row of the
 * bookings table, because onboarding also names the first Resource after
 * it (10-01-2026 review, item 14).
 *
 * A Shopify `shop` is a real myshopify.com domain and is a reasonable
 * placeholder name; this is only about the manual key.
 */
/**
 * Is this a URL we are willing to send a booking customer to?
 *
 * `thank_you_url` is typed by a merchant and used as a redirect target on
 * the public booking page, which is the product's one unauthenticated,
 * anonymous-visitor surface. Without a scheme-and-host check that is an
 * open redirect: `javascript:` executes in the customer's browser against
 * our origin, `data:` renders attacker-authored HTML that still looks
 * like it came from us, and a protocol-relative `//evil.example` is a
 * different site that reads as a path.
 *
 * Allowlist, not denylist — anything that is not an absolute http(s) URL
 * is refused, so a scheme nobody has thought of yet is refused too.
 * http:// is permitted alongside https:// only because some small
 * merchants genuinely still run one; the UI nudges toward https.
 */
export function isSafeRedirectUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not absolute, or not parseable at all. Both are refusals: a
    // relative path here is far more likely to be a typo than an intent.
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // `new URL("https:///foo")` parses with an empty host.
  return url.hostname.length > 0;
}

export function isInternalShopKey(shop: string): boolean {
  return /^manual-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shop);
}

export function term(settings: Settings, key: keyof Terms): string {
  return settings.terms?.[key] || defaultTerms()[key];
}

export function money(settings: Settings, amount: number): string {
  return `${settings.currency_symbol}${amount.toFixed(2)}`;
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

/**
 * How large a stored logo may be, after the browser has downscaled it.
 *
 * 48KB of base64 is roughly a 36KB image — comfortably enough for a
 * 512px logo and small enough to sit inside the settings row and be
 * inlined into the booking page without anyone noticing. The cap is
 * enforced server-side because the downscale happens in the browser,
 * and anything that happens in the browser is a suggestion.
 */
export const BRAND_LOGO_MAX_BYTES = 48 * 1024;

/** Only formats every browser renders, and never SVG — it can carry script. */
const LOGO_PREFIXES = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"];

export interface BrandingProblem {
  field: "brand_logo" | "brand_accent";
  message: string;
}

/**
 * Checks a logo and accent colour before they are stored.
 *
 * SVG is refused outright. It is an image format that can contain
 * script, and this value is inlined into a page served on our origin —
 * accepting one would be a stored-XSS hole dressed up as a logo upload.
 */
export function validateBranding(input: { logo?: string; accent?: string }): BrandingProblem[] {
  const problems: BrandingProblem[] = [];
  const logo = (input.logo ?? "").trim();
  const accent = (input.accent ?? "").trim();

  if (logo) {
    if (!LOGO_PREFIXES.some((p) => logo.startsWith(p))) {
      problems.push({ field: "brand_logo", message: "Upload a PNG, JPEG or WebP image." });
    } else if (Buffer.byteLength(logo, "utf8") > BRAND_LOGO_MAX_BYTES) {
      problems.push({ field: "brand_logo", message: "That image is too large — try one under 500×500." });
    }
  }

  // Six-digit hex only. Named colours and rgb() are valid CSS but would
  // be interpolated into a style attribute, so the narrow form is the
  // one that cannot carry anything else.
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) {
    problems.push({ field: "brand_accent", message: "Pick a colour, or enter a hex code like #8f3aa9." });
  }

  return problems;
}
