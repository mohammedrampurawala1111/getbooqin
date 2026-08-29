import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings, gatewayContext, bookingPayload } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { PaymentManager } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    throttle(`verify:${shop}:${clientIp(request)}`, 30);

    const body = await request.json();
    const settings = await getSettings(shop);

    // One opaque error for every failure mode, so this route cannot be used
    // to enumerate which payment IDs exist.
    const opaque = new GetBooqinError("getbooqin_not_found", "Payment not found.", 404);

    const payment = await PaymentManager.get(Number(body.payment_id || 0));
    if (!payment || payment.shop !== shop) throw opaque;

    const booking = await Bookings.get(shop, payment.bookingId);
    const gateway = PaymentManager.gateway(payment.gateway);
    if (!booking || !gateway) throw opaque;

    const ctx = gatewayContext(shop, settings);
    try {
      await gateway.handleVerify(ctx, body, payment, booking);
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === "getbooqin_not_supported") throw opaque;
      throw err;
    }

    const fresh = await Bookings.get(shop, booking.id);
    return ok(await bookingPayload(shop, settings, fresh!));
  } catch (err) {
    return fail(err);
  }
}
