import type { Route } from "./+types/dashboard.$connectionId.booking-qr[.png]";
import { Qr, Settings } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { getAppUrl } from "~/lib/env.server";

/**
 * The booking link as a printable QR.
 *
 * A clinic tapes this to the window, puts it on a receipt, or prints it
 * on a card. Someone scans it with their phone camera and lands on the
 * booking page — no app, no account, nothing to install.
 *
 * Generated on demand rather than stored: it is a pure function of the
 * booking URL, so there is nothing to keep in sync and nothing to
 * invalidate if the slug changes.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { connection, shop, platform } = await requireTenant(request, params.connectionId!);
  const settings = await Settings.getSettings(shop, platform);

  // The shop's own booking_page_url when it has one, so a custom slug
  // is honoured rather than silently replaced by the raw connection id.
  const url = settings.booking_page_url || `${getAppUrl()}/book/${connection.slug ?? connection.id}`;

  // 1024px is about 9cm at 300dpi — a printed sheet scans reliably from
  // a metre away at that size, and the file is still small enough to
  // email.
  const png = await Qr.qrPng(url, { width: 1024, margin: 2 });

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="${Qr.qrFilename(settings.business_name || shop)}"`,
      // Safe to cache in the browser: it only changes if the booking URL
      // does, and it carries nothing private.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
