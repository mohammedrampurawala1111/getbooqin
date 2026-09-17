/**
 * A merchant's connected WhatsApp Business Account: storing it, reading
 * it back, and the lifecycle of it going wrong.
 *
 * The access token is encrypted at rest with the same
 * `CONNECTION_ENCRYPTION_KEY` that protects Shopify's, because it is
 * the same class of thing — a long-lived credential that can act as the
 * merchant's business until they revoke it. It is decrypted only inside
 * `withToken()`, and nothing outside this module ever holds the
 * plaintext in a variable it might log.
 */
import prisma from "../db.js";
import type { WhatsAppAccount } from "@prisma/client";
import { encryptCredentials, decryptCredentials } from "../auth/encryption.js";
import { GraphError } from "./graph.js";
import {
  exchangeCode,
  fetchPhoneNumber,
  generatePin,
  listPhoneNumbers,
  registerPhone,
  subscribeApp,
  type OnboardingMode,
} from "./embeddedSignup.js";

export type AccountStatus = "pending" | "active" | "revoked" | "error";

/** What a screen may see. Deliberately never includes the token. */
export interface PublicAccount {
  id: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  status: AccountStatus;
  onboardingMode: OnboardingMode;
  qualityRating: string | null;
  messagingLimit: string | null;
  lastError: string | null;
  connectedAt: Date;
}

export function toPublic(row: WhatsAppAccount): PublicAccount {
  return {
    id: row.id,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    status: row.status as AccountStatus,
    onboardingMode: row.onboardingMode as OnboardingMode,
    qualityRating: row.qualityRating,
    messagingLimit: row.messagingLimit,
    lastError: row.lastError,
    connectedAt: row.connectedAt,
  };
}

export async function forConnection(connectionId: string): Promise<PublicAccount | null> {
  const row = await rowForConnection(connectionId);
  return row ? toPublic(row) : null;
}

/**
 * The full row, token and all.
 *
 * Separate from `forConnection` so that the token-bearing version has
 * to be asked for by name. Anything rendering a screen wants the other
 * one; this is for the callers that are about to talk to Meta.
 */
export async function rowForConnection(connectionId: string): Promise<WhatsAppAccount | null> {
  return prisma.whatsAppAccount.findUnique({ where: { connectionId } });
}

/** By the WABA id a webhook arrives under. */
export async function forWaba(wabaId: string): Promise<WhatsAppAccount | null> {
  return prisma.whatsAppAccount.findFirst({ where: { wabaId } });
}

export async function forPhoneNumberId(phoneNumberId: string): Promise<WhatsAppAccount | null> {
  return prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
}

/**
 * Run `fn` with the decrypted token, and handle the one failure that
 * means the credential is gone rather than unlucky.
 *
 * Centralised here so that every caller gets the revocation handling
 * for free. A merchant who removes our app at Meta produces a 190 on
 * the very next call, and an integration that retries that forever
 * looks alive in the logs while sending nothing — so the account is
 * marked `revoked` at the first one, which is what makes the Settings
 * screen able to say "reconnect" instead of "sending failed".
 */
export async function withToken<T>(account: WhatsAppAccount, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(decryptCredentials(account.accessToken));
  } catch (error) {
    if (error instanceof GraphError && error.isTokenRevoked) {
      await markRevoked(account.id, error.message);
    }
    throw error;
  }
}

export async function markRevoked(id: string, reason: string): Promise<void> {
  await prisma.whatsAppAccount.update({
    where: { id },
    data: { status: "revoked", lastError: reason.slice(0, 500) },
  });
}

export async function recordError(id: string, reason: string): Promise<void> {
  await prisma.whatsAppAccount.update({ where: { id }, data: { lastError: reason.slice(0, 500) } });
}

/** Cleared on the next success, so a stale error does not sit on the screen forever. */
export async function clearError(id: string): Promise<void> {
  await prisma.whatsAppAccount.update({ where: { id }, data: { lastError: null } });
}

export async function updateHealth(
  phoneNumberId: string,
  health: { qualityRating?: string | null; messagingLimit?: string | null }
): Promise<void> {
  await prisma.whatsAppAccount.updateMany({
    where: { phoneNumberId },
    data: {
      ...(health.qualityRating !== undefined ? { qualityRating: health.qualityRating } : {}),
      ...(health.messagingLimit !== undefined ? { messagingLimit: health.messagingLimit } : {}),
    },
  });
}

export interface SignupInput {
  connectionId: string;
  /** From the Facebook SDK callback. */
  code: string;
  /** From the WA_EMBEDDED_SIGNUP postMessage. */
  wabaId: string;
  /**
   * Present for a classic `FINISH`, **absent for coexistence** — that
   * event carries only `waba_id`, because the number was already on the
   * merchant's WhatsApp Business app and nobody picked it in a wizard.
   * Looked up from the WABA when it is missing.
   */
  phoneNumberId?: string;
  mode: OnboardingMode;
}

