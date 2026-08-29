import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings, bookingPayload } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    throttle(`cancel:${shop}:${clientIp(request)}`, 10);

    const settings = await getSettings(shop);
    const booking = await Bookings.getByUid(shop, params.uid || "");
    if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

    if (!Bookings.customerCanCancel(booking, settings)) {
      throw new GetBooqinError("getbooqin_cancel_blocked", "This booking can no longer be cancelled online. Please contact us.", 403);
    }

    await Bookings.setStatus(shop, booking.id, "cancelled", "customer");
    const fresh = await Bookings.get(shop, booking.id);
    return ok(await bookingPayload(shop, settings, fresh!));
  } catch (err) {
    return fail(err);
  }
}
