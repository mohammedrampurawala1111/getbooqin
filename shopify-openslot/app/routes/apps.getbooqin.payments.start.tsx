import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings, gatewayContext } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { PaymentManager } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    throttle(`pay:${shop}:${clientIp(request)}`, 15);

    const body = await request.json();
    const settings = await getSettings(shop);

    const booking = await Bookings.getByUid(shop, String(body.uid || ""));
    if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

    const ctx = gatewayContext(shop, settings);
    const result = await PaymentManager.start(ctx, "shopify", booking, String(body.gateway || ""));
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
