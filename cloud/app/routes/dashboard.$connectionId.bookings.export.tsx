import type { Route } from "./+types/dashboard.$connectionId.bookings.export";
import { Bookings, Data, Billing, Settings, isGetBooqinError } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";

/**
 * Bookings as CSV — the `export` plan feature.
 *
 * A resource route with no component: it answers with a file, not a
 * page. Gated server-side like every other feature, so a bookmarked URL
 * is refused the same way a hidden button would be.
 */
const HEADERS = [
  "reference", "status", "date", "time", "timezone",
  "service", "resource", "room",
  "customer_first_name", "customer_last_name", "customer_email", "customer_phone",
  "price", "currency", "source", "notes", "created_at",
];

/**
 * RFC 4180: quote every field, double any embedded quote.
 *
 * The leading-character guard is not about CSV at all — it is about
 * spreadsheets. A field starting with `=`, `+`, `-` or `@` is treated as
 * a formula by Excel and Sheets, so a customer who types
 * `=HYPERLINK(...)` into a booking note gets it *executed* on the
 * merchant's machine. Prefixing a tab neutralises that without changing
 * what the value reads as.
 */
function cell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `\t${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { shop, platform } = await requireTenant(request, params.connectionId, "read");

  // A GetBooqinError is a plain Error, so React Router turns it into a
  // 500 unless the status is carried deliberately — which would answer
  // "something broke" to a merchant whose actual problem is "this is on
  // a higher plan". Converted here into a real Response so the status
  // means what it says.
  try {
    await Billing.assertFeature(shop, platform, "export");
  } catch (err) {
    if (isGetBooqinError(err)) {
      return new Response(err.message, { status: err.status, headers: { "Cache-Control": "no-store" } });
    }
    throw err;
  }

  const [settings, services, resources] = await Promise.all([
    Settings.getSettings(shop, platform),
    Data.catalogServices(shop, platform, false),
    Data.resources(shop, platform, false),
  ]);
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const resourceName = new Map(resources.map((r) => [r.id, r.name]));

  // Bookings.query() caps at 500, so page rather than silently
  // truncating someone's export at the point they most need it complete.
  const PAGE = 500;
  const bookings = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await Bookings.query(shop, platform, { limit: PAGE, offset });
    bookings.push(...page);
    if (page.length < PAGE) break;
  }

  // Customers resolved in pages too, rather than one lookup per booking:
  // an export of a few thousand bookings would otherwise be a few
  // thousand round trips.
  const customerById = new Map<number, Awaited<ReturnType<typeof Data.customers>>[number]>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await Data.customers(shop, platform, "", PAGE, offset);
    for (const c of page) customerById.set(c.id, c);
    if (page.length < PAGE) break;
  }

  const rows = [HEADERS.join(",")];
  for (const b of bookings) {
    const customer = customerById.get(b.customerId) ?? null;
    rows.push(
      [
        b.uid,
        b.status,
        Bookings.localDate(b, settings.timezone),
        Bookings.localTime(b, settings.timezone),
        Bookings.localTzLabel(b, settings.timezone) || settings.timezone,
        serviceName.get(b.serviceId) ?? "",
        resourceName.get(b.resourceId) ?? "",
        b.roomId ? resourceName.get(b.roomId) ?? "" : "",
        customer?.firstName ?? "",
        customer?.lastName ?? "",
        customer?.email ?? "",
        customer?.phone ?? "",
        b.price,
        b.currency,
        b.source,
        b.notes ?? "",
        b.createdAt.toISOString(),
      ].map(cell).join(",")
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(rows.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bookings-${stamp}.csv"`,
      // A merchant's customer list is not something to leave in a shared
      // cache.
      "Cache-Control": "no-store",
    },
  });
}
