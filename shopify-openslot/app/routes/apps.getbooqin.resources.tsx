import type { LoaderFunctionArgs } from "react-router";
import { proxyShop } from "~/lib/proxy.server";
import { Data } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const url = new URL(request.url);
    const serviceId = Number(url.searchParams.get("service_id") || 0);

    const resources = serviceId ? await Data.resourcesForService(shop, "shopify", serviceId) : await Data.resources(shop, "shopify", true);

    return ok(
      resources.map((r) => ({
        id: r.id,
        name: r.name,
        title: r.title,
        description: (r.description ?? "").replace(/<[^>]*>/g, ""),
        avatar: r.avatarUrl,
      }))
    );
  } catch (err) {
    return fail(err);
  }
}
