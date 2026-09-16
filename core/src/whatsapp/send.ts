/**
 * Sending one template message, and recording what became of it.
 *
 * ## Everything we send is a template, and that is not a limitation we
 * chose
 *
 * WhatsApp only permits free-form text inside a 24-hour *customer
 * service window*, which opens when the **customer** messages the
 * business and closes 24 hours after their last message. Every message
 * GetBooqin sends is proactive — a confirmation, a reminder, a
 * cancellation — so none of them can rely on a window being open.
 * Hence templates, and hence the approval dance in templateSync.ts.
 *
 * ## The row is written before the send
 *
 * Not after. A crash between the Graph call and the insert would
 * otherwise leave a message the customer received and we have no record
 * of — and the whole reason to prefer WhatsApp over email is that it
 * can answer "did they actually get it". Losing that on the write path
 * would give up the only thing this channel has over the one we already
 * had.
 *
 * ## Failures are not exceptions here
 *
 * `sendTemplate` returns an outcome rather than throwing for the
 * ordinary failures, because almost all of them are facts about a
 * customer rather than faults: no WhatsApp account on that number, no
 * opt-in, a template still pending approval. A reminder that cannot go
 * by WhatsApp must not take down the email that was going anyway —
 * which is precisely how a "nice to have" channel breaks a product's
 * core promise.
 */
import prisma from "../db.js";
import type { WhatsAppAccount } from "@prisma/client";
import { graph, GraphError } from "./graph.js";
import { withToken, recordError, clearError } from "./accounts.js";
import {
  metaName,
  orderedParameters,
  templateFor,
  type TemplateVariable,
  type WhatsAppTemplateKey,
} from "./templates.js";

export type SendOutcome =
  | { sent: true; messageId: string; recordId: string }
  | { sent: false; reason: SkipReason; detail?: string };

/**
 * Why a message did not go. Each is a different thing for the merchant
 * to see, which is why this is not a boolean.
 */
export type SkipReason =
  | "not_connected"
  | "not_opted_in"
  | "no_phone"
  | "template_not_approved"
  | "not_on_whatsapp"
  | "failed";

export interface SendArgs {
  account: WhatsAppAccount;
  template: WhatsAppTemplateKey;
  /** E.164, already normalised against the shop's default country code. */
  toPhone: string;
  values: Partial<Record<TemplateVariable, string>>;
  /** Language the template was approved in. */
  language?: string;
  bookingId?: number;
  waitlistId?: number;
  fetchImpl?: typeof fetch;
}

/**
 * E.164 without the plus, digits only — what Meta's `to` field wants.
 *
 * Returns null for anything that cannot be one. A number typed as
 * "call the front desk" reaching Meta's API is a failed send counted
 * against the merchant's quality rating, so it is refused here instead.
 */
export function toWhatsAppNumber(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  // Shortest plausible international number is 7 digits after the
  // country code; longest E.164 is 15 in total.
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  return digits;
}

interface SendResponse {
  messages?: { id: string }[];
}

export async function sendTemplate(args: SendArgs): Promise<SendOutcome> {
  const { account, template, values, language = "en", bookingId, waitlistId, fetchImpl = fetch } = args;

  if (account.status !== "active") return { sent: false, reason: "not_connected" };

  const to = toWhatsAppNumber(args.toPhone);
  if (!to) return { sent: false, reason: "no_phone" };

  const name = metaName(template);
  // Asked of our cached copy of Meta's verdict rather than of Meta:
  // sending against a template it has rejected or paused is a
  // guaranteed failure *and* a quality-rating hit, and we already know
  // the answer. See templateSync.ts for how the cache stays fresh.
  const approved = await prisma.whatsAppTemplate.findFirst({
    where: { accountId: account.id, name, language, status: "APPROVED" },
  });
  if (!approved) return { sent: false, reason: "template_not_approved" };

  let parameters: string[];
  try {
    parameters = orderedParameters(template, values);
  } catch (error) {
    // A missing token is our bug, not the merchant's, and Meta would
    // answer it with an opaque 132000. Fail here where it names the
    // token.
    return { sent: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }

  const def = templateFor(template);
  const record = await prisma.whatsAppMessage.create({
    data: { accountId: account.id, template, toPhone: to, status: "queued", bookingId, waitlistId },
  });

  try {
    const result = await withToken(account, (token) =>
      graph<SendResponse>({
        path: `${account.phoneNumberId}/messages`,
        accessToken: token,
        method: "POST",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "template",
          template: {
            name,
            language: { code: language },
            components: buildComponents(def.variables, parameters, values, def.button?.urlVariable),
          },
        },
        fetchImpl,
      })
    );

    const messageId = result.messages?.[0]?.id;
    if (!messageId) {
      await prisma.whatsAppMessage.update({
        where: { id: record.id },
        data: { status: "failed", errorTitle: "Meta accepted the send but returned no message id" },
      });
      return { sent: false, reason: "failed" };
    }

    await prisma.whatsAppMessage.update({
      where: { id: record.id },
      data: { status: "sent", providerMessageId: messageId },
    });
    if (account.lastError) await clearError(account.id);
    return { sent: true, messageId, recordId: record.id };
  } catch (error) {
    const graphError = error instanceof GraphError ? error : null;
    await prisma.whatsAppMessage.update({
      where: { id: record.id },
      data: {
        status: "failed",
        errorCode: graphError ? String(graphError.code) : null,
        errorTitle: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      },
    });

    // "This number isn't on WhatsApp" is a fact about a customer, not a
    // fault in the integration — surfacing it on the Settings screen as
    // the account's last error would have merchants chasing a problem
    // that isn't theirs.
    if (graphError?.isNotOnWhatsApp) return { sent: false, reason: "not_on_whatsapp" };

    if (graphError && !graphError.isTokenRevoked) await recordError(account.id, graphError.message);
    return { sent: false, reason: "failed", detail: graphError?.message };
  }
}

/**
 * Meta's component array.
 *
 * The body's parameters are positional, and a URL button's parameter is
 * a *separate* component with its own index — a detail that silently
 * produces a button pointing at the wrong place if it is folded in with
 * the body's.
 *
 * The button parameter is only the URL's **suffix**: the template is
 * registered with a base URL and Meta appends what we pass. So this
 * sends the path rather than the whole link — see templateSync.ts,
 * which registers the base.
 */
function buildComponents(
  variables: TemplateVariable[],
  parameters: string[],
  values: Partial<Record<TemplateVariable, string>>,
  buttonVariable?: TemplateVariable
): unknown[] {
  const components: unknown[] = [
    { type: "body", parameters: parameters.map((text) => ({ type: "text", text })) },
  ];

  if (buttonVariable) {
    const url = values[buttonVariable];
    if (url) {
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: urlSuffix(url) }],
      });
    }
  }

  void variables;
  return components;
}

/**
 * The part of a link Meta appends to a template's registered base URL.
 *
 * Templates are approved with a fixed prefix — a dynamic URL button
 * cannot point anywhere it likes, which is the whole reason it is safe
 * for Meta to allow one. So a full link is reduced to what comes after
 * the origin.
 */
export function urlSuffix(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.replace(/^\//, "");
  } catch {
    return url.replace(/^https?:\/\/[^/]+\//, "");
  }
}
