/**
 * Applying what the webhook parsed.
 *
 * Split from `webhook.ts` so that parsing stays pure and total — no
 * database, no network, returns null for shapes it does not know. This
 * is the half that writes, and it is deliberately the half that can
 * fail, because the route's answer to Meta must not depend on it.
 *
 * ## Answer 200 first, then apply
 *
 * Meta retries a non-2xx, and after enough consecutive failures it
 * disables the subscription for the whole app — every merchant loses
 * delivery receipts because one row hit a constraint. So the route
 * acknowledges as soon as the signature verifies, and calls this
 * afterwards. A lost status update costs a stale row on one screen; a
 * disabled subscription costs the channel.
 */
import prisma from "../db.js";
import * as Accounts from "./accounts.js";
import { applyStatusUpdate } from "./templateSync.js";
import type { WhatsAppEvent } from "./webhook.js";

export async function applyEvents(events: WhatsAppEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await applyOne(event);
    } catch (error) {
      // One bad event must not stop the batch. Meta delivers these
      // batched, and a status for a message we never recorded is an
      // ordinary consequence of a database restore or a test send.
      console.error(`[getbooqin whatsapp] could not apply ${event.kind} event:`, error);
    }
  }
}

async function applyOne(event: WhatsAppEvent): Promise<void> {
  switch (event.kind) {
    case "status":
      return applyStatus(event);
    case "inbound":
      return applyInbound(event);
    case "template_status":
      return applyTemplate(event);
    case "account_health":
      return Accounts.updateHealth(event.phoneNumberId, {
        qualityRating: event.qualityRating,
        messagingLimit: event.messagingLimit,
      });
  }
}

/**
 * Delivery state, which is the whole reason this channel beats email.
 *
 * `updateMany` rather than `update`: a status can arrive for a message
 * we have no row for — a send from Meta's own test console, or a row
 * lost to a restore — and that is not an error worth logging on every
 * delivery.
 *
 * Statuses can also arrive out of order. `read` landing before
 * `delivered` must not leave the row saying `delivered`, so a status is
 * only ever allowed to move forward.
 */
const PROGRESS: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function applyStatus(event: Extract<WhatsAppEvent, { kind: "status" }>): Promise<void> {
  const existing = await prisma.whatsAppMessage.findUnique({
    where: { providerMessageId: event.providerMessageId },
    select: { id: true, status: true },
  });
  if (!existing) return;

  // `failed` always wins: it is terminal, and a delivery receipt that
  // arrives after one describes a different attempt.
  const forward = event.status === "failed" || (PROGRESS[event.status] ?? 0) > (PROGRESS[existing.status] ?? 0);
  if (!forward) return;

  await prisma.whatsAppMessage.update({
    where: { id: existing.id },
    data: {
      status: event.status,
      errorCode: event.errorCode,
      errorTitle: event.errorTitle,
    },
  });
}

/**
 * The customer replied.
 *
 * Recorded, not answered. A reply opens WhatsApp's 24-hour customer
 * service window, during which free-form messages are permitted — but
 * GetBooqin has no inbox, and auto-replying to "can I move this to
 * Tuesday?" with something generated would be worse than staying quiet.
 * The merchant sees it and answers from their own WhatsApp, where the
 * conversation already is.
 *
 * Stored on the message log as an inbound row so the booking's timeline
 * can show that the customer responded at all, which is the part the
 * merchant would otherwise miss.
 */
async function applyInbound(event: Extract<WhatsAppEvent, { kind: "inbound" }>): Promise<void> {
  const account = await Accounts.forPhoneNumberId(event.phoneNumberId);
  if (!account) return;

  await prisma.whatsAppMessage.upsert({
    where: { providerMessageId: event.providerMessageId },
    create: {
      accountId: account.id,
      template: "inbound",
      toPhone: event.fromPhone,
      providerMessageId: event.providerMessageId,
      status: "received",
      errorTitle: event.text.slice(0, 500) || null,
    },
    update: {},
  });
}

async function applyTemplate(event: Extract<WhatsAppEvent, { kind: "template_status" }>): Promise<void> {
  const account = await Accounts.forWaba(event.wabaId);
  if (!account) return;
  await applyStatusUpdate(account.id, event.name, event.language, event.status, event.reason);
}
