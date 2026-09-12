import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { BillingWebhooks, RazorpayProvider } from "getbooqin-core";

/**
 * Razorpay's webhook endpoint — the only way the product learns that a
 * renewal succeeded, a card bounced, or a mandate was revoked. Month two
 * onward there is no browser and no session for any of that; a return
 * URL can't tell you.
 *
 * Configured in the Razorpay dashboard against these events:
 * subscription.{authenticated,activated,charged,pending,halted,cancelled,
 * completed,updated}. Deliberately not the `payment.*` events — they'd
 * duplicate `subscription.charged` and give two sources of truth for one
 * fact.
 *
 * `/webhooks/razorpay` must stay in server/combined.js's CLOUD_PREFIXES:
 * that file only forwards the paths it lists to this app, and
 * shopify-openslot owns the rest of `/webhooks/*` for its own mandatory
 * Shopify webhooks.
 */
export async function action({ request }: ActionFunctionArgs) {
  // The raw body, not the parsed object. The HMAC is computed over the
  // exact bytes Razorpay sent — re-serialising parsed JSON changes key
  // order and whitespace, and the digest stops matching.
  const rawBody = await request.text();

  let outcome: Awaited<ReturnType<typeof BillingWebhooks.handleWebhook>>;
  try {
    outcome = await BillingWebhooks.handleWebhook(RazorpayProvider, rawBody, request.headers);
  } catch (error) {
    // The event is on the record with its error (see handleWebhook), so
    // it can be replayed. Answering 500 is deliberate: it makes Razorpay
    // retry, which is the cheapest possible recovery.
    console.error("[getbooqin billing] razorpay webhook failed:", error);
    return Response.json({ ok: false }, { status: 500 });
  }

  if (!outcome.ok) {
    // 400, not 401 — a bad signature is a malformed request from our
    // point of view, and a 401 invites a retry loop for something that
    // will never start working. Nothing about which check failed goes
    // back in the body.
    console.warn(`[getbooqin billing] razorpay webhook rejected: ${outcome.status}`);
    return Response.json({ ok: false }, { status: 400 });
  }

  if (outcome.status === "applied") {
    console.log(`[getbooqin billing] razorpay ${outcome.type} applied to connection ${outcome.connectionId}`);
  }

  return Response.json({ ok: true, status: outcome.status });
}

/**
 * A GET is not a delivery. Answering 405 rather than 404 makes "is the
 * URL right?" answerable from a browser without implying the endpoint
 * accepts reads.
 */
export async function loader(_: LoaderFunctionArgs) {
  return Response.json({ ok: false, error: "POST only" }, { status: 405 });
}
