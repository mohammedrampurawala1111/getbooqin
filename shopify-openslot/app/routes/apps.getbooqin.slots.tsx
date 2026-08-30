import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { Availability } from "getbooqin-core";
import { Data } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    const url = new URL(request.url);
    const serviceId = Number(url.searchParams.get("service_id") || 0);
    const resourceId = Number(url.searchParams.get("resource_id") || 0);
    const date = url.searchParams.get("date") || "";
    const addonIds = (url.searchParams.get("addon_ids") || "")
      .split(",")
      .map(Number)
      .filter((n) => n > 0);
    // Only meaningful for a specific resource — Availability.slots() itself
    // already ignores this when resourceId resolves to more than one
    // candidate (see that function's comment), so no need to duplicate that
    // guard here.
    const includeBlocked = url.searchParams.get("include_blocked") === "1";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new GetBooqinError("getbooqin_invalid_date", "Please choose a valid date.", 400);
    }

    const addons = await Data.addonsForServiceByIds(shop, serviceId, addonIds);
    const extraDurationMin = addons.reduce((sum, a) => sum + a.durationMin, 0);

    const slots = await Availability.slots(shop, "shopify", settings.timezone, serviceId, resourceId, date, 0, extraDurationMin, includeBlocked);
    return ok(slots);
  } catch (err) {
    return fail(err);
  }
}
