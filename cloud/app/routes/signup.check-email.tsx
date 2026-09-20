import type { ActionFunctionArgs } from "react-router";
import { prisma, emailKey } from "getbooqin-core";

/**
 * "Is this mailbox already an account?"
 *
 * Resource route, no UI. Called by signup.tsx before it hands anything
 * to Clerk.
 *
 * ## Why this is needed at all
 *
 * Clerk enforces uniqueness on the address as typed, which is the
 * correct rule for Clerk and the wrong one for a mailbox.
 * `info.scintillaweb@gmail.com` and `info.scintilla.web@gmail.com` are
 * two different strings and one inbox — so Clerk happily creates the
 * second account, and one person ends up with two trials, two booking
 * pages, and bookings split across both with no way to see it.
 *
 * ## Unauthenticated, and deliberately vague
 *
 * It answers before anyone has signed in, so it is an email-enumeration
 * oracle by construction. That is a real cost, accepted because the
 * signup form is already one — Clerk answers "that email is taken" on
 * submit regardless, so refusing to answer here would hide nothing and
 * only move the discovery one step later.
 *
 * What it will not do is confirm the *exact* address on file. Telling a
 * stranger that `info.scintillaweb@gmail.com` exists when they asked
 * about `info.scintilla.web@gmail.com` leaks a real person's precise
 * address, which is materially worse than confirming a mailbox is in
 * use. So the response is a boolean.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let email = "";
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email : "";
  } catch {
    return Response.json({ taken: false });
  }

  const key = emailKey(email);
  // No key means it isn't shaped like an address. Let Clerk's own
  // validation give that message — it phrases it better than we would,
  // and two different "that's not an email" errors on one form is
  // worse than one.
  if (!key) return Response.json({ taken: false });

  const existing = await prisma.user.findFirst({ where: { emailKey: key }, select: { id: true } });
  return Response.json({ taken: !!existing });
}
