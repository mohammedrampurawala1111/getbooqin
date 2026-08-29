import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings, gatewayContext } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { PaymentManager } from "getbooqin-core";

/**
 * Browser return from a redirect gateway (Stripe Checkout, PayPal). Verifies
 * server-side, then sends the customer to their booking page rather than
 * leaving them on JSON.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const shop = await proxyShop(request).catch(() => null);
  if (!shop) return Response.redirect(new URL(request.url).origin, 302);

  const settings = await getSettings(shop);
  const url = new URL(request.url);
  const payment = await PaymentManager.get(Number(url.searchParams.get("payment") || 0));
  const gateway = payment ? PaymentManager.gateway(params.gateway || "") : null;
  const booking = payment && payment.shop === shop ? await Bookings.get(shop, payment.bookingId) : null;

  if (!payment || !gateway || !booking) {
    return Response.redirect(`https://${shop}/`, 302);
  }

  const ctx = gatewayContext(shop, settings);
  let failed = false;
  try {
    await gateway.handleReturn(ctx, url.searchParams, payment, booking);
  } catch {
    failed = true;
  }

  const base = Bookings.manageUrl(booking, settings);
  const sep = base.includes("?") ? "&" : "?";
  const redirectUrl = `${base}${sep}${failed ? "payment_failed=1" : "paid=1"}`;

  return Response.redirect(redirectUrl, 302);
}
