import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { WhatsAppApply, WhatsAppWebhook } from "getbooqin-core";

/**
 * Meta's webhook endpoint — everything WhatsApp sends back.
 *
 * Three different things arrive here: delivery statuses (sent →
 * delivered → read → failed), the customer's own replies, and Meta's
 * verdicts on our message templates. The first of those is the reason
 * this channel is worth having at all — email cannot tell you whether
 * anybody received anything.
 *
 * Configured once in the Meta app dashboard against the `messages` and
 * `message_template_status_update` fields. The `GET` below answers the
 * verification handshake that saving that configuration triggers.
 *
 * `/webhooks/meta` must stay in server/combined.js's CLOUD_PREFIXES:
 * that file forwards only the paths it lists to this app, and
 * shopify-openslot owns the rest of `/webhooks/*`.
 */

/**
 * Meta's one-time verification handshake.
 *
 * It GETs the URL with a challenge and a token we chose, and expects
 * the challenge echoed as **plain text** — a JSON body fails
 * verification even with the right value in it.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const challenge = WhatsAppWebhook.verificationChallenge(
    params,
    process.env.META_WEBHOOK_VERIFY_TOKEN ?? ""
  );

  if (!challenge) return new Response("Forbidden", { status: 403 });
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function action({ request }: ActionFunctionArgs) {
  // The raw body, not the parsed object. The signature is an HMAC over
  // the exact bytes Meta sent, and re-serialising parsed JSON changes
  // whitespace and key order enough to break it.
  const rawBody = await request.text();

  const verified = WhatsAppWebhook.verifySignature(
    rawBody,
    request.headers.get("x-hub-signature-256"),
    process.env.META_APP_SECRET ?? ""
  );

  if (!verified) {
    // 403 and nothing in the body about which check failed. This URL is
    // public and its shape is documented by Meta, so unsigned traffic
    // is expected rather than exceptional.
    console.warn("[getbooqin whatsapp] rejected a webhook with a bad or missing signature");
    return Response.json({ ok: false }, { status: 403 });
  }

  const events = WhatsAppWebhook.parseEvent(rawBody);

  // Applied after the acknowledgement rather than before it, and never
  // allowed to change the status code.
  //
  // Meta retries a non-2xx, and after enough consecutive failures it
  // disables the subscription **for the whole app** — every merchant
  // loses delivery receipts because one row hit a constraint. A lost
  // status update costs a stale row on one screen; a disabled
  // subscription costs the channel. So the failure is logged and
  // swallowed, and `applyEvents` is itself per-event fault-tolerant.
  try {
    await WhatsAppApply.applyEvents(events);
  } catch (error) {
    console.error("[getbooqin whatsapp] could not apply webhook events:", error);
  }

  return Response.json({ ok: true });
}
