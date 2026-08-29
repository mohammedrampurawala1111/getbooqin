import type { LoaderFunctionArgs } from "react-router";
import { proxyShop } from "~/lib/proxy.server";
import { Data } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

/**
 * Resolves the current Shopify product to a linked service, if any. The
 * "book on product page" app embed can't read product.id from Liquid (app
 * embed blocks only get the global Liquid scope, not page-specific objects —
 * see Shopify's theme-app-extension docs), so it parses the product handle
 * out of the page URL in JS and looks it up here instead. Returns
 * { service: null } rather than 404 when nothing is linked, since "no
 * service for this product" is the normal, expected case, not an error.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const url = new URL(request.url);
    const handle = url.searchParams.get("handle") || "";
    const service = handle ? await Data.serviceByProductHandle(shop, "shopify", handle) : null;

    return ok({
      service: service
        ? { id: service.id, name: service.name, duration: service.durationMin }
        : null,
    });
  } catch (err) {
    return fail(err);
  }
}
