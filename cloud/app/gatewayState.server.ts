import { createCookie } from "react-router";

/**
 * The OAuth `state` for the Razorpay partner connect flow, and which
 * connection started it.
 *
 * A signed httpOnly cookie rather than a database row, because this is
 * genuinely browser-round-trip state: single-use, valid for minutes, and
 * meaningless to anyone but the tab that began it. A table would need
 * its own expiry sweep to avoid accumulating abandoned rows forever.
 *
 * Signed with the session secret, so the connectionId inside cannot be
 * edited by the browser — without that signature, a merchant could
 * complete an OAuth flow and have the resulting token attached to
 * somebody else's account.
 */
const SECRET = process.env.SESSION_SECRET || process.env.CLERK_SECRET_KEY || "";

export const gatewayStateCookie = createCookie("gb_gateway_oauth", {
  path: "/connect/razorpay",
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  // Long enough for a merchant to read Razorpay's consent screen and
  // think about it; short enough that an abandoned flow cannot be
  // resumed from a shared machine an hour later.
  maxAge: 15 * 60,
  secrets: SECRET ? [SECRET] : [],
});

export interface GatewayState {
  state: string;
  connectionId: string;
}

export function commitGatewayState(value: GatewayState): Promise<string> {
  return gatewayStateCookie.serialize(value);
}

export async function readGatewayState(request: Request): Promise<GatewayState | null> {
  const parsed = (await gatewayStateCookie.parse(request.headers.get("Cookie"))) as GatewayState | null;
  if (!parsed || typeof parsed.state !== "string" || typeof parsed.connectionId !== "string") return null;
  return parsed;
}

/** Expiring the cookie is what makes the nonce single-use. */
export function clearGatewayState(): Promise<string> {
  return gatewayStateCookie.serialize("", { maxAge: 0 });
}
