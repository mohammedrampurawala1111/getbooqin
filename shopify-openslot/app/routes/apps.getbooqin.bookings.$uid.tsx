import type { LoaderFunctionArgs } from "react-router";
import { proxyShop, getSettings, bookingPayload } from "~/lib/proxy.server";
import { Bookings } from "getbooqin-core";
import { ok, fail } from "~/lib/http.server";
import { GetBooqinError } from "getbooqin-core";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const shop = await proxyShop(request);
    const settings = await getSettings(shop);
    const booking = await Bookings.getByUid(shop, params.uid || "");
    if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

    return ok(await bookingPayload(shop, settings, booking));
  } catch (err) {
    return fail(err);
  }
}
