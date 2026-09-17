/**
 * Everything Meta sends back.
 *
 * Three kinds of delivery arrive on one endpoint, and they are
 * genuinely different things:
 *
 *   statuses    sent → delivered → read, or failed with a reason. This
 *               is the answer to "did the customer actually get their
 *               reminder", which email cannot give at all.
 *   messages    the customer replied. Worth recording because a reply
 *               opens a 24-hour service window, and because a merchant
 *               needs to know somebody answered a reminder.
 *   templates   Meta approved, rejected or paused one of ours.
 *
 * ## Verification is not optional and not a formality
 *
 * The URL is public and its shape is documented by Meta, so anything on
 * the internet can POST to it. Without the signature check, a stranger
 * can mark a merchant's messages delivered, or flip a template to
 * APPROVED and cause every subsequent send to fail against Meta for
 * real. `verifySignature` is HMAC-SHA256 over the **raw body** —
 * re-serialising parsed JSON produces a different string and fails, so
 * the route must hand this the untouched text.
 *
 * ## Parse and apply are separate
 *
 * `parseEvent` is pure and total: no database, no network, and it
 * returns null rather than throwing for a shape it does not know.
 * Meta adds fields and event types without warning, and a webhook
 * handler that throws on an unrecognised payload answers 500, which
 * makes Meta retry it, which makes it throw again — and after enough of
 * those Meta disables the subscription for the whole app. Every
 * merchant stops receiving statuses because one payload had a new key
 * in it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type WhatsAppEvent =
  | {
      kind: "status";
      phoneNumberId: string;
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      errorCode: string | null;
      errorTitle: string | null;
    }
  | {
      kind: "inbound";
      phoneNumberId: string;
      fromPhone: string;
      text: string;
      providerMessageId: string;
    }
  | {
      kind: "template_status";
      wabaId: string;
      name: string;
      language: string;
      status: string;
      reason: string | null;
    }
  | {
      kind: "account_health";
      phoneNumberId: string;
      qualityRating: string | null;
      messagingLimit: string | null;
    };

/**
 * True only if the body genuinely came from Meta.
 *
 * Constant-time, and false for a malformed header rather than throwing
 * — a caller that has to try/catch its own auth check eventually wraps
 * it in something that swallows the failure.
 */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;

  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Meta's verification handshake, used once when the webhook URL is
 * first saved in the app dashboard.
 *
 * Returns the challenge to echo, or null to refuse. The token compared
 * here is one we invented and typed into Meta's dashboard; it proves
 * the GET came from someone who knows it.
 */
export function verificationChallenge(
  params: URLSearchParams,
  verifyToken: string
): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!verifyToken || params.get("hub.verify_token") !== verifyToken) return null;
  return params.get("hub.challenge");
}

interface Envelope {
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: Record<string, unknown>;
    }[];
  }[];
}

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Subscribed to for coexistence, acted on by nothing yet. See parseEvent. */
export const COEXISTENCE_FIELDS = new Set(["history", "smb_app_state_sync", "smb_message_echoes"]);

/**
 * One delivery into zero or more events.
 *
 * Zero is normal and not a problem: Meta batches, and sends field types
 * we have no interest in. Never throws.
 */
export function parseEvent(rawBody: string): WhatsAppEvent[] {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(rawBody) as Envelope;
  } catch {
    return [];
  }

  const events: WhatsAppEvent[] = [];

  for (const entry of envelope.entry ?? []) {
    const wabaId = entry.id ?? "";

    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      if (change.field === "message_template_status_update") {
        const name = str(value.message_template_name);
        if (!name) continue;
        events.push({
          kind: "template_status",
          wabaId,
          name,
          language: str(value.message_template_language) || "en",
          status: str(value.event) || "PENDING",
          reason: str(value.reason) && str(value.reason) !== "NONE" ? str(value.reason) : null,
        });
        continue;
      }

      if (change.field === "phone_number_quality_update") {
        const metadata = value.metadata as { phone_number_id?: string } | undefined;
        const phoneNumberId = str(value.display_phone_number) || str(metadata?.phone_number_id);
        if (!phoneNumberId) continue;
        events.push({
          kind: "account_health",
          phoneNumberId,
          qualityRating: str(value.current_limit) ? null : str(value.event) || null,
          messagingLimit: str(value.current_limit) || null,
        });
        continue;
      }

      // Coexistence fields. Meta requires an app running coexistence to
      // subscribe to all three, and they arrive on every merchant on
      // that path — so they are named and ignored rather than left to
      // fall through. Silently dropping a field we are subscribed to is
      // how "why is nothing syncing" becomes unanswerable later.
      //
      //   history              the app's back catalogue, synced once
      //                        within 24h of onboarding
      //   smb_app_state_sync   contacts and app-side state
      //   smb_message_echoes   the merchant's own replies, sent from
      //                        the app rather than through us
      //
      // None of them has anywhere to go until there is an inbox in the
      // product. `smb_message_echoes` is the one worth building on
      // first: it is what would let a booking's timeline show that the
      // merchant answered.
      if (COEXISTENCE_FIELDS.has(change.field ?? "")) continue;

      if (change.field !== "messages") continue;

      const metadata = value.metadata as { phone_number_id?: string } | undefined;
      const phoneNumberId = str(metadata?.phone_number_id);
      if (!phoneNumberId) continue;

      for (const status of asArray(value.statuses)) {
        const id = str(status.id);
        const state = str(status.status);
        if (!id || !STATUSES.has(state)) continue;

        // Meta nests the failure reason two different ways depending on
        // the error, and the array form is the one that carries the
        // human-readable title.
        const errors = asArray(status.errors);
        const first = errors[0];
        events.push({
          kind: "status",
          phoneNumberId,
          providerMessageId: id,
          status: state as "sent" | "delivered" | "read" | "failed",
          errorCode: first?.code !== undefined ? String(first.code) : null,
          errorTitle: str(first?.title) || str(first?.message) || null,
        });
      }

      for (const message of asArray(value.messages)) {
        const id = str(message.id);
        const from = str(message.from);
        if (!id || !from) continue;
        const text = message.text as { body?: string } | undefined;
        events.push({
          kind: "inbound",
          phoneNumberId,
          fromPhone: from,
          text: str(text?.body),
          providerMessageId: id,
        });
      }
    }
  }

  return events;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}
