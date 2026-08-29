import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings, bookingPayload } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

/**
 * Customer self-service reschedule — same shape as .cancel.tsx, but moves
 * the booking to a new date/time instead of cancelling it. The hard part
 * (availability re-check against every other booking for that resource,
 * event emission that drives the "your booking has moved" email) already
 * existed in Bookings.reschedule(); this is the first thing that actually
 * exposes it to a customer rather than only the merchant-facing admin.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    throttle(`reschedule:${shop}:${clientIp(request)}`, 10);

    const settings = await getSettings(shop);
    const booking = await Bookings.getByUid(shop, params.uid || "");
    if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

    if (!Bookings.customerCanReschedule(booking, settings)) {
      throw new GetBooqinError(
        "getbooqin_reschedule_blocked",
        "This booking can no longer be rescheduled online. Please contact us.",
        403
      );
    }

    const body = await request.json();
    const date = String(body?.date || "");
    const time = String(body?.time || "");

    const updated = await Bookings.reschedule(shop, "shopify", settings.timezone, booking.id, date, time);
    return ok(await bookingPayload(shop, settings, updated));
  } catch (err) {
    return fail(err);
  }
}
