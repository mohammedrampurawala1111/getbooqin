import type { ActionFunctionArgs } from "react-router";
import { PaymentGateway } from "getbooqin-core";

/**
 * Payment events on a *merchant's own* Razorpay account.
 *
 * Deliberately a separate route from /webhooks/razorpay, which handles
 * our own subscription billing. They are signed with different secrets
 * — ours is the platform-wide RAZORPAY_WEBHOOK_SECRET, these are
 * per-account secrets we generated at connect time — and sharing one
 * endpoint would mean trying each secret in turn against every request,
 * which is both slower and a worse security story.
 *
 * `?account=acc_...` identifies which merchant, because the secret to
 * verify against cannot be known until the account is. The id is opaque
 * and the lookup reads one row; nothing is trusted until the signature
 * checks out.
 *
 * Must stay in server/combined.js's CLOUD_PREFIXES — that file only
 * forwards the paths it lists here, and shopify-openslot owns the rest
 * of /webhooks/*.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Raw bytes, not the parsed object — the HMAC is over exactly what
  // was sent, and re-serialising JSON changes key order and whitespace.
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";
  const accountId = new URL(request.url).searchParams.get("account") ?? "";

  if (!accountId) return Response.json({ ok: false }, { status: 400 });

  let outcome: Awaited<ReturnType<typeof PaymentGateway.handlePaymentEvent>>;
  try {
    outcome = await PaymentGateway.handlePaymentEvent(accountId, rawBody, signature);
  } catch (error) {
    // 500 so Razorpay retries. A captured payment whose booking never
    // confirmed is the one failure here that actually costs someone
    // something, and a retry is the cheapest possible recovery.
    console.error("[getbooqin gateway] payment webhook failed:", error);
    return Response.json({ ok: false }, { status: 500 });
  }

  if (!outcome.ok) {
    // 400 rather than 401: a bad signature is a malformed request from
    // here, and 401 invites a retry loop for something that will never
    // start working. Which check failed does not go back in the body.
    console.warn(`[getbooqin gateway] payment webhook rejected: ${outcome.status}`);
    return Response.json({ ok: false }, { status: 400 });
  }

  return Response.json({ ok: true, status: outcome.status });
}
