import { redirect } from "react-router";
import type { Route } from "./+types/connect.razorpay.callback";
import { PaymentGateway, Entitlements, isGetBooqinError } from "getbooqin-core";
import { requireUserSession } from "~/session.server";
import { getUserConnection } from "getbooqin-core";
import { getAppUrl } from "~/lib/env.server";
import { readGatewayState, clearGatewayState } from "~/gatewayState.server";

/**
 * Where Razorpay sends the merchant back after they authorise us.
 *
 * Three things are checked before a token is exchanged, and all three
 * matter:
 *
 *   1. The `state` in the URL matches the one in our cookie. Without
 *      this, an attacker can hand a merchant a crafted callback URL and
 *      have *their* Razorpay account connected to the merchant's
 *      business — a login-CSRF with a payment rail attached.
 *   2. The signed-in user actually owns the connection the cookie
 *      names. The cookie is signed, so this is belt-and-braces, but the
 *      cost is one query against an authorization decision the rest of
 *      the app already makes this way.
 *   3. The account still has the entitlement. It is granted per-account
 *      and could have been revoked between starting and finishing.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const session = await requireUserSession(request);
  const url = new URL(request.url);
  const expected = await readGatewayState(request);

  // Always clears the cookie, whatever happens next — a nonce that
  // survives a failed attempt is not single-use.
  const headers = { "Set-Cookie": await clearGatewayState() };
  const fail = (reason: string, connectionId?: string) =>
    redirect(
      connectionId
        ? `/dashboard/${connectionId}/settings?page=payments&gateway_error=${encodeURIComponent(reason)}`
        : `/dashboard?gateway_error=${encodeURIComponent(reason)}`,
      { headers }
    );

  if (!expected) return fail("That connection attempt expired — start again from Settings.");

  const state = url.searchParams.get("state") ?? "";
  if (!state || state !== expected.state) {
    console.warn("[getbooqin gateway] OAuth callback with a mismatched state — refusing.");
    return fail("That connection link didn't match. Start again from Settings.", expected.connectionId);
  }

  // Razorpay reports a refusal in the query string rather than by
  // failing the redirect. A merchant who clicked Deny should land back
  // on Settings, not on an exception.
  const denied = url.searchParams.get("error");
  if (denied) return fail("Razorpay wasn't connected — you can try again any time.", expected.connectionId);

  const code = url.searchParams.get("code") ?? "";
  if (!code) return fail("Razorpay didn't send an authorisation code back.", expected.connectionId);

  const connection = await getUserConnection(session.userId, expected.connectionId);
  if (!connection) return fail("That business isn't yours to connect.");

  const entitlements = await Entitlements.entitlementsFor(connection.id);
  if (!entitlements.features.has("payments_gateway")) {
    return fail("Taking payments isn't enabled for this account.", connection.id);
  }

  try {
    const account = await PaymentGateway.completeConnect(
      connection.id,
      code,
      `${getAppUrl()}/connect/razorpay/callback`,
      // Base only — completeConnect appends ?account=<acc_id> once the
      // exchange tells it which account this is. The handler needs that
      // id to know which per-account secret to verify against.
      `${getAppUrl()}/webhooks/razorpay/payments`
    );

    // `pending`/`error` means the token exchange worked and the webhook
    // registration did not. Saying so beats a success message for a
    // connection that cannot confirm a single booking.
    if (account.status !== "active") {
      return fail(
        "Razorpay is connected, but we couldn't set up payment notifications. Try reconnecting.",
        connection.id
      );
    }
  } catch (err) {
    const message = isGetBooqinError(err) ? err.message : "Couldn't finish connecting Razorpay. Try again.";
    console.error("[getbooqin gateway] connect failed:", err);
    return fail(message, connection.id);
  }

  return redirect(`/dashboard/${connection.id}/settings?page=payments&gateway=connected`, { headers });
}
