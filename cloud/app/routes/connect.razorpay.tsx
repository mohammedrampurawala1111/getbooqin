import { redirect } from "react-router";
import type { Route } from "./+types/connect.razorpay";
import { PaymentGateway, Entitlements } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";
import { getAppUrl } from "~/lib/env.server";
import { commitGatewayState } from "~/gatewayState.server";

/**
 * Starts the Razorpay Technology Partner OAuth round trip.
 *
 * POST-only. A GET that mints a nonce and redirects would be burned by
 * a link preview or a prefetch, so the Settings page submits a real
 * form to this.
 *
 * Not nested under /dashboard/:connectionId because the callback half
 * cannot be — Razorpay's redirect URI is registered once, per OAuth
 * client, and cannot carry a path that varies per account. Keeping the
 * pair together at /connect/razorpay/* matches /connect/shopify/*, which
 * has the same constraint for the same reason.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const connectionId = String(form.get("connection_id") ?? "");

  // Ownership and role in one call — the same decision every other
  // dashboard write path makes. "admin" rather than "write": pointing a
  // business's money at a payment account is not something a
  // write-role teammate should be able to do.
  const { connection } = await requireTenant(request, connectionId, "admin");

  // Granted by no plan — an admin turns it on per account from /admin.
  // Checked here as well as in the UI, because a hidden button is not a
  // gate.
  const entitlements = await Entitlements.entitlementsFor(connection.id);
  if (!entitlements.features.has("payments_gateway")) {
    throw new Response("Not found", { status: 404 });
  }

  const state = PaymentGateway.newState();

  // The nonce rides in a signed, httpOnly cookie rather than a table:
  // it is single-use, valid for minutes, and belongs to this browser
  // round trip rather than to the account. It also carries which
  // connection began the flow, which is the one thing the callback has
  // no other trustworthy way to learn.
  return redirect(PaymentGateway.authorizeUrl(state, `${getAppUrl()}/connect/razorpay/callback`), {
    headers: { "Set-Cookie": await commitGatewayState({ state, connectionId: connection.id }) },
  });
}

/** Nothing to render: this route is a POST target and a redirect. */
export async function loader() {
  throw new Response("Not found", { status: 404 });
}
