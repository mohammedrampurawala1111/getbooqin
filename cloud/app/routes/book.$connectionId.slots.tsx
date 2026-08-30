import { data, type LoaderFunctionArgs } from "react-router";
import { Availability, Settings, getPublicConnection, GetBooqinError, isGetBooqinError } from "getbooqin-core";
import { throttle, clientIp } from "~/lib/http.server";

// Resource route only — no UI, fetched client-side (useFetcher().load) by
// book.$connectionId.tsx as the customer picks a service/resource/date. No
// `date` param means "which of the next few days actually have openings" —
// lets the page suggest a real date on first paint instead of defaulting to
// today and frequently showing zero slots. A `date` means "give me that
// day's actual times."
export async function loader({ request, params }: LoaderFunctionArgs) {
  const connection = await getPublicConnection(params.connectionId!);
  if (!connection) throw data("Not found", { status: 404 });

  const url = new URL(request.url);
  const serviceId = Number(url.searchParams.get("service_id") || 0);
  const resourceId = Number(url.searchParams.get("resource_id") || 0);
  const date = url.searchParams.get("date") || "";

  if (!serviceId) throw data("Missing service_id.", { status: 400 });

  try {
    // Unlike the book/cancel actions, a legitimate customer's browser calls
    // this on every date change while stepping through the wizard — a
    // higher ceiling than those, but this still does real DB-backed
    // availability computation (up to a 45-day scan) with nothing else
    // guarding it, so it needs its own throttle bucket, not a free pass.
    throttle(`slots:${params.connectionId}:${clientIp(request)}`, 60);
    const settings = await Settings.getSettings(connection.shop, connection.platform);

    if (!date) {
      const days = await Availability.nextAvailableDays(connection.shop, connection.platform, settings.timezone, serviceId, resourceId, 7);
      return { mode: "days" as const, days };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GetBooqinError("getbooqin_invalid_date", "Please choose a valid date.", 400);
    const slots = await Availability.slots(connection.shop, connection.platform, settings.timezone, serviceId, resourceId, date);
    return { mode: "slots" as const, slots };
  } catch (err) {
    if (isGetBooqinError(err)) throw data(err.message, { status: err.status });
    throw err;
  }
}
