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
import type { Booking, Waitlist as WaitlistRow } from "@prisma/client";
import { DateTime } from "luxon";
import { authenticate } from "~/shopify.server";
import {
  Data,
  Bookings,
  Settings as CoreSettings,
  GetBooqinError,
} from "getbooqin-core";

type Settings = CoreSettings.Settings;

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

export async function bookingPayload(shop: string, settings: Settings, booking: Booking) {
  const service = await Data.catalogService(shop, booking.serviceId);
  const resource = await Data.resource(shop, booking.resourceId);
  const customer = await Data.customer(shop, booking.customerId);
  const addons = await Data.bookingAddons(shop, booking.id);

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
    // No `payment` or `meeting` block any more: merchant deposits and
    // video-meeting provisioning both came out in Phase 1's trim, and the
    // storefront widget's matching branches went with them. `is_video` is
    // still a real property of a service, but with nothing left to
    // provision a link there is no per-booking meeting state to report.
  };
}

/**
 * JSON shape for the storefront waitlist manage/leave card
 * (booking-widget.liquid's ?getbooqin_waitlist=uid branch), same idea as
 * bookingPayload above. Falls back to the entry's requested window when no
 * offer has been made yet (offeredStartUtc only exists once matchAndOffer
 * has run).
 */
export async function waitlistPayload(shop: string, settings: Settings, entry: WaitlistRow) {
  const service = await Data.catalogService(shop, entry.serviceId);
  const resource = entry.offeredResourceId ? await Data.resource(shop, entry.offeredResourceId) : null;
  const tz = settings.timezone || "UTC";
  const startUtc = entry.offeredStartUtc ?? entry.windowStartUtc;
  const start = startUtc ? DateTime.fromJSDate(startUtc, { zone: "utc" }).setZone(tz) : null;

  return {
    uid: entry.uid,
    status: entry.status,
    service: service?.name ?? "",
    service_id: entry.serviceId,
    resource: resource?.name ?? "",
    resource_id: entry.resourceId,
    date: start?.toFormat("DDD") ?? "",
    time: start?.toFormat("h:mm a") ?? "",
    timezone_label: start ? start.toFormat("z") : "",
    expires_at: entry.offerExpiresAt ? DateTime.fromJSDate(entry.offerExpiresAt, { zone: "utc" }).setZone(tz).toFormat("h:mm a") : "",
    can_leave: entry.status === "waiting" || entry.status === "offered",
  };
}

export { getSettings };
