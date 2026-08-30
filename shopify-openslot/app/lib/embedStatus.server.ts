import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Settings as CoreSettings } from "getbooqin-core";
type Settings = CoreSettings.Settings;

/**
 * Fallback heuristic for whether the storefront app embed looks turned
 * on, used only when checkEmbedActive() below can't get a real answer
 * (read_themes not yet granted — the merchant hasn't re-consented since it
 * was added — or the API call fails for any reason). The embed script
 * pings apps.getbooqin.embed-ping.tsx once per storefront pageview
 * (throttled there to once an hour per shop); this reads "recently" as
 * within the last 2 hours — comfortably above that 1-hour write-throttle
 * so an actively-visited storefront never flickers between visits, while
 * keeping the after-disable false-positive window to hours, not the 3 days
 * this used to be before checkEmbedActive() existed. A store with no
 * visits for 2+ hours can still read as "not detected" even while
 * genuinely on — same class of heuristic error, just a much shorter
 * window than before.
 */
const EMBED_DETECTED_RECENTLY_MS = 2 * 60 * 60 * 1000;

export function isEmbedDetected(settings: Pick<Settings, "embed_last_seen_at">): boolean {
  if (!settings.embed_last_seen_at) return false;
  return Date.now() - new Date(settings.embed_last_seen_at).getTime() < EMBED_DETECTED_RECENTLY_MS;
}

interface SettingsDataBlock {
  type?: string;
  disabled?: boolean;
}

interface ThemeSettingsData {
  current?: { blocks?: Record<string, SettingsDataBlock> };
}

/**
 * Reads the main theme's config/settings_data.json directly and checks
 * whether this app's floating-button app embed (blocks/
 * product-floating-button.liquid) is present and not disabled — the real
 * answer, not an inference. Needs the read_themes scope (shopify.app.toml).
 * Returns null (not false) whenever the real answer can't be determined —
 * scope not yet granted, no main theme, the block genuinely isn't in
 * settings_data.json's shape we expect — so callers fall back to the ping
 * heuristic instead of confidently reporting "off" on what might just be
 * an API hiccup or a merchant who hasn't reopened the app since the scope
 * was added.
 */
export async function checkEmbedActive(admin: AdminApiContext): Promise<boolean | null> {
  try {
    const response = await admin.graphql(`#graphql
      query MainThemeEmbedSettings {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            files(filenames: ["config/settings_data.json"]) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }
    `);
    const body = await response.json();
    const content: string | undefined = body?.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    if (!content) return null;

    // Shopify writes every settings_data.json with a leading
    // "/* ... auto-generated ... */" comment before the actual JSON object
    // (confirmed against a real theme, not theoretical) — plain JSON.parse
    // rejects that outright, which is exactly why this silently fell back
    // to the ping heuristic every time before this strip existed.
    const withoutLeadingComment = content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
    const settingsData = JSON.parse(withoutLeadingComment) as ThemeSettingsData;
    const blocks = settingsData.current?.blocks ?? {};
    // App-embed block types look like
    // "shopify://apps/<app>/blocks/<block-file-name>/<uuid>" — matching on
    // the block's own file name (not a specific app/uuid) is what stays
    // correct across environments (dev vs. production app installs render
    // different app/uuid segments for the same block).
    const embedBlock = Object.values(blocks).find(
      (block) => typeof block?.type === "string" && block.type.includes("/blocks/product-floating-button/")
    );
    if (!embedBlock) return false; // never added to the theme at all
    return embedBlock.disabled !== true;
  } catch (err) {
    console.error("[getbooqin] checkEmbedActive failed, falling back to the ping heuristic:", err);
    return null;
  }
}

/** The one function routes should call — real answer when available, heuristic otherwise. */
export async function resolveEmbedDetected(admin: AdminApiContext, settings: Settings): Promise<boolean> {
  const accurate = await checkEmbedActive(admin);
  return accurate !== null ? accurate : isEmbedDetected(settings);
}
