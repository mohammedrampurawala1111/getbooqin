import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { proxyShop, getSettings, waitlistPayload } from "~/lib/proxy.server";
import { ok, fail, throttle, clientIp } from "~/lib/http.server";
import { Waitlist, GetBooqinError } from "getbooqin-core";

/**
 * fixpromptwaitlist.md Task 4.2. `/apps/getbooqin/waitlist/<uid>/leave` is a
 * two-segment path, so unlike GET `/waitlist/<uid>` (see the $token route's
 * header comment) it can't collide with the offer-claim route. Serves both
 * the widget's manage card (JS fetch, wants JSON) and the plain <Form> POST
 * from the bare-HTML claim/manage page (wantsJson false, redirects back to
 * that page so it re-renders with the now-cancelled status).
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail(new GetBooqinError("getbooqin_method", "Method not allowed.", 405));

  const shop = await proxyShop(request);
  const wantsJson = (request.headers.get("accept") || "").includes("application/json");
  const uid = params.uid || "";

  try {
    throttle(`waitlist-leave:${shop}:${clientIp(request)}`, 10);
    const settings = await getSettings(shop);

    const entry = await Waitlist.getByUid(shop, uid);
    if (!entry) throw new GetBooqinError("getbooqin_not_found", "Waitlist entry not found.", 404);

    await Waitlist.leaveByUid(shop, uid);

    if (wantsJson) {
      const fresh = await Waitlist.getByUid(shop, uid);
      return ok(await waitlistPayload(shop, settings, fresh!));
    }
    return redirect(`/apps/getbooqin/waitlist/${uid}`);
  } catch (err) {
    if (wantsJson) return fail(err);
    const message = err instanceof GetBooqinError ? err.message : "Something went wrong. Please try again.";
    return redirect(`/apps/getbooqin/waitlist/${uid}?error=${encodeURIComponent(message)}`);
  }
}
