/**
 * Shared helpers for the public app-proxy routes (`/apps/getbooqin/*`).
 *
 * Shopify's App Proxy signs every storefront request with an HMAC the CLI
 * library verifies for us — that signature is what makes these routes safe
 * to leave open to logged-out visitors, the same way the WordPress version
 * relied on `permission_callback => '__return_true'` plus its own honeypot
 * and IP throttling. A request that reaches a handler here has already been
 * proven to have come from Shopify's proxy for a real, named shop.
 */
import type { Booking } from "@prisma/client";
import { authenticate } from "~/shopify.server";
import {
  Data,
  Bookings,
  PaymentManager,
  MeetingManager,
  Settings as CoreSettings,
  GetBooqinError,
} from "getbooqin-core";

type Settings = CoreSettings.Settings;
type GatewayContext = PaymentManager.GatewayContext;

// Thin compat wrapper — every App Proxy route still imports `getSettings`
// with the pre-cutover single-arg shape from here; this is the one place
// that fixes the platform.
const getSettings = (shop: string) => CoreSettings.getSettings(shop, "shopify");

export async function proxyShop(request: Request): Promise<string> {
  await authenticate.public.appProxy(request);
  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) throw new GetBooqinError("getbooqin_bad_proxy_request", "Missing shop.", 400);
  return shop;
}

export function gatewayContext(shop: string, settings: Settings): GatewayContext {
  return {
    shop,
    settings,
    appProxyBase: `https://${shop}/apps/getbooqin`,
    manageUrl: (booking: Booking) => Bookings.manageUrl(booking, settings),
  };
}

export async function bookingPayload(shop: string, settings: Settings, booking: Booking) {
  const service = await Data.catalogService(shop, booking.serviceId);
  const resource = await Data.resource(shop, booking.resourceId);
  const customer = await Data.customer(shop, booking.customerId);
  const addons = await Data.bookingAddons(shop, booking.id);
  const ctx = gatewayContext(shop, settings);

  return {
    uid: booking.uid,
    status: booking.status,
    service: service?.name ?? "",
    service_id: booking.serviceId,
    resource: resource?.name ?? "",
    resource_id: booking.resourceId,
    customer: customer ? `${customer.firstName} ${customer.lastName}`.trim() : "",
    email: customer?.email ?? "",
    date: Bookings.localDate(booking, settings.timezone),
    time: Bookings.localTime(booking, settings.timezone),
    timezone_label: Bookings.localTzLabel(booking, settings.timezone) || settings.timezone,
    start_utc: booking.startUtc.toISOString(),
    end_utc: booking.endUtc.toISOString(),
    price_html: booking.price > 0 ? `${settings.currency_symbol}${booking.price.toFixed(2)}` : "",
    addons: addons.map((a) => ({
      name: a.name,
      price: a.price,
      price_html: a.price > 0 ? `${settings.currency_symbol}${a.price.toFixed(2)}` : "",
    })),
    manage_url: Bookings.manageUrl(booking, settings),
    can_cancel: Bookings.customerCanCancel(booking, settings),
    can_reschedule: Bookings.customerCanReschedule(booking, settings),
    payment: {
      status: booking.paymentStatus,
      due: booking.amountDue,
      due_html: booking.amountDue ? `${settings.currency_symbol}${booking.amountDue.toFixed(2)}` : "",
      required: Bookings.needsPayment(booking),
      gateways: Bookings.needsPayment(booking) ? PaymentManager.optionsFor(ctx) : [],
    },
    meeting: {
      is_video: service?.locationType === "video",
      url: MeetingManager.joinOpen(booking, settings) ? booking.meetingUrl : "",
      ready: !!booking.meetingUrl,
    },
  };
}

export { getSettings };
