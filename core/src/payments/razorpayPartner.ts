/**
 * Razorpay Technology Partner — the API adapter.
 *
 * ## Why this shape and not Razorpay Route
 *
 * Route splits one payment across several beneficiaries at settlement.
 * It is the obvious answer and it is closed to us twice over: it pools
 * funds (which is the PA function RBI licenses, see
 * docs/india-market-analysis.md §8.3), and it is gated on *our* business
 * having ₹40 lakh of domestic turnover. Every payment aggregator's split
 * product carries the same gate, because the gate is regulatory rather
 * than commercial — so shopping around does not help.
 *
 * The Technology Partner programme is a different thing. The merchant
 * opens their **own** Razorpay account; we hold an OAuth token against
 * it and act on their behalf. Money settles merchant-direct and never
 * pools with us, so the line §8.3 draws stays uncrossed — and we get the
 * one thing a `upi://pay` deep link can never provide, which is a
 * callback saying the money arrived.
 *
 * ## What is verified and what is not
 *
 * The endpoints and payload shapes below are taken from Razorpay's
 * published partner documentation. **None of it has been exercised
 * against a live partner account**, because that needs a signed partner
 * agreement and client credentials we do not have yet. Treat every
 * request shape here as "documented, not proven" — the pure functions
 * (signature verification, order payload construction, event parsing)
 * are unit-tested, the network calls are not.
 *
 * This is why the whole feature sits behind the `payments_gateway`
 * entitlement, granted by no plan. See core/src/billing/plans.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Razorpay's OAuth host, which is not its API host. */
const AUTH_BASE = "https://auth.razorpay.com";
const API_BASE = "https://api.razorpay.com";

export interface PartnerTokens {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute, not a duration — a duration is only meaningful at the moment it was issued. */
  expiresAt: Date | null;
}

export interface OrderRequest {
  /** Minor units. Razorpay takes paise, never rupees — see toMinorUnits(). */
  amountMinor: number;
  currency: string;
  /** Our own reference, echoed back on the webhook. */
  receipt: string;
  /** Carried through the payment and returned on the webhook payload. */
  notes: Record<string, string>;
}

/**
 * Both halves, same reasoning as RazorpayProvider.isConfigured() in
 * billing: credentials that can create a charge but cannot be told the
 * outcome are worse than none, because money moves and the booking
 * never confirms.
 */
export function isConfigured(): boolean {
  return !!process.env.RAZORPAY_PARTNER_CLIENT_ID && !!process.env.RAZORPAY_PARTNER_CLIENT_SECRET;
}

/**
 * Where to send the merchant to authorise us.
 *
 * `state` is ours and must be unguessable and single-use — it is the
 * only thing tying the callback back to the connection that started it,
 * and without that check anyone could complete an OAuth flow against
 * someone else's account. See gateway.ts's connect flow.
 */
