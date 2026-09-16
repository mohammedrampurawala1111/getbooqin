/**
 * Per-shop settings storage. One JSON row per (platform, shop), ported from
 * shopify-openslot's app/lib/settings.server.ts — same shape and logic, only
 * the storage key gained an explicit `platform` since core serves more than
 * one platform's tenants from a single database.
 *
 * The Settings type and the pure formatting helpers (term, money, …) live in
 * ./settingsShared so UI components can import them without pulling this
 * DB-touching module along. They are re-exported here too, for convenience.
 */
import prisma from "../db.js";
import { defaultTerms, withDefaultTerms } from "./presets.js";
import type { Settings } from "./settingsShared.js";
import { assertFeature } from "../billing/enforcement.js";
import { GetBooqinError } from "./errors.js";
import { validateBranding } from "./settingsShared.js";

export type { Settings, BookingRuleField, BookingRuleInput } from "./settingsShared.js";
export {
  term, money, template,
  BOOKING_RULE_LIMITS, validateBookingRules, cancelCutoffExceedsNotice, bookingWindowIsClosed,
} from "./settingsShared.js";

/** @param shopDomain The shop's identifier on its platform (e.g. a *.myshopify.com domain). */
export function defaultSettings(shopDomain: string, adminEmail: string): Settings {
  return {
    preset: "generic",
    business_name: shopDomain,
    business_email: adminEmail,
    business_phone: "",
    business_description: "",
    business_address: "",
    default_country_code: "",
    currency: "USD",
    currency_symbol: "$",
    timezone: "UTC",

    terms: defaultTerms(),

    slot_interval: 30,
    min_notice_hours: 2,
    max_advance_days: 60,
    auto_confirm: true,
    allow_cancel: true,
    cancel_cutoff_hours: 24,
    require_phone: false,
    require_email: true,
    consent_text: "",
    privacy_notice_url: "",
    booking_page_url: `https://${shopDomain}`,
    intake_fields: [],

    waitlist_enabled: false,
    waitlist_offer_window_hours: 4,

    notify_customer: true,
    notify_admin: true,
    admin_email: adminEmail,
    reminder_enabled: true,
    reminder_hours: 24,

    templates: {},
    template_enabled: {},
    whatsapp_templates: {},
    widget_text: {},

    embed_last_seen_at: null,
    onboarding_completed: false,
    channel_setup_skipped: false,

    // Overview cards this shop has switched off. "revenue" is no longer
    // one of them — the card itself came out with merchant deposits in
    // Phase 1's trim (Defect Dossier's BQ-30 finding was that same card
    // showing zeroes for a gateway that was never reachable). Existing
    // rows may still carry the key; nothing reads it any more.
    hidden_overview_cards: [],
    brand_logo: "",
    brand_accent: "",
    upi_id: "",
    paypal_me: "",
  };
}

// No in-memory cache here, same reasoning as shopify-openslot: this runs on
// multiple instances behind one proxy, and a plain per-process Map has no
// way to invalidate itself on another instance when setSettings() runs here.
export async function getSettings(shop: string, platform = "shopify"): Promise<Settings> {
  const row = await prisma.shopSettings.findUnique({ where: { platform_shop: { platform, shop } } });
  const fallback = defaultSettings(shop, "");
  const merged: Settings = row ? { ...fallback, ...JSON.parse(row.data) } : fallback;

  // Read-time backfill, so a row written before vocabulary was editable
  // (or one saved from a half-filled form) can never render an empty noun
  // in a heading. scripts_backfill_terms.ts does the same thing once, at
  // rest; this is the belt to its braces.
  merged.terms = withDefaultTerms(merged.terms);

  return merged;
}

/**
 * Merge-and-persist. Plain object merge since Phase 1's trim: the
 * `fromPreset` escape hatch, the `customized_fields` bookkeeping and the
 * per-key comparison against a preset's own defaults all existed to keep
 * `applyPreset()` from silently overwriting a merchant's hand-edits when
 * they switched industry template. Nothing applies a template to a live
 * shop any more — STARTER_TEMPLATES is read once during onboarding and
 * never again (see presets.ts) — so there is nothing left to protect a
 * field from, and the whole "Preset default / Customized" concept went
 * with it.
 */
export async function setSettings(
  shop: string,
  platform: string,
  values: Partial<Settings>
): Promise<Settings> {
  // Editing the *wording* of a notification is a plan feature; turning
  // one on or off is not. `template_enabled` is therefore ungated — a
  // merchant on any plan must be able to stop a message going out —
  // while `templates`, which holds their own subject/body overrides, is
  // gated. Checked here rather than in the route because the Shopify
  // admin writes the same field through its own settings screen.
  if (values.templates !== undefined) {
    await assertFeature(shop, platform, "email_templates");
  }

  // Branding is what the cheapest paid tier is actually sold on, so the
  // gate is here rather than in the route — the Shopify admin and any
  // future client write through this same function, and a check that
  // only one caller performs is not a gate.
  //
  // Clearing branding is always allowed. A merchant whose trial ends
  // must be able to take their logo back off, and refusing that would
  // trap them with a page they can no longer edit.
  if ((values.brand_logo !== undefined && values.brand_logo !== "") ||
      (values.brand_accent !== undefined && values.brand_accent !== "")) {
    await assertFeature(shop, platform, "branding");

    const problems = validateBranding({ logo: values.brand_logo, accent: values.brand_accent });
    if (problems.length > 0) {
      throw new GetBooqinError("getbooqin_invalid_branding", problems[0].message, 400);
    }
  }

  const current = await getSettings(shop, platform);

  // Undefined means "not in this submission" and must not overwrite.
  // Prisma-style partial updates are what every caller assumes, and the
  // spread alone gave that — but a form that posts only some of a
  // section's fields turns the rest into `""` before they ever reach
  // here, so the guard has to be at the boundary that knows the
  // difference. Callers that genuinely mean "clear this" pass "".
  const patch = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Partial<Settings>;
  const merged: Settings = { ...current, ...patch };

  await prisma.shopSettings.upsert({
    where: { platform_shop: { platform, shop } },
    create: { shop, platform, data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });

  return merged;
}
