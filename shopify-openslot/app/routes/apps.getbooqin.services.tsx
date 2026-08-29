import type { LoaderFunctionArgs } from "react-router";
import { proxyShop } from "~/lib/proxy.server";
import { Data } from "getbooqin-core";
import { Settings } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await Settings.getSettings(shop, "shopify");
    const services = await Data.catalogServices(shop, "shopify", true);

    return ok(
      services.map((service) => ({
        id: service.id,
        name: service.name,
        category: service.category,
        description: (service.description ?? "").replace(/<[^>]*>/g, ""),
        duration: service.durationMin,
        price: service.price,
        price_html: service.price > 0 ? Settings.money(settings, service.price) : "Free",
        color: service.color,
      }))
    );
  } catch (err) {
    return fail(err);
  }
}
