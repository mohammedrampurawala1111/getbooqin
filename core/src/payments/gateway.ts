/**
 * The merchant's connected payment gateway — connect, disconnect, charge,
 * and the webhook that confirms a booking.
 *
 * This is the seam. Everything outside this module talks in bookings and
 * "is a gateway live for this account?"; only razorpayPartner.ts knows
 * what Razorpay is. A second provider is a second adapter behind these
 * same functions, not a second set of call sites.
 *
 * ## What this changes about a deposit
 *
 * Without it, booking/payments.ts is the whole story: the customer pays
 * the merchant directly over UPI, and the merchant marks it received by
 * hand. That stays — it is the only thing that works for a merchant who
 * will not do KYC, and it is the fallback whenever this is not live.
 *
 * With it, the same state machine runs with a webhook where the person
 * was. Payments.markPaid() is still what confirms the booking; it is
 * just called by handlePaymentEvent() below instead of by a merchant
 * clicking a button. That is deliberate — one path from "paid" to
 * "confirmed", not two that can disagree.
 *
 * ## The compliance line
 *
 * Funds never pool with GetBooqin. The order is created *on the
 * merchant's own Razorpay account* with a token they granted us, and it
 * settles to them. We are not a payment aggregator and must not become
 * one — docs/india-market-analysis.md §8.3 has the numbers (₹15 Cr net
 * worth at application, ₹25 Cr after). If a future change would route
 * money through an account we control, it needs a licence first, not a
 * code review.
 */
import { randomBytes } from "node:crypto";
import type { PaymentGatewayAccount } from "@prisma/client";
import prisma from "../db.js";
import { encryptCredentials, decryptCredentials } from "../auth/encryption.js";
import { GetBooqinError } from "../booking/errors.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { getSettings } from "../booking/settings.js";
import * as Payments from "../booking/payments.js";
import * as Razorpay from "./razorpayPartner.js";

export type { PaymentGatewayAccount };

/** The booking uid travels in the order's `notes` under this key. See createOrderForBooking. */
const BOOKING_NOTE_KEY = "getbooqin_booking_uid";

export function forConnection(connectionId: string): Promise<PaymentGatewayAccount | null> {
  return prisma.paymentGatewayAccount.findUnique({ where: { connectionId } });
}

/**
 * Can this account actually take a gateway payment right now?
 *
 * Three things, all required, and the entitlement is checked against the
 * live plan rather than trusted from the row: an account that connected
 * a gateway and then lost the feature must stop being charged against,
 * the same way branding stops applying on downgrade.
 *
 * `status === "active"` and not merely `pending` because pending means
 * the token was exchanged but the webhook never registered — and a
 * payment taken in that state would succeed and never confirm the
 * booking, which is the worst of all available outcomes.
 */
export async function isLive(connectionId: string): Promise<boolean> {
  if (!Razorpay.isConfigured()) return false;
  const entitlements = await entitlementsFor(connectionId);
  if (!entitlements.features.has("payments_gateway")) return false;
  const account = await forConnection(connectionId);
  return account?.status === "active";
}

/* ------------------------------------------------------------------ */
/* Connecting                                                          */
/* ------------------------------------------------------------------ */

/**
 * The `state` parameter for the OAuth round trip.
 *
 * Signed is unnecessary here and a stored nonce is the stronger choice:
 * this is single-use and we need to know *which* connection began the
 * flow when the callback lands with no session guarantee. Kept on the
 * row itself, in lastError's sibling field rather than a new table —
 * see beginConnect().
 */
export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizeUrl(state: string, redirectUri: string): string {
  return Razorpay.authorizeUrl(state, redirectUri);
}

/**
 * Finish the OAuth round trip: exchange the code, store the tokens, then
 * register the webhook.
 *
 * The row is written as `pending` before the webhook call and promoted
 * to `active` only once it succeeds. That ordering matters: if the
 * webhook registration fails we still hold a usable token, and a
 * merchant looking at Settings sees "connected, but not receiving
 * confirmations" instead of a connect button that silently did nothing.
 * `isLive()` refuses pending, so no payment can be taken in that state.
 */
