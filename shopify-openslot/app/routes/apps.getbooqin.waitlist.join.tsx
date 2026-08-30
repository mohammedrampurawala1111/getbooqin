import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings } from "~/lib/proxy.server";
import { Waitlist, GetBooqinError } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";

/** Storefront self-service join — the staff-entered join in app.waitlist.tsx/dashboard.$connectionId.waitlist.tsx calls Waitlist.join() directly, this is the public equivalent for booking.js's "no slots" prompt. */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    const body = await request.json();

    // Honeypot: must stay empty. Named so browser autofill never volunteers a value.
    if (String(body.os_hp_a1b2 || "").trim() !== "") {
      return ok({ uid: "", spam: true });
    }

    throttle(`waitlist-join:${shop}:${clientIp(request)}`, 8);

    const settings = await getSettings(shop);
    if (!settings.waitlist_enabled) {
      throw new GetBooqinError("getbooqin_waitlist_disabled", "The waitlist isn't available for this business.", 400);
    }

    const entry = await Waitlist.join(shop, "shopify", settings.timezone, {
      service_id: Number(body.service_id || 0),
      resource_id: Number(body.resource_id || 0) || undefined,
      window_start: String(body.window_start || ""),
      window_end: String(body.window_end || "") || undefined,
      time: String(body.time || "") || undefined,
      first_name: String(body.first_name || ""),
      last_name: String(body.last_name || ""),
      email: String(body.email || ""),
      phone: String(body.phone || ""),
    });

    return ok({ uid: entry.uid });
  } catch (err) {
    return fail(err);
  }
}
