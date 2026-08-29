import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { Data } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    const url = new URL(request.url);
    const serviceId = Number(url.searchParams.get("service_id") || 0);
    if (!serviceId) throw new GetBooqinError("getbooqin_missing_service", "service_id is required.", 400);

    const addons = await Data.addonsForService(shop, serviceId);

    return ok(
      addons.map((a) => ({
        id: a.id,
        name: a.name,
        description: (a.description ?? "").replace(/<[^>]*>/g, ""),
        price: a.price,
        price_html: a.price > 0 ? `${settings.currency_symbol}${a.price.toFixed(2)}` : "Free",
        duration_min: a.durationMin,
      }))
    );
  } catch (err) {
    return fail(err);
  }
}
