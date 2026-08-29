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
import { getPreset } from "./presets.js";
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

export async function setSettings(shop: string, platform: string, values: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(shop, platform);
  const merged = { ...current, ...values };

  await prisma.shopSettings.upsert({
    where: { platform_shop: { platform, shop } },
    create: { shop, platform, data: JSON.stringify(merged) },
    update: { data: JSON.stringify(merged) },
  });

  return merged;
}

export async function applyPreset(shop: string, platform: string, key: string): Promise<Settings> {
  const preset = getPreset(key);
  return setSettings(shop, platform, {
    preset: key,
    terms: preset.terms,
    ...(preset.defaults as Partial<Settings>),
  });
}
