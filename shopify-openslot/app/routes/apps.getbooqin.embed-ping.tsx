import type { ActionFunctionArgs } from "react-router";
import { proxyShop } from "~/lib/proxy.server";
import { Settings } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

/**
 * The floating-button app embed pings this once per page load so the admin
 * home page can show whether the embed is actually turned on. Writes are
 * throttled to once an hour per shop — every storefront pageview calling
 * this doesn't need to hit the database, "sometime in the last hour" is
 * plenty fresh for an on/off status card.
 */
export async function action({ request }: ActionFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await Settings.getSettings(shop, "shopify");
    const last = settings.embed_last_seen_at ? new Date(settings.embed_last_seen_at) : null;
    const staleAfterMs = 60 * 60 * 1000;

    if (!last || Date.now() - last.getTime() > staleAfterMs) {
      await Settings.setSettings(shop, "shopify", { embed_last_seen_at: new Date().toISOString() });
    }

    return ok({});
  } catch (err) {
    return fail(err);
  }
}