export async function completeConnect(
  connectionId: string,
  code: string,
  redirectUri: string,
  /**
   * The webhook endpoint *without* its account query parameter — the
   * account id is only known after the exchange below, and the handler
   * needs it in the URL to know which per-account secret to verify
   * against.
   */
  webhookBaseUrl: string
): Promise<PaymentGatewayAccount> {
  const tokens = await Razorpay.exchangeCode(code, redirectUri);
  if (!tokens.accountId) {
    throw new GetBooqinError(
      "getbooqin_gateway_no_account",
      "Razorpay did not say which account was connected. Try again, or contact support.",
      502
    );
  }

  // Ours, per account, and never the platform-wide subscription webhook
  // secret — see the schema comment on webhookSecret.
  const webhookSecret = randomBytes(32).toString("base64url");

  const account = await prisma.paymentGatewayAccount.upsert({
    where: { connectionId },
    create: {
      connectionId,
      provider: "razorpay",
      accountId: tokens.accountId,
      accessToken: encryptCredentials(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptCredentials(tokens.refreshToken) : "",
      tokenExpiresAt: tokens.expiresAt,
      webhookSecret: encryptCredentials(webhookSecret),
      status: "pending",
    },
    update: {
      accountId: tokens.accountId,
      accessToken: encryptCredentials(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptCredentials(tokens.refreshToken) : "",
      tokenExpiresAt: tokens.expiresAt,
      webhookSecret: encryptCredentials(webhookSecret),
      status: "pending",
      lastError: null,
    },
  });

  try {
    const webhookUrl = `${webhookBaseUrl}?account=${encodeURIComponent(tokens.accountId)}`;
    const webhookId = await Razorpay.createWebhook(tokens.accountId, tokens.accessToken, webhookUrl, webhookSecret);
    return await prisma.paymentGatewayAccount.update({
      where: { connectionId },
      data: { webhookId, status: "active", lastError: null },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[getbooqin gateway] webhook registration failed for ${connectionId}:`, message);
    await prisma.paymentGatewayAccount.update({
      where: { connectionId },
      // Truncated, and it is an API error string — never a token, which
      // is why the message and not the request is what gets stored.
      data: { status: "error", lastError: message.slice(0, 500) },
    });
    return account;
  }
}

/**
 * Hand the account back.
 *
 * Best-effort on Razorpay's side and unconditional on ours: a merchant
 * who clicks Disconnect must end up disconnected even if Razorpay is
 * down, or they are stuck with a connection they have withdrawn consent
 * for. A stale webhook on their account is tidier to leave behind than
 * a row here that keeps claiming to be live.
 */
export async function disconnect(connectionId: string): Promise<void> {
  const account = await forConnection(connectionId);
  if (!account) return;

  if (account.webhookId) {
    try {
      await Razorpay.deleteWebhook(account.accountId, decryptCredentials(account.accessToken), account.webhookId);
    } catch (err) {
      console.warn(`[getbooqin gateway] could not remove the webhook for ${connectionId}:`, err);
    }
  }
  await prisma.paymentGatewayAccount.delete({ where: { connectionId } });
}

/* ------------------------------------------------------------------ */
/* Charging                                                            */
/* ------------------------------------------------------------------ */

/**
 * A usable access token, refreshed ahead of expiry rather than after a
 * 401.
 *
 * Sixty seconds of headroom: a token that is valid when checked and
 * expired by the time Razorpay reads it produces a failed charge on a
 * booking the customer thinks they are paying for.
 */
async function accessTokenFor(account: PaymentGatewayAccount): Promise<string> {
  const expiring = account.tokenExpiresAt && account.tokenExpiresAt.getTime() - Date.now() < 60_000;
  if (!expiring || !account.refreshToken) return decryptCredentials(account.accessToken);

  const tokens = await Razorpay.refreshTokens(decryptCredentials(account.refreshToken));
  await prisma.paymentGatewayAccount.update({
    where: { connectionId: account.connectionId },
    data: {
      accessToken: encryptCredentials(tokens.accessToken),
      ...(tokens.refreshToken ? { refreshToken: encryptCredentials(tokens.refreshToken) } : {}),
      tokenExpiresAt: tokens.expiresAt,
    },
  });
  return tokens.accessToken;
}

export interface CheckoutIntent {
  orderId: string;
  /** Razorpay's publishable key for the *merchant's* account — safe in a client bundle. */
  keyId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
}

/**
 * Raise an order against the merchant's account for what this booking
 * owes, and record our own Payment row alongside it.
 *
 * Reuses Payments.requestPayment() rather than writing its own ledger
 * row: that function is already idempotent per booking and kind, and
 * having two places that decide what a booking owes is how the figure
 * on the screen and the figure in the database come apart.
 */
export async function createOrderForBooking(
  shop: string,
  platform: string,
  connectionId: string,
  bookingId: number
): Promise<CheckoutIntent | null> {
  if (!(await isLive(connectionId))) return null;

  const account = await forConnection(connectionId);
  if (!account) return null;

  const booking = await prisma.booking.findFirst({ where: { shop, platform, id: bookingId } });
  if (!booking) throw new GetBooqinError("getbooqin_not_found", "Booking not found.", 404);

  const settings = await getSettings(shop, platform);
  const request = await Payments.requestPayment(shop, platform, bookingId, { method: "other" });
  if (request.amount <= 0) return null;

  const amountMinor = Razorpay.toMinorUnits(request.amount);
  const orderId = await Razorpay.createOrder(await accessTokenFor(account), {
    amountMinor,
    currency: settings.currency,
    receipt: request.reference,
    // The webhook arrives with no session, no cookie and no referer,
    // minutes later. This is the only thread back to the booking.
    notes: { [BOOKING_NOTE_KEY]: booking.uid, getbooqin_payment_id: String(request.id) },
  });

  // Stored so a webhook can be matched even if `notes` is ever dropped,
  // and so a merchant looking at Orders can quote a provider reference.
  await prisma.payment.update({
    where: { id: request.id },
    data: { gateway: "razorpay", transactionId: orderId },
  });

  return {
    orderId,
    keyId: process.env.RAZORPAY_PARTNER_CLIENT_ID ?? "",
    accountId: account.accountId,
    amountMinor,
    currency: settings.currency,
  };
}

/* ------------------------------------------------------------------ */
/* The webhook                                                         */
/* ------------------------------------------------------------------ */

export interface WebhookOutcome {
  ok: boolean;
  status: string;
}

/**
 * `payment.captured` on a merchant's account — the event this entire
 * integration exists to receive.
 *
 * Finds the account by the Razorpay account id in the URL rather than
 * trusting anything in the body, verifies against *that* account's own
 * secret, and only then acts. Verifying before lookup is not possible
 * (the secret is per-account), so the lookup must not itself be a
 * trusted operation — it reads one row by an opaque id and nothing else.
 */
export async function handlePaymentEvent(
  accountId: string,
  rawBody: string,
  signature: string
): Promise<WebhookOutcome> {
  const account = await prisma.paymentGatewayAccount.findFirst({ where: { accountId } });
  if (!account || !account.webhookSecret) return { ok: false, status: "unknown_account" };

  if (!Razorpay.verifyWebhookSignature(rawBody, signature, decryptCredentials(account.webhookSecret))) {
    return { ok: false, status: "bad_signature" };
  }

  const event = Razorpay.parsePaymentEvent(rawBody);
  if (!event) return { ok: true, status: "ignored" };

  const bookingUid = event.notes[BOOKING_NOTE_KEY];
  if (!bookingUid) return { ok: true, status: "no_booking_reference" };

  const connection = await prisma.connection.findUnique({ where: { id: account.connectionId } });
  if (!connection) return { ok: true, status: "connection_gone" };

  const booking = await prisma.booking.findFirst({
    where: { shop: connection.shop, platform: connection.platform, uid: bookingUid },
  });
  if (!booking) return { ok: true, status: "booking_gone" };

  if (event.event === "payment.failed") {
    // Deliberately does not cancel the booking. A failed card is
    // routinely followed by a successful retry a minute later, and
    // cancelling in between would destroy a booking the customer is in
    // the middle of paying for. It stays pending — which is already
    // what it is — and the merchant sees an unpaid request.
    return { ok: true, status: "payment_failed" };
  }

  const pending = await prisma.payment.findFirst({
    where: { shop: connection.shop, platform: connection.platform, bookingId: booking.id, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return { ok: true, status: "already_settled" };

  // The same call a merchant's "mark paid" button makes. markPaid is
  // idempotent on an already-paid row, so a replayed webhook is safe,
  // and it is what confirms the booking — see its own comment on why
  // that happens outside its transaction.
  await Payments.markPaid(connection.shop, connection.platform, pending.id, {
    // Not a person. The audit trail should say so rather than
    // attributing an automated confirmation to whoever last logged in.
    userId: "razorpay",
    utr: event.paymentId,
  });

  return { ok: true, status: "captured" };
}