export function authorizeUrl(state: string, redirectUri: string): string {
  const url = new URL(`${AUTH_BASE}/authorize`);
  url.searchParams.set("client_id", process.env.RAZORPAY_PARTNER_CLIENT_ID ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  // read_write on payments and orders is the minimum that lets us create
  // an order and register a webhook. Deliberately not requesting
  // settlement or payout scopes: we have no business reading where the
  // merchant's money goes, and a scope we never use is a scope that can
  // only ever be a liability.
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<PartnerTokens> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.RAZORPAY_PARTNER_CLIENT_ID ?? "",
      client_secret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET ?? "",
      ...body,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Razorpay's error body, not ours — but never the request body, which
    // carries the client secret.
    throw new Error(`Razorpay OAuth rejected the request (${res.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new Error("Razorpay OAuth returned no access token.");

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 0;
  return {
    // Razorpay calls the merchant account id `razorpay_account_id` on the
    // token response. Empty is a real failure — every later call is
    // scoped to it — so gateway.ts refuses to store a row without one.
    accountId: typeof payload.razorpay_account_id === "string" ? payload.razorpay_account_id : "",
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

export function exchangeCode(code: string, redirectUri: string): Promise<PartnerTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export function refreshTokens(refreshToken: string): Promise<PartnerTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

async function api(
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" }
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Razorpay ${init.method} ${path} failed (${res.status}): ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload;
}

/**
 * Register the webhook that makes this whole integration worth having.
 *
 * Note the v2 /accounts/{id}/webhooks path: this creates a webhook *on
 * the merchant's account*, not on ours. `payment.captured` on that
 * account is the event that confirms their booking.
 *
 * The secret is ours, per-account, and generated by the caller — it is
 * deliberately not the platform-wide RAZORPAY_WEBHOOK_SECRET that signs
 * our own subscription events, so a leak of one tells an attacker
 * nothing about the other.
 */
export async function createWebhook(
  accountId: string,
  accessToken: string,
  url: string,
  secret: string
): Promise<string> {
  const payload = await api(accessToken, `/v2/accounts/${accountId}/webhooks`, {
    method: "POST",
    body: {
      url,
      alert_email: undefined,
      secret,
      // Only what we act on. payment.captured confirms a booking;
      // payment.failed lets the booking say so rather than sitting
      // silently pending. Nothing else is subscribed, because an event
      // nobody handles is a webhook retry storm waiting to happen.
      events: ["payment.captured", "payment.failed"],
    },
  });
  return typeof payload.id === "string" ? payload.id : "";
}

export async function deleteWebhook(accountId: string, accessToken: string, webhookId: string): Promise<void> {
  await api(accessToken, `/v2/accounts/${accountId}/webhooks/${webhookId}`, { method: "DELETE" });
}

/**
 * Create the order the customer's checkout is opened against.
 *
 * `notes` is the load-bearing field: Razorpay echoes it back on the
 * webhook, and it is how a `payment.captured` arriving minutes later
 * with no session and no cookie is matched to a booking.
 */
export async function createOrder(accessToken: string, req: OrderRequest): Promise<string> {
  const payload = await api(accessToken, "/v1/orders", {
    method: "POST",
    body: {
      amount: req.amountMinor,
      currency: req.currency,
      receipt: req.receipt,
      // 1 = Razorpay captures automatically on authorisation. Manual
      // capture would mean an authorised-but-uncaptured payment that
      // never fires payment.captured, so the booking would sit pending
      // on money the customer has already committed.
      payment_capture: 1,
      notes: req.notes,
    },
  });
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) throw new Error("Razorpay created an order with no id.");
  return id;
}

/**
 * Rupees (or whatever the account's currency is) to the minor units
 * every Razorpay amount is denominated in.
 *
 * Math.round, not a cast: 1234.56 * 100 is 123455.99999999999 in IEEE
 * 754, and a truncating conversion would quietly undercharge by a paisa
 * on a substantial fraction of all amounts.
 */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Constant-time HMAC check over the exact bytes received.
 *
 * Same rule as the billing webhook: the digest is computed over the raw
 * body, because re-serialising parsed JSON changes key order and
 * whitespace and the signature stops matching.
 */
export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false, and a wrong-length signature is the commonest garbage input.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CapturedPayment {
  event: string;
  paymentId: string;
  orderId: string;
  /** Minor units, as Razorpay sends them. */
  amountMinor: number;
  notes: Record<string, string>;
}

/** Narrows a webhook body to the fields we act on, or null if it is not one we handle. */
export function parsePaymentEvent(rawBody: string): CapturedPayment | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return null;
  }

  const event = typeof body.event === "string" ? body.event : "";
  if (event !== "payment.captured" && event !== "payment.failed") return null;

  const entity = (body.payload as Record<string, unknown> | undefined)?.payment as
    | { entity?: Record<string, unknown> }
    | undefined;
  const payment = entity?.entity;
  if (!payment) return null;

  const notes: Record<string, string> = {};
  for (const [key, value] of Object.entries((payment.notes as Record<string, unknown>) ?? {})) {
    if (typeof value === "string") notes[key] = value;
  }

  return {
    event,
    paymentId: typeof payment.id === "string" ? payment.id : "",
    orderId: typeof payment.order_id === "string" ? payment.order_id : "",
    amountMinor: typeof payment.amount === "number" ? payment.amount : 0,
    notes,
  };
}