/**
 * The whole server-side half of Embedded Signup, in one call.
 *
 * ## The token is stored before the remaining steps, on purpose
 *
 * `exchangeCode` is the only step that cannot be retried: the `code` is
 * single-use and the merchant would have to walk through Meta's popup
 * again to produce another. Subscribing the app and registering the
 * number are both idempotent and both retryable from a button.
 *
 * So the ordering is: get the irreplaceable thing, write it down, then
 * do the replaceable things. A failure after the write leaves a
 * `pending` account carrying the reason, which the Settings screen
 * offers to finish — rather than a merchant who completed Meta's flow,
 * saw an error, and has nothing to show for it.
 */
export async function completeSignup(input: SignupInput, fetchImpl: typeof fetch = fetch): Promise<PublicAccount> {
  const token = await exchangeCode(input.code, fetchImpl);

  // Coexistence hands back a WABA and nothing else, so the number has to
  // be asked for. Done before the write rather than during setup,
  // because phoneNumberId is the row's unique key — there is no
  // meaningful account to store without it.
  let phoneNumberId = input.phoneNumberId;
  if (!phoneNumberId) {
    const numbers = await listPhoneNumbers(input.wabaId, token, fetchImpl);
    phoneNumberId = numbers[0]?.id;
    if (!phoneNumberId) {
      throw new Error("That WhatsApp account has no phone number on it yet.");
    }
  }

  const stored = await prisma.whatsAppAccount.upsert({
    where: { connectionId: input.connectionId },
    create: {
      connectionId: input.connectionId,
      wabaId: input.wabaId,
      phoneNumberId,
      onboardingMode: input.mode,
      accessToken: encryptCredentials(token),
      status: "pending",
    },
    update: {
      wabaId: input.wabaId,
      phoneNumberId,
      onboardingMode: input.mode,
      accessToken: encryptCredentials(token),
      status: "pending",
      lastError: null,
    },
  });

  return finishSetup(stored.id, fetchImpl);
}

/**
 * Subscribe, register, and read the number back — the retryable half.
 *
 * Also the "Finish setup" button on the Settings screen, which is why
 * it takes an account id rather than being folded into the call above.
 */
export async function finishSetup(accountId: string, fetchImpl: typeof fetch = fetch): Promise<PublicAccount> {
  const account = await prisma.whatsAppAccount.findUniqueOrThrow({ where: { id: accountId } });

  try {
    return await withToken(account, async (token) => {
      await subscribeApp(account.wabaId, token, fetchImpl);

      // The one branch in this whole module that a merchant would
      // notice. A coexistence number is already registered — to their
      // own WhatsApp Business app — and /register is the call that
      // would move it off. Skipping it is the entire difference between
      // "you keep your app" and "you have just lost the thing you run
      // your business on".
      if (account.onboardingMode !== "coexistence") {
        await registerPhone(account.phoneNumberId, token, generatePin(), fetchImpl);
      }

      const info = await fetchPhoneNumber(account.phoneNumberId, token, fetchImpl);
      const updated = await prisma.whatsAppAccount.update({
        where: { id: account.id },
        data: {
          displayPhoneNumber: info.displayPhoneNumber,
          verifiedName: info.verifiedName,
          qualityRating: info.qualityRating,
          status: "active",
          lastError: null,
        },
      });
      return toPublic(updated);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Not re-thrown as a different type: the caller needs to be able to
    // show the merchant what Meta actually said, because the common
    // failures here are things only they can fix (a number already in
    // use on the WhatsApp app, a business not yet verified).
    const current = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
    if (current && current.status !== "revoked") await recordError(accountId, message);
    throw error;
  }
}

/**
 * Forget the merchant's WhatsApp account.
 *
 * Deliberately does **not** call Meta to unsubscribe or deregister.
 * Disconnecting here should never be able to take their number offline
 * — it is their WABA, on their payment method, and they may well be
 * moving it to another tool or back to the WhatsApp Business app. We
 * drop our copy of the credential; they remove our app from their side
 * if they want the permission gone, which is a thing only they should
 * be able to decide.
 */
export async function disconnect(connectionId: string): Promise<void> {
  await prisma.whatsAppAccount.deleteMany({ where: { connectionId } });
}

/**
 * Can this account actually put a message in front of a customer right
 * now?
 *
 * Deliberately stricter than "is it connected". A merchant can be
 * entitled, connected, and still unable to send because Meta has not
 * finished reviewing the templates — which is an ordinary state lasting
 * minutes to days after signup, not a fault.
 *
 * Asked by the public booking page before it offers the opt-in
 * checkbox. Collecting a consent that nothing can act on is worse than
 * not asking: it teaches a customer to expect messages that never come.
 */
export async function canSend(connectionId: string): Promise<boolean> {
  const account = await prisma.whatsAppAccount.findUnique({
    where: { connectionId },
    select: { id: true, status: true },
  });
  if (!account || account.status !== "active") return false;

  // The confirmation specifically, because that is the message the
  // checkbox is implicitly promising. A merchant whose reminder is
  // approved but whose confirmation is not would otherwise tick a box
  // and hear nothing at the moment they most expect to.
  const approved = await prisma.whatsAppTemplate.count({
    where: { accountId: account.id, key: "booking_confirmed", status: "APPROVED" },
  });
  return approved > 0;
}
