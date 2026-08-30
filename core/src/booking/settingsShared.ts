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
  booking_page_url: string;
  intake_fields: IntakeField[];

  // When a booking's slot frees up early (cancelled/declined/no-show), offer
  // it to the next matching waitlist entry instead of just letting it reopen
  // silently. `waitlist_offer_window_hours` is how long that offer stays
  // claimable before it expires and cascades to the next entry — see
  // core/src/booking/waitlist.ts.
  waitlist_enabled: boolean;
  waitlist_offer_window_hours: number;

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
