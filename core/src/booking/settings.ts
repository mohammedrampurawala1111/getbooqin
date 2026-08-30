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
import { getPreset, PRESET_CONTROLLED_KEYS } from "./presets.js";
import type { Settings } from "./settingsShared.js";

export type { Settings, GatewaySettings, VideoSettings } from "./settingsShared.js";
export { term, money, gatewaySetting, videoSetting, template } from "./settingsShared.js";

/** @param shopDomain The shop's identifier on its platform (e.g. a *.myshopify.com domain). */
export function defaultSettings(shopDomain: string, adminEmail: string): Settings {
  return {
    preset: "generic",
    business_name: shopDomain,
    business_email: adminEmail,
    business_phone: "",
    currency: "USD",
    currency_symbol: "$",
    timezone: "UTC",

    terms: getPreset("generic").terms,

    slot_interval: 30,
    min_notice_hours: 2,
    max_advance_days: 60,
    auto_confirm: true,
    allow_cancel: true,
    cancel_cutoff_hours: 24,
    require_phone: false,
    consent_text: "",
    booking_page_url: `https://${shopDomain}`,
    intake_fields: [],

    waitlist_enabled: false,
    waitlist_offer_window_hours: 4,

    enabled_gateways: [],
    gateways: {},
    default_deposit: 100,

    video_provider: "jitsi",
    video: {},
    video_join_window: 15,

    notify_customer: true,
    notify_admin: true,
    admin_email: adminEmail,
    reminder_enabled: true,
    reminder_hours: 24,

    chat_enabled: true,
    chat_position: "right",
    chat_color: "#2563eb",
    chat_title: "Chat with us",
    chat_subtitle: "We usually reply in a few minutes",
    chat_greeting: "Hi there! 👋 How can I help you today?",
    chat_show_faq: true,
    chat_show_booking: true,
    chat_show_message: true,
    chat_offline_note: "Leave your details and we will get back to you.",
    chat_hide_pages: "",
    chat_launcher_text: "Need help?",

    templates: {},
    template_enabled: {},
    widget_text: {},

    embed_last_seen_at: null,
    onboarding_completed: false,

    hidden_overview_cards: [],
    customized_fields: [],
  };
}

// No in-memory cache here, same reasoning as shopify-openslot: this runs on
// multiple instances behind one proxy, and a plain per-process Map has no
// way to invalidate itself on another instance when setSettings() runs here.
export async function getSettings(shop: string, platform = "shopify"): Promise<Settings> {
  const row = await prisma.shopSettings.findUnique({ where: { platform_shop: { platform, shop } } });
  const fallback = defaultSettings(shop, "");
  const merged: Settings = row ? { ...fallback, ...JSON.parse(row.data) } : fallback;

  if (!merged.terms || Object.keys(merged.terms).length === 0) {
    merged.terms = getPreset(merged.preset).terms;
  }

  return merged;
}

function valueChanged(a: unknown, b: unknown): boolean {
  if (a === b) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

// `fromPreset` is applyPreset()'s own escape hatch, not a merchant-facing
// option: a normal save (settings form, onboarding) marks any
// PRESET_CONTROLLED_KEYS whose value actually changes as customized, so a
// later preset switch knows to leave that field alone. applyPreset()
// already computed its own next `customized_fields` value (respecting
// existing customizations, or clearing them under `force`) and passes it
// through `values` — this flag just stops that from being reinterpreted as
// "the merchant just customized these keys."
//
// Comparing values (not just checking which keys are present in `values`)
// matters because at least one settings form submits its whole section on
// every save — shopify-openslot's General tab always includes
// slot_interval/min_notice_hours/etc. in the payload even when a merchant
// only meant to change business_name. A presence check would have marked
// every rule field "customized" on that app's very first save of anything,
// silently defeating preset switching for it from day one.
export async function setSettings(
  shop: string,
  platform: string,
  values: Partial<Settings>,
  opts: { fromPreset?: boolean } = {}
): Promise<Settings> {
  const current = await getSettings(shop, platform);

  let customizedFields = current.customized_fields ?? [];
  if (!opts.fromPreset) {
    const touched = (Object.keys(values) as (keyof Settings)[]).filter(
      (key) =>
        (PRESET_CONTROLLED_KEYS as readonly string[]).includes(key as string) &&
        valueChanged(values[key], current[key])
    );
    if (touched.length > 0) {
      customizedFields = Array.from(new Set([...customizedFields, ...(touched as string[])]));
    }
  }

  const merged: Settings = { ...current, ...values, customized_fields: values.customized_fields ?? customizedFields };

  await prisma.shopSettings.upsert({
    where: { platform_shop: { platform, shop } },
    create: { shop, platform, data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });

  return merged;
}

/**
 * Applies a preset's terms + rule defaults. Vocabulary (`terms`) always
 * updates — it is purely cosmetic and safe to reapply. Rule defaults only
 * overwrite fields the merchant has not already hand-edited (tracked via
 * `customized_fields`), so switching presets — or re-visiting onboarding —
 * can never silently discard a customization made after the last preset
 * apply. Pass `force: true` (an explicit "Reset to industry defaults"
 * action) to overwrite everything and clear that preset's customizations.
 */
export async function applyPreset(
  shop: string,
  platform: string,
  key: string,
  opts: { force?: boolean } = {}
): Promise<Settings> {
  const preset = getPreset(key);
  const current = await getSettings(shop, platform);
  const customized = new Set(current.customized_fields ?? []);

  const defaults = preset.defaults as Partial<Settings>;
  const toApply: Partial<Settings> = {};
  for (const field of Object.keys(defaults) as (keyof Settings)[]) {
    if (opts.force || !customized.has(field)) {
      (toApply as Record<string, unknown>)[field] = defaults[field];
    }
  }

  const nextCustomized = opts.force
    ? [...customized].filter((field) => !(field in defaults))
    : [...customized];

  return setSettings(
    shop,
    platform,
    { preset: key, terms: preset.terms, ...toApply, customized_fields: nextCustomized },
    { fromPreset: true }
  );
}
