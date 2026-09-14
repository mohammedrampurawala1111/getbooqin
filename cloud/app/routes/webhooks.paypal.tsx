import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { BillingWebhooks, PayPalProvider } from "getbooqin-core";

/**
 * PayPal's webhook endpoint — the rail for every customer outside
 * India. Same processor, same idempotency, same normalised events as
 * the Razorpay one; only the verification differs, and that difference
 * lives inside the provider.
 *
 * Configured in the PayPal developer dashboard against:
 * BILLING.SUBSCRIPTION.{ACTIVATED,CANCELLED,SUSPENDED,EXPIRED,UPDATED,
 * PAYMENT.FAILED} and PAYMENT.SALE.COMPLETED.
 *
 * PAYMENT.SALE.COMPLETED is the one that cannot be obtained any other
 * way — it is the money actually moving on a renewal, and it is what an
 * invoice is issued against.
 *
 * `/webhooks/paypal` must stay in server/combined.js's CLOUD_PREFIXES:
 * that file only forwards the paths it lists to this app, and
 * shopify-openslot owns the rest of `/webhooks/*`.
 */
export async function action({ request }: ActionFunctionArgs) {
  const rawBody = await request.text();

  let outcome: Awaited<ReturnType<typeof BillingWebhooks.handleWebhook>>;
  try {
    outcome = await BillingWebhooks.handleWebhook(PayPalProvider, rawBody, request.headers);
  } catch (error) {
    // 500 so PayPal retries — the event is on the record with its error
    // and can be replayed either way.
    console.error("[getbooqin billing] paypal webhook failed:", error);
    return Response.json({ ok: false }, { status: 500 });
  }

  if (!outcome.ok) {
    // Includes the case where PayPal itself could not verify the
    // delivery. Nothing about which check failed goes back in the body.
    console.warn(`[getbooqin billing] paypal webhook rejected: ${outcome.status}`);
    return Response.json({ ok: false }, { status: 400 });
  }

  if (outcome.status === "applied") {
    console.log(`[getbooqin billing] paypal ${outcome.type} applied to connection ${outcome.connectionId}`);
  }

  return Response.json({ ok: true, status: outcome.status });
}

/** A GET is not a delivery. See the Razorpay route for why this is 405. */
export async function loader(_: LoaderFunctionArgs) {
  return Response.json({ ok: false, error: "POST only" }, { status: 405 });
}
