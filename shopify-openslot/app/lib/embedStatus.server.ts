import type { Settings as CoreSettings } from "getbooqin-core";
type Settings = CoreSettings.Settings;

/**
 * Whether the storefront app embed looks turned on. There's no way to ask
 * Shopify directly (that needs the read_themes scope, not currently
 * granted — adding it now would force every installed merchant through a
 * re-consent screen, same cost the write_products scope change already
 * incurred once, see shopify.app.production.toml's [access_scopes]
 * comment). So this stays a "was it seen recently" heuristic: the embed
 * script pings apps.getbooqin.embed-ping.tsx once per storefront pageview
 * (throttled there to once an hour per shop), and this reads "recently" as
 * within the last 2 hours — comfortably above that 1-hour write-throttle
 * so an actively-visited storefront never flickers between visits, while
 * keeping the after-disable false-positive window to hours, not the 3 days
 * this used to be. A store with no visits for 2+ hours can still read as
 * "not detected" even while genuinely on — same class of heuristic error,
 * just a much shorter window than before.
 */
const EMBED_DETECTED_RECENTLY_MS = 2 * 60 * 60 * 1000;

export function isEmbedDetected(settings: Pick<Settings, "embed_last_seen_at">): boolean {
  if (!settings.embed_last_seen_at) return false;
  return Date.now() - new Date(settings.embed_last_seen_at).getTime() < EMBED_DETECTED_RECENTLY_MS;
}
