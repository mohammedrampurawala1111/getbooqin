import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { Availability } from "getbooqin-core";
import { Data } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    const url = new URL(request.url);
    const serviceId = Number(url.searchParams.get("service_id") || 0);
    const resourceId = Number(url.searchParams.get("resource_id") || 0);
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 14)));
    const addonIds = (url.searchParams.get("addon_ids") || "")
      .split(",")
      .map(Number)
      .filter((n) => n > 0);

    const addons = await Data.addonsForServiceByIds(shop, serviceId, addonIds);
    const extraDurationMin = addons.reduce((sum, a) => sum + a.durationMin, 0);

    const year = Number(url.searchParams.get("year") || 0);
    const month = Number(url.searchParams.get("month") || 0);
    if (year && month) {
      const days = await Availability.daysInMonth(shop, "shopify", settings.timezone, serviceId, resourceId, year, month, extraDurationMin);
      return ok(days);
    }

    const days = await Availability.nextAvailableDays(shop, "shopify", settings.timezone, serviceId, resourceId, limit, 45, extraDurationMin);
    return ok(days);
  } catch (err) {
    return fail(err);
  }
}
