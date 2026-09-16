/**
 * Meta's Embedded Signup — the merchant-facing "connect WhatsApp"
 * flow.
 *
 * ## What actually happens
 *
 * The browser opens Meta's own popup (see the cloud route; it is
 * Facebook's JS SDK, and it has to be, because Meta will not let this
 * run in an iframe of ours). Inside it the merchant picks or creates a
 * WhatsApp Business Account, picks or adds a phone number, verifies it
 * by SMS, and **attaches their own payment method**. We never see any
 * of that — no passwords, no card, no OTP.
 *
 * The popup hands back two things by two different routes, which is the
 * part that surprises people:
 *
 *   1. A **`code`** through the SDK callback, exchanged here for a
 *      long-lived business token scoped to that one WABA.
 *   2. A **`waba_id` and `phone_number_id`** through a `postMessage`
 *      the page has to have been listening for.
 *
 * Neither contains the other. Miss the listener and you hold a token
 * with nothing to spend it on.
 *
 * ## Then three server-side steps, in order
 *
 *   exchangeCode      code → token
 *   subscribeApp      tell Meta to send this WABA's webhooks to us —
 *                     without it, message statuses and inbound replies
 *                     go nowhere and the integration looks one-way
 *   registerPhone     activate the number for Cloud API sending
 *
 * `completeSignup()` runs all three, because a merchant who ends up
 * with a token but an unregistered number has an integration that looks
 * connected and cannot send. If a step fails the account is stored
 * `pending` with the reason, rather than not stored at all — the token
 * is the expensive part to re-obtain, and the later steps are safe to
 * retry.
 *
 * ## The 2FA PIN
 *
 * Registering a number sets a six-digit PIN on it. We generate one,
 * store nothing, and never need it again unless the number is
 * re-registered elsewhere — at which point the merchant resets it from
 * Meta's own UI. Storing it would make this a credential worth stealing
 * for no benefit we would ever use.
 */
import { randomInt } from "node:crypto";
import { graph, GraphError } from "./graph.js";

export interface SignupConfig {
  appId: string;
  appSecret: string;
}

export function signupConfig(): SignupConfig | null {
  const appId = (process.env.META_APP_ID ?? "").trim();
  const appSecret = (process.env.META_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/** Whether this deployment can run Embedded Signup at all. */
export function isConfigured(): boolean {
  return signupConfig() !== null && !!(process.env.META_WHATSAPP_CONFIG_ID ?? "").trim();
}

/**
 * The authorisation code from the SDK callback, exchanged for a
 * business integration system user token.
 *
 * Long-lived by construction — Meta issues these without an expiry for
 * the Embedded Signup flow specifically, which is why there is no
 * refresh path anywhere in this module. It dies when the merchant
 * removes the app, and that arrives as a 190 on the next call.
 */
export async function exchangeCode(code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const config = signupConfig();
  if (!config) throw new Error("META_APP_ID and META_APP_SECRET are not set");

  const result = await graph<{ access_token?: string }>({
    path: "oauth/access_token",
    // This one call authenticates with the app secret in the query
    // rather than a bearer token, because the whole point of it is that
    // we do not have a token yet.
    accessToken: "",
    query: {
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      grant_type: "authorization_code",
    },
    fetchImpl,
  });

  if (!result.access_token) throw new Error("Meta returned no access token for that code");
  return result.access_token;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string | null;
  /** Meta's own word for whether the number is ready to send. */
  status: string | null;
}

/** What Meta knows about the number the merchant picked. */
export async function fetchPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<PhoneNumberInfo> {
  const result = await graph<{
    id: string;
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    status?: string;
  }>({
    path: phoneNumberId,
    accessToken,
    query: { fields: "id,display_phone_number,verified_name,quality_rating,status" },
    fetchImpl,
  });

  return {
    id: result.id,
    displayPhoneNumber: result.display_phone_number ?? "",
    verifiedName: result.verified_name ?? "",
    qualityRating: result.quality_rating ?? null,
    status: result.status ?? null,
  };
}

/**
 * Point this WABA's webhooks at our app.
 *
 * Easy to skip and impossible to notice: everything sends fine without
 * it. What breaks is everything coming *back* — delivery receipts,
 * read receipts, failures, template approvals, and the customer's own
 * replies. The integration looks like it works and quietly cannot
 * answer "did they get it".
 */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await graph({ path: `${wabaId}/subscribed_apps`, accessToken, method: "POST", fetchImpl });
}

/**
 * Activate the number for Cloud API sending.
 *
 * A number that exists on a WABA is not automatically sendable-from —
 * this is the step that moves it onto the Cloud API rather than
 * whatever it was on before (often the merchant's own WhatsApp Business
 * *app* on a phone, which it is then signed out of).
 */
export async function registerPhone(
  phoneNumberId: string,
  accessToken: string,
  pin: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    await graph({
      path: `${phoneNumberId}/register`,
      accessToken,
      method: "POST",
      body: { messaging_product: "whatsapp", pin },
      fetchImpl,
    });
  } catch (error) {
    // Already registered is a success for our purposes — it is what a
    // merchant who reconnects after removing and re-adding the app
    // hits, and failing them there would strand a working number.
    if (error instanceof GraphError && error.code === 133005) return;
    throw error;
  }
}

/**
 * A fresh six-digit PIN.
 *
 * `Math.random()` would be fine for a value we discard, but this is
 * cheap and means nobody has to reason about whether it is fine.
 */
export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
