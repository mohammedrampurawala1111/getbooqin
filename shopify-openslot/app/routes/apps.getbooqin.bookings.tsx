import type { ActionFunctionArgs } from "react-router";
import { proxyShop, getSettings, bookingPayload } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

function sanitizeCustomFields(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === "string" && (typeof value === "string" || typeof value === "number")) {
      out[key] = String(value).slice(0, 2000);
    }
  }
  return out;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  try {
    const shop = await proxyShop(request);
    const body = await request.json();

    // Honeypot: must stay empty. Named so browser autofill never volunteers a value.
    if (String(body.os_hp_a1b2 || "").trim() !== "") {
      return ok({ uid: "", spam: true, date: "", time: "" });
    }

    throttle(`book:${shop}:${clientIp(request)}`, 8);

    const settings = await getSettings(shop);
    const booking = await Bookings.create(shop, "shopify", settings.timezone, {
      service_id: Number(body.service_id || 0),
      resource_id: Number(body.resource_id || 0),
      date: String(body.date || ""),
      time: String(body.time || ""),
      first_name: String(body.first_name || ""),
      last_name: String(body.last_name || ""),
      email: String(body.email || ""),
      phone: String(body.phone || ""),
      notes: String(body.notes || ""),
      custom_fields: sanitizeCustomFields(body.custom_fields),
      addon_ids: Array.isArray(body.addon_ids) ? body.addon_ids.map(Number).filter((n: number) => n > 0) : [],
      source: "form",
    });

    return ok(await bookingPayload(shop, settings, booking));
  } catch (err) {
    return fail(err);
  }
}
